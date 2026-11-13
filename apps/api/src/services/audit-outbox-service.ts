import type { PoolClient } from 'pg';
import type { AuditAction, OutboxEventType } from '@crewmesh/shared';

const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'token_hash',
  'tokenHash',
  'code',
  'rawCode',
  'inviteToken',
  'sessionToken',
  'csrfToken',
  'csrf_token_hash',
]);

/**
 * Strips any sensitive secret keys from metadata before writing to audit_log or outbox_events.
 */
export function sanitizeEventMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input) {
    return {};
  }
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      continue;
    }
    if (val !== undefined && typeof val === 'object' && val !== null && !Array.isArray(val)) {
      clean[key] = sanitizeEventMetadata(val as Record<string, unknown>);
    } else {
      clean[key] = val;
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
