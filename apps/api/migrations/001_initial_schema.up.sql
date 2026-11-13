-- ============================================================================
-- CrewMesh — Migration 001: Core Schema & Non-Negotiable Database Invariants
-- ============================================================================
-- Enforces all PS1 database invariants at the PostgreSQL engine level:
-- 1. Unique (hackathon_id, user_id) on team_members (one team per participant per hackathon).
-- 2. Team size bounds (min_team_size, max_team_size) and forming/ready status consistency.
-- 3. At most one leader per team (partial unique index on team_members where role = 'leader').
-- 4. At most one pending join request per (team_id, user_id) (partial unique index).
-- 5. Unique SHA-256 invite token hashes; plaintext invite tokens are never stored.
-- 6. Unique idempotency scope (actor_user_id, operation, idempotency_key) bound to request_hash.
-- 7. Durable audit_log and outbox_events tables that preserve team_id without cascade deletion.
-- 8. Shared PostgreSQL rate_limit_buckets table for auth and invite-code brute-force defense.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. users
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  skills TEXT[] NOT NULL DEFAULT '{}'::text[],
  timezone TEXT NOT NULL DEFAULT 'UTC',
  bio TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_normalized_chk CHECK (
    email = lower(btrim(email))
    AND length(email) BETWEEN 3 AND 254
    AND position('@' in email) > 1
  ),
  CONSTRAINT users_password_hash_argon2_chk CHECK (
    password_hash LIKE '$argon2id$%'
    AND length(password_hash) >= 32
  ),
  CONSTRAINT users_display_name_length_chk CHECK (
    length(btrim(display_name)) BETWEEN 2 AND 80
  ),
  CONSTRAINT users_timezone_length_chk CHECK (
    length(btrim(timezone)) BETWEEN 2 AND 64
  ),
  CONSTRAINT users_bio_length_chk CHECK (
    length(bio) <= 500
  )
);

CREATE INDEX IF NOT EXISTS idx_users_skills_gin ON users USING GIN (skills);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. hackathons
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hackathons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_team_size INTEGER NOT NULL DEFAULT 2,
  max_team_size INTEGER NOT NULL DEFAULT 5,
  registration_deadline TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT hackathons_slug_unique UNIQUE (slug),
  CONSTRAINT hackathons_slug_format_chk CHECK (
    slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'
  ),
  CONSTRAINT hackathons_name_length_chk CHECK (
    length(btrim(name)) BETWEEN 2 AND 120
  ),
  CONSTRAINT hackathons_team_size_bounds_chk CHECK (
    min_team_size >= 1
    AND max_team_size >= min_team_size
    AND max_team_size <= 20
  )
);

-- ----------------------------------------------------------------------------
-- 3. teams
-- ----------------------------------------------------------------------------
-- Teams below min_team_size have status = 'forming'; once member_count >= min_team_size,
-- status becomes 'ready'. Hard capacity is enforced by teams_member_count_bounds_chk
-- and serialized via SELECT ... FOR UPDATE on the teams row during membership mutations.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  desired_skills TEXT[] NOT NULL DEFAULT '{}'::text[],
  leader_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'forming',
  member_count INTEGER NOT NULL DEFAULT 1,
  min_team_size INTEGER NOT NULL DEFAULT 2,
  max_team_size INTEGER NOT NULL DEFAULT 5,
  looking_for_members BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT teams_id_hackathon_unique UNIQUE (id, hackathon_id),
  CONSTRAINT teams_hackathon_name_unique UNIQUE (hackathon_id, name),
  CONSTRAINT teams_name_length_chk CHECK (
    length(btrim(name)) BETWEEN 2 AND 80
  ),
  CONSTRAINT teams_description_length_chk CHECK (
    length(description) <= 1000
  ),
  CONSTRAINT teams_size_config_chk CHECK (
    min_team_size >= 1
    AND max_team_size >= min_team_size
    AND max_team_size <= 20
  ),
  CONSTRAINT teams_member_count_bounds_chk CHECK (
    member_count >= 1
    AND member_count <= max_team_size
  ),
  CONSTRAINT teams_status_values_chk CHECK (
    status IN ('forming', 'ready')
  ),
  CONSTRAINT teams_status_min_size_consistency_chk CHECK (
    (member_count < min_team_size AND status = 'forming')
    OR (member_count >= min_team_size AND status = 'ready')
  )
);

CREATE INDEX IF NOT EXISTS idx_teams_board_cursor
  ON teams (hackathon_id, looking_for_members, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_teams_hackathon_status
  ON teams (hackathon_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_teams_desired_skills_gin
  ON teams USING GIN (desired_skills);
CREATE INDEX IF NOT EXISTS idx_teams_leader_user_id
  ON teams (leader_user_id);

-- ----------------------------------------------------------------------------
-- 4. team_members
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT team_members_team_hackathon_fk
    FOREIGN KEY (team_id, hackathon_id)
    REFERENCES teams(id, hackathon_id)
    ON DELETE CASCADE,
  CONSTRAINT team_members_one_team_per_hackathon_unique
    UNIQUE (hackathon_id, user_id),
  CONSTRAINT team_members_team_user_unique
    UNIQUE (team_id, user_id),
  CONSTRAINT team_members_role_chk
    CHECK (role IN ('leader', 'member'))
);

-- Invariant: at most one active leader per team
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_one_leader_per_team
  ON team_members (team_id)
  WHERE role = 'leader';

-- Deterministic leadership handoff ordering (earliest joined_at, tie-break by user_id)
CREATE INDEX IF NOT EXISTS idx_team_members_handoff_order
  ON team_members (team_id, joined_at ASC, user_id ASC);

CREATE INDEX IF NOT EXISTS idx_team_members_user_id
  ON team_members (user_id);

-- ----------------------------------------------------------------------------
-- 5. invite_codes
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  max_uses INTEGER NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT invite_codes_team_hackathon_fk
    FOREIGN KEY (team_id, hackathon_id)
    REFERENCES teams(id, hackathon_id)
    ON DELETE CASCADE,
  CONSTRAINT invite_codes_token_hash_unique
    UNIQUE (token_hash),
  CONSTRAINT invite_codes_token_hash_sha256_chk
    CHECK (length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invite_codes_token_prefix_chk
    CHECK (length(token_prefix) BETWEEN 4 AND 12),
  CONSTRAINT invite_codes_uses_chk
    CHECK (
      use_count >= 0
      AND (max_uses IS NULL OR (max_uses >= 1 AND use_count <= max_uses))
    )
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_team_active
  ON invite_codes (team_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- 6. join_requests
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'board',
  invite_code_id UUID NULL REFERENCES invite_codes(id) ON DELETE SET NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT join_requests_team_hackathon_fk
    FOREIGN KEY (team_id, hackathon_id)
    REFERENCES teams(id, hackathon_id)
    ON DELETE CASCADE,
  CONSTRAINT join_requests_source_chk
    CHECK (source IN ('board', 'invite_code')),
  CONSTRAINT join_requests_status_chk
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  CONSTRAINT join_requests_message_length_chk
    CHECK (length(message) <= 500)
);

-- Invariant: at most one pending join request per (team_id, user_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_one_pending_per_team_user
  ON join_requests (team_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_join_requests_team_inbox
  ON join_requests (team_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_join_requests_user_hackathon_status
  ON join_requests (user_id, hackathon_id, status);

-- ----------------------------------------------------------------------------
-- 7. sessions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  csrf_token_hash TEXT NOT NULL,
  ip_address TEXT NULL,
  user_agent TEXT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_sha256_chk CHECK (
    length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT sessions_csrf_hash_sha256_chk CHECK (
    length(csrf_token_hash) = 64 AND csrf_token_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
  ON sessions (expires_at);

-- ----------------------------------------------------------------------------
-- 8. idempotency_keys
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  response_status INTEGER NULL,
  response_body JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

  CONSTRAINT idempotency_keys_scope_unique
    UNIQUE (actor_user_id, operation, idempotency_key),
  CONSTRAINT idempotency_keys_operation_length_chk
    CHECK (length(btrim(operation)) BETWEEN 3 AND 160),
  CONSTRAINT idempotency_keys_key_length_chk
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT idempotency_keys_request_hash_sha256_chk
    CHECK (length(request_hash) = 64 AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_keys_status_chk
    CHECK (status IN ('in_progress', 'completed'))
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at);

-- ----------------------------------------------------------------------------
-- 9. audit_log
-- ----------------------------------------------------------------------------
-- Invariant: Audit records are NEVER cascade-deleted when a team is deleted.
-- team_id is stored as a UUID without a cascading foreign key so audit history
-- survives final-member team deletion intact.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE RESTRICT,
  team_id UUID NULL,
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  target_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT audit_log_action_length_chk
    CHECK (length(btrim(action)) BETWEEN 3 AND 80),
  CONSTRAINT audit_log_entity_type_length_chk
    CHECK (length(btrim(entity_type)) BETWEEN 3 AND 60),
  CONSTRAINT audit_log_entity_id_length_chk
    CHECK (length(btrim(entity_id)) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_team_created
  ON audit_log (team_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_hackathon_created
  ON audit_log (hackathon_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created
  ON audit_log (actor_user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 10. outbox_events
-- ----------------------------------------------------------------------------
-- Durable transactional outbox for SSE board and team streams (Last-Event-ID replay).
-- Preserves team_id without cascade deletion so TEAM_DELETED events can be replayed.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE RESTRICT,
  team_id UUID NULL,
  scope TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT outbox_events_scope_chk
    CHECK (scope IN ('board', 'team', 'both')),
  CONSTRAINT outbox_events_type_length_chk
    CHECK (length(btrim(event_type)) BETWEEN 3 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_hackathon_replay
  ON outbox_events (hackathon_id, id ASC);

CREATE INDEX IF NOT EXISTS idx_outbox_events_team_replay
  ON outbox_events (team_id, id ASC)
  WHERE team_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 11. rate_limit_buckets
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT rate_limit_buckets_key_length_chk
    CHECK (length(btrim(bucket_key)) BETWEEN 3 AND 255),
  CONSTRAINT rate_limit_buckets_scope_chk
    CHECK (scope IN ('auth_ip', 'auth_email', 'invite_ip', 'invite_user')),
  CONSTRAINT rate_limit_buckets_hits_chk
    CHECK (hits >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires_at
  ON rate_limit_buckets (expires_at);
