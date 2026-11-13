import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PublicUserProfile } from '@crewmesh/shared';
import { getEnv } from '../config/env.js';
import { getDbPool } from '../db/pool.js';
import { deriveCsrfToken, sha256Hex } from '../security/crypto.js';
import { enforceCsrfAndOrigin } from '../security/csrf.js';
import { AppError } from './error-handler.js';

export interface AuthenticatedSessionContext {
  sessionId: string;
  sessionTokenHash: string;
  csrfTokenHash: string;
  csrfToken: string;
  expiresAt: string;
  user: PublicUserProfile;
}

declare module 'fastify' {
  interface FastifyRequest {
    authSession: AuthenticatedSessionContext | null;
  }
}

interface SessionLookupRow {
  session_id: string;
  token_hash: string;
  csrf_token_hash: string;
  expires_at: Date;
  user_id: string;
  email: string;
  display_name: string;
  skills: string[];
  timezone: string | null;
  timezone_confirmed_at: Date | null;
  bio: string;
  user_created_at: Date;
  user_updated_at: Date;
}

/**
 * Parses a raw Cookie header string into a key-value map.
 */
export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) {
    return result;
  }
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }
    const rawKey = pair.slice(0, eqIdx).trim();
    const rawVal = pair.slice(eqIdx + 1).trim();
    if (rawKey) {
      try {
        result[rawKey] = decodeURIComponent(rawVal);
      } catch {
        result[rawKey] = rawVal;
      }
    }
  }
  return result;
}

/**
 * Formats a Set-Cookie header string with HttpOnly, SameSite=Lax, Path=/, and Secure in production.
 */
export function serializeSessionCookie(params: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string {
  const parts = [
    `${params.name}=${encodeURIComponent(params.value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(params.maxAgeSeconds))}`,
  ];
  if (params.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Registers session hydration on every request and provides the `requireAuth` preHandler.
 */
export function registerAuthSession(app: FastifyInstance): void {
  app.decorateRequest('authSession', null);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.authSession = null;

    const env = getEnv();
    const cookies = parseCookieHeader(request.headers.cookie);
    const rawSessionToken = cookies[env.SESSION_COOKIE_NAME];

    if (!rawSessionToken || rawSessionToken.length < 16) {
      return;
    }

    const tokenHash = sha256Hex(rawSessionToken);
    const pool = getDbPool();

    const res = await pool.query<SessionLookupRow>(
      `
      SELECT
        s.id AS session_id,
        s.token_hash,
        s.csrf_token_hash,
        s.expires_at,
        u.id AS user_id,
        u.email,
        u.display_name,
        u.skills,
        u.timezone,
        u.timezone_confirmed_at,
        u.bio,
        u.created_at AS user_created_at,
        u.updated_at AS user_updated_at
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1
      `,
      [tokenHash],
    );

    const row = res.rows[0];
    if (!row) {
      return;
    }

    const csrfToken = deriveCsrfToken(row.token_hash, env.CSRF_SECRET);
    const isConfirmed = row.timezone !== null && row.timezone_confirmed_at !== null;
    const confirmedIso =
      isConfirmed && row.timezone_confirmed_at
        ? row.timezone_confirmed_at instanceof Date
          ? row.timezone_confirmed_at.toISOString()
          : String(row.timezone_confirmed_at)
        : null;

    request.authSession = {
      sessionId: row.session_id,
      sessionTokenHash: row.token_hash,
      csrfTokenHash: row.csrf_token_hash,
      csrfToken,
      expiresAt:
        row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
      user: {
        id: row.user_id,
        email: row.email,
        displayName: row.display_name,
        skills: Array.isArray(row.skills) ? row.skills : [],
        timezone: isConfirmed ? row.timezone : null,
        timezoneConfirmed: isConfirmed,
        timezoneConfirmedAt: confirmedIso,
        bio: row.bio,
        createdAt:
          row.user_created_at instanceof Date
            ? row.user_created_at.toISOString()
            : String(row.user_created_at),
        updatedAt:
          row.user_updated_at instanceof Date
            ? row.user_updated_at.toISOString()
            : String(row.user_updated_at),
      },
    };
  });

  // Enforce same-origin and CSRF token verification on state-changing requests
  app.addHook('preHandler', enforceCsrfAndOrigin);
}

/**
 * Guard preHandler that rejects unauthenticated requests with 401 UNAUTHORIZED.
 */
export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.authSession) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required to access this resource');
  }
}
