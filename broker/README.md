# Codex subscription broker

The broker lets `second-opinion` use an eligible ChatGPT/Codex subscription without copying
`auth.json` to GitHub-hosted runners. A workflow presents a short-lived GitHub Actions OIDC token;
the broker verifies the exact repository, workflow, event, and trusted ref before running the
official Codex CLI.

```text
pull_request_target workflow
        | GitHub OIDC token (one use)
        v
  Codex broker + PostgreSQL
        | decrypted auth.json in an isolated temporary CODEX_HOME
        v
  official codex exec
        | { summary, findings }
        v
  second-opinion posts the GitHub review
```

This is an advanced self-hosted deployment. It is not an OpenAI API emulator and it does not turn
a ChatGPT login into a general-purpose bearer token. Review OpenAI's current subscription terms and
automation guidance before operating it.

## Security model

- The GitHub runner never receives the Codex credential.
- GitHub's JWT signature, issuer, audience, expiry, and required claims are verified against the
  official OIDC JWKS.
- Repository ID, workflow path/ref, event name, and base ref must exactly match an enrollment.
- Every OIDC `jti` is accepted once; replay IDs and per-repository rate limits are transactional.
- Codex credentials use AES-256-GCM with credential/version-bound associated data.
- Use of one credential is serialized because Codex refresh tokens rotate.
- Codex runs in a fresh temporary home/workspace with host environment secrets removed, approval
  disabled, read-only sandboxing, user config/rules ignored, and tool/plugin/web surfaces disabled.
- Request, output, queue, concurrency, timeout, and model allowlists are bounded.
- The service returns sanitized errors and never logs JWTs, prompts, diffs, model output, or auth.

The broker still sees repository diffs and sends them to OpenAI. Run it only on infrastructure you
trust. Put it behind HTTPS and a reverse proxy; plain HTTP is accepted by the Action only for
localhost development.

## Requirements

- A host with Docker and Docker Compose
- HTTPS endpoint for the broker
- An eligible ChatGPT account that can use the official Codex CLI
- Permission to configure Actions variables and the workflow in each enrolled repository

## 1. Log in with the official Codex CLI

On a trusted operator workstation:

```bash
npm install --global @openai/codex@0.147.0
codex login
codex login status
```

This creates `~/.codex/auth.json`. Never commit, upload, print, or paste that file into an issue.

## 2. Configure and start the broker

```bash
cp broker/.env.example broker/.env
openssl rand -base64 32       # use as BROKER_MASTER_KEY
openssl rand -base64 36       # use as POSTGRES_PASSWORD
```

Set `BROKER_OIDC_AUDIENCE` to a stable identifier owned by this deployment, normally its HTTPS URL.
The workflow must request the exact same string. Then:

```bash
docker compose --env-file broker/.env -f broker/compose.yaml up -d --build
curl https://reviews.example.com/readyz
```

Terminate TLS at Caddy, nginx, a cloud load balancer, or equivalent and proxy to
`127.0.0.1:3000`. Do not expose PostgreSQL.

## 3. Enroll the Codex login

Stream the auth file over stdin so it is not copied into the repository or image:

```bash
docker compose --env-file broker/.env -f broker/compose.yaml run --rm -T broker \
  npm run admin -- enroll --label primary --auth-file - < "$HOME/.codex/auth.json"
```

The command returns a `credential_id`. The plaintext buffer is cleared after encryption; only the
AES-GCM record is stored in PostgreSQL.

## 4. Register a repository identity

Get the immutable numeric repository ID:

```bash
gh api repos/OWNER/REPO --jq .id
```

Register the exact trusted workflow identity (replace all placeholders):

```bash
docker compose --env-file broker/.env -f broker/compose.yaml run --rm broker \
  npm run admin -- register \
  --repository OWNER/REPO \
  --repository-id REPOSITORY_ID \
  --credential-id CREDENTIAL_UUID \
  --workflow-ref OWNER/REPO/.github/workflows/review.yml@refs/heads/main \
  --ref refs/heads/main \
  --event-name pull_request_target
```

If the workflow is reusable, also pin the exact `--job-workflow-ref` claim. List registrations with
`npm run admin -- list`; use `disable` or `enable` for an emergency stop.

## 5. Configure the repository workflow

Grant OIDC only to the review job and select the broker provider:

```yaml
permissions:
  contents: read
  id-token: write
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: wuisabel-gif/second-opinion@v0.4.0
        with:
          provider: codex-broker
          broker-url: https://reviews.example.com
          broker-audience: https://reviews.example.com/second-opinion
          model: gpt-5.6-sol
```

No `REVIEW_API_KEY`, `OPENAI_API_KEY`, or `CODEX_AUTH_JSON` repository secret is needed.

## Key rotation

Use a versioned keyring to rotate encryption without downtime:

```bash
export BROKER_MASTER_KEYS='{"1":"OLD_BASE64_KEY","2":"NEW_BASE64_KEY"}'
export BROKER_ACTIVE_KEY_VERSION=2
npm run admin -- rotate-keys
```

Keep old keys available until every record has been rotated and verified. Back up PostgreSQL and
the keyring separately. Losing every applicable master key permanently loses the enrolled login.

Codex may rotate its refresh token during a review. The broker persists the updated `auth.json`
under the credential lock before returning the result. If the account is revoked or expires, run
`codex login` again and enroll the replacement credential, then update repository registrations.

## Operations

- `GET /healthz` checks the process.
- `GET /readyz` checks PostgreSQL connectivity.
- `POST /v1/reviews` is the OIDC-authenticated protocol endpoint.
- Set reverse-proxy body and request timeouts at least as high as broker limits.
- Alert on `upstream_failed`, `queue_full`, database readiness, and repeated authorization failures.
- Keep core dumps and request-body logging disabled.
- Upgrade the pinned Codex version deliberately; verify every strict `--disable` feature against
  `codex features list` and run the integration tests first.

## Local development

```bash
cd broker
npm ci
npm run check
npm test
```

Unit/integration tests use mocked OIDC, database, and Codex boundaries and do not need credentials.
The root Rust tests cover the Action-side OIDC client. A real subscription smoke test can be run
with the benchmark harness described in the root README.
