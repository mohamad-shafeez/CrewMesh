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
import { getDbPool, resolvePgSslOptions } from '../db/pool.js';
import { AppError } from '../plugins/error-handler.js';
import { sanitizeEventMetadata } from './audit-outbox-service.js';

const { Client: PgClient } = pg;

const LEADER_ONLY_TEAM_EVENTS = new Set<OutboxEventType>([
  'JOIN_REQUEST_CREATED',
  'JOIN_REQUEST_DECLINED',
  'INVITE_CREATED',
  'INVITE_REVOKED',
]);

const LEADER_ONLY_EVENT_TYPES_ARRAY: OutboxEventType[] = [
  'JOIN_REQUEST_CREATED',
  'JOIN_REQUEST_DECLINED',
  'INVITE_CREATED',
  'INVITE_REVOKED',
];

const TEAM_EVENT_ALLOWED_KEYS: Record<OutboxEventType, readonly string[]> = {
  TEAM_CREATED: [
    'teamId',
    'hackathonId',
    'name',
    'leaderUserId',
    'status',
    'memberCount',
    'minTeamSize',
    'maxTeamSize',
    'isFull',
  ],
  TEAM_UPDATED: [
    'teamId',
    'hackathonId',
    'status',
    'memberCount',
    'minTeamSize',
    'maxTeamSize',
    'isFull',
  ],
  TEAM_PREFERENCES_UPDATED: [
    'teamId',
    'hackathonId',
    'desiredSkills',
    'lookingForMembers',
    'memberCount',
    'minTeamSize',
    'maxTeamSize',
    'status',
    'isFull',
  ],
  TEAM_DELETED: ['teamId', 'hackathonId', 'actorUserId', 'reason'],
  JOIN_REQUEST_CREATED: [
    'joinRequestId',
    'teamId',
    'hackathonId',
    'applicantUserId',
    'source',
    'status',
  ],
  JOIN_REQUEST_ACCEPTED: [
    'joinRequestId',
    'teamId',
    'hackathonId',
    'acceptedUserId',
    'decidedByUserId',
    'memberCount',
    'status',
  ],
  JOIN_REQUEST_DECLINED: [
    'joinRequestId',
    'teamId',
    'hackathonId',
    'applicantUserId',
    'decidedByUserId',
    'status',
  ],
  INVITE_CREATED: [
    'inviteId',
    'teamId',
    'hackathonId',
    'tokenPrefix',
    'maxUses',
    'expiresAt',
  ],
  INVITE_REVOKED: ['inviteId', 'teamId', 'hackathonId', 'revokedAt'],
  MEMBER_JOINED: [
    'teamId',
    'hackathonId',
    'userId',
    'memberCount',
    'minTeamSize',
    'maxTeamSize',
    'status',
    'isFull',
  ],
  MEMBER_REMOVED: [
    'teamId',
    'hackathonId',
    'removedUserId',
    'memberCount',
    'minTeamSize',
    'maxTeamSize',
    'status',
    'isFull',
  ],
  MEMBER_LEFT: [
    'teamId',
    'hackathonId',
    'departedUserId',
    'memberCount',
    'minTeamSize',
    'maxTeamSize',
    'status',
    'isFull',
  ],
  LEADER_SUCCESSION: [
    'teamId',
    'hackathonId',
    'previousLeaderUserId',
    'newLeaderUserId',
    'memberCount',
    'minTeamSize',
    'maxTeamSize',
    'status',
    'isFull',
  ],
};

const MAX_SSE_SUBSCRIBERS = 500;
const MAX_SUBSCRIBER_QUEUED_FRAMES = 256;
const REPLAY_PAGE_BATCH_SIZE = 250;

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
  needsCatchup?: boolean;
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
  needsCatchup?: boolean;
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
 * filtered by the member's current role ('leader' vs 'member') and restricted
 * to the explicit allowlisted fields for `row.event_type` after recursive sanitization.
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

  const recursivelySanitized = sanitizeEventMetadata(row.payload ?? {});
  const allowedKeys = TEAM_EVENT_ALLOWED_KEYS[row.event_type] ?? [];
  const allowlistedData: Record<string, unknown> = {};

  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(recursivelySanitized, key)) {
      allowlistedData[key] = recursivelySanitized[key];
    }
  }

  const createdAt =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);

  return {
    eventId: String(row.id),
    eventType: row.event_type,
    hackathonId: row.hackathon_id,
    teamId: row.team_id,
    data: allowlistedData,
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
 *
 * Synchronization & Replay Guarantees (Batch 08):
 * 1. `registerSubscriber` and `drainNewOutboxEvents` are serialized through `this.runExclusive(...)`
 *    so no outbox event can commit and be drained between watermark capture, paginated replay,
 *    and adding the subscriber to `this.subscribers`.
 * 2. `replayEventsForSubscriber` uses cursor-paginated batches (`REPLAY_PAGE_BATCH_SIZE = 250`)
 *    with SQL-level role filtering so `> 500` missed events or `> 500` leader-only events never
 *    truncate history or starve regular team members.
 * 3. Per-subscriber delivery errors during live draining are isolated per subscriber and flag
 *    `subscriber.needsCatchup = true` without advancing `subscriber.lastSentEventId`, allowing
 *    automatic catch-up on the next drain cycle without blocking other subscribers.
 */
export class OutboxSseDispatcher {
  private readonly pool: Pool;
  private readonly subscribers = new Map<string, SseSubscriber>();
  private listenClient: pg.Client | null = null;
  private lastDispatchedId: bigint = 0n;
  private exclusiveChain: Promise<void> = Promise.resolve();
  private drainRequested = false;
  private draining = false;
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

  /**
   * Serializes subscriber registration and outbox drain cycles so watermark capture,
   * replay, and live map insertion form a single atomic logical operation.
   */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.exclusiveChain.then(task, task);
    this.exclusiveChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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

    const ssl = resolvePgSslOptions(env.DATABASE_SSL, connectionString);
    const client = new PgClient({
      connectionString,
      ...(ssl ? { ssl } : {}),
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

  public async simulateListenerInterruptionForTest(): Promise<void> {
    if (this.listenClient) {
      const active = this.listenClient;
      this.listenClient = null;
      await active.end().catch(() => undefined);
      this.scheduleListenerReconnect();
    }
  }

  /**
   * Registers a subscriber atomically relative to dispatcher draining:
   * 1. Acquires `runExclusive` lock and drains any pending committed events so
   *    `this.lastDispatchedId` equals the exact current watermark.
   * 2. Replays all events in `(replaySinceEventId, watermarkId]` using cursor-based
   *    keyset pagination (`REPLAY_PAGE_BATCH_SIZE = 250`) with SQL role filtering.
   * 3. Sets `subscriber.lastSentEventId = watermarkId` and inserts the subscriber
   *    into `this.subscribers` before releasing `runExclusive`.
   */
  public async registerSubscriber(
    subscriber: SseSubscriber,
    replaySinceEventId: bigint | null,
  ): Promise<void> {
    if (this.subscribers.size >= MAX_SSE_SUBSCRIBERS) {
      throw new AppError(503, 'RATE_LIMITED', 'Maximum concurrent SSE streams reached');
    }

    await this.start();

    subscriber.res.on('close', () => {
      this.closeSubscriber(subscriber.id);
    });
    subscriber.res.on('error', () => {
      this.closeSubscriber(subscriber.id);
    });

    await this.runExclusive(async () => {
      if (subscriber.closed || this.shuttingDown) {
        return;
      }

      // First drain any newly committed outbox rows so existing subscribers and
      // `this.lastDispatchedId` are brought up to the current PostgreSQL watermark
      await this.drainNewOutboxEventsInternal();

      const watermarkRes = await this.pool.query<{ max_id: string | null }>(
        'SELECT MAX(id)::text AS max_id FROM outbox_events',
      );
      const watermarkId = watermarkRes.rows[0]?.max_id ? BigInt(watermarkRes.rows[0]!.max_id!) : 0n;
      this.lastDispatchedId = watermarkId;

      if (replaySinceEventId !== null) {
        subscriber.lastSentEventId = replaySinceEventId;
        await this.replayEventsForSubscriber(subscriber, replaySinceEventId, watermarkId);
        if (watermarkId > subscriber.lastSentEventId) {
          subscriber.lastSentEventId = watermarkId;
        }
      } else {
        subscriber.lastSentEventId = watermarkId;
      }

      if (subscriber.closed) {
        return;
      }

      this.subscribers.set(subscriber.id, subscriber);
    });
  }

  /**
   * Cursor-paginated replay over `(sinceEventId, upToEventId]` in bounded batches of 250 rows.
   * Filters out leader-only events directly in SQL when replaying for a non-leader team member
   * so >500 leader-only events never starve a regular member.
   */
  public async replayEventsForSubscriber(
    subscriber: SseSubscriber,
    sinceEventId: bigint,
    upToEventId: bigint,
  ): Promise<void> {
    let cursorId = sinceEventId;

    if (subscriber.kind === 'board') {
      while (cursorId < upToEventId && !subscriber.closed) {
        const res = await this.pool.query<OutboxEventRow>(
          `
          SELECT id::text AS id, hackathon_id, team_id, scope, event_type, payload, created_at
          FROM outbox_events
          WHERE hackathon_id = $1
            AND scope IN ('board', 'both')
            AND id > $2::bigint
            AND id <= $3::bigint
          ORDER BY id ASC
          LIMIT $4
          `,
          [
            subscriber.hackathonId,
            cursorId.toString(),
            upToEventId.toString(),
            REPLAY_PAGE_BATCH_SIZE,
          ],
        );

        if (res.rows.length === 0) {
          break;
        }

        for (const row of res.rows) {
          if (subscriber.closed) {
            return;
          }
          cursorId = BigInt(row.id);
          await this.deliverRowToSubscriber(subscriber, row, true);
        }

        if (res.rows.length < REPLAY_PAGE_BATCH_SIZE) {
          break;
        }
      }
      return;
    }

    // Team subscriber: check current role once before paginated replay so SQL can filter leader-only events
    const authState = await this.verifyTeamSubscriberAccess(subscriber, 'TEAM_UPDATED');
    if (!authState.authorized) {
      this.closeSubscriber(subscriber.id);
      return;
    }

    const isLeader = authState.role === 'leader';

    while (cursorId < upToEventId && !subscriber.closed) {
      const res = await this.pool.query<OutboxEventRow>(
        isLeader
          ? `
            SELECT id::text AS id, hackathon_id, team_id, scope, event_type, payload, created_at
            FROM outbox_events
            WHERE team_id = $1
              AND scope IN ('team', 'both')
              AND id > $2::bigint
              AND id <= $3::bigint
            ORDER BY id ASC
            LIMIT $4
            `
          : `
            SELECT id::text AS id, hackathon_id, team_id, scope, event_type, payload, created_at
            FROM outbox_events
            WHERE team_id = $1
              AND scope IN ('team', 'both')
              AND NOT (event_type = ANY($5::text[]))
              AND id > $2::bigint
              AND id <= $3::bigint
            ORDER BY id ASC
            LIMIT $4
            `,
        isLeader
          ? [
              subscriber.teamId,
              cursorId.toString(),
              upToEventId.toString(),
              REPLAY_PAGE_BATCH_SIZE,
            ]
          : [
              subscriber.teamId,
              cursorId.toString(),
              upToEventId.toString(),
              REPLAY_PAGE_BATCH_SIZE,
              LEADER_ONLY_EVENT_TYPES_ARRAY,
            ],
      );

      if (res.rows.length === 0) {
        break;
      }

      for (const row of res.rows) {
        if (subscriber.closed) {
          return;
        }
        cursorId = BigInt(row.id);
        await this.deliverRowToSubscriber(subscriber, row, true);
      }

      if (res.rows.length < REPLAY_PAGE_BATCH_SIZE) {
        break;
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
        await this.runExclusive(async () => {
          if (!this.shuttingDown) {
            await this.drainNewOutboxEventsInternal();
          }
        });
      } while (this.drainRequested && !this.shuttingDown);
    } catch {
      // Prevent background drain error from crashing process; next poll recovers
    } finally {
      this.draining = false;
    }
  }

  private async drainNewOutboxEventsInternal(): Promise<void> {
    if (this.subscribers.size === 0) {
      const maxRes = await this.pool.query<{ max_id: string | null }>(
        'SELECT MAX(id)::text AS max_id FROM outbox_events',
      );
      this.lastDispatchedId = maxRes.rows[0]?.max_id ? BigInt(maxRes.rows[0].max_id) : 0n;
      return;
    }

    // First recover any subscriber that experienced a transient DB error on a prior drain cycle
    for (const sub of Array.from(this.subscribers.values())) {
      if (!sub.closed && sub.needsCatchup && sub.lastSentEventId < this.lastDispatchedId) {
        try {
          sub.needsCatchup = false;
          await this.replayEventsForSubscriber(sub, sub.lastSentEventId, this.lastDispatchedId);
        } catch {
          sub.needsCatchup = true;
        }
      }
    }

    while (!this.shuttingDown) {
      const res = await this.pool.query<OutboxEventRow>(
        `
        SELECT id::text AS id, hackathon_id, team_id, scope, event_type, payload, created_at
        FROM outbox_events
        WHERE id > $1::bigint
        ORDER BY id ASC
        LIMIT 250
        `,
        [this.lastDispatchedId.toString()],
      );

      if (res.rows.length === 0) {
        break;
      }

      for (const row of res.rows) {
        const rowId = BigInt(row.id);
        const activeSubscribers = Array.from(this.subscribers.values());

        for (const sub of activeSubscribers) {
          if (sub.closed) {
            continue;
          }
          try {
            // If subscriber fell behind due to an earlier transient error, catch it up before delivering rowId
            if (sub.needsCatchup && sub.lastSentEventId < rowId - 1n) {
              sub.needsCatchup = false;
              await this.replayEventsForSubscriber(sub, sub.lastSentEventId, rowId - 1n);
            }
            await this.deliverRowToSubscriber(sub, row, false);
          } catch {
            // Isolate per-subscriber transient failure: keep sub.lastSentEventId unchanged and mark for catch-up
            sub.needsCatchup = true;
          }
        }

        if (rowId > this.lastDispatchedId) {
          this.lastDispatchedId = rowId;
        }
      }

      if (res.rows.length < 250) {
        break;
      }
    }
  }

  private async deliverRowToSubscriber(
    subscriber: SseSubscriber,
    row: OutboxEventRow,
    isReplay = false,
  ): Promise<void> {
    const eventId = BigInt(row.id);
    if (eventId <= subscriber.lastSentEventId || subscriber.closed) {
      return;
    }

    if (subscriber.kind === 'board') {
      if (row.hackathon_id !== subscriber.hackathonId) {
        if (!isReplay && eventId > subscriber.lastSentEventId) {
          subscriber.lastSentEventId = eventId;
        }
        return;
      }
      const projected = projectPublicBoardSseEvent(row);
      if (!projected) {
        if (!isReplay && eventId > subscriber.lastSentEventId) {
          subscriber.lastSentEventId = eventId;
        }
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
      if (!isReplay && eventId > subscriber.lastSentEventId) {
        subscriber.lastSentEventId = eventId;
      }
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
      if (eventId > subscriber.lastSentEventId) {
        subscriber.lastSentEventId = eventId;
      }
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
