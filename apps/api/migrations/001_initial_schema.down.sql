-- ============================================================================
-- CrewMesh — Migration 001 Down: Rollback Core Schema
-- ============================================================================

DROP TABLE IF EXISTS rate_limit_buckets;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS join_requests;
DROP TABLE IF EXISTS invite_codes;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS hackathons;
DROP TABLE IF EXISTS users;
