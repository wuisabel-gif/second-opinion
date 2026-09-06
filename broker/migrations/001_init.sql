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
    workflow_ref TEXT,
    job_workflow_ref TEXT,
    trusted_ref TEXT NOT NULL,
    event_name TEXT NOT NULL DEFAULT 'pull_request_target',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrade databases created before hosted-service auto-enrollment was added.
ALTER TABLE broker_repositories ALTER COLUMN workflow_ref DROP NOT NULL;

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
    source TEXT NOT NULL DEFAULT 'oidc' CHECK (source IN ('oidc', 'service')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE broker_usage_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'oidc';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'broker_usage_events_source_check'
          AND conrelid = 'broker_usage_events'::regclass
    ) THEN
        ALTER TABLE broker_usage_events
            ADD CONSTRAINT broker_usage_events_source_check
            CHECK (source IN ('oidc', 'service'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS broker_usage_repository_time_idx
    ON broker_usage_events (repository, requested_at DESC);

CREATE INDEX IF NOT EXISTS broker_usage_source_time_idx
    ON broker_usage_events (source, requested_at DESC);
