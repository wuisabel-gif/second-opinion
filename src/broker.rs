use crate::model::{ReviewOutput, ReviewRequest};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::env;
use std::io::Read;
use std::time::Duration;
use url::Url;

const MAX_OIDC_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_BROKER_RESPONSE_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
struct OidcResponse {
    value: String,
}

pub fn run_review(
    model: &str,
    request: &ReviewRequest<'_>,
    system: &str,
    output_schema: Value,
) -> Result<ReviewOutput> {
    let base_url = required_env("REVIEW_BROKER_URL")?;
    let endpoint = broker_endpoint(&base_url)?;
    let audience = required_env("REVIEW_BROKER_AUDIENCE")?;
    let oidc_token = request_oidc_token(&audience)?;

    let body = json!({
        "task": "pull_request_review",
        "model": model,
        "system": system,
        "repository": request.repo,
        "diff": request.diff,
        "context": request.context,
        "rules": request.rules,
        "output_schema": output_schema,
    });

    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(10))
        .timeout_write(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(15 * 60))
        .build();
    let user_agent = format!("second-opinion/{}", env!("CARGO_PKG_VERSION"));
    let response = agent
        .post(endpoint.as_str())
        .set("Authorization", &format!("Bearer {oidc_token}"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set("User-Agent", &user_agent)
        .set("X-Second-Opinion-Protocol", "1")
        .send_json(body)
        .map_err(|error| sanitized_http_error("credential broker", error))?;
    let bytes = read_limited(
        response,
        MAX_BROKER_RESPONSE_BYTES,
        "credential broker response",
    )?;
    serde_json::from_slice(&bytes).context("credential broker returned an invalid review")
}

fn request_oidc_token(audience: &str) -> Result<String> {
    let request_url = required_env("ACTIONS_ID_TOKEN_REQUEST_URL")
        .context("GitHub OIDC is unavailable; grant the workflow 'id-token: write' permission")?;
    let request_token = required_env("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
        .context("GitHub OIDC is unavailable; grant the workflow 'id-token: write' permission")?;
    let url = oidc_request_url(&request_url, audience)?;

    let response = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(10))
        .build()
        .get(url.as_str())
        .set("Authorization", &format!("Bearer {request_token}"))
        .set("Accept", "application/json")
        .call()
        .map_err(|error| sanitized_http_error("GitHub OIDC", error))?;
    let bytes = read_limited(response, MAX_OIDC_RESPONSE_BYTES, "GitHub OIDC response")?;
    let parsed: OidcResponse =
        serde_json::from_slice(&bytes).context("GitHub OIDC returned invalid JSON")?;
    if parsed.value.trim().is_empty() {
        bail!("GitHub OIDC returned an empty token");
    }
    Ok(parsed.value)
}

fn oidc_request_url(request_url: &str, audience: &str) -> Result<Url> {
    let mut url = Url::parse(request_url).context("invalid GitHub OIDC request URL")?;
    if !url.username().is_empty() || url.password().is_some() {
        bail!("GitHub OIDC request URL must not contain credentials");
    }
    if url.scheme() != "https" && !is_local_http(&url) {
        bail!("GitHub OIDC request URL must use HTTPS");
    }
    url.query_pairs_mut().append_pair("audience", audience);
    Ok(url)
}

fn broker_endpoint(base: &str) -> Result<Url> {
    let mut url = Url::parse(base).context("REVIEW_BROKER_URL is not a valid URL")?;
    if !url.username().is_empty() || url.password().is_some() {
        bail!("REVIEW_BROKER_URL must not contain credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("REVIEW_BROKER_URL must not contain a query string or fragment");
    }
    if url.scheme() != "https" && !is_local_http(&url) {
        bail!("REVIEW_BROKER_URL must use HTTPS (HTTP is allowed only for localhost)");
    }

    let path = url.path().trim_end_matches('/');
    if path.is_empty() {
        url.set_path("/v1/reviews");
    } else if path != "/v1/reviews" {
        url.set_path(&format!("{path}/v1/reviews"));
    }
    Ok(url)
}

fn is_local_http(url: &Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn read_limited(response: ureq::Response, max: usize, label: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("could not read {label}"))?;
    if bytes.len() > max {
        bail!("{label} exceeded {max} bytes");
    }
    Ok(bytes)
}

fn sanitized_http_error(label: &str, error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(code, _) => anyhow::anyhow!("{label} returned HTTP {code}"),
        ureq::Error::Transport(_) => anyhow::anyhow!("{label} request failed"),
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn required_env(name: &str) -> Result<String> {
    non_empty_env(name).with_context(|| format!("{name} not set"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_review_path_to_broker_base() {
        assert_eq!(
            broker_endpoint("https://broker.example").unwrap().as_str(),
            "https://broker.example/v1/reviews"
        );
        assert_eq!(
            broker_endpoint("https://broker.example/api/")
                .unwrap()
                .as_str(),
            "https://broker.example/api/v1/reviews"
        );
    }

    #[test]
    fn preserves_exact_review_endpoint() {
        assert_eq!(
            broker_endpoint("https://broker.example/v1/reviews")
                .unwrap()
                .as_str(),
            "https://broker.example/v1/reviews"
        );
    }

    #[test]
    fn rejects_insecure_remote_broker() {
        assert!(broker_endpoint("http://broker.example").is_err());
        assert!(broker_endpoint("http://localhost:3000").is_ok());
    }

    #[test]
    fn appends_encoded_oidc_audience() {
        let url = oidc_request_url(
            "https://token.actions.githubusercontent.com/request?job=1",
            "https://broker.example/reviews",
        )
        .unwrap();
        let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("job").map(String::as_str), Some("1"));
        assert_eq!(
            query.get("audience").map(String::as_str),
            Some("https://broker.example/reviews")
        );
    }

    #[test]
    fn rejects_insecure_remote_oidc_url() {
        assert!(oidc_request_url("http://example.com/token", "audience").is_err());
        assert!(oidc_request_url("http://127.0.0.1/token", "audience").is_ok());
        assert!(oidc_request_url("https://user@example.com/token", "audience").is_err());
    }
}
