# Hosted service privacy and retention

Last updated: 2026-09-06. This draft applies to the private-alpha hosted service and must receive
legal and operator review before public launch.

## Data processed

The service processes GitHub account and installation identifiers, selected repository metadata,
pull request numbers and commit SHAs, pull request diffs, selected text-file context, trusted
`REVIEW.md` rules, generated summaries/findings, encrypted GitHub user access tokens, review job
status, and monthly usage counts. It also receives standard HTTP metadata needed for security and
operations.

Provider credentials and GitHub App private credentials belong to the service. They are not user
data and are never exposed to repositories or browser clients.

## Purpose and sharing

Repository content is used only to generate and post the requested review, prevent duplicate
reviews, enforce quotas, secure the service, and diagnose aggregate service health. Diff, context,
rules, and generated review content are sent to the model provider selected in the dashboard.
GitHub receives the resulting review. No repository content is sold or used to train a separate
model by this service.

Before launch, the operator must publish the enabled model providers, their regions and retention
terms, and any infrastructure subprocessors. Providers must be configured for the shortest
available retention and with model training disabled where the provider offers those controls.

## Retention

- Diffs, file context, rules, model prompts, and generated review text remain in process memory
  only for the review and are not written to service state or application logs.
- Job keys, repository IDs, pull request numbers, head SHAs, status, and timestamps are retained
  for at most 30 days for deduplication and reliability.
- Monthly usage counters are deleted after their calendar month is no longer current.
- Encrypted GitHub user tokens and sessions expire after eight hours.
- Installation settings persist until deletion or App uninstall.
- Security logs must contain metadata only and use an operator-defined short retention published
  before launch. Core dumps and request-body capture must be disabled.

Model providers and infrastructure systems may have independent transient retention. Those terms
must be disclosed before public signup.

## Access, deletion, and revocation

The dashboard's **Delete service data** action deletes installation settings, usage, and review job
records. Uninstalling the GitHub App revokes repository access and its signed `installation.deleted`
event performs the same deletion. Users should uninstall through GitHub after dashboard deletion
to revoke the App itself.

The production service must provide a support contact and a verified export/deletion process.
Backups must carry deletion markers and age out within a published period.

## Security

Data is encrypted in transit. OAuth tokens are encrypted at rest, access is least-privileged, and
service credentials are stored outside source control. The architecture and threat model are in
[`hosted-service.md`](hosted-service.md). A public launch requires incident-response and breach
notification procedures.
