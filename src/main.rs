mod benchmark;
mod broker;
mod codex;
mod github;
mod model;
mod sarif;

use anyhow::{bail, Context, Result};
use github::ReviewTarget;
use model::{Provider, ReviewMode, ReviewRequest, ReviewStyle};
use std::env;

/// Review-wide output options resolved from flags/env, applied after the model runs.
#[derive(Clone, Default)]
struct OutputConfig {
    /// Exit nonzero when a finding at or above this severity rank is reported.
    fail_on: Option<u8>,
    /// Write a SARIF 2.1.0 report to this path for GitHub code scanning.
    sarif_path: Option<String>,
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Parse CLI args into (review mode, review style, optional benchmark suite
/// path). A `--mode`/`--security` or `--style` flag wins over the matching
/// `REVIEW_MODE` / `REVIEW_STYLE` env var.
fn parse_args(args: &[String]) -> Result<(ReviewMode, ReviewStyle, OutputConfig, Option<String>)> {
    let mut mode: Option<ReviewMode> = None;
    let mut style: Option<ReviewStyle> = None;
    let mut fail_on: Option<u8> = None;
    let mut sarif_path: Option<String> = None;
    let mut benchmark: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--security" => mode = Some(ReviewMode::Security),
            "--mode" => {
                let value = args
                    .get(i + 1)
                    .context("--mode requires a value (general|security)")?;
                mode = Some(ReviewMode::parse(value)?);
                i += 1;
            }
            _ if arg.starts_with("--mode=") => {
                mode = Some(ReviewMode::parse(&arg["--mode=".len()..])?);
            }
            "--style" => {
                let value = args
                    .get(i + 1)
                    .context("--style requires a value (strict|balanced|blocking-only)")?;
                style = Some(ReviewStyle::parse(value)?);
                i += 1;
            }
            _ if arg.starts_with("--style=") => {
                style = Some(ReviewStyle::parse(&arg["--style=".len()..])?);
            }
            "--fail-on" => {
                let value = args
                    .get(i + 1)
                    .context("--fail-on requires a value (high|medium|low)")?;
                fail_on = Some(model::parse_severity_threshold(value)?);
                i += 1;
            }
            _ if arg.starts_with("--fail-on=") => {
                fail_on = Some(model::parse_severity_threshold(&arg["--fail-on=".len()..])?);
            }
            "--sarif" => {
                let path = args
                    .get(i + 1)
                    .context("--sarif requires an output file path")?;
                sarif_path = Some(path.clone());
                i += 1;
            }
            _ if arg.starts_with("--sarif=") => {
                sarif_path = Some(arg["--sarif=".len()..].to_string());
            }
            "--benchmark" => {
                let path = args
                    .get(i + 1)
                    .context("usage: second-opinion --benchmark <suite.json>")?;
                benchmark = Some(path.clone());
                i += 1;
            }
            other => bail!(
                "unknown argument '{other}'; use --security, --mode <general|security>, \
                 --style <strict|balanced|blocking-only>, --fail-on <high|medium|low>, \
                 --sarif <file>, or --benchmark <suite.json>"
            ),
        }
        i += 1;
    }
    let mode = match mode {
        Some(mode) => mode,
        None => ReviewMode::from_env()?,
    };
    let style = match style {
        Some(style) => style,
        None => ReviewStyle::from_env()?,
    };
    let fail_on = match fail_on {
        Some(rank) => Some(rank),
        None => match env_value("REVIEW_FAIL_ON") {
            Some(value) => Some(model::parse_severity_threshold(&value)?),
            None => None,
        },
    };
    let sarif_path = sarif_path.or_else(|| env_value("REVIEW_SARIF_FILE"));
    Ok((
        mode,
        style,
        OutputConfig {
            fail_on,
            sarif_path,
        },
        benchmark,
    ))
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let (mode, style, output, benchmark_path) = parse_args(&args)?;
    let provider = Provider::from_env()?;
    let api_key = provider.api_key()?;
    let model = provider.model()?;
    let (passes, threshold) = model::voting_config()?;

    if let Some(path) = benchmark_path {
        return benchmark::run(
            &path,
            provider,
            api_key.as_deref(),
            &model,
            passes,
            threshold,
            mode,
            style,
        );
    }

    let github_token = github::required_env("GITHUB_TOKEN")?;
    let repo = github::required_env("GITHUB_REPOSITORY")?;
    let target = github::detect_review_target()?;
    match &target {
        ReviewTarget::PullRequest { number } => {
            eprintln!(
                "Reviewing {repo}#{number} with {}/{model} ({} mode, {} style, {passes} pass(es), threshold {threshold})",
                provider.name(),
                mode.name(),
                style.name()
            );
        }
        ReviewTarget::Commit { sha, .. } => {
            eprintln!(
                "Reviewing {repo}@{sha} with {}/{model} ({} mode, {} style, {passes} pass(es), threshold {threshold})",
                provider.name(),
                mode.name(),
                style.name()
            );
        }
    }

    run_review(
        &github_token,
        &repo,
        &target,
        provider,
        api_key.as_deref(),
        &model,
        passes,
        threshold,
        mode,
        style,
        &output,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_review(
    github_token: &str,
    repo: &str,
    target: &ReviewTarget,
    provider: Provider,
    api_key: Option<&str>,
    model: &str,
    passes: usize,
    threshold: usize,
    mode: ReviewMode,
    style: ReviewStyle,
    output: &OutputConfig,
) -> Result<()> {
    if let ReviewTarget::Commit { sha, .. } = target {
        if github::commit_has_open_pull(github_token, repo, sha)? {
            eprintln!(
                "Commit {sha} is already the head of an open pull request; skipping push review."
            );
            return Ok(());
        }
    }
    if let ReviewTarget::PullRequest { number } = target {
        if !github::head_is_expected(github_token, repo, *number)? {
            eprintln!(
                "Pull request head changed before review input was loaded; skipping stale job."
            );
            return Ok(());
        }
        if github::review_run_already_posted(github_token, repo, *number)? {
            eprintln!("This pull request revision already has a completed second-opinion review.");
            return Ok(());
        }
    }

    let input = github::load_review_input(github_token, repo, target)?;
    if input.diff.trim().is_empty() {
        eprintln!("Empty diff, nothing to review.");
        return Ok(());
    }
    if let ReviewTarget::PullRequest { number } = target {
        if !github::head_is_expected(github_token, repo, *number)? {
            eprintln!(
                "Pull request head changed while review input was loaded; skipping stale job."
            );
            return Ok(());
        }
    }

    let request = ReviewRequest {
        repo,
        diff: &input.diff,
        context: &input.context,
        rules: &input.rules,
    };
    let mut review = model::run_consensus(
        provider, api_key, model, &request, passes, threshold, mode, style,
    )?;

    // SARIF and the severity gate act on the full consensus findings (the real
    // state of the code), before PR-level dedup drops already-posted ones.
    if let Some(path) = &output.sarif_path {
        let document = sarif::to_sarif(&review, mode);
        std::fs::write(path, serde_json::to_string_pretty(&document)?)
            .with_context(|| format!("writing SARIF report to {path}"))?;
        eprintln!("Wrote SARIF report to {path}");
    }
    let gate_failed = output.fail_on.is_some_and(|min| {
        review
            .findings
            .iter()
            .any(|finding| model::severity_rank(&finding.severity) >= min)
    });

    if let ReviewTarget::PullRequest { number } = target {
        if !github::head_is_expected(github_token, repo, *number)? {
            eprintln!("Pull request head changed during model execution; discarding stale review.");
            return Ok(());
        }
        let existing = match github::existing_fingerprints(github_token, repo, *number) {
            Ok(existing) => existing,
            Err(error) => {
                eprintln!("Could not load existing review fingerprints: {error:#}");
                Default::default()
            }
        };
        let before = review.findings.len();
        review
            .findings
            .retain(|finding| !existing.contains(&github::finding_fingerprint(finding)));
        let skipped = before - review.findings.len();
        if skipped > 0 {
            review.summary.push_str(&format!(
                " {skipped} finding(s) were omitted because they were already posted on this PR."
            ));
        }
        github::post_review(
            github_token,
            repo,
            *number,
            review,
            &input.commentable,
            github::expected_head_sha().as_deref(),
        )?;
        return gate_result(gate_failed, output.fail_on);
    }

    if let ReviewTarget::Commit { sha, .. } = target {
        github::post_commit_review(github_token, repo, sha, review, &input.commentable)?;
    }
    gate_result(gate_failed, output.fail_on)
}

/// Exit nonzero (via an error) when the severity gate tripped, so CI goes red.
fn gate_result(gate_failed: bool, fail_on: Option<u8>) -> Result<()> {
    if gate_failed {
        let level = fail_on.map(severity_name).unwrap_or("configured");
        bail!("second-opinion gate: findings at or above '{level}' severity were reported");
    }
    Ok(())
}

fn severity_name(rank: u8) -> &'static str {
    match rank {
        3 => "high",
        2 => "medium",
        1 => "low",
        _ => "configured",
    }
}
