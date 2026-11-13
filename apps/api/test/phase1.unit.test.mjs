import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pure domain helpers mirroring @crewmesh/shared and @crewmesh/api security primitives
function normalizeEmail(rawEmail) {
  return rawEmail.trim().toLowerCase();
}

function normalizeSkillTags(rawSkills) {
  const seen = new Set();
  const result = [];
  for (const raw of rawSkills) {
    const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (cleaned.length >= 1 && cleaned.length <= 40 && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}

function isValidIanaTimeZone(tz) {
  const trimmed = tz.trim();
  if (trimmed.length < 2 || trimmed.length > 64) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function generateOpaqueToken(byteLength = 32) {
  if (byteLength < 24) {
    throw new Error('Token entropy must be at least 192 bits (24 bytes)');
  }
  return crypto.randomBytes(byteLength).toString('base64url');
}

function deriveCsrfToken(sessionTokenHash, csrfSecret) {
  return crypto
    .createHmac('sha256', csrfSecret)
    .update(`crewmesh-csrf:${sessionTokenHash}`, 'utf8')
    .digest('base64url');
}

function verifyCsrfTokenHash(providedCsrfToken, expectedCsrfTokenHash) {
  if (!providedCsrfToken || typeof providedCsrfToken !== 'string') {
    return false;
  }
  const providedHash = sha256Hex(providedCsrfToken);
  if (providedHash.length !== expectedCsrfTokenHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(providedHash, 'utf8'),
    Buffer.from(expectedCsrfTokenHash, 'utf8'),
  );
}

test('1. Email and skill tag normalization enforce deterministic canonical formatting', () => {
  assert.equal(normalizeEmail('  Mohamad.Shafeez@Example.COM \n'), 'mohamad.shafeez@example.com');
  assert.deepEqual(
    normalizeSkillTags(['  TypeScript ', 'PostgreSQL', 'typescript', 'Node JS', '']),
    ['typescript', 'postgresql', 'node-js'],
  );
});

test('2. IANA time zone validator accepts valid zones and rejects invalid strings', () => {
  assert.equal(isValidIanaTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidIanaTimeZone('UTC'), true);
  assert.equal(isValidIanaTimeZone('America/New_York'), true);
  assert.equal(isValidIanaTimeZone('Not/A_Real_Zone'), false);
  assert.equal(isValidIanaTimeZone(''), false);
});

test('3. Opaque session token generator enforces >=192-bit entropy and SHA-256 hashing', () => {
  assert.throws(() => generateOpaqueToken(16), /192 bits/);
  const token = generateOpaqueToken(32);
  assert.ok(token.length >= 43);
  const hash = sha256Hex(token);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('4. Session-bound CSRF token derivation and constant-time verification reject tampering', () => {
  const sessionHash = sha256Hex(generateOpaqueToken(32));
  const secret = 'unit_test_csrf_secret_with_at_least_32_bytes_of_entropy';
  const csrfToken = deriveCsrfToken(sessionHash, secret);
  const storedCsrfHash = sha256Hex(csrfToken);

  assert.equal(verifyCsrfTokenHash(csrfToken, storedCsrfHash), true);
  assert.equal(verifyCsrfTokenHash(`${csrfToken}x`, storedCsrfHash), false);
  assert.equal(verifyCsrfTokenHash(undefined, storedCsrfHash), false);
});

test('5. Migration 001_initial_schema.up.sql defines all 11 required tables and non-negotiable invariants', () => {
  const upSqlPath = path.resolve(__dirname, '../migrations/001_initial_schema.up.sql');
  const downSqlPath = path.resolve(__dirname, '../migrations/001_initial_schema.down.sql');

  const upSql = fs.readFileSync(upSqlPath, 'utf8');
  const downSql = fs.readFileSync(downSqlPath, 'utf8');

  const requiredTables = [
    'users',
    'hackathons',
    'teams',
    'team_members',
    'join_requests',
    'invite_codes',
    'sessions',
    'idempotency_keys',
    'audit_log',
    'outbox_events',
    'rate_limit_buckets',
  ];

  for (const table of requiredTables) {
    assert.match(upSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `Missing table ${table} in up migration`);
    assert.match(downSql, new RegExp(`DROP TABLE IF EXISTS ${table};`), `Missing drop for ${table} in down migration`);
  }

  // Verify non-negotiable database constraints
  assert.match(upSql, /CONSTRAINT team_members_one_team_per_hackathon_unique\s+UNIQUE \(hackathon_id, user_id\)/);
  assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_one_leader_per_team\s+ON team_members \(team_id\)\s+WHERE role = 'leader'/);
  assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_one_pending_per_team_user\s+ON join_requests \(team_id, user_id\)\s+WHERE status = 'pending'/);
  assert.match(upSql, /CONSTRAINT invite_codes_token_hash_unique\s+UNIQUE \(token_hash\)/);
  assert.match(upSql, /CONSTRAINT idempotency_keys_scope_unique\s+UNIQUE \(actor_user_id, operation, idempotency_key\)/);
  assert.match(upSql, /CONSTRAINT teams_status_min_size_consistency_chk CHECK/);

  // Verify audit_log does NOT cascade-delete when teams are deleted
  const auditSection = upSql.slice(upSql.indexOf('CREATE TABLE IF NOT EXISTS audit_log'));
  const auditTableDef = auditSection.slice(0, auditSection.indexOf(');'));
  assert.equal(auditTableDef.includes('REFERENCES teams'), false, 'audit_log must not have a cascading FK to teams');
});
