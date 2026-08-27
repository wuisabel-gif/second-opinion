# Webhook starter for second-opinion

This folder contains a minimal webhook implementation you can run as your **single endpoint** for `second-opinion`.

It accepts the payload that `second-opinion` sends when `REVIEW_PROVIDER=webhook`,
runs an optional LLM review, and returns the normalized `{ summary, findings }` response.

## Run it

```bash
cd webhook
node server.mjs
```

Node 18+ is recommended because the server uses the built-in `fetch` API.

## What it expects from second-opinion

`second-opinion` sends a JSON body containing:

- `task` (usually `pull_request_review`)
- `model`
- `system`
- `repository`
- `diff`
- `context`
- `rules`
- `output_schema`

The server currently uses the whole payload for prompt construction, and keeps the
request shape flexible so you can swap in your own provider or routing logic later.

## Environment variables

- `PORT` (optional): listen port (default `3000`)
- `MAX_BODY_BYTES` (optional): request body cap in bytes (default `5242880`).
- `REVIEW_WEBHOOK_TOKEN` (recommended): shared token the webhook validates.
- `REVIEW_AUTH_HEADER` / `REVIEW_AUTH_SCHEME` (optional): mirror the auth header that
  `second-opinion` uses; defaults to `Authorization` and `Bearer`.
- `OPENAI_API_KEY` (optional): if present, the server calls OpenAI Chat Completions.
- `OPENAI_BASE_URL` (optional): default `https://api.openai.com/v1`.
- `OPENAI_MODEL` (optional): model name used for OpenAI calls.
- `LEARNED_PROFILE_PATH` (optional): JSON file path for repo-level memory.

`LEARNED_PROFILE_PATH` format:

```json
{
  "owner/repo": {
    "summary": "Keep PR comments short and explicit.",
    "style": ["no abstractions", "prefer existing utilities"]
  }
}
```

## Minimal endpoint behavior

`POST /` returns a normalized review object:

```json
{
  "summary": "...",
  "findings": [
    {
      "path": "src/main.rs",
      "line": 42,
      "severity": "high",
      "comment": "..."
    }
  ]
}
```

If OpenAI is not configured, it returns an empty-review fallback.

## Deployment idea

- **Railway / Render / Fly / ECS / VPS**: run `node webhook/server.mjs`.
- **Vercel / Cloudflare Pages + Functions**: port logic into their function handler.
- Set GitHub Actions variables/secrets:
  - `REVIEW_ENDPOINT` => your public URL (for example `https://your-service.example/review`)
  - `vars.REVIEW_ENDPOINT` in the repo to auto-switch action into webhook mode
  - `REVIEW_API_KEY` can be repurposed as your webhook auth token when using this endpoint.

## Learnable behavior

To start experimenting with "maintainer behavior", populate `LEARNED_PROFILE_PATH` from
prior PR/maintainer review data in your own pipeline. The sample server includes the
loaded profile text in prompt context when available, so reviewers can bias toward your
team conventions.

If you want to replace the OpenAI backend, edit `callOpenAI()` in `server.mjs` and keep
the `normalizeReview()` return shape unchanged.
