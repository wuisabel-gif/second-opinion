# Hosted service architecture

## Decision

Status: accepted for private alpha.

`second-opinion` will support a GitHub App driven hosted mode without replacing the existing
Action, webhook, or self-hosted paths. The hosted service owns provider credentials and model
costs. The first version uses a free plan with a hard per-installation monthly review cap. It does
not advertise or activate a paid plan until payment state can be enforced transactionally.

This is preferable to accepting a client-selected paid plan without verified payment, and it
keeps the first billing invariant simple: no installation can create more than the configured
number of review attempts in a calendar month. A paid launch should use per-installation monthly
subscriptions with included reviews and no automatic overage. Metered overage can be added only
after cost alerts and customer-visible usage records exist.

## Components and data flow

1. A repository owner installs the GitHub App on selected repositories and authorizes the App's
   OAuth flow. Authorization always starts at the service's `/login` endpoint so state and PKCE are
   initialized before GitHub receives the request.
2. The dashboard obtains the user's accessible App installations from GitHub. Settings changes
   require current GitHub access, the installer identity recorded by GitHub's signed installation
   event, and a same-origin CSRF token.
3. GitHub sends a `pull_request` webhook. The service checks the HMAC-SHA256 signature over the
   unmodified bytes before parsing JSON.
4. The service rejects unsupported actions and drafts, applies the per-installation burst limit,
   then reserves the `(installation, repository, pull request, head SHA)` idempotency key and one
   monthly quota unit in persistent state. A global pending-work cap returns `503` backpressure
   before accepting more work.
5. A worker creates a one-hour installation token restricted to the event repository and to
   `contents: read` plus `pull_requests: write`. It verifies the current head SHA before starting.
6. The existing Rust binary fetches the diff, repository context, and trusted base `REVIEW.md`;
   verifies the expected head before model execution and again before posting; invokes the
   configured provider; normalizes `{ summary, findings }`; and posts the review with GitHub's
   `commit_id` set to the reviewed head SHA.
7. The worker records only job status and timestamps. Pull request content and model responses are
   not written to service state or application logs.

Webhook delivery IDs alone are not the idempotency boundary because GitHub may legitimately emit
multiple deliveries for one revision. The head-SHA key prevents duplicate model spend and reviews.
A failed attempt may be retried, while queued, running, and successful attempts are deduplicated.

## Authentication and credential boundaries

- Webhooks use `X-Hub-Signature-256` and constant-time comparison.
- Review workers use short-lived installation tokens, scoped to one repository when minted.
- Onboarding uses GitHub App OAuth with state and PKCE. Flow cookies and session cookies are
  `Secure`, `HttpOnly`, and `SameSite=Lax`; mutating requests also require an exact allowed origin
  and per-session CSRF token.
- OAuth user tokens are encrypted at rest and expire with the eight-hour local session.
- A signed `github_app_authorization.revoked` event immediately deletes every local session for
  that GitHub user.
- Dashboard disable, App suspension, uninstall, and dashboard deletion terminate active reviewer
  processes and stop queued work. Suspension preserves settings and usage while pausing reviews;
  uninstall and explicit deletion remove the installation's stored state.
- Provider keys are read only in the server process and passed to the trusted reviewer child. The
  child receives an allowlisted environment rather than all service secrets.
- Provider credentials, OAuth tokens, installation tokens, webhook bodies, diffs, and model output
  must never be included in logs, analytics, browser responses, or support exports.

The webhook path is the sole review trigger in this version. Actions-originated OIDC requests are
not accepted; adding them would require audience validation, repository/ref claims, replay
protection, and an equivalent quota reservation before work starts.

## Persistence and operations

The reference service atomically replaces a mode-`0600` JSON state file and serializes mutations
inside one process. It stores installation settings, monthly counters, encrypted user sessions,
and job status. Jobs expire after 30 days, usage buckets after the month changes, and sessions
after eight hours. At startup, interrupted running jobs are transactionally returned to the queue.
Reviewer children have a hard deadline and are terminated with `SIGTERM`, followed by `SIGKILL`
after a configurable grace period.

This is intentionally a single-instance alpha design. Before public signup:

- replace the file with a transactional datastore and reserve idempotency plus quota in one row
  transaction;
- use a durable queue with leases, bounded retries, and a dead-letter path;
- move burst limits to a shared store and add account, installation, IP, and global spend limits;
- enforce payment-provider webhooks before changing a plan and reconcile usage to provider bills;
- add encrypted backups, secret rotation, audit events, alerts, and deletion verification;
- run workers in an isolated runtime with egress restricted to GitHub and approved model APIs;
- publish and obtain legal review of the privacy and retention terms.

## Threat model

| Threat | Control | Residual risk / production gate |
|---|---|---|
| Forged or modified webhook | HMAC over raw bytes; reject before JSON parsing | Rotate leaked webhook secrets |
| Duplicate delivery and cost amplification | Head-SHA idempotency, quota reservation, burst limit | Shared transactional controls before horizontal scaling |
| Prompt injection in a diff | Existing prompt marks diff/context untrusted; trusted policy comes from base | Models can still fail; do not grant worker privileges beyond review posting |
| Provider-key disclosure | Server-only secret, allowlisted child environment, no payload logging | Isolate workers and scan logs/support tooling |
| Installation-token abuse | One-hour GitHub token restricted to one repository and minimal permissions | Compromised worker can act until expiry |
| Cross-site settings mutation | OAuth state/PKCE, SameSite cookies, exact-origin and CSRF checks | XSS would bypass CSRF; keep dashboard CSP strict |
| Unauthorized installation management | Every API read/write rechecks `/user/installations` | Organization policy and SAML can affect visibility |
| Malicious oversized payload | 2 MiB webhook limit; reviewer has independent diff/context limits | Reverse proxy must also impose body and timeout limits |
| Runaway spend | Hard monthly quota, per-minute limit, bounded workers | Add global/provider budget circuit breakers before launch |
| Repository data retention | Diff remains in process memory only; metadata expires | Provider processing and crash dumps remain subprocessors/data paths |

## GitHub App permissions

`contents: read` is required for changed-file context and trusted base-branch `REVIEW.md`.
`pull_requests: write` includes reading pull request metadata/diffs and posting reviews.
`metadata: read` is GitHub's baseline repository metadata permission. No issues, checks, Actions,
administration, members, or secrets permission is requested.

The service subscribes only to `pull_request`; installation lifecycle events are supplied to Apps
and are used for deletion. It does not subscribe to `pull_request_review` because it never consumes
that event. Adding an unused event would violate the minimum-access goal.

## Deliberate exclusions

- The service does not execute pull request code or check out the pull request head.
- The service does not copy provider credentials into repository or Actions secrets.
- The service does not retain review text or diffs for analytics or model training.
- The alpha has no paid checkout, seats, overages, organization-wide default access, or public
  signup promise.
