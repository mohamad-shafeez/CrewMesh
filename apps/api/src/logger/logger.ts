import type { FastifyLoggerOptions } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';

/**
 * Sensitive fields that must NEVER appear in application logs.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'res.headers["x-csrf-token"]',
  'body.password',
  'body.passwordHash',
  'body.token',
  'body.inviteToken',
  'body.sessionToken',
  'body.csrfToken',
  'password',
  'password_hash',
  'token',
  'token_hash',
  'csrf_token_hash',
  'sessionToken',
  'csrfToken',
  'inviteToken',
];

/**
 * Builds Fastify/Pino structured logger options with strict secret redaction.
 */
export function buildLoggerOptions(
  level: string,
  nodeEnv: 'development' | 'test' | 'production',
): FastifyLoggerOptions & PinoLoggerOptions {
  return {
    level: nodeEnv === 'test' && level === 'info' ? 'warn' : level,
    redact: {
      paths: REDACTED_LOG_PATHS,
      censor: '[REDACTED]',
    },
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          remoteAddress: request.ip,
        };
      },
      res(reply) {
        return {
          statusCode: reply.statusCode,
        };
      },
    },
  };
}
