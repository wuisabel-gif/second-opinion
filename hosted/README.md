# Hosted service

This directory contains the first deployable control plane for the optional hosted
`second-opinion` reviewer. It receives GitHub App webhooks, creates a repository-scoped
installation token, and runs the existing Rust reviewer with service-owned model credentials or
the separately deployed Codex subscription broker.
The self-hosted Action and generic webhook remain unchanged.

The implementation is deliberately dependency-free and suitable for a single-instance private
alpha. Read [`../docs/hosted-service.md`](../docs/hosted-service.md) before deploying it. Public
signup requires the production gates listed there, including a transactional shared datastore,
distributed rate limiting, payment enforcement, legal review, and operational monitoring.

The alpha uses two layers of idempotency: signed delivery IDs and a durable bot-authored run marker
on the GitHub review. Interrupted jobs can therefore be requeued without repeating a completed
model call/review, and queue admission is reserved before monthly quota is charged.

## GitHub App

1. Create one service-owned GitHub App under the operator's GitHub settings.
2. Use [`github-app-manifest.json`](github-app-manifest.json) as the versioned source of truth for
   its URLs, permissions, event subscription, and OAuth-on-install settings, replacing
   `https://second-opinion.example` with the deployment URL.
3. Generate a client secret, private key, and high-entropy webhook secret, then save them with the
   App and client IDs in the service's secret manager.
4. Build the reviewer with `cargo build --release` and expose the resulting binary to the service.

The hosted service has one centrally operated App that customers install. The JSON file is not a
public per-customer App Manifest registration flow, and the service intentionally does not expose
GitHub's one-time manifest code-conversion endpoint or App private credentials.

The manifest requests only `contents: read`, `metadata: read`, and `pull_requests: write`.
It subscribes to `pull_request`; installation lifecycle events are delivered automatically.
`pull_request_review` is intentionally omitted because the service does not consume it.
OAuth-on-install is disabled so the service always starts authorization at `/login`, where it can
create and validate OAuth state and PKCE. The post-install setup URL returns that session to the
dashboard.

## Configuration

Required environment variables:

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | External HTTPS origin, without a path |
| `SESSION_SECRET` | At least 32 random bytes for flow signing and token encryption |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_SLUG` | Public App slug used for the installation link |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub App user authorization |
| `GITHUB_PRIVATE_KEY` | PEM private key; literal `\n` sequences are accepted |
| `GITHUB_WEBHOOK_SECRET` | High-entropy webhook signing secret |
| `GITHUB_BOT_LOGIN` | App comment author, such as `second-opinion-hosted[bot]` |
| `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` | Service-owned provider credential |
| `CODEX_BROKER_URL` / `CODEX_BROKER_TOKEN` | Optional internal Codex subscription backend; configure both |

Optional variables:

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | Local listen port |
| `HOST` | `127.0.0.1` | Listen address; the container sets `0.0.0.0` |
| `HOSTED_STATE_PATH` | `./hosted-state.json` | Private persistent state file |
| `REVIEWER_BINARY` | `second-opinion` | Compiled reviewer executable |
| `HOSTED_MONTHLY_REVIEW_LIMIT` | `25` | Hard per-installation monthly cap |
| `HOSTED_RATE_LIMIT_PER_MINUTE` | `10` | Per-installation webhook burst cap |
| `HOSTED_WORKERS` | `2` | Concurrent review processes |
| `HOSTED_MAX_QUEUE` | `100` | Maximum pending reviews before fail-closed backpressure |
| `HOSTED_REVIEW_TIMEOUT_SECONDS` | `1200` | Hard reviewer child timeout |
| `HOSTED_OPENAI_MODELS` | `gpt-5.6-sol` | Comma-separated offered models |
| `HOSTED_ANTHROPIC_MODELS` | `claude-sonnet-4-6` | Comma-separated offered models |
| `HOSTED_CODEX_MODELS` | `gpt-5.6-sol` | Models offered through the Codex broker |

Terminate TLS at a reverse proxy and forward only to `127.0.0.1`. The state file contains
encrypted short-lived GitHub user tokens and must live on an encrypted persistent volume with
mode `0600`. Do not use `ALLOW_INSECURE_HTTP=true` outside local development.

For subscription-backed reviews, deploy [`../broker`](../broker), set its independent
`BROKER_SERVICE_TOKEN`, and copy only that token into `CODEX_BROKER_TOKEN`. The hosted worker calls
the broker's internal endpoint; it never receives `auth.json`. Set the broker's
`BROKER_DEFAULT_CREDENTIAL_ID` to auto-enroll repositories after their first authenticated hosted
request, or enroll them explicitly for tighter operator control. The dashboard then offers
`codex-broker` as a provider, while users add no Actions secret or provider credential.

## Container image

From the repository root:

```bash
docker build -f hosted/Dockerfile -t second-opinion-hosted .
docker run --rm --env-file hosted/.env -p 127.0.0.1:3001:3000 \
  -v second-opinion-hosted:/data second-opinion-hosted
```

Copy `hosted/.env.example` to `hosted/.env`, replace every placeholder, and keep it outside source
control. Terminate HTTPS at a reverse proxy before exposing the service.
Give the container at least a 30-second termination grace period. Shutdown closes webhook intake,
preserves pending jobs for restart, terminates active reviewer process groups, and waits for workers
to drain.

## Run and test

```bash
cargo build --release
node --test hosted/server.test.mjs
REVIEWER_BINARY="$PWD/target/release/second-opinion" node hosted/server.mjs
```

The dashboard is available at `/dashboard`, OAuth begins at `/login`, GitHub sends webhooks to
`/github/webhooks`, and `/health` is the unauthenticated health check.
