import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATIC_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Builds and configures the Fastify API instance.
 * When `SERVE_WEB_DIST=true` (or in production when `apps/web/dist/index.html` is present),
 * also serves the built React SPA under the same origin so `SameSite=Lax` cookies,
 * CSRF `Origin` checks, and native `EventSource` SSE streams work under a single origin.
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

  const webDistDir = path.resolve(__dirname, '../../../web/dist');
  const webIndexHtml = path.join(webDistDir, 'index.html');
  const shouldServeStaticWeb =
    (process.env.SERVE_WEB_DIST === 'true' || env.NODE_ENV === 'production') &&
    fs.existsSync(webIndexHtml);

  if (shouldServeStaticWeb) {
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD'
      ) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Route ${request.method}:${request.url} not found`,
            requestId: request.id,
          },
        });
      }

      const rawPath = (request.url.split('?')[0] ?? '/').replace(/^\/+/, '');
      if (rawPath.startsWith('api/') || rawPath === 'api') {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `API route ${request.method}:${request.url} not found`,
            requestId: request.id,
          },
        });
      }

      const resolvedCandidate = path.resolve(webDistDir, rawPath);
      if (
        rawPath.length > 0 &&
        resolvedCandidate.startsWith(webDistDir) &&
        fs.existsSync(resolvedCandidate) &&
        fs.statSync(resolvedCandidate).isFile()
      ) {
        const ext = path.extname(resolvedCandidate).toLowerCase();
        const contentType = STATIC_MIME_TYPES[ext] ?? 'application/octet-stream';
        if (resolvedCandidate.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
        return reply.type(contentType).send(fs.readFileSync(resolvedCandidate));
      }

      // SPA history-API fallback
      reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html; charset=utf-8').send(fs.readFileSync(webIndexHtml));
    });
  }

  return app;
}
