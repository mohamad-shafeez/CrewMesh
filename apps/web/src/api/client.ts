import {
  canonicalJsonStringify,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type AuthSessionResponse,
  type HackathonSummary,
  type LoginRequestDto,
  type PublicBoardSseEventPayload,
  type PublicUserProfile,
  type RegisterRequestDto,
  type TeamStreamSseEventPayload,
  type UpdateProfileRequestDto,
} from '@crewmesh/shared';

let activeCsrfToken: string | null = null;

export function getActiveCsrfToken(): string | null {
  return activeCsrfToken;
}

export function setActiveCsrfToken(token: string | null): void {
  activeCsrfToken = token;
}

/**
 * Logical User Action Idempotency Key Manager (Section 15 of Batch 04)
 * - Generates one Idempotency-Key per logical user action (`operationScope`).
 * - If a network error occurs and the user retries with the exact same payload,
 *   returns the SAME Idempotency-Key so the backend will never duplicate the mutation.
 * - If the payload changes, generates a new key for the new logical operation.
 * - Clears the stored key once a terminal HTTP response is received.
 */
interface PendingIdempotencyEntry {
  key: string;
  canonicalPayload: string;
}

const pendingIdempotencyKeys = new Map<string, PendingIdempotencyEntry>();

function generateRandomIdempotencyKey(prefix = 'idem'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  const randomPart = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${randomPart}`;
}

export function getOrCreateIdempotencyKey(operationScope: string, payload: unknown): string {
  const canonical = canonicalJsonStringify(payload ?? null);
  const existing = pendingIdempotencyKeys.get(operationScope);
  if (existing && existing.canonicalPayload === canonical) {
    return existing.key;
  }
  const freshKey = generateRandomIdempotencyKey('cm');
  pendingIdempotencyKeys.set(operationScope, {
    key: freshKey,
    canonicalPayload: canonical,
  });
  return freshKey;
}

export function clearIdempotencyKey(operationScope: string): void {
  pendingIdempotencyKeys.delete(operationScope);
}

export function resetAllIdempotencyKeys(): void {
  pendingIdempotencyKeys.clear();
}

const USER_FRIENDLY_ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  TEAM_NOT_FOUND: 'This team could not be found (it may have been deleted when its last member left).',
  TEAM_FULL: 'This team has reached its maximum member capacity.',
  TEAM_NOT_RECRUITING: 'This team is not currently accepting new join requests.',
  TEAM_NAME_ALREADY_EXISTS: 'A team with this name already exists in this hackathon.',
  INVALID_TEAM_SIZE: 'The requested team size limits are outside the hackathon bounds.',
  ALREADY_IN_TEAM: 'A participant can belong to only one team per hackathon.',
  NOT_A_TEAM_MEMBER: 'You must be an active member of this team to perform this action.',
  MEMBER_NOT_FOUND: 'The specified participant is no longer a member of this team.',
  JOIN_REQUEST_NOT_FOUND: 'This join request could not be found.',
  JOIN_REQUEST_ALREADY_EXISTS: 'You already have a pending join request for this team.',
  JOIN_REQUEST_ALREADY_PROCESSED: 'This join request has already been accepted or declined.',
  UNAUTHORIZED_TEAM_ACTION: 'Only the current team leader is authorized to perform this action.',
  LEADER_MUST_USE_LEAVE:
    'As team leader, use the Leave Team action so leadership transfers atomically to the next member.',
  INVALID_INVITE_CODE: 'The invitation code is invalid. Please double-check the code with the team leader.',
  INVITE_EXPIRED: 'This invitation code has expired.',
  INVITE_REVOKED: 'This invitation code was revoked by the team leader.',
  INVITE_MAX_USES_REACHED: 'This invitation code has reached its maximum usage limit.',
  IDEMPOTENCY_KEY_REQUIRED: 'Request is missing a required idempotency token. Please retry.',
  IDEMPOTENCY_KEY_REUSED:
    'This action token was already used with different form data. Please submit again.',
  HACKATHON_REGISTRATION_CLOSED: 'Team formation for this hackathon is currently closed.',
  EMAIL_ALREADY_REGISTERED: 'An account with this email address is already registered.',
  INVALID_CREDENTIALS: 'Invalid email address or password.',
  RATE_LIMITED: 'Too many requests in a short window. Please wait a moment and try again.',
};

export class ApiClientError extends Error {
  public readonly statusCode: number;
  public readonly code: ApiErrorCode | string;
  public readonly requestId: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ApiErrorCode | string,
    message: string,
    requestId: string,
    details?: Record<string, unknown>,
  ) {
    const friendly =
      USER_FRIENDLY_ERROR_MESSAGES[code as ApiErrorCode] ?? message;
    super(friendly);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    idempotencyScope?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (method !== 'GET' && activeCsrfToken) {
    headers['X-CSRF-Token'] = activeCsrfToken;
  }

  const resolvedIdempotencyKey =
    options.idempotencyKey ??
    (options.idempotencyScope
      ? getOrCreateIdempotencyKey(options.idempotencyScope, {
          path,
          method,
          body: options.body ?? null,
        })
      : undefined);

  if (resolvedIdempotencyKey) {
    headers['Idempotency-Key'] = resolvedIdempotencyKey;
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    signal: options.signal,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const csrfFromHeader = response.headers.get('x-csrf-token');
  if (csrfFromHeader) {
    activeCsrfToken = csrfFromHeader;
  }

  const payload = (await response.json().catch(() => null)) as
    | (T & Partial<ApiErrorEnvelope>)
    | null;

  // Clear pending idempotency key once the server returns a terminal response (2xx or 4xx)
  if (options.idempotencyScope && response.status < 500) {
    clearIdempotencyKey(options.idempotencyScope);
  }

  if (!response.ok) {
    const errObj = payload?.error;
    throw new ApiClientError(
      response.status,
      errObj?.code ?? 'INTERNAL_ERROR',
      errObj?.message ?? `Request failed with HTTP ${response.status}`,
      errObj?.requestId ?? 'unknown',
      errObj?.details,
    );
  }

  return payload as T;
}

// Re-export core auth & hackathon helpers for backwards compatibility with existing callers
export async function fetchCurrentHackathon(): Promise<HackathonSummary> {
  const res = await apiRequest<{ hackathon: HackathonSummary }>('/api/v1/hackathons/current');
  return res.hackathon;
}

export async function fetchCurrentUser(): Promise<AuthSessionResponse | null> {
  try {
    const res = await apiRequest<AuthSessionResponse>('/api/v1/auth/me');
    if (res.csrfToken) {
      activeCsrfToken = res.csrfToken;
    }
    return res;
  } catch (err) {
    if (err instanceof ApiClientError && err.statusCode === 401) {
      activeCsrfToken = null;
      return null;
    }
    throw err;
  }
}

export async function registerAccount(input: RegisterRequestDto): Promise<AuthSessionResponse> {
  const res = await apiRequest<AuthSessionResponse>('/api/v1/auth/register', {
    method: 'POST',
    body: input,
  });
  activeCsrfToken = res.csrfToken;
  return res;
}

export async function loginAccount(input: LoginRequestDto): Promise<AuthSessionResponse> {
  const res = await apiRequest<AuthSessionResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: input,
  });
  activeCsrfToken = res.csrfToken;
  return res;
}

export async function logoutAccount(): Promise<void> {
  await apiRequest<{ loggedOut: boolean }>('/api/v1/auth/logout', {
    method: 'POST',
  });
  activeCsrfToken = null;
}

export async function updateProfile(
  input: UpdateProfileRequestDto,
): Promise<{ user: PublicUserProfile }> {
  return apiRequest<{ user: PublicUserProfile }>('/api/v1/auth/profile', {
    method: 'PATCH',
    body: input,
  });
}

export type { PublicBoardSseEventPayload, TeamStreamSseEventPayload };
