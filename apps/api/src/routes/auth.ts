import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  isValidIanaTimeZone,
  normalizeEmail,
  normalizeSkillTags,
  type PublicUserProfile,
} from '@crewmesh/shared';
import { getEnv } from '../config/env.js';
import { getDbPool, withTransaction } from '../db/pool.js';
import {
  parseCookieHeader,
  requireAuth,
  serializeSessionCookie,
} from '../plugins/auth-session.js';
import { AppError } from '../plugins/error-handler.js';
import {
  deriveCsrfToken,
  generateOpaqueToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from '../security/crypto.js';
import { consumeRateLimitBucket } from '../security/rate-limit.js';

const registerBodySchema = z.object({
  email: z
    .string()
    .min(3)
    .max(254)
    .transform(normalizeEmail)
    .refine((val) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val), 'Must be a valid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must not exceed 128 characters'),
  displayName: z
    .string()
    .trim()
    .min(2, 'Display name must be at least 2 characters')
    .max(80, 'Display name must not exceed 80 characters'),
  skills: z.array(z.string()).max(25).optional().default([]),
  timezone: z
    .string()
    .trim()
    .default('UTC')
    .refine(isValidIanaTimeZone, 'Must be a valid IANA time zone (e.g. Asia/Kolkata, UTC)'),
  bio: z.string().trim().max(500).optional().default(''),
});

const loginBodySchema = z.object({
  email: z.string().min(1).max(254).transform(normalizeEmail),
  password: z.string().min(1).max(128),
});

const updateProfileBodySchema = z.object({
  displayName: z.string().trim().min(2).max(80).optional(),
  skills: z.array(z.string()).max(25).optional(),
  timezone: z
    .string()
    .trim()
    .refine(isValidIanaTimeZone, 'Must be a valid IANA time zone')
    .optional(),
  bio: z.string().trim().max(500).optional(),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  skills: string[];
  timezone: string;
  bio: string;
  created_at: Date;
  updated_at: Date;
}

function mapUserToPublicProfile(row: UserRow): PublicUserProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    skills: Array.isArray(row.skills) ? row.skills : [],
    timezone: row.timezone,
    bio: row.bio,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/auth/register
   * Normalizes email, hashes password with Argon2id, creates user and initial session transactionally.
   */
  app.post('/api/v1/auth/register', async (request, reply) => {
    const env = getEnv();
    const body = registerBodySchema.parse(request.body);
    const normalizedSkills = normalizeSkillTags(body.skills);

    // Rate limit registration attempts by IP
    const ipLimit = await consumeRateLimitBucket({
      scope: 'auth_ip',
      identifier: `register:${request.ip}`,
      limit: 20,
      windowSeconds: 60,
    });
    if (!ipLimit.allowed) {
      reply.header('Retry-After', String(ipLimit.retryAfterSeconds));
      throw new AppError(429, 'RATE_LIMITED', 'Too many registration attempts. Please try again later.');
    }

    const passwordHash = await hashPassword(body.password);
    const rawSessionToken = generateOpaqueToken(32);
    const sessionTokenHash = sha256Hex(rawSessionToken);
    const csrfToken = deriveCsrfToken(sessionTokenHash, env.CSRF_SECRET);
    const csrfTokenHash = sha256Hex(csrfToken);
    const ttlSeconds = env.SESSION_TTL_HOURS * 3600;

    try {
      const result = await withTransaction(async (client) => {
        const userRes = await client.query<UserRow>(
          `
          INSERT INTO users (email, password_hash, display_name, skills, timezone, bio)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, email, password_hash, display_name, skills, timezone, bio, created_at, updated_at
          `,
          [body.email, passwordHash, body.displayName, normalizedSkills, body.timezone, body.bio],
        );

        const userRow = userRes.rows[0];
        if (!userRow) {
          throw new Error('Failed to insert user row');
        }

        const sessionRes = await client.query<{ expires_at: Date }>(
          `
          INSERT INTO sessions (user_id, token_hash, csrf_token_hash, ip_address, user_agent, expires_at)
          VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second'))
          RETURNING expires_at
          `,
          [
            userRow.id,
            sessionTokenHash,
            csrfTokenHash,
            request.ip,
            request.headers['user-agent'] ?? null,
            ttlSeconds,
          ],
        );

        const sessionRow = sessionRes.rows[0];
        return {
          user: mapUserToPublicProfile(userRow),
          expiresAt:
            sessionRow?.expires_at instanceof Date
              ? sessionRow.expires_at.toISOString()
              : new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        };
      });

      reply.header(
        'Set-Cookie',
        serializeSessionCookie({
          name: env.SESSION_COOKIE_NAME,
          value: rawSessionToken,
          maxAgeSeconds: ttlSeconds,
          secure: env.NODE_ENV === 'production',
        }),
      );
      reply.header('X-CSRF-Token', csrfToken);

      return reply.status(201).send({
        user: result.user,
        csrfToken,
        sessionExpiresAt: result.expiresAt,
      });
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'users_email_unique') {
        throw new AppError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'An account with this email address already exists',
        );
      }
      throw err;
    }
  });

  /**
   * POST /api/v1/auth/login
   * Verifies Argon2id password, revokes any prior session token on the request (session rotation),
   * and issues a fresh session cookie + CSRF token.
   */
  app.post('/api/v1/auth/login', async (request, reply) => {
    const env = getEnv();
    const body = loginBodySchema.parse(request.body);

    const ipLimit = await consumeRateLimitBucket({
      scope: 'auth_ip',
      identifier: `login:${request.ip}`,
      limit: 15,
      windowSeconds: 60,
    });
    if (!ipLimit.allowed) {
      reply.header('Retry-After', String(ipLimit.retryAfterSeconds));
      throw new AppError(429, 'RATE_LIMITED', 'Too many login attempts. Please try again later.');
    }

    const pool = getDbPool();
    const userRes = await pool.query<UserRow>(
      `
      SELECT id, email, password_hash, display_name, skills, timezone, bio, created_at, updated_at
      FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [body.email],
    );

    const userRow = userRes.rows[0];
    if (!userRow) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const validPassword = await verifyPassword(userRow.password_hash, body.password);
    if (!validPassword) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const cookies = parseCookieHeader(request.headers.cookie);
    const oldSessionToken = cookies[env.SESSION_COOKIE_NAME];
    const oldSessionTokenHash =
      oldSessionToken && oldSessionToken.length >= 16 ? sha256Hex(oldSessionToken) : null;

    const newSessionToken = generateOpaqueToken(32);
    const newSessionTokenHash = sha256Hex(newSessionToken);
    const csrfToken = deriveCsrfToken(newSessionTokenHash, env.CSRF_SECRET);
    const csrfTokenHash = sha256Hex(csrfToken);
    const ttlSeconds = env.SESSION_TTL_HOURS * 3600;

    const sessionExpiresAt = await withTransaction(async (client) => {
      if (oldSessionTokenHash) {
        await client.query(
          'UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
          [oldSessionTokenHash],
        );
      }

      const sessionRes = await client.query<{ expires_at: Date }>(
        `
        INSERT INTO sessions (user_id, token_hash, csrf_token_hash, ip_address, user_agent, expires_at)
        VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second'))
        RETURNING expires_at
        `,
        [
          userRow.id,
          newSessionTokenHash,
          csrfTokenHash,
          request.ip,
          request.headers['user-agent'] ?? null,
          ttlSeconds,
        ],
      );

      const exp = sessionRes.rows[0]?.expires_at;
      return exp instanceof Date
        ? exp.toISOString()
        : new Date(Date.now() + ttlSeconds * 1000).toISOString();
    });

    reply.header(
      'Set-Cookie',
      serializeSessionCookie({
        name: env.SESSION_COOKIE_NAME,
        value: newSessionToken,
        maxAgeSeconds: ttlSeconds,
        secure: env.NODE_ENV === 'production',
      }),
    );
    reply.header('X-CSRF-Token', csrfToken);

    return reply.status(200).send({
      user: mapUserToPublicProfile(userRow),
      csrfToken,
      sessionExpiresAt,
    });
  });

  /**
   * POST /api/v1/auth/logout
   * Revokes the current session in PostgreSQL and clears the session cookie.
   */
  app.post('/api/v1/auth/logout', { preHandler: [requireAuth] }, async (request, reply) => {
    const env = getEnv();
    const session = request.authSession!;
    const pool = getDbPool();

    await pool.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
      [session.sessionId],
    );

    reply.header(
      'Set-Cookie',
      serializeSessionCookie({
        name: env.SESSION_COOKIE_NAME,
        value: '',
        maxAgeSeconds: 0,
        secure: env.NODE_ENV === 'production',
      }),
    );

    return reply.status(200).send({
      loggedOut: true,
    });
  });

  /**
   * GET /api/v1/auth/me
   * Returns the currently authenticated user profile and CSRF token.
   */
  app.get('/api/v1/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const session = request.authSession!;
    reply.header('X-CSRF-Token', session.csrfToken);
    return reply.status(200).send({
      user: session.user,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.expiresAt,
    });
  });

  /**
   * PATCH /api/v1/auth/profile
   * Updates the authenticated user's display name, skills, IANA timezone, or bio.
   */
  app.patch('/api/v1/auth/profile', { preHandler: [requireAuth] }, async (request, reply) => {
    const session = request.authSession!;
    const body = updateProfileBodySchema.parse(request.body);

    const displayName = body.displayName ?? session.user.displayName;
    const skills =
      body.skills !== undefined ? normalizeSkillTags(body.skills) : session.user.skills;
    const timezone = body.timezone ?? session.user.timezone;
    const bio = body.bio ?? session.user.bio;

    const pool = getDbPool();
    const res = await pool.query<UserRow>(
      `
      UPDATE users
      SET
        display_name = $2,
        skills = $3,
        timezone = $4,
        bio = $5,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, email, password_hash, display_name, skills, timezone, bio, created_at, updated_at
      `,
      [session.user.id, displayName, skills, timezone, bio],
    );

    const updated = res.rows[0];
    if (!updated) {
      throw new AppError(404, 'NOT_FOUND', 'User account not found');
    }

    return reply.status(200).send({
      user: mapUserToPublicProfile(updated),
    });
  });
}
