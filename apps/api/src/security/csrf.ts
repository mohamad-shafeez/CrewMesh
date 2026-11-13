import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnv } from '../config/env.js';
import { verifyCsrfTokenHash } from './crypto.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Extracts normalized origin (`protocol//host`) from an Origin or Referer header URL.
 */
export function extractNormalizedOrigin(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }
  try {
    const parsed = new URL(headerValue);
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Validates that a state-changing request originates from the configured APP_ORIGIN
 * (or the same host in same-origin production deployments).
 */
export function isAllowedOrigin(
  originHeader: string | undefined,
  refererHeader: string | undefined,
  configuredAppOrigin: string,
  requestHostHeader?: string,
): boolean {
  const allowedOrigins = new Set<string>();
  const normalizedAppOrigin = extractNormalizedOrigin(configuredAppOrigin);
  if (normalizedAppOrigin) {
    allowedOrigins.add(normalizedAppOrigin);
  }
  if (requestHostHeader) {
    allowedOrigins.add(`http://${requestHostHeader}`);
    allowedOrigins.add(`https://${requestHostHeader}`);
  }

  const candidateOrigin =
    extractNormalizedOrigin(originHeader) ?? extractNormalizedOrigin(refererHeader);

  if (!candidateOrigin) {
    return false;
  }
  return allowedOrigins.has(candidateOrigin);
}

/**
 * Fastify preHandler enforcing:
 * 1. Same-origin `Origin` (or `Referer`) verification on all state-changing requests.
 * 2. Constant-time `X-CSRF-Token` validation for cookie-authenticated state-changing requests.
 */
export async function enforceCsrfAndOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) {
    return;
  }

  const env = getEnv();
  const originHeader = request.headers.origin;
  const refererHeader = request.headers.referer;

  if (!isAllowedOrigin(originHeader, refererHeader, env.APP_ORIGIN, request.headers.host)) {
    return reply.status(403).send({
      error: {
        code: 'ORIGIN_INVALID',
        message: 'Cross-origin state-changing requests are not permitted',
        requestId: request.id,
      },
    });
  }

  // If the endpoint requires an authenticated session (or a session is active on a protected route),
  // require a valid X-CSRF-Token header matching the session's csrf_token_hash.
  if (request.authSession) {
    const csrfHeader = request.headers['x-csrf-token'];
    const tokenValue = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;

    if (!verifyCsrfTokenHash(tokenValue, request.authSession.csrfTokenHash)) {
      return reply.status(403).send({
        error: {
          code: 'CSRF_INVALID',
          message: 'Missing or invalid CSRF token for state-changing request',
          requestId: request.id,
        },
      });
    }
  }
}
