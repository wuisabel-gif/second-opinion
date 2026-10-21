use crate::model::{ReviewMode, ReviewOutput};
use serde_json::{json, Value};

const INFO_URI: &str = "https://github.com/wuisabel-gif/second-opinion";

/// Build a SARIF 2.1.0 document from a review so findings can be uploaded to
/// GitHub code scanning and appear in the repository Security tab.
pub fn to_sarif(review: &ReviewOutput, mode: ReviewMode) -> Value {
    let results: Vec<Value> = review
        .findings
        .iter()
        .map(|finding| {
            json!({
                "ruleId": rule_id(&finding.comment, mode),
                "level": level(&finding.severity),
                "message": { "text": finding.comment },
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": { "uri": finding.path },
                        "region": { "startLine": finding.line.max(1) }
                    }
                }]
            })
        })
        .collect();

    json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": { "driver": {
                "name": "second-opinion",
                "informationUri": INFO_URI,
                "rules": []
            }},
            "results": results
        }]
    })
}

/// SARIF severity level. high -> error, medium -> warning, everything else -> note.
fn level(severity: &str) -> &'static str {
    match severity.trim().to_ascii_lowercase().as_str() {
        "high" => "error",
        "medium" => "warning",
        _ => "note",
    }
}

/// Use the `[Category]` prefix the security prompt emits as the ruleId (e.g.
/// `security/sql-injection`); fall back to `<mode>/finding`.
fn rule_id(comment: &str, mode: ReviewMode) -> String {
    if let Some(rest) = comment.trim_start().strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let slug = slug(rest[..end].trim());
            if !slug.is_empty() {
                return format!("{}/{slug}", mode.name());
            }
        }
    }
    format!("{}/finding", mode.name())
}

fn slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_dash = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Finding;

    fn finding(severity: &str, comment: &str) -> Finding {
        Finding {
            path: "app/db.php".to_string(),
            line: 12,
            severity: severity.to_string(),
            comment: comment.to_string(),
        }
    }

    #[test]
    fn maps_severity_and_category() {
        let review = ReviewOutput {
            summary: "s".into(),
            findings: vec![
                finding(
                    "high",
                    "[SQL Injection] id is concatenated. Fix: parameterize.",
                ),
                finding("low", "no category here"),
            ],
        };
        let sarif = to_sarif(&review, ReviewMode::Security);
        assert_eq!(sarif["version"], "2.1.0");
        let results = sarif["runs"][0]["results"].as_array().unwrap();
        assert_eq!(results[0]["level"], "error");
        assert_eq!(results[0]["ruleId"], "security/sql-injection");
        assert_eq!(
            results[0]["locations"][0]["physicalLocation"]["region"]["startLine"],
            12
        );
        assert_eq!(results[1]["level"], "note");
        assert_eq!(results[1]["ruleId"], "security/finding");
    }
}
