import { useEffect, useRef, useState } from 'react';
import type { PublicBoardSseEventPayload } from '@crewmesh/shared';
import {
  connectBoardEventStream,
  type SseConnectionState,
} from '../api/events.js';

/**
 * Connects to the public hackathon board SSE stream (`GET /api/v1/hackathons/:hackathonId/events`),
 * tracks real stream connection status, preserves opaque BIGINT event IDs as strings,
 * and triggers a debounced callback when board updates arrive.
 */
export function useBoardEvents(params: {
  hackathonIdOrSlug: string | null;
  enabled?: boolean;
  onBoardChanged: (latestEvent: PublicBoardSseEventPayload) => void;
}): {
  connectionState: SseConnectionState;
  lastEventId: string | null;
} {
  const [connectionState, setConnectionState] = useState<SseConnectionState>('offline');
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const onChangedRef = useRef(params.onBoardChanged);
  onChangedRef.current = params.onBoardChanged;

  useEffect(() => {
    if (!params.hackathonIdOrSlug || params.enabled === false) {
      setConnectionState('offline');
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let latestPayload: PublicBoardSseEventPayload | null = null;

    const disconnect = connectBoardEventStream({
      hackathonIdOrSlug: params.hackathonIdOrSlug,
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
            onChangedRef.current(latestPayload);
          }
        }, 160);
      },
    });

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      disconnect();
    };
  }, [params.hackathonIdOrSlug, params.enabled]);

  return { connectionState, lastEventId };
}
