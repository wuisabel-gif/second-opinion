# Migrating to the hosted GitHub App

Hosted mode is optional. Existing API-key Actions, generic webhooks, and self-hosted deployments
remain supported and use the same normalized review contract and trusted `REVIEW.md` policy.

## Migrate a repository

1. Install the hosted GitHub App and select only the repositories that should be reviewed.
2. Sign in to the hosted dashboard, select the provider/model, and enable reviews.
3. Open or synchronize a test pull request and confirm the App posts a review.
4. Disable the repository's `second-opinion` Actions workflow to avoid duplicate reviews. Keep the
   workflow file in history until the hosted path is verified.
5. Remove `REVIEW_API_KEY` and hosted-only reviewer variables from Actions secrets/variables if no
   other workflow uses them.

The App reads `REVIEW.md` from the pull request's trusted base revision exactly as the Action does.
No policy migration is required.

## Roll back

Re-enable the existing workflow and restore its provider secret, then disable hosted reviews in
the dashboard. After confirming the Action posts reviews, delete hosted service data and uninstall
the App in GitHub. Uninstall revokes GitHub access and deletes installation state; it does not
delete reviews already posted to pull requests.
