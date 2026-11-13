import type { ServerResponse } from 'node:http';
import pg from 'pg';
import type { Pool } from 'pg';
import type {
  OutboxEventType,
  PublicBoardSseEventPayload,
  TeamRole,
  TeamStatus,
  TeamStreamSseEventPayload,
} from '@crewmesh/shared';
import { getEnv } from '../config/env.js';
import { getDbPool } from '../db/pool.js';
import { AppError } from '../plugins/error-handler.js';
import { sanitizeEventMetadata } from './audit-outbox-service.js';

const { Client: PgClient } = pg;

const LEADER_ONLY_TEAM_EVENTS = new Set<OutboxEventType>([
  'JOIN_REQUEST_CREATED',
  'JOIN_REQUEST_DECLINED',
  'INVITE_CREATED',
  'INVITE_REVOKED',
]);

const MAX_SSE_SUBSCRIBERS = 500;
const MAX_SUBSCRIBER_QUEUED_FRAMES = 256;

export interface OutboxEventRow {
  id: string;
  hackathon_id: string;
  team_id: string | null;
  scope: 'board' | 'team' | 'both';
  event_type: OutboxEventType;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface BoardSseSubscriber {
  id: string;
  kind: 'board';
  hackathonId: string;
  res: ServerResponse;
  lastSentEventId: bigint;
  closed: boolean;
  queuedFrames: number;
}

export interface TeamSseSubscriber {
  id: string;
  kind: 'team';
  teamId: string;
  hackathonId: string;
  userId: string;
  sessionId: string;
  res: ServerResponse;
  lastSentEventId: bigint;
  closed: boolean;
  queuedFrames: number;
}

export type SseSubscriber = BoardSseSubscriber | TeamSseSubscriber;

/**
 * Parses and validates a `Last-Event-ID` header string as a non-negative 64-bit BigInt.
 */
export function parseLastEventId(rawHeader: string | string[] | undefined): bigint | null {
  const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^\d{1,20}$/.test(trimmed)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Last-Event-ID must be a non-negative integer');
  }
  const parsed = BigInt(trimmed);
  if (parsed > 9223372036854775807n) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Last-Event-ID exceeds PostgreSQL BIGINT bounds');
  }
  return parsed;
}

/**
 * Projects a committed outbox row into a privacy-safe public board SSE event payload.
 * Returns null if the outbox row is not meant for the public board.
 */
export function projectPublicBoardSseEvent(
  row: OutboxEventRow,
): PublicBoardSseEventPayload | null {
  if (row.scope !== 'board' && row.scope !== 'both') {
    return null;
  }
  if (LEADER_ONLY_TEAM_EVENTS.has(row.event_type)) {
    return null;
  }

  const p = row.payload ?? {};
  const createdAt =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);

  return {
    eventId: String(row.id),
    eventType: row.event_type,
    hackathonId: row.hackathon_id,
    teamId: row.team_id,
    ...(typeof p.status === 'string' ? { status: p.status as TeamStatus } : {}),
    ...(typeof p.memberCount === 'number' ? { memberCount: p.memberCount } : {}),
    ...(typeof p.minTeamSize === 'number' ? { minTeamSize: p.minTeamSize } : {}),
    ...(typeof p.maxTeamSize === 'number' ? { maxTeamSize: p.maxTeamSize } : {}),
    ...(typeof p.isFull === 'boolean' ? { isFull: p.isFull } : {}),
    createdAt,
  };
}

/**
 * Projects a committed outbox row into an authorized team SSE event payload
 * filtered by the member's current role ('leader' vs 'member').
 */
export function projectTeamStreamSseEvent(
  row: OutboxEventRow,
  memberRole: TeamRole,
): TeamStreamSseEventPayload | null {
  if (!row.team_id) {
    return null;
  }
  if (row.scope !== 'team' && row.scope !== 'both') {
    return null;
  }
  if (LEADER_ONLY_TEAM_EVENTS.has(row.event_type) && memberRole !== 'leader') {
    return null;
  }

  const safeData = sanitizeEventMetadata(row.payload ?? {});
  // Strip any accidental email field even if present in payload
  delete safeData.email;

  const createdAt =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);

  return {
    eventId: String(row.id),
    eventType: row.event_type,
    hackathonId: row.hackathon_id,
    teamId: row.team_id,
    data: safeData,
    createdAt,
  };
}

/**
 * Formats an SSE wire frame with `id:`, `event:`, and `data:`.
 */
export function formatSseFrame(params: {
  id: string;
  event: string;
  data: unknown;
}): string {
  return `id: ${params.id}\nevent: ${params.event}\ndata: ${JSON.stringify(params.data)}\n\n`;
}

/**
 * Shared durable outbox SSE dispatcher.
 * Uses a single PostgreSQL LISTEN connection for low-latency wake-ups and falls back to
 * durable `outbox_events` polling so missed notifications or listener disconnects
 * never lose committed events.
 *
 * Commit-order guarantee (Migration 006):
 * `trg_outbox_events_serialize_id` acquires `pg_advisory_xact_lock(842026002)` before
 * allocating `outbox_events.id`, ensuring sequence allocation order strictly equals
 * transaction commit visibility order.
 */
export class OutboxSseDispatcher {
  private readonly pool: Pool;
  private readonly subscribers = new Map<string, SseSubscriber>();
  private listenClient: pg.Client | null = null;
  private lastDispatchedId: bigint = 0n;
  private draining = false;
  private drainRequested = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private started = false;

  constructor(pool: Pool = getDbPool()) {
    this.pool = pool;
  }

  public getSubscriberCount(): number {
    return this.subscribers.size;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.shuttingDown = false;

    const maxRes = await this.pool.query<{ max_id: string | null }>(
      'SELECT MAX(id)::text AS max_id FROM outbox_events',
    );
    const maxIdStr = maxRes.rows[0]?.max_id;
    this.lastDispatchedId = maxIdStr ? BigInt(maxIdStr) : 0n;

    await this.connectListener();

    const env = getEnv();
    const pollIntervalMs = env.NODE_ENV === 'test' ? 150 : 2_000;
    const heartbeatIntervalMs = env.NODE_ENV === 'test' ? 5_000 : 15_000;

    this.pollTimer = setInterval(() => {
      void this.requestDrain();
    }, pollIntervalMs);
    this.pollTimer.unref?.();

    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeats();
    }, heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async connectListener(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const env = getEnv();
    const connectionString =
      env.NODE_ENV === 'test' && env.TEST_DATABASE_URL
        ? env.TEST_DATABASE_URL
        : env.DATABASE_URL;

    const client = new PgClient({
      connectionString,
      application_name: 'crewmesh_sse_listener',
    });

    client.on('notification', (msg) => {
      if (msg.channel === 'crewmesh_outbox') {
        void this.requestDrain();
      }
    });

    client.on('error', () => {
      this.handleListenerDisconnect();
    });

    client.on('end', () => {
      this.handleListenerDisconnect();
    });

    try {
      await client.connect();
      await client.query('LISTEN crewmesh_outbox');
      this.listenClient = client;
      // Drain any events committed while the listener was connecting
      void this.requestDrain();
    } catch {
      try {
        await client.end();
      } catch {
        // Ignore cleanup error
      }
      this.scheduleListenerReconnect();
    }
  }

  private handleListenerDisconnect(): void {
    if (this.listenClient) {
      const old = this.listenClient;
      this.listenClient = null;
      void old.end().catch(() => undefined);
    }
    if (!this.shuttingDown) {
      this.scheduleListenerReconnect();
    }
  }

  private scheduleListenerReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    const delayMs = getEnv().NODE_ENV === 'test' ? 100 : 1_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListener();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  /**
   * Simulates a PostgreSQL listener connection drop in integration tests to verify
   * automatic listener reconnection and durable outbox catch-up recovery.
   */
  public async simulateListenerInterruptionForTest(): Promise<void> {
    if (this.listenClient) {
      const active = this.listenClient;
      this.listenClient = null;
      await active.end().catch(() => undefined);
      this.scheduleListenerReconnect();
    }
  }

  /**
   * Registers a subscriber, replays missed events since `lastEventId` from PostgreSQL,
   * and attaches close cleanup handlers.
   */
  public async registerSubscriber(
    subscriber: SseSubscriber,
    replaySinceEventId: bigint | null,
  ): Promise<void> {
    if (this.subscribers.size >= MAX_SSE_SUBSCRIBERS) {
      throw new AppError(503, 'RATE_LIMITED', 'Maximum concurrent SSE streams reached');
    }

    await this.start();

    // Capture current max outbox ID before replay so we know the live watermark
    const watermarkRes = await this.pool.query<{ max_id: string | null }>(
      'SELECT MAX(id)::text AS max_id FROM outbox_events',
    );
    const currentMaxId = watermarkRes.rows[0]?.max_id
      ? BigInt(watermarkRes.rows[0]!.max_id!)
      : 0n;

    if (replaySinceEventId !== null) {
      subscriber.lastSentEventId = replaySinceEventId;
      await this.replayEventsForSubscriber(subscriber, replaySinceEventId, currentMaxId);
    } else {
      subscriber.lastSentEventId = currentMaxId;
    }

    if (subscriber.closed) {
      return;
    }

    this.subscribers.set(subscriber.id, subscriber);

    subscriber.res.on('close', () => {
      this.closeSubscriber(subscriber.id);
    });
    subscriber.res.on('error', () => {
      this.closeSubscriber(subscriber.id);
    });
  }

  private async replayEventsForSubscriber(
    subscriber: SseSubscriber,
    sinceEventId: bigint,
    upToEventId: bigint,
  ): Promise<void> {
    if (subscriber.kind === 'board') {
      const res = await this.pool.query<OutboxEventRow>(
        `
        SELECT id::text AS id, hackathon_id, team_id, scope, event_type, payload, created_at
        FROM outbox_events
        WHERE hackathon_id = $1
          AND scope IN ('board', 'both')
          AND id > $2::bigint
          AND id <= $3::bigint
        ORDER BY id ASC
        LIMIT 500
        `,
        [subscriber.hackathonId, sinceEventId.toString(), upToEventId.toString()],
      );

      for (const row of res.rows) {
        if (subscriber.closed) {
          return;
        }
        await this.deliverRowToSubscriber(subscriber, row);
      }
    } else {
      const res = await this.pool.query<OutboxEventRow>(
        `
        SELECT id::text AS id, hackathon_id, team_id, scope, event_type, payload, created_at
        FROM outbox_events
        WHERE team_id = $1
          AND scope IN ('team', 'both')
          AND id > $2::bigint
          AND id <= $3::bigint
        ORDER BY id ASC
        LIMIT 500
        `,
        [subscriber.teamId, sinceEventId.toString(), upToEventId.toString()],
      );

      for (const row of res.rows) {
        if (subscriber.closed) {
          return;
        }
        await this.deliverRowToSubscriber(subscriber, row);
      }
    }
  }

  public async requestDrain(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (this.draining) {
      this.drainRequested = true;
      return;
    }

    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        await this.drainNewOutboxEvents();
      } while (this.drainRequested && !this.shuttingDown);
    } catch {
      // Prevent background drain error from crashing process; next poll recovers
    } finally {
      this.draining = false;
    }
  }

  private async drainNewOutboxEvents(): Promise<void> {
    if (this.subscribers.size === 0) {
      const maxRes = await this.pool.query<{ max_id: string | null }>(
        'SELECT MAX(id)::text AS max_id FROM outbox_events',
      );
      if (maxRes.rows[0]?.max_id) {
        const latest = BigInt(maxRes.rows[0].max_id);
        if (latest > this.lastDispatchedId) {
          this.lastDispatchedId = latest;
        }
      }
      return;
    }

    const res = await this.pool.query<OutboxEventRow>(
      `
      SELECT id::text AS id, hackathon_id, team_id, scope, event_type, payload, created_at
      FROM outbox_events
      WHERE id > $1::bigint
      ORDER BY id ASC
      LIMIT 200
      `,
      [this.lastDispatchedId.toString()],
    );

    for (const row of res.rows) {
      const rowId = BigInt(row.id);
      if (rowId > this.lastDispatchedId) {
        this.lastDispatchedId = rowId;
      }

      const activeSubscribers = Array.from(this.subscribers.values());
      for (const sub of activeSubscribers) {
        if (!sub.closed) {
          await this.deliverRowToSubscriber(sub, row);
        }
      }
    }
  }

  private async deliverRowToSubscriber(
    subscriber: SseSubscriber,
    row: OutboxEventRow,
  ): Promise<void> {
    const eventId = BigInt(row.id);
    if (eventId <= subscriber.lastSentEventId || subscriber.closed) {
      return;
    }

    if (subscriber.kind === 'board') {
      if (row.hackathon_id !== subscriber.hackathonId) {
        return;
      }
      const projected = projectPublicBoardSseEvent(row);
      if (!projected) {
        return;
      }
      this.writeFrameToSubscriber(
        subscriber,
        eventId,
        formatSseFrame({
          id: projected.eventId,
          event: projected.eventType,
          data: projected,
        }),
      );
      return;
    }

    // Team stream subscriber: must match team_id
    if (row.team_id !== subscriber.teamId) {
      return;
    }

    // If this subscriber is the user who was just removed or departed, close their stream immediately
    if (
      (row.event_type === 'MEMBER_REMOVED' && row.payload?.removedUserId === subscriber.userId) ||
      (row.event_type === 'MEMBER_LEFT' && row.payload?.departedUserId === subscriber.userId)
    ) {
      this.closeSubscriber(subscriber.id);
      return;
    }

    // Re-verify active session and current team membership/role against PostgreSQL
    const authState = await this.verifyTeamSubscriberAccess(subscriber, row.event_type);
    if (!authState.authorized) {
      this.closeSubscriber(subscriber.id);
      return;
    }

    const projected = projectTeamStreamSseEvent(row, authState.role);
    if (!projected) {
      return;
    }

    this.writeFrameToSubscriber(
      subscriber,
      eventId,
      formatSseFrame({
        id: projected.eventId,
        event: projected.eventType,
        data: projected,
      }),
    );

    if (row.event_type === 'TEAM_DELETED' || authState.closeAfterDelivery) {
      this.closeSubscriber(subscriber.id);
    }
  }

  private async verifyTeamSubscriberAccess(
    subscriber: TeamSseSubscriber,
    eventType: OutboxEventType,
  ): Promise<{
    authorized: boolean;
    role: TeamRole;
    closeAfterDelivery?: boolean;
  }> {
    // 1. Verify session is still active and unrevoked
    const sessionRes = await this.pool.query<{ id: string }>(
      `
      SELECT id
      FROM sessions
      WHERE id = $1
        AND user_id = $2
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1
      `,
      [subscriber.sessionId, subscriber.userId],
    );

    if (sessionRes.rows.length === 0) {
      return { authorized: false, role: 'member' };
    }

    // 2. If the team was deleted by the last member leaving, allow delivering TEAM_DELETED and close
    if (eventType === 'TEAM_DELETED') {
      return { authorized: true, role: 'member', closeAfterDelivery: true };
    }

    // 3. Verify subscriber is still an active member of the team and fetch current role
    const memberRes = await this.pool.query<{ role: TeamRole }>(
      `
      SELECT role
      FROM team_members
      WHERE team_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [subscriber.teamId, subscriber.userId],
    );

    const member = memberRes.rows[0];
    if (!member) {
      return { authorized: false, role: 'member' };
    }

    return {
      authorized: true,
      role: member.role,
    };
  }

  private writeFrameToSubscriber(
    subscriber: SseSubscriber,
    eventId: bigint,
    frame: string,
  ): void {
    if (subscriber.closed || subscriber.res.writableEnded || subscriber.res.destroyed) {
      this.closeSubscriber(subscriber.id);
      return;
    }

    if (subscriber.queuedFrames >= MAX_SUBSCRIBER_QUEUED_FRAMES) {
      // Backpressure limit exceeded on slow client -> close stream to protect server memory
      this.closeSubscriber(subscriber.id);
      return;
    }

    subscriber.lastSentEventId = eventId;
    const flushed = subscriber.res.write(frame);
    if (!flushed) {
      subscriber.queuedFrames += 1;
      subscriber.res.once('drain', () => {
        subscriber.queuedFrames = Math.max(0, subscriber.queuedFrames - 1);
      });
    }
  }

  private async sendHeartbeats(): Promise<void> {
    const comment = `: heartbeat ${new Date().toISOString()}\n\n`;
    for (const sub of Array.from(this.subscribers.values())) {
      if (sub.closed || sub.res.writableEnded || sub.res.destroyed) {
        this.closeSubscriber(sub.id);
        continue;
      }
      if (sub.kind === 'team') {
        try {
          const authState = await this.verifyTeamSubscriberAccess(sub, 'TEAM_UPDATED');
          if (!authState.authorized) {
            this.closeSubscriber(sub.id);
            continue;
          }
        } catch {
          // Transient DB error during heartbeat check; keep stream open for next poll
        }
      }
      sub.res.write(comment);
    }
  }

  public closeSubscriber(subscriberId: string): void {
    const sub = this.subscribers.get(subscriberId);
    if (!sub) {
      return;
    }
    sub.closed = true;
    this.subscribers.delete(subscriberId);
    if (!sub.res.writableEnded && !sub.res.destroyed) {
      try {
        sub.res.end();
      } catch {
        // Ignore stream close errors
      }
    }
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.started = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const subId of Array.from(this.subscribers.keys())) {
      this.closeSubscriber(subId);
    }

    if (this.listenClient) {
      const client = this.listenClient;
      this.listenClient = null;
      await client.end().catch(() => undefined);
    }
  }
}
