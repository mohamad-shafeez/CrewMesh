import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { getEnv } from './config/env.js';
import { buildLoggerOptions } from './logger/logger.js';
import { registerAuthSession } from './plugins/auth-session.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerSecurityHeaders } from './plugins/security-headers.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerJoinRequestRoutes } from './routes/join-requests.js';
import { registerTeamRoutes } from './routes/teams.js';

/**
 * Builds and configures the Fastify API instance.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    logger: buildLoggerOptions(env.LOG_LEVEL, env.NODE_ENV),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 64 * 1024, // 64 KiB strict JSON body limit
    genReqId(req) {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(incoming)) {
        return incoming;
      }
      return `req_${crypto.randomUUID()}`;
    },
  });

  registerSecurityHeaders(app);
  registerErrorHandler(app);
  registerAuthSession(app);

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerTeamRoutes(app);
  await registerJoinRequestRoutes(app);
  await registerInviteRoutes(app);
  await registerEventRoutes(app);

  return app;
}
