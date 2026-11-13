/**
 * @crewmesh/shared
 * Shared domain types, error codes, normalization helpers, and API contracts.
 */

export type TeamStatus = 'forming' | 'ready';
export type TeamRole = 'leader' | 'member';
export type JoinRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
export type JoinRequestSource = 'board' | 'invite_code';
export type HackathonParticipantStatus = 'registered' | 'withdrawn' | 'disqualified';

export type AuditAction =
  | 'TEAM_CREATED'
  | 'TEAM_PREFERENCES_UPDATED'
  | 'JOIN_REQUEST_CREATED'
  | 'JOIN_REQUEST_ACCEPTED'
  | 'JOIN_REQUEST_DECLINED'
  | 'INVITE_CREATED'
  | 'INVITE_REVOKED'
  | 'INVITE_REDEEMED'
  | 'MEMBER_ADDED'
  | 'MEMBER_REMOVED'
  | 'MEMBER_LEFT'
  | 'LEADER_SUCCESSION'
  | 'TEAM_DELETED';

export type OutboxEventType =
  | 'TEAM_CREATED'
  | 'TEAM_UPDATED'
  | 'TEAM_PREFERENCES_UPDATED'
  | 'TEAM_DELETED'
  | 'JOIN_REQUEST_CREATED'
  | 'JOIN_REQUEST_ACCEPTED'
  | 'JOIN_REQUEST_DECLINED'
  | 'INVITE_CREATED'
  | 'INVITE_REVOKED'
  | 'MEMBER_JOINED'
  | 'MEMBER_REMOVED'
  | 'MEMBER_LEFT'
  | 'LEADER_SUCCESSION';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CSRF_INVALID'
  | 'ORIGIN_INVALID'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'NOT_FOUND'
  | 'HACKATHON_NOT_FOUND'
  | 'HACKATHON_INACTIVE'
  | 'HACKATHON_REGISTRATION_CLOSED'
  | 'NOT_HACKATHON_PARTICIPANT'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_FULL'
  | 'TEAM_NOT_RECRUITING'
  | 'TEAM_NAME_ALREADY_EXISTS'
  | 'INVALID_TEAM_SIZE'
  | 'ALREADY_IN_TEAM'
  | 'NOT_A_TEAM_MEMBER'
  | 'MEMBER_NOT_FOUND'
  | 'JOIN_REQUEST_NOT_FOUND'
  | 'JOIN_REQUEST_ALREADY_EXISTS'
  | 'JOIN_REQUEST_ALREADY_PROCESSED'
  | 'UNAUTHORIZED_TEAM_ACTION'
  | 'LEADER_MUST_USE_LEAVE'
  | 'INVALID_INVITE_CODE'
  | 'INVITE_EXPIRED'
  | 'INVITE_REVOKED'
  | 'INVITE_MAX_USES_REACHED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export interface PublicUserProfile {
  id: string;
  email: string;
  displayName: string;
  skills: string[];
  /**
   * Confirmed IANA time zone, or `null` if the participant has not explicitly confirmed a time zone.
   * Unconfirmed legacy defaults are never exposed as confirmed UTC.
   */
  timezone: string | null;
  timezoneConfirmed: boolean;
  timezoneConfirmedAt: string | null;
  bio: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Privacy-safe participant representation for public team boards and member lists.
 * Never includes email, password_hash, or session metadata.
 * `timezone` is `null` unless explicitly confirmed by the participant (`timezone_confirmed_at IS NOT NULL`).
 */
export interface PublicMemberSummary {
  userId: string;
  displayName: string;
  skills: string[];
  timezone: string | null;
  bio: string;
  role: TeamRole;
  joinedAt: string;
}

export interface TeamDetailsDto {
  id: string;
  hackathonId: string;
  name: string;
  description: string;
  desiredSkills: string[];
  leaderUserId: string;
  leader: PublicMemberSummary;
  status: TeamStatus;
  isFull: boolean;
  memberCount: number;
  minTeamSize: number;
  maxTeamSize: number;
  availableSeats: number;
  lookingForMembers: boolean;
  members: PublicMemberSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamViewerContextDto {
  myTeamIdInHackathon: string | null;
  myRoleInTeam: TeamRole | null;
  myJoinRequestForTeam: JoinRequestDto | null;
}

export interface TeamDetailResponseDto {
  team: TeamDetailsDto;
  viewerContext?: TeamViewerContextDto | null;
}

export interface TeamBoardPageResponse {
  items: TeamDetailsDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface JoinRequestDto {
  id: string;
  teamId: string;
  hackathonId: string;
  userId: string;
  source: JoinRequestSource;
  inviteCodeId?: string | null;
  message: string;
  status: JoinRequestStatus;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  applicant?: {
    userId: string;
    displayName: string;
    skills: string[];
    timezone: string | null;
    bio: string;
  };
}

export interface JoinRequestInboxPageResponse {
  items: JoinRequestDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface InviteCodeCreatedDto {
  id: string;
  teamId: string;
  hackathonId: string;
  code: string;
  tokenPrefix: string;
  maxUses: number | null;
  useCount: number;
  expiresAt: string;
  createdAt: string;
}

/**
 * Leader-visible invitation metadata returned by GET /api/v1/teams/:teamId/invites.
 * Never includes plaintext code or token_hash.
 */
export interface InviteCodeMetadataDto {
  id: string;
  teamId: string;
  hackathonId: string;
  tokenPrefix: string;
  createdByUserId: string;
  maxUses: number | null;
  useCount: number;
  expiresAt: string;
  revokedAt: string | null;
  isRevoked: boolean;
  isExpired: boolean;
  isExhausted: boolean;
  createdAt: string;
}

export interface InviteCodeListResponse {
  invites: InviteCodeMetadataDto[];
}

export interface InviteRedeemResultDto {
  joinRequest: JoinRequestDto;
}

/**
 * Batch 05 & 06 — Teammate Suggestion Algorithm Constants & Contracts (crewmesh-match-v1)
 */
export const CREWMESH_MATCH_ALGORITHM_VERSION = 'crewmesh-match-v1' as const;

export const CREWMESH_MATCH_WEIGHTS = {
  skill: 70,
  timezone: 30,
} as const;

export type ScoreComponentKey = 'skill' | 'timezone';

export type SkillSignalStatus =
  | 'available'
  | 'no_team_desired_skills'
  | 'all_desired_skills_covered';

export interface SuggestedTeammateCandidateDto {
  userId: string;
  displayName: string;
  skills: string[];
  timezone: string | null;
  overallScore: number;
  skillScore: number | null;
  timezoneScore: number | null;
  scoreComponentsUsed: ScoreComponentKey[];
  matchedDesiredSkills: string[];
  unmetDesiredSkills: string[];
  explanation: string[];
}

export interface TimezoneEvidenceDiagnosticsDto {
  teamMembersCount: number;
  confirmedTeamMembersCount: number;
  unconfirmedTeamMembersCount: number;
  eligibleCandidatesWithConfirmedTimezone: number;
  eligibleCandidatesWithUnconfirmedTimezone: number;
}

export interface TeammateSuggestionsResponseDto {
  teamId: string;
  hackathonId: string;
  algorithmVersion: typeof CREWMESH_MATCH_ALGORITHM_VERSION;
  calculatedAt: string;
  scoring: {
    weights: {
      skill: number;
      timezone: number;
    };
    timezoneMethod: 'current-utc-offset-proximity';
    limitation: string;
  };
  teamSkillSummary: {
    desiredSkills: string[];
    coveredDesiredSkills: string[];
    unmetDesiredSkills: string[];
  };
  candidates: SuggestedTeammateCandidateDto[];
  diagnostics: {
    eligibleCandidatesEvaluated: number;
    excludedAlreadyInTeam: number;
    excludedExistingRequests: number;
    unrankableProfiles: number;
    skillSignal: SkillSignalStatus;
    timezoneEvidence: TimezoneEvidenceDiagnosticsDto;
  };
}

export interface UpdateTeamPreferencesRequestDto {
  desiredSkills: string[];
  lookingForMembers?: boolean;
}

/**
 * Public board SSE notification payload (never contains private applicant or invite details).
 */
export interface PublicBoardSseEventPayload {
  eventId: string;
  eventType: OutboxEventType;
  hackathonId: string;
  teamId: string | null;
  status?: TeamStatus;
  memberCount?: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  isFull?: boolean;
  createdAt: string;
}

/**
 * Authorized private team SSE notification payload.
 */
export interface TeamStreamSseEventPayload {
  eventId: string;
  eventType: OutboxEventType;
  hackathonId: string;
  teamId: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AuthSessionResponse {
  user: PublicUserProfile;
  csrfToken: string;
  sessionExpiresAt: string;
}

export interface HackathonSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  minTeamSize: number;
  maxTeamSize: number;
  registrationDeadline: string | null;
  isActive: boolean;
}

export interface RegisterRequestDto {
  email: string;
  password: string;
  displayName: string;
  skills?: string[];
  timezone?: string | null;
  bio?: string;
  hackathonId?: string;
  enrollInActiveHackathon?: boolean;
}

export interface LoginRequestDto {
  email: string;
  password: string;
}

export interface UpdateProfileRequestDto {
  displayName?: string;
  skills?: string[];
  timezone?: string | null;
  bio?: string;
}

/**
 * Normalizes an email address to canonical lowercase trimmed form.
 */
export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().toLowerCase();
}

/**
 * Normalizes a list of skill tags: lowercase, trimmed, deduplicated, non-empty.
 */
export function normalizeSkillTags(rawSkills: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawSkills) {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-');
    if (cleaned.length >= 1 && cleaned.length <= 40 && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}

/**
 * Validates whether a string is a valid IANA time zone identifier using Intl.DateTimeFormat.
 */
export function isValidIanaTimeZone(tz: string): boolean {
  const trimmed = tz.trim();
  if (trimmed.length < 2 || trimmed.length > 64) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes team status ('forming' vs 'ready') from current member count and minimum team size.
 */
export function computeTeamStatus(memberCount: number, minTeamSize: number): TeamStatus {
  return memberCount >= minTeamSize ? 'ready' : 'forming';
}

/**
 * Produces a deterministic canonical JSON string with recursively sorted object keys
 * for binding idempotency keys to exact request payloads.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const pairs = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`,
  );
  return `{${pairs.join(',')}}`;
}
