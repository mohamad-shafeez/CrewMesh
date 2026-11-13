import React from 'react';
import type { SseConnectionState } from '../api/events.js';

interface SseStatusBadgeProps {
  state: SseConnectionState;
  label?: string;
}

export function SseStatusBadge({
  state,
  label = 'Stream',
}: SseStatusBadgeProps): React.JSX.Element {
  const modifier =
    state === 'live'
      ? 'sse-status-pill--live'
      : state === 'reconnecting' || state === 'connecting'
        ? 'sse-status-pill--reconnecting'
        : '';

  const statusText =
    state === 'live'
      ? 'Live'
      : state === 'reconnecting'
        ? 'Reconnecting'
        : state === 'connecting'
          ? 'Connecting'
          : 'Offline';

  return (
    <span className={`sse-status-pill ${modifier}`} role="status" aria-live="polite">
      <span className="sse-status-dot" aria-hidden="true" />
      <span>
        {label}: {statusText}
      </span>
    </span>
  );
}
