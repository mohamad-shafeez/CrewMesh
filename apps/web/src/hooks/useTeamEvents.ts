import { useEffect, useRef, useState } from 'react';
import type { TeamStreamSseEventPayload } from '@crewmesh/shared';
import {
  connectTeamEventStream,
  type SseConnectionState,
} from '../api/events.js';

/**
 * Connects to the private team SSE stream (`GET /api/v1/teams/:teamId/events`)
 * ONLY when `enabled` is true (viewer is a verified team member).
 * Preserves opaque BIGINT event IDs as strings and debounces bursts into canonical refetches.
 */
export function useTeamEvents(params: {
  teamId: string | null;
  enabled: boolean;
  onTeamEvent: (latestEvent: TeamStreamSseEventPayload) => void;
}): {
  connectionState: SseConnectionState;
  lastEventId: string | null;
} {
  const [connectionState, setConnectionState] = useState<SseConnectionState>('offline');
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const onEventRef = useRef(params.onTeamEvent);
  onEventRef.current = params.onTeamEvent;

  useEffect(() => {
    if (!params.teamId || !params.enabled) {
      setConnectionState('offline');
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let latestPayload: TeamStreamSseEventPayload | null = null;

    const disconnect = connectTeamEventStream({
      teamId: params.teamId,
      lastEventId: lastEventIdRef.current,
      onStateChange: (state) => {
        setConnectionState(state);
      },
      onEvent: (payload, rawEventId) => {
        if (rawEventId) {
          lastEventIdRef.current = rawEventId;
          setLastEventId(rawEventId);
        }
        latestPayload = payload;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          if (latestPayload) {
            onEventRef.current(latestPayload);
          }
        }, 140);
      },
    });

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      disconnect();
    };
  }, [params.teamId, params.enabled]);

  return { connectionState, lastEventId };
}
