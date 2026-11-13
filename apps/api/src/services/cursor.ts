import { AppError } from '../plugins/error-handler.js';

export interface KeysetCursor {
  createdAt: string;
  id: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encodes a `(createdAt, id)` pair into an opaque base64url keyset cursor.
 */
export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a base64url keyset cursor. Throws 400 VALIDATION_ERROR on tampered input.
 */
export function decodeKeysetCursor(rawCursor: string): KeysetCursor {
  try {
    const json = Buffer.from(rawCursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<KeysetCursor>;
    if (
      !parsed ||
      typeof parsed.createdAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string' ||
      !UUID_REGEX.test(parsed.id)
    ) {
      throw new Error('Invalid cursor fields');
    }
    return {
      createdAt: new Date(parsed.createdAt).toISOString(),
      id: parsed.id,
    };
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
}
