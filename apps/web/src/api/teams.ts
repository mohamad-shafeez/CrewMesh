import type {
  HackathonSummary,
  JoinRequestDto,
  JoinRequestInboxPageResponse,
  JoinRequestStatus,
  TeamBoardPageResponse,
  TeamDetailResponseDto,
  TeamDetailsDto,
  TeammateSuggestionsResponseDto,
  TeamStatus,
  UpdateTeamPreferencesRequestDto,
} from '@crewmesh/shared';
import { apiRequest, fetchCurrentHackathon } from './client.js';

export { fetchCurrentHackathon };

export interface TeamBoardQueryFilters {
  cursor?: string;
  limit?: number;
  status?: TeamStatus;
  hasCapacity?: boolean;
  lookingForMembers?: boolean;
  skill?: string;
  search?: string;
}

export async function fetchTeamBoard(
  hackathonIdOrSlug: string,
  filters: TeamBoardQueryFilters = {},
  signal?: AbortSignal,
): Promise<TeamBoardPageResponse> {
  const searchParams = new URLSearchParams();
  if (filters.cursor) {
    searchParams.set('cursor', filters.cursor);
  }
  if (filters.limit !== undefined) {
    searchParams.set('limit', String(filters.limit));
  }
  if (filters.status) {
    searchParams.set('status', filters.status);
  }
  if (filters.hasCapacity !== undefined) {
    searchParams.set('hasCapacity', String(filters.hasCapacity));
  }
  if (filters.lookingForMembers !== undefined) {
    searchParams.set('lookingForMembers', String(filters.lookingForMembers));
  }
  if (filters.skill && filters.skill.trim().length > 0) {
    searchParams.set('skill', filters.skill.trim());
  }
  if (filters.search && filters.search.trim().length > 0) {
    searchParams.set('search', filters.search.trim());
  }

  const qs = searchParams.toString();
  const url = `/api/v1/hackathons/${encodeURIComponent(hackathonIdOrSlug)}/teams${qs ? `?${qs}` : ''}`;
  return apiRequest<TeamBoardPageResponse>(url, { signal });
}

export async function fetchTeamDetail(
  teamId: string,
  signal?: AbortSignal,
): Promise<TeamDetailResponseDto> {
  return apiRequest<TeamDetailResponseDto>(
    `/api/v1/teams/${encodeURIComponent(teamId)}`,
    { signal },
  );
}

export async function fetchTeamSuggestions(
  teamId: string,
  options: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<TeammateSuggestionsResponseDto> {
  const searchParams = new URLSearchParams();
  if (options.limit !== undefined) {
    searchParams.set('limit', String(options.limit));
  }
  const qs = searchParams.toString();
  return apiRequest<TeammateSuggestionsResponseDto>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/suggestions${qs ? `?${qs}` : ''}`,
    { signal },
  );
}

export async function updateTeamPreferences(
  teamId: string,
  input: UpdateTeamPreferencesRequestDto,
): Promise<{ team: TeamDetailsDto }> {
  return apiRequest<{ team: TeamDetailsDto }>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/preferences`,
    {
      method: 'PATCH',
      body: input,
      idempotencyScope: `update-preferences:${teamId}`,
    },
  );
}

export async function createTeam(
  hackathonIdOrSlug: string,
  input: {
    name: string;
    description: string;
    desiredSkills: string[];
    lookingForMembers?: boolean;
  },
): Promise<{ team: TeamDetailsDto }> {
  return apiRequest<{ team: TeamDetailsDto }>(
    `/api/v1/hackathons/${encodeURIComponent(hackathonIdOrSlug)}/teams`,
    {
      method: 'POST',
      body: input,
      idempotencyScope: `create-team:${hackathonIdOrSlug}`,
    },
  );
}

export async function createJoinRequest(
  teamId: string,
  message: string,
): Promise<{ joinRequest: JoinRequestDto }> {
  return apiRequest<{ joinRequest: JoinRequestDto }>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/join-requests`,
    {
      method: 'POST',
      body: { message },
      idempotencyScope: `join-request:${teamId}`,
    },
  );
}

export async function fetchTeamJoinRequests(
  teamId: string,
  options: { status?: JoinRequestStatus; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<JoinRequestInboxPageResponse> {
  const searchParams = new URLSearchParams();
  if (options.status) {
    searchParams.set('status', options.status);
  }
  if (options.cursor) {
    searchParams.set('cursor', options.cursor);
  }
  if (options.limit !== undefined) {
    searchParams.set('limit', String(options.limit));
  }
  const qs = searchParams.toString();
  return apiRequest<JoinRequestInboxPageResponse>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/join-requests${qs ? `?${qs}` : ''}`,
    { signal },
  );
}

export async function acceptJoinRequest(
  teamId: string,
  requestId: string,
): Promise<{ joinRequest: JoinRequestDto; team: TeamDetailsDto }> {
  return apiRequest<{ joinRequest: JoinRequestDto; team: TeamDetailsDto }>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/join-requests/${encodeURIComponent(requestId)}/accept`,
    {
      method: 'POST',
      idempotencyScope: `accept-jr:${teamId}:${requestId}`,
    },
  );
}

export async function declineJoinRequest(
  teamId: string,
  requestId: string,
): Promise<{ joinRequest: JoinRequestDto }> {
  return apiRequest<{ joinRequest: JoinRequestDto }>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/join-requests/${encodeURIComponent(requestId)}/decline`,
    {
      method: 'POST',
      idempotencyScope: `decline-jr:${teamId}:${requestId}`,
    },
  );
}

export async function removeTeamMember(
  teamId: string,
  memberUserId: string,
): Promise<{ team: TeamDetailsDto }> {
  return apiRequest<{ team: TeamDetailsDto }>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberUserId)}`,
    {
      method: 'DELETE',
      idempotencyScope: `remove-member:${teamId}:${memberUserId}`,
    },
  );
}

export async function leaveTeam(
  teamId: string,
): Promise<{
  teamDeleted: boolean;
  teamId: string;
  newLeaderUserId: string | null;
  team: TeamDetailsDto | null;
}> {
  return apiRequest<{
    teamDeleted: boolean;
    teamId: string;
    newLeaderUserId: string | null;
    team: TeamDetailsDto | null;
  }>(`/api/v1/teams/${encodeURIComponent(teamId)}/leave`, {
    method: 'POST',
    idempotencyScope: `leave-team:${teamId}`,
  });
}

export type { HackathonSummary };
