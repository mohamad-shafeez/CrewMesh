import crypto from 'node:crypto';
import argon2 from 'argon2';

/**
 * Argon2id parameters aligned with OWASP recommendations:
 * 64 MiB memory, 3 iterations, parallelism 4.
 */
const ARGON2_OPTIONS: argon2.Options & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
};

/**
 * Hashes a plaintext password using Argon2id.
 */
export async function hashPassword(plaintextPassword: string): Promise<string> {
  return argon2.hash(plaintextPassword, ARGON2_OPTIONS);
}

/**
 * Verifies a plaintext password against a stored Argon2id hash.
 */
export async function verifyPassword(
  storedHash: string,
  plaintextPassword: string,
): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plaintextPassword);
  } catch {
    return false;
  }
}

/**
 * Generates a cryptographically random URL-safe token with 256 bits (32 bytes) of entropy.
 */
export function generateOpaqueToken(byteLength = 32): string {
  if (byteLength < 24) {
    throw new Error('Token entropy must be at least 192 bits (24 bytes)');
  }
  return crypto.randomBytes(byteLength).toString('base64url');
}

/**
 * Computes a lowercase hex-encoded SHA-256 hash of a token or payload string.
 */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Derives a session-bound CSRF token using HMAC-SHA256(csrfSecret, sessionTokenHash).
 * This allows GET /api/v1/auth/me to return the active CSRF token after browser reloads
 * while storing only the one-way SHA-256 hash of the CSRF token in PostgreSQL.
 */
export function deriveCsrfToken(sessionTokenHash: string, csrfSecret: string): string {
  return crypto
    .createHmac('sha256', csrfSecret)
    .update(`crewmesh-csrf:${sessionTokenHash}`, 'utf8')
    .digest('base64url');
}

/**
 * Verifies a caller-supplied X-CSRF-Token against the session's stored csrf_token_hash
 * in constant time.
 */
export function verifyCsrfTokenHash(
  providedCsrfToken: string | undefined,
  expectedCsrfTokenHash: string,
): boolean {
  if (!providedCsrfToken || typeof providedCsrfToken !== 'string') {
    return false;
  }
  const providedHash = sha256Hex(providedCsrfToken);
  if (providedHash.length !== expectedCsrfTokenHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(providedHash, 'utf8'),
    Buffer.from(expectedCsrfTokenHash, 'utf8'),
  );
}
