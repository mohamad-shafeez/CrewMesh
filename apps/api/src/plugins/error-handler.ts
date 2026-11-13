import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiErrorCode } from '@crewmesh/shared';
import { getEnv } from '../config/env.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ApiErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const env = getEnv();

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }

    if (error instanceof ZodError) {
      const fieldIssues: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const key = issue.path.join('.') || '_root';
        const list = fieldIssues[key] ?? [];
        list.push(issue.message);
        fieldIssues[key] = list;
      }

      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          requestId: request.id,
          details: { fields: fieldIssues },
        },
      });
    }

    const fastifyErr = error as FastifyError;
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return reply.status(fastifyErr.statusCode).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: fastifyErr.message || 'Invalid request payload',
          requestId: request.id,
        },
      });
    }

    request.log.error(
      {
        err: {
          name: error.name,
          message: error.message,
          ...(env.NODE_ENV !== 'production' ? { stack: error.stack } : {}),
        },
        requestId: request.id,
      },
      'Unhandled API error',
    );

    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected internal server error occurred',
        requestId: request.id,
      },
    });
  });
}
