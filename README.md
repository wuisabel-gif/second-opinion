# second-opinion

> **Change the agent, not the reviewer.**

An agent-agnostic AI code reviewer, written in Rust and packaged as a reusable GitHub Action. It supports native Anthropic and OpenAI APIs, OpenAI-compatible services, direct or brokered Codex subscription login, and an HTTP webhook contract for any other hosted or local AI agent.

## Install

1. Copy [`examples/review.yml`](examples/review.yml) to `.github/workflows/review.yml` in the repository you want to review.
2. Add the selected credential: `REVIEW_API_KEY` for API providers, `CODEX_AUTH_JSON` for direct Codex mode, or enroll the repository with a Codex broker so no model credential is stored in GitHub.
3. Set `REVIEW_PROVIDER` and any adapter-specific values as repository Actions variables. Setting `REVIEW_BROKER_URL` automatically selects broker mode in the example workflow.
4. Open or update a pull request.

The reusable action can also be added directly:

```yaml
- name: Review pull request
  uses: wuisabel-gif/second-opinion@v0.4.0
  with:
    api-key: ${{ secrets.REVIEW_API_KEY }}
    provider: ${{ vars.REVIEW_PROVIDER || 'anthropic' }}
    model: ${{ vars.REVIEW_MODEL }}
```

Pinning a full commit SHA instead of a release tag provides the strongest supply-chain protection. The installation workflow uses `pull_request_target` but never checks out or executes the pull request head; it treats the fetched diff only as review input.

### Optional hosted GitHub App

The repository also includes a deployable private-alpha hosted service for one-click GitHub App
installation and service-owned provider credentials. It verifies signed `pull_request` webhooks,
enforces per-installation quotas and idempotency, creates repository-scoped installation tokens,
and invokes the same reviewer and normalized output contract. It can route reviews through the
Codex broker, so App users add no repository API key or `auth.json`. Existing Action and self-hosted
paths remain unchanged.

Start with [`hosted/README.md`](hosted/README.md). The
[`architecture and threat model`](docs/hosted-service.md),
[`privacy and retention policy`](docs/privacy.md), and
[`migration guide`](docs/hosted-migration.md) define the alpha boundaries and public-launch gates.

## How it works

1. The workflow triggers on `pull_request_target` events and runs the trusted, versioned reviewer action.
2. The binary fetches the unified diff, changed-file contents, and direct imports from the pull request's head revision. Context is byte-bounded and binary files are skipped.
3. It loads `REVIEW.md` from the trusted base revision, so a pull request cannot alter its own review rules.
4. It runs the configured number of independent review passes. When voting is enabled, only findings reported at the same file and line by the configured threshold survive.
5. It removes findings already posted by this action on earlier pushes, then validates remaining line anchors against the diff.
6. Valid findings become line comments. Findings outside the diff or comment limit are included in the summary, and a rejected batch falls back without losing findings.

## v0.2 features

- **Consensus reviews:** set `REVIEW_PASSES` from 1 to 7. `REVIEW_VOTE_THRESHOLD` defaults to a strict majority.
- **Cross-push deduplication:** inline comments contain stable, hidden location fingerprints that suppress repeat comments on later pushes.
- **Repository context:** changed text files and resolvable direct Rust, JavaScript/TypeScript, and Python imports are sent with the diff under a configurable byte budget.
- **Trusted rules:** a root-level `REVIEW.md` on the base branch is appended as review policy.
- **Benchmarks:** JSON suites replay known diffs and report location-level precision and recall.

Multiple passes increase model usage proportionally, so the default remains one pass. For majority voting, start with `REVIEW_PASSES=3`; the default threshold will be 2.

## Review rules

Add `REVIEW.md` to the repository's default branch to define project-specific review policy:

```markdown
# Review policy

- Treat authentication and authorization regressions as high severity.
- Ignore generated files under `src/generated/`.
- Database migrations must be backward compatible.
- Control code growth: prefer deletion or extension of existing code over new abstractions.
  Add a new file, function, or dependency only when it clearly reduces duplication,
  improves correctness/clarity, or is required for a concrete need; avoid speculative
  scaffolding.
```

## Provider setup

Choose an adapter and add its credential under Settings, Secrets and variables, Actions. API providers use `REVIEW_API_KEY`; direct Codex mode uses `CODEX_AUTH_JSON`; a local unauthenticated service, webhook, or Codex broker may need neither. `REVIEW_PROVIDER` defaults to `anthropic`; other adapters require it explicitly. The `GITHUB_TOKEN` is supplied automatically. The example workflow grants `contents: read`, `pull-requests: write`, and `id-token: write`; the last permission only lets broker mode request a short-lived GitHub OIDC identity token.

| Adapter | `REVIEW_PROVIDER` | Required configuration | Typical services |
|---|---|---|---|
| Anthropic Messages | `anthropic` | `REVIEW_API_KEY`; optional `REVIEW_MODEL` | Claude |
| OpenAI Responses | `openai` or `openai-responses` | `REVIEW_API_KEY`; optional `REVIEW_MODEL` | OpenAI GPT models |
| OpenAI-compatible Chat Completions | `openai-compatible` | `REVIEW_BASE_URL`, `REVIEW_MODEL`; API key when required | OpenRouter, Groq, Mistral, xAI, DeepSeek, Ollama, LM Studio, and compatible gateways |
| Direct Codex subscription | `codex` | `CODEX_AUTH_JSON`; optional `REVIEW_MODEL` | Official Codex CLI on the Actions runner |
| Codex subscription broker | `codex-broker` | `REVIEW_BROKER_URL`, `REVIEW_BROKER_AUDIENCE`; optional `REVIEW_MODEL` | Official Codex CLI using broker-held ChatGPT auth |
| Generic webhook | `webhook` | `REVIEW_ENDPOINT`; optional `REVIEW_API_KEY` and `REVIEW_MODEL` | Any agent exposed through an HTTP adapter |

To run it by hand against any PR:

```bash
GITHUB_TOKEN=ghp_... ANTHROPIC_API_KEY=sk-ant-... \
GITHUB_REPOSITORY=owner/repo PR_NUMBER=42 \
cargo run --release
```

Or run with OpenAI:

```bash
GITHUB_TOKEN=ghp_... OPENAI_API_KEY=sk-... \
GITHUB_REPOSITORY=owner/repo PR_NUMBER=42 \
REVIEW_PROVIDER=openai cargo run --release
```

Run an OpenAI-compatible local or hosted model:

```bash
GITHUB_TOKEN=ghp_... REVIEW_API_KEY=provider-key \
GITHUB_REPOSITORY=owner/repo PR_NUMBER=42 \
REVIEW_PROVIDER=openai-compatible \
REVIEW_BASE_URL=https://provider.example/v1 REVIEW_MODEL=provider-model \
cargo run --release
```

## Universal webhook contract

Use `REVIEW_PROVIDER=webhook` for an agent that does not implement an OpenAI-compatible API. The reviewer sends a JSON object containing:

```json
{
  "task": "pull_request_review",
  "model": "optional-model-name",
  "system": "review instructions",
  "repository": "owner/repo",
  "diff": "unified diff",
  "context": "changed files and direct imports",
  "rules": "trusted REVIEW.md contents",
  "output_schema": { "type": "object" }
}
```

The webhook should return the normalized review directly:

```json
{
  "summary": "One-paragraph summary",
  "findings": [
    {
      "path": "src/example.rs",
      "line": 42,
      "severity": "high",
      "comment": "Problem and suggested fix"
    }
  ]
}
```

Responses wrapped in `review`, `output`, `result`, or `data` are also accepted, including JSON encoded as a string. For any other response shape, set `REVIEW_RESPONSE_JSON_POINTER` to the JSON Pointer locating the normalized review.

## Configuration

- `REVIEW_PROVIDER`: `anthropic`, `openai-responses`, `openai-compatible`, `codex`, `codex-broker`, or `webhook`. Aliases include `claude`, `openai`, `openai-chat`, `chat-completions`, `codex-cli`, `chatgpt-subscription`, `codex-subscription` (broker), and `custom`.
- `REVIEW_MODEL`: provider-specific model. It defaults to `claude-sonnet-4-6` for Anthropic and `gpt-5.6-sol` for OpenAI Responses; it is required for OpenAI-compatible services and optional for webhooks.
- `REVIEW_API_KEY`: provider credential used by the supplied GitHub Actions workflow.
- `ANTHROPIC_API_KEY`: backward-compatible alternative to `REVIEW_API_KEY` for local Anthropic runs.
- `OPENAI_API_KEY`: backward-compatible alternative to `REVIEW_API_KEY` for local OpenAI and OpenAI-compatible runs.
- `REVIEW_BASE_URL`: base URL for OpenAI-compatible APIs. It falls back to `OPENAI_BASE_URL`, then `https://api.openai.com/v1`.
- `REVIEW_ENDPOINT`: exact URL for the generic webhook adapter.
- `CODEX_AUTH_JSON`: base64-encoded ChatGPT-mode Codex `auth.json`, required only for direct `codex` mode.
- `CODEX_BIN`: Codex executable override; defaults to `codex`.
- `REVIEW_CODEX_TIMEOUT_SECONDS`: direct Codex timeout, from 10 to 3600 seconds; defaults to 900.
- `REVIEW_BROKER_URL`: HTTPS base URL for the Codex subscription broker. Plain HTTP is accepted only for localhost development.
- `REVIEW_BROKER_AUDIENCE`: deployment-specific audience placed in the GitHub Actions OIDC token. It is required in broker mode and must exactly match the broker configuration.
- `REVIEW_AUTH_HEADER`: credential header for OpenAI-compatible and webhook requests; defaults to `Authorization`.
- `REVIEW_AUTH_SCHEME`: credential prefix; defaults to `Bearer`. Set it to `none` for raw-key headers such as `api-key`.
- `REVIEW_RESPONSE_JSON_POINTER`: optional RFC 6901 JSON Pointer for extracting a normalized review from a custom webhook response.
- `REVIEW_PASSES`: independent model calls per review, from 1 to 7; defaults to `1`.
- `REVIEW_VOTE_THRESHOLD`: passes that must report the same path and line; defaults to a strict majority.
- `REVIEW_CONTEXT_BYTES`: repository-context budget; defaults to `60000`, `0` disables context fetching, and the hard maximum is `1000000`.
- `REVIEW_BOT_LOGIN`: only this author's hidden fingerprints are trusted for deduplication; defaults to `github-actions[bot]`.
- Diff and line-comment limits are bounded internally to control request and GitHub API sizes.

## Direct Codex subscription mode

Direct mode satisfies issue #6 with the official Codex CLI and no OpenAI API key. Log in once on
a trusted machine, then save the base64-encoded login as a GitHub Actions secret:

```bash
npm install --global @openai/codex@0.147.0
codex login
codex login status

# macOS
base64 -i "$HOME/.codex/auth.json" | pbcopy
# GNU/Linux
base64 -w 0 "$HOME/.codex/auth.json"
```

Create the repository secret `CODEX_AUTH_JSON`, then configure the Action:

```yaml
concurrency:
  group: second-opinion-codex
  cancel-in-progress: false

steps:
  - uses: wuisabel-gif/second-opinion@v0.4.0
    with:
      provider: codex
      codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}
      model: gpt-5.6-sol
```

The Action installs a pinned official CLI, validates that the decoded file is ChatGPT-mode auth,
and writes it to a fresh private `CODEX_HOME` outside the repository. Codex runs ephemeral with a
read-only sandbox, no approvals, user config/rules ignored, host secrets removed, and tool/plugin,
browser, shell, image, memory, and multi-agent features disabled. Only the schema-constrained final
JSON message is read.

**Rotation limitation:** Codex refresh tokens can rotate. A GitHub secret cannot be updated by the
normal job token, so direct mode can eventually require another `codex login` and secret update.
Serialize runs with `concurrency` to avoid two jobs using the same refresh chain. Reviews consume
the ChatGPT plan's Codex allowance. For persistent token rotation and multiple repositories, use
the broker instead.

## Codex subscription broker

`REVIEW_PROVIDER=codex-broker` uses ChatGPT-managed Codex access without placing
`auth.json` on a GitHub runner. The action requests a short-lived GitHub Actions OIDC token,
sends the normalized review payload to the broker, and receives only `{ summary, findings }`.
The broker verifies the repository and workflow identity, keeps the rotating Codex credential
encrypted at rest, serializes use of each credential, and runs Codex with model-generated tools
disabled in an isolated worker.

```yaml
permissions:
  contents: read
  id-token: write
  pull-requests: write

steps:
  - uses: wuisabel-gif/second-opinion@v0.4.0
    with:
      provider: codex-broker
      broker-url: ${{ vars.REVIEW_BROKER_URL }}
      broker-audience: ${{ vars.REVIEW_BROKER_AUDIENCE }}
```

See [`broker/README.md`](broker/README.md) for Docker/VPS deployment, credential enrollment,
repository registration, HTTPS, rotation, and the threat model.

OpenAI recommends API keys for ordinary automation and documents account-backed `auth.json`
CI as an advanced pattern for trusted private infrastructure. The broker architecture keeps that
credential off public GitHub runners, but operators must still review OpenAI's current terms and
guidance before enabling subscription-backed automation.

Generic webhook mode remains available when another service should perform the model call:

```yaml
with:
  provider: webhook
  endpoint: ${{ vars.REVIEW_ENDPOINT }}
  api-key: ${{ secrets.REVIEW_API_KEY }}
```

## Pullfrog starter

This repo now includes `.github/workflows/pullfrog.yml` for manual Pullfrog runs.
It defaults to `.github/pullfrog/review.md`, which tells Pullfrog to review changes
against this repo's `REVIEW.md` policy and to keep code growth in check.

To use automated Pullfrog triggers, install the Pullfrog GitHub App and configure
the trigger in the Pullfrog dashboard. The repo-side workflow is still useful for
ad hoc manual runs from the Actions tab.

## Benchmarking

Create a suite using [`benchmarks/example.json`](benchmarks/example.json), then run it with any configured provider:

```bash
REVIEW_PROVIDER=openai OPENAI_API_KEY=sk-... \
cargo run --release -- --benchmark benchmarks/example.json
```

Each expected finding is matched by `path` and new-side `line`. The runner prints aggregate precision and recall as JSON, making it suitable for comparing providers, prompts, vote thresholds, and future releases.

## License

Licensed under the [MIT License](LICENSE).
