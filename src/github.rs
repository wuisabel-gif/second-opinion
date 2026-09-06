use crate::model::{Finding, ReviewOutput};
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::Read;

const MAX_DIFF_BYTES: usize = 120_000;
const MAX_COMMENTS: usize = 15;
const DEFAULT_CONTEXT_BYTES: usize = 60_000;
const MAX_CONTEXT_BYTES: usize = 1_000_000;
const MAX_SINGLE_FILE_BYTES: usize = 20_000;
const MAX_RULES_BYTES: usize = 20_000;
const MAX_IMPORT_FILES: usize = 12;
const MAX_CONTEXT_BLOBS: usize = 64;
const MAX_CHANGED_FILES: usize = 500;
const MAX_TREE_ENTRIES: usize = 20_000;
const MAX_GITHUB_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_REVIEW_RUN_ID_BYTES: usize = 256;

pub struct ReviewInput {
    pub diff: String,
    pub commentable: BTreeMap<String, BTreeSet<u64>>,
    pub context: String,
    pub rules: String,
}

struct PullRefs {
    head_commit: String,
    base_commit: String,
    head_repo: String,
    base_repo: String,
}

struct ChangedFile {
    path: String,
    sha: String,
}

pub fn required_env(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{name} not set"))
}

pub fn pr_number() -> Result<u64> {
    if let Ok(number) = env::var("PR_NUMBER") {
        return number.parse().context("PR_NUMBER is not a number");
    }
    let path = required_env("GITHUB_EVENT_PATH")?;
    let event: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
    event["pull_request"]["number"]
        .as_u64()
        .or_else(|| event["issue"]["number"].as_u64())
        .context("could not find a PR number in the event payload")
}

pub fn head_is_expected(token: &str, repo: &str, pr: u64) -> Result<bool> {
    let expected = expected_head_sha();
    if expected.is_none() {
        return Ok(true);
    }
    Ok(expected_head_matches(
        expected.as_deref(),
        &fetch_pull_refs(token, repo, pr)?.head_commit,
    ))
}

pub fn expected_head_sha() -> Option<String> {
    env::var("EXPECTED_HEAD_SHA")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn review_run_id() -> Result<Option<String>> {
    let Some(value) = env::var("REVIEW_RUN_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    if value.len() > MAX_REVIEW_RUN_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
    {
        bail!("REVIEW_RUN_ID contains unsupported characters or is too long");
    }
    Ok(Some(value))
}

fn expected_head_matches(expected: Option<&str>, actual: &str) -> bool {
    expected.map(|value| value == actual).unwrap_or(true)
}

pub fn load_review_input(token: &str, repo: &str, pr: u64) -> Result<ReviewInput> {
    let diff = truncate_utf8(&fetch_diff(token, repo, pr)?, MAX_DIFF_BYTES);
    let commentable = commentable_lines(&diff);
    if diff.trim().is_empty() {
        return Ok(ReviewInput {
            diff,
            commentable,
            context: String::new(),
            rules: String::new(),
        });
    }

    let refs = fetch_pull_refs(token, repo, pr)?;
    let rules = match fetch_commit_tree_sha(token, &refs.base_repo, &refs.base_commit)
        .and_then(|tree| fetch_review_rules(token, &refs.base_repo, &tree))
    {
        Ok(rules) => rules,
        Err(error) => {
            eprintln!("Could not load REVIEW.md: {error:#}");
            String::new()
        }
    };
    let budget = context_budget()?;
    let context = if budget == 0 {
        String::new()
    } else {
        match fetch_commit_tree_sha(token, &refs.head_repo, &refs.head_commit).and_then(|tree| {
            fetch_repository_context(token, repo, &refs.head_repo, pr, &tree, budget)
        }) {
            Ok(context) => context,
            Err(error) => {
                eprintln!("Could not load repository context: {error:#}");
                String::new()
            }
        }
    };
    Ok(ReviewInput {
        diff,
        commentable,
        context,
        rules,
    })
}

fn context_budget() -> Result<usize> {
    let budget = match env::var("REVIEW_CONTEXT_BYTES") {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse::<usize>()
            .context("REVIEW_CONTEXT_BYTES must be a non-negative integer"),
        _ => Ok(DEFAULT_CONTEXT_BYTES),
    }?;
    if budget > MAX_CONTEXT_BYTES {
        bail!("REVIEW_CONTEXT_BYTES must not exceed {MAX_CONTEXT_BYTES}");
    }
    Ok(budget)
}

fn fetch_diff(token: &str, repo: &str, pr: u64) -> Result<String> {
    let url = format!("https://api.github.com/repos/{repo}/pulls/{pr}");
    let response = github_request(token, &url)
        .set("Accept", "application/vnd.github.v3.diff")
        .call()
        .context("fetching PR diff failed")?;
    let (bytes, _) = read_response_prefix(response, MAX_DIFF_BYTES)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn fetch_pull_refs(token: &str, repo: &str, pr: u64) -> Result<PullRefs> {
    let url = format!("https://api.github.com/repos/{repo}/pulls/{pr}");
    let value = github_json(token, &url)?;
    let head_sha = value["head"]["sha"]
        .as_str()
        .context("PR response missing head SHA")?;
    let base_sha = value["base"]["sha"]
        .as_str()
        .context("PR response missing base SHA")?;
    let head_repo = value["head"]["repo"]["full_name"]
        .as_str()
        .unwrap_or(repo)
        .to_string();
    let base_repo = value["base"]["repo"]["full_name"]
        .as_str()
        .unwrap_or(repo)
        .to_string();
    Ok(PullRefs {
        head_commit: head_sha.to_string(),
        base_commit: base_sha.to_string(),
        head_repo,
        base_repo,
    })
}

fn fetch_commit_tree_sha(token: &str, repo: &str, commit_sha: &str) -> Result<String> {
    let url = format!("https://api.github.com/repos/{repo}/git/commits/{commit_sha}");
    github_json(token, &url)?["tree"]["sha"]
        .as_str()
        .context("commit response missing tree SHA")
        .map(str::to_string)
}

fn fetch_changed_files(token: &str, repo: &str, pr: u64) -> Result<Vec<ChangedFile>> {
    let mut files = Vec::new();
    for page in 1..=30 {
        let url = format!(
            "https://api.github.com/repos/{repo}/pulls/{pr}/files?per_page=100&page={page}"
        );
        let value = github_json(token, &url)?;
        let entries = value
            .as_array()
            .context("PR files response was not an array")?;
        for entry in entries {
            if entry["status"] == "removed" {
                continue;
            }
            if let (Some(path), Some(sha)) = (entry["filename"].as_str(), entry["sha"].as_str()) {
                files.push(ChangedFile {
                    path: path.to_string(),
                    sha: sha.to_string(),
                });
                if files.len() >= MAX_CHANGED_FILES {
                    return Ok(files);
                }
            }
        }
        if entries.len() < 100 {
            break;
        }
    }
    Ok(files)
}

fn fetch_tree(
    token: &str,
    repo: &str,
    sha: &str,
    recursive: bool,
) -> Result<BTreeMap<String, String>> {
    let suffix = if recursive { "?recursive=1" } else { "" };
    let url = format!("https://api.github.com/repos/{repo}/git/trees/{sha}{suffix}");
    let value = github_json(token, &url)?;
    let entries = value["tree"]
        .as_array()
        .context("tree response missing entries")?;
    let mut tree = BTreeMap::new();
    for entry in entries.iter().take(MAX_TREE_ENTRIES) {
        if entry["type"] == "blob" {
            if let (Some(path), Some(blob_sha)) = (entry["path"].as_str(), entry["sha"].as_str()) {
                tree.insert(path.to_string(), blob_sha.to_string());
            }
        }
    }
    Ok(tree)
}

fn fetch_blob(token: &str, repo: &str, sha: &str, max_bytes: usize) -> Result<Option<String>> {
    let url = format!("https://api.github.com/repos/{repo}/git/blobs/{sha}");
    let response = github_request(token, &url)
        .call()
        .with_context(|| format!("GitHub request failed: {url}"))?;
    let maximum_response = max_bytes.saturating_mul(2).saturating_add(8 * 1024);
    let (bytes, truncated) = read_response_prefix(response, maximum_response)?;
    if truncated {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_slice(&bytes).context("GitHub blob response was not JSON")?;
    if value["encoding"] != "base64" {
        return Ok(None);
    }
    if value["size"].as_u64().unwrap_or(u64::MAX) > max_bytes as u64 {
        return Ok(None);
    }
    let encoded = value["content"]
        .as_str()
        .context("blob response missing content")?
        .replace('\n', "");
    let bytes = STANDARD.decode(encoded).context("invalid base64 blob")?;
    if bytes.len() > max_bytes {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

fn fetch_review_rules(token: &str, repo: &str, base_sha: &str) -> Result<String> {
    let tree = fetch_tree(token, repo, base_sha, false)?;
    let Some(blob_sha) = tree.get("REVIEW.md") else {
        return Ok(String::new());
    };
    Ok(fetch_blob(token, repo, blob_sha, MAX_RULES_BYTES)?.unwrap_or_default())
}

fn fetch_repository_context(
    token: &str,
    pull_repo: &str,
    content_repo: &str,
    pr: u64,
    head_tree: &str,
    budget: usize,
) -> Result<String> {
    let changed = fetch_changed_files(token, pull_repo, pr)?;
    let tree = fetch_tree(token, content_repo, head_tree, true)?;
    let mut output = String::new();
    let mut changed_contents = Vec::new();

    let mut attempted_blobs = 0_usize;
    for file in &changed {
        if output.len() >= budget {
            break;
        }
        if attempted_blobs >= MAX_CONTEXT_BLOBS {
            break;
        }
        attempted_blobs += 1;
        let maximum = MAX_SINGLE_FILE_BYTES.min(budget.saturating_sub(output.len()));
        let Some(content) = fetch_blob(token, content_repo, &file.sha, maximum)? else {
            continue;
        };
        append_file_context(&mut output, &file.path, &content, budget);
        changed_contents.push((file.path.clone(), content));
    }

    let changed_paths: BTreeSet<&str> = changed.iter().map(|file| file.path.as_str()).collect();
    let mut imports = BTreeSet::new();
    for (path, content) in &changed_contents {
        imports.extend(resolve_imports(path, content, &tree));
    }
    for path in imports.into_iter().take(MAX_IMPORT_FILES) {
        if output.len() >= budget || changed_paths.contains(path.as_str()) {
            continue;
        }
        let Some(blob_sha) = tree.get(&path) else {
            continue;
        };
        if attempted_blobs >= MAX_CONTEXT_BLOBS {
            break;
        }
        attempted_blobs += 1;
        let maximum = (MAX_SINGLE_FILE_BYTES / 2).min(budget.saturating_sub(output.len()));
        let Some(content) = fetch_blob(token, content_repo, blob_sha, maximum)? else {
            continue;
        };
        append_file_context(
            &mut output,
            &format!("{path} (direct import)"),
            &content,
            budget,
        );
    }
    Ok(output)
}

fn append_file_context(output: &mut String, path: &str, content: &str, budget: usize) {
    if output.len() >= budget {
        return;
    }
    let header = format!("\n<file path={path:?}>\n");
    let footer = "\n</file>\n";
    let remaining = budget.saturating_sub(output.len());
    if remaining <= header.len() + footer.len() {
        return;
    }
    output.push_str(&header);
    let available = remaining - header.len() - footer.len();
    output.push_str(utf8_prefix(content, available));
    output.push_str(footer);
}

fn resolve_imports(path: &str, content: &str, tree: &BTreeMap<String, String>) -> BTreeSet<String> {
    let mut resolved = BTreeSet::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("import ")
            || trimmed.starts_with("export ")
            || trimmed.contains("require(")
        {
            for segment in line.split(['\'', '"']) {
                if segment.starts_with('.') {
                    add_relative_candidates(path, segment, tree, &mut resolved);
                }
            }
        }
        if let Some(rest) = trimmed.strip_prefix("use crate::") {
            let module = rest
                .split([';', '{'])
                .next()
                .unwrap_or(rest)
                .trim_end_matches("::")
                .replace("::", "/");
            for candidate in [format!("src/{module}.rs"), format!("src/{module}/mod.rs")] {
                if tree.contains_key(&candidate) {
                    resolved.insert(candidate);
                }
            }
        }
        if let Some(rest) = trimmed.strip_prefix("from .") {
            let module = rest
                .split_whitespace()
                .next()
                .unwrap_or("")
                .replace('.', "/");
            add_relative_candidates(path, &format!("./{module}"), tree, &mut resolved);
        }
    }
    resolved
}

fn add_relative_candidates(
    source: &str,
    specifier: &str,
    tree: &BTreeMap<String, String>,
    output: &mut BTreeSet<String>,
) {
    let specifier = specifier.split(['?', '#']).next().unwrap_or(specifier);
    let Some(base) = normalize_relative_path(source, specifier) else {
        return;
    };
    let extensions = ["", ".rs", ".ts", ".tsx", ".js", ".jsx", ".py"];
    for extension in extensions {
        let candidate = format!("{base}{extension}");
        if tree.contains_key(&candidate) {
            output.insert(candidate);
        }
    }
    for index in [
        "index.ts",
        "index.tsx",
        "index.js",
        "index.jsx",
        "mod.rs",
        "__init__.py",
    ] {
        let candidate = format!("{base}/{index}");
        if tree.contains_key(&candidate) {
            output.insert(candidate);
        }
    }
}

fn normalize_relative_path(source: &str, specifier: &str) -> Option<String> {
    if !specifier.starts_with('.') {
        return None;
    }
    let mut parts: Vec<&str> = source.split('/').collect();
    parts.pop();
    for part in specifier.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            value => parts.push(value),
        }
    }
    Some(parts.join("/"))
}

pub fn existing_fingerprints(token: &str, repo: &str, pr: u64) -> Result<BTreeSet<String>> {
    let mut fingerprints = BTreeSet::new();
    let bot_login = configured_bot_login();
    for page in 1..=10 {
        let url = format!(
            "https://api.github.com/repos/{repo}/pulls/{pr}/comments?per_page=100&page={page}"
        );
        let value = github_json(token, &url)?;
        let comments = value
            .as_array()
            .context("review comments response was not an array")?;
        fingerprints.extend(fingerprints_from_comments(comments, &bot_login));
        if comments.len() < 100 {
            break;
        }
    }
    Ok(fingerprints)
}

pub fn review_run_already_posted(token: &str, repo: &str, pr: u64) -> Result<bool> {
    let Some(run_id) = review_run_id()? else {
        return Ok(false);
    };
    let marker = format!("<!-- second-opinion-run:{run_id} -->");
    let bot_login = configured_bot_login();
    for page in 1..=10 {
        let url = format!(
            "https://api.github.com/repos/{repo}/pulls/{pr}/reviews?per_page=100&page={page}"
        );
        let value = github_json(token, &url)?;
        let reviews = value
            .as_array()
            .context("pull request reviews response was not an array")?;
        if reviews.iter().any(|review| {
            review["user"]["login"].as_str() == Some(bot_login.as_str())
                && review["body"]
                    .as_str()
                    .is_some_and(|body| body.contains(&marker))
        }) {
            return Ok(true);
        }
        if reviews.len() < 100 {
            break;
        }
    }
    Ok(false)
}

fn configured_bot_login() -> String {
    env::var("REVIEW_BOT_LOGIN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "github-actions[bot]".to_string())
}

fn fingerprints_from_comments(comments: &[Value], bot_login: &str) -> BTreeSet<String> {
    comments
        .iter()
        .filter(|comment| comment["user"]["login"].as_str() == Some(bot_login))
        .filter_map(|comment| comment["body"].as_str())
        .filter_map(marker_value)
        .map(str::to_string)
        .collect()
}

fn marker_value(body: &str) -> Option<&str> {
    [
        "<!-- second-opinion:",
        "<!-- secondopinion:",
        "<!-- pr-reviewer:",
    ]
    .iter()
    .find_map(|prefix| body.split(prefix).nth(1))
    .and_then(|rest| rest.split(" -->").next())
}

pub fn finding_fingerprint(finding: &Finding) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in finding
        .path
        .bytes()
        .chain([0])
        .chain(finding.line.to_le_bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn post_review(
    token: &str,
    repo: &str,
    pr: u64,
    review: ReviewOutput,
    commentable: &BTreeMap<String, BTreeSet<u64>>,
    commit_id: Option<&str>,
) -> Result<()> {
    let mut comments = Vec::new();
    let mut orphaned = Vec::new();
    let mut fallback_findings = Vec::new();

    for finding in review.findings {
        let rendered = format!(
            "- `{}:{}` [{}] {}",
            finding.path, finding.line, finding.severity, finding.comment
        );
        fallback_findings.push(rendered.clone());
        let valid = commentable
            .get(&finding.path)
            .map(|lines| lines.contains(&finding.line))
            .unwrap_or(false);
        if valid && comments.len() < MAX_COMMENTS {
            let marker = finding_fingerprint(&finding);
            comments.push(json!({
                "path": finding.path,
                "line": finding.line,
                "side": "RIGHT",
                "body": format!(
                    "**[{}]** {}\n\n<!-- second-opinion:{marker} -->",
                    finding.severity, finding.comment
                ),
            }));
        } else {
            orphaned.push(rendered);
        }
    }

    let mut body = format!("## second-opinion review\n\n{}", review.summary);
    if let Some(run_id) = review_run_id()? {
        body.push_str(&format!("\n\n<!-- second-opinion-run:{run_id} -->"));
    }
    if !orphaned.is_empty() {
        body.push_str("\n\n**Findings outside the diff or comment limit:**\n");
        body.push_str(&orphaned.join("\n"));
    }

    let url = format!("https://api.github.com/repos/{repo}/pulls/{pr}/reviews");
    let mut payload = json!({ "event": "COMMENT", "body": body, "comments": comments });
    if let Some(commit_id) = commit_id {
        payload["commit_id"] = json!(commit_id);
    }
    let result = github_post_request(token, &url).send_json(payload);
    match result {
        Ok(_) => {
            eprintln!("Posted review with {} line comments.", comments.len());
            Ok(())
        }
        Err(ureq::Error::Status(422, response)) => {
            eprintln!(
                "422 posting line comments, falling back to summary: {}",
                response.into_string().unwrap_or_default()
            );
            let mut fallback_body = body;
            if !fallback_findings.is_empty() {
                fallback_body.push_str("\n\n**Line findings:**\n");
                fallback_body.push_str(&fallback_findings.join("\n"));
            }
            let mut fallback_payload = json!({ "event": "COMMENT", "body": fallback_body });
            if let Some(commit_id) = commit_id {
                fallback_payload["commit_id"] = json!(commit_id);
            }
            github_post_request(token, &url)
                .send_json(fallback_payload)
                .context("fallback summary review also failed")?;
            Ok(())
        }
        Err(error) => bail!("posting review failed: {error}"),
    }
}

fn github_request(token: &str, url: &str) -> ureq::Request {
    ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "second-opinion")
        .set("X-GitHub-Api-Version", "2022-11-28")
}

fn github_post_request(token: &str, url: &str) -> ureq::Request {
    ureq::post(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "second-opinion")
        .set("X-GitHub-Api-Version", "2022-11-28")
}

fn github_json(token: &str, url: &str) -> Result<Value> {
    let response = github_request(token, url)
        .call()
        .with_context(|| format!("GitHub request failed: {url}"))?;
    let (bytes, truncated) = read_response_prefix(response, MAX_GITHUB_JSON_BYTES)?;
    if truncated {
        bail!("GitHub response exceeded {MAX_GITHUB_JSON_BYTES} bytes: {url}");
    }
    serde_json::from_slice(&bytes).context("GitHub response was not valid JSON")
}

fn read_response_prefix(response: ureq::Response, max: usize) -> Result<(Vec<u8>, bool)> {
    read_prefix(response.into_reader(), max)
}

fn read_prefix(reader: impl Read, max: usize) -> Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::with_capacity(max.min(64 * 1024));
    reader
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .context("could not read GitHub response")?;
    let truncated = bytes.len() > max;
    if truncated {
        bytes.truncate(max);
    }
    Ok((bytes, truncated))
}

fn commentable_lines(diff: &str) -> BTreeMap<String, BTreeSet<u64>> {
    let mut map = BTreeMap::new();
    let mut current_file: Option<String> = None;
    let mut new_line = 0_u64;
    let mut remaining = 0_u64;
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            current_file = None;
            remaining = 0;
        } else if let Some(rest) = line.strip_prefix("+++ b/") {
            current_file = Some(rest.to_string());
            remaining = 0;
        } else if line.starts_with("+++ ") {
            current_file = None;
            remaining = 0;
        } else if line.starts_with("@@") {
            if let Some((start, count)) = parse_new_hunk_range(line) {
                new_line = start;
                remaining = count;
            } else {
                remaining = 0;
            }
        } else if remaining > 0 {
            let Some(file) = &current_file else { continue };
            if line.starts_with('+') || line.starts_with(' ') {
                map.entry(file.clone())
                    .or_insert_with(BTreeSet::new)
                    .insert(new_line);
                new_line += 1;
                remaining -= 1;
            }
        }
    }
    map
}

fn parse_new_hunk_range(header: &str) -> Option<(u64, u64)> {
    let range = header
        .split_whitespace()
        .find(|part| part.starts_with('+'))?
        .strip_prefix('+')?;
    let mut parts = range.splitn(2, ',');
    let start = parts.next()?.parse().ok()?;
    let count = parts.next().map(str::parse).transpose().ok()?.unwrap_or(1);
    Some((start, count))
}

fn truncate_utf8(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated at {max} bytes]", &value[..end])
}

fn utf8_prefix(value: &str, max: usize) -> &str {
    if value.len() <= max {
        return value;
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_parser_ignores_metadata() {
        let diff = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n+x\n\\ No newline at end of file\nindex 1..2\n";
        assert_eq!(commentable_lines(diff)["a.rs"].len(), 1);
    }

    #[test]
    fn resolves_relative_imports() {
        let tree = BTreeMap::from([
            ("src/lib.ts".to_string(), "1".to_string()),
            ("src/util.ts".to_string(), "2".to_string()),
        ]);
        let imports = resolve_imports("src/lib.ts", "import x from './util';", &tree);
        assert!(imports.contains("src/util.ts"));
    }

    #[test]
    fn fingerprint_is_location_stable() {
        let first = Finding {
            path: "a.rs".into(),
            line: 2,
            severity: "low".into(),
            comment: "a".into(),
        };
        let second = Finding {
            comment: "different".into(),
            ..first.clone()
        };
        assert_eq!(finding_fingerprint(&first), finding_fingerprint(&second));
    }

    #[test]
    fn extracts_comment_marker() {
        assert_eq!(
            marker_value("comment\n<!-- second-opinion:abc123 -->"),
            Some("abc123")
        );
        assert_eq!(
            marker_value("compat\n<!-- secondopinion:compat123 -->"),
            Some("compat123")
        );
        assert_eq!(
            marker_value("legacy\n<!-- pr-reviewer:legacy123 -->"),
            Some("legacy123")
        );
    }

    #[test]
    fn context_section_respects_budget() {
        let mut output = String::new();
        append_file_context(&mut output, "src/a.rs", &"é".repeat(100), 80);
        assert!(output.len() <= 80);
        assert!(output.is_char_boundary(output.len()));
    }

    #[test]
    fn dedup_trusts_only_configured_author() {
        let comments = vec![
            json!({"user":{"login":"attacker"},"body":"<!-- second-opinion:forged -->"}),
            json!({"user":{"login":"github-actions[bot]"},"body":"<!-- second-opinion:trusted -->"}),
        ];
        let values = fingerprints_from_comments(&comments, "github-actions[bot]");
        assert_eq!(values, BTreeSet::from(["trusted".to_string()]));
    }

    #[test]
    fn expected_head_prevents_stale_hosted_reviews() {
        assert!(expected_head_matches(None, "head"));
        assert!(expected_head_matches(Some("head"), "head"));
        assert!(!expected_head_matches(Some("old"), "head"));
    }

    #[test]
    fn response_reader_never_keeps_more_than_its_limit() {
        let (bytes, truncated) = read_prefix(&b"123456"[..], 4).unwrap();
        assert_eq!(bytes, b"1234");
        assert!(truncated);
        let (bytes, truncated) = read_prefix(&b"1234"[..], 4).unwrap();
        assert_eq!(bytes, b"1234");
        assert!(!truncated);
    }

    #[test]
    fn run_id_validation_rejects_marker_injection() {
        // Test the same allowlist without mutating process-global environment in parallel tests.
        let valid = "123:42:abcdef";
        assert!(valid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte)));
        let invalid = "abc --> injected";
        assert!(!invalid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte)));
    }
}
