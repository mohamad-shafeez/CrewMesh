import type {
  OutboxEventType,
  PublicBoardSseEventPayload,
  TeamStreamSseEventPayload,
} from '@crewmesh/shared';

export type SseConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

const BOARD_EVENT_TYPES: OutboxEventType[] = [
  'TEAM_CREATED',
  'TEAM_UPDATED',
  'TEAM_PREFERENCES_UPDATED',
  'TEAM_DELETED',
  'MEMBER_JOINED',
  'MEMBER_REMOVED',
  'MEMBER_LEFT',
  'LEADER_SUCCESSION',
  'JOIN_REQUEST_ACCEPTED',
];

const TEAM_EVENT_TYPES: OutboxEventType[] = [
  'TEAM_CREATED',
  'TEAM_UPDATED',
  'TEAM_PREFERENCES_UPDATED',
  'TEAM_DELETED',
  'JOIN_REQUEST_CREATED',
  'JOIN_REQUEST_ACCEPTED',
  'JOIN_REQUEST_DECLINED',
  'INVITE_CREATED',
  'INVITE_REVOKED',
  'MEMBER_JOINED',
  'MEMBER_REMOVED',
  'MEMBER_LEFT',
  'LEADER_SUCCESSION',
];

/**
 * Opens a live EventSource stream to GET /api/v1/hackathons/:hackathonId/events.
 * Preserves event IDs as opaque decimal strings (never converting BIGINT to Number).
 */
export function connectBoardEventStream(params: {
  hackathonIdOrSlug: string;
  lastEventId?: string | null;
  onEvent: (payload: PublicBoardSseEventPayload, rawEventId: string) => void;
  onStateChange: (state: SseConnectionState) => void;
}): () => void {
  if (typeof EventSource === 'undefined') {
    params.onStateChange('offline');
    return () => undefined;
  }

  params.onStateChange('connecting');
  const query =
    params.lastEventId && params.lastEventId.trim().length > 0
      ? `?lastEventId=${encodeURIComponent(params.lastEventId.trim())}`
      : '';

  const es = new EventSource(
    `/api/v1/hackathons/${encodeURIComponent(params.hackathonIdOrSlug)}/events${query}`,
    { withCredentials: true },
  );

  es.onopen = () => {
    params.onStateChange('live');
  };

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      params.onStateChange('offline');
    } else {
      params.onStateChange('reconnecting');
    }
  };

  for (const eventType of BOARD_EVENT_TYPES) {
    es.addEventListener(eventType, (evt) => {
      const msg = evt as MessageEvent<string>;
      try {
        const parsed = JSON.parse(msg.data) as PublicBoardSseEventPayload;
        const opaqueId = String(msg.lastEventId || parsed.eventId || '');
        params.onEvent(parsed, opaqueId);
      } catch {
        // Ignore non-JSON frame
      }
    });
  }

  return () => {
    es.close();
  };
}

/**
 * Opens a live authenticated EventSource stream to GET /api/v1/teams/:teamId/events.
 * Preserves event IDs as opaque decimal strings (never converting BIGINT to Number).
 */
export function connectTeamEventStream(params: {
  teamId: string;
  lastEventId?: string | null;
  onEvent: (payload: TeamStreamSseEventPayload, rawEventId: string) => void;
  onStateChange: (state: SseConnectionState) => void;
}): () => void {
  if (typeof EventSource === 'undefined') {
    params.onStateChange('offline');
    return () => undefined;
  }

  params.onStateChange('connecting');
  const query =
    params.lastEventId && params.lastEventId.trim().length > 0
      ? `?lastEventId=${encodeURIComponent(params.lastEventId.trim())}`
      : '';

  const es = new EventSource(
    `/api/v1/teams/${encodeURIComponent(params.teamId)}/events${query}`,
    { withCredentials: true },
  );

  es.onopen = () => {
    params.onStateChange('live');
  };

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      params.onStateChange('offline');
    } else {
      params.onStateChange('reconnecting');
    }
  };

  for (const eventType of TEAM_EVENT_TYPES) {
    es.addEventListener(eventType, (evt) => {
      const msg = evt as MessageEvent<string>;
      try {
        const parsed = JSON.parse(msg.data) as TeamStreamSseEventPayload;
        const opaqueId = String(msg.lastEventId || parsed.eventId || '');
        params.onEvent(parsed, opaqueId);
      } catch {
        // Ignore non-JSON frame
      }
    });
  }

  return () => {
    es.close();
  };
}
