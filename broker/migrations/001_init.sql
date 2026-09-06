CREATE TABLE IF NOT EXISTS broker_credentials (
    id UUID PRIMARY KEY,
    label TEXT NOT NULL,
    key_version INTEGER NOT NULL CHECK (key_version > 0),
    nonce TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broker_repositories (
    repository TEXT PRIMARY KEY,
    repository_id BIGINT,
    credential_id UUID NOT NULL REFERENCES broker_credentials(id) ON DELETE RESTRICT,
    workflow_ref TEXT NOT NULL,
    job_workflow_ref TEXT,
    trusted_ref TEXT NOT NULL,
    event_name TEXT NOT NULL DEFAULT 'pull_request_target',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_repositories_credential_idx
    ON broker_repositories (credential_id);

CREATE TABLE IF NOT EXISTS broker_oidc_replays (
    jti TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_oidc_replays_expiry_idx
    ON broker_oidc_replays (expires_at);

CREATE TABLE IF NOT EXISTS broker_usage_events (
    id BIGSERIAL PRIMARY KEY,
    repository TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_usage_repository_time_idx
    ON broker_usage_events (repository, requested_at DESC);
