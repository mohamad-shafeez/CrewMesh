import type { PoolClient } from 'pg';
import type { AuditAction, OutboxEventType } from '@crewmesh/shared';

/**
 * Determines whether an object property key represents sensitive authentication,
 * credential, token, invite-code, or personal email data that must never appear
 * in `audit_log` or `outbox_events`.
 *
 * Normalizes case and strips underscores/hyphens/spaces before matching, while
 * explicitly preserving safe non-secret prefix/identifier metadata (`tokenPrefix`, `inviteCodeId`).
 */
export function isSensitiveMetadataKey(rawKey: string): boolean {
  const normalized = rawKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (normalized.length === 0) {
    return false;
  }

  // Safe non-secret 8-char prefix of an invite code or UUID identifier is explicitly permitted
  if (normalized === 'tokenprefix' || normalized === 'invitecodeid') {
    return false;
  }

  if (
    normalized.includes('password') ||
    normalized.includes('passwd') ||
    normalized.includes('pwd') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('csrf') ||
    normalized.includes('cookie') ||
    normalized.includes('session') ||
    normalized.includes('email') ||
    normalized.includes('authorization') ||
    normalized.includes('authheader') ||
    normalized.includes('credential') ||
    normalized.includes('privatekey') ||
    normalized.includes('invitecode') ||
    normalized.includes('rawcode') ||
    normalized.includes('plaintextcode') ||
    normalized === 'code'
  ) {
    return true;
  }

  return false;
}

function sanitizeNestedValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNestedValue(item));
  }
  if (typeof value === 'object' && !(value instanceof Date)) {
    return sanitizeEventMetadata(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Recursively strips any sensitive secret or private keys from plain objects,
 * nested objects, arrays of objects, and nested arrays before writing to
 * `audit_log` or `outbox_events` or projecting to SSE subscribers.
 */
export function sanitizeEventMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (isSensitiveMetadataKey(key)) {
      continue;
    }
    if (val !== undefined) {
      clean[key] = sanitizeNestedValue(val);
    }
  }
  return clean;
}

export interface AuditEntryInput {
  hackathonId: string;
  teamId: string | null;
  actorUserId: string | null;
  targetUserId?: string | null;
  action: AuditAction;
  entityType: 'team' | 'team_member' | 'join_request' | 'invite_code';
  entityId: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboxEventInput {
  hackathonId: string;
  teamId: string | null;
  scope: 'board' | 'team' | 'both';
  eventType: OutboxEventType;
  payload: Record<string, unknown>;
}

/**
 * Appends an immutable audit record inside the caller's active PostgreSQL transaction.
 */
export async function insertAuditLog(
  client: PoolClient,
  entry: AuditEntryInput,
): Promise<string> {
  const safeMetadata = sanitizeEventMetadata({
    ...entry.metadata,
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
  });

  const res = await client.query<{ id: string }>(
    `
    INSERT INTO audit_log (
      hackathon_id,
      team_id,
      actor_user_id,
      target_user_id,
      action,
      entity_type,
      entity_id,
      request_id,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    RETURNING id::text AS id
    `,
    [
      entry.hackathonId,
      entry.teamId,
      entry.actorUserId,
      entry.targetUserId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.requestId ?? null,
      JSON.stringify(safeMetadata),
    ],
  );

  return res.rows[0]?.id ?? '';
}

/**
 * Appends a durable outbox event inside the caller's active PostgreSQL transaction.
 * Sequence ID is allocated under `pg_advisory_xact_lock(842026002)` by `trg_outbox_events_serialize_id`.
 */
export async function insertOutboxEvent(
  client: PoolClient,
  event: OutboxEventInput,
): Promise<string> {
  const safePayload = sanitizeEventMetadata(event.payload);

  const res = await client.query<{ id: string }>(
    `
    INSERT INTO outbox_events (
      hackathon_id,
      team_id,
      scope,
      event_type,
      payload
    )
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING id::text AS id
    `,
    [
      event.hackathonId,
      event.teamId,
      event.scope,
      event.eventType,
      JSON.stringify(safePayload),
    ],
  );

  return res.rows[0]?.id ?? '';
}
