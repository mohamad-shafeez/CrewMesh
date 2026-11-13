import type {
  InviteCodeCreatedDto,
  InviteCodeListResponse,
  InviteCodeMetadataDto,
  InviteRedeemResultDto,
} from '@crewmesh/shared';
import { apiRequest } from './client.js';

export async function fetchTeamInvites(
  teamId: string,
  signal?: AbortSignal,
): Promise<InviteCodeMetadataDto[]> {
  const res = await apiRequest<InviteCodeListResponse>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/invites`,
    { signal },
  );
  return res.invites;
}

export async function createTeamInvite(
  teamId: string,
  input: {
    expiresInHours?: number;
    maxUses?: number | null;
  },
): Promise<{ invite: InviteCodeCreatedDto }> {
  return apiRequest<{ invite: InviteCodeCreatedDto }>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/invites`,
    {
      method: 'POST',
      body: input,
      idempotencyScope: `create-invite:${teamId}:${Date.now()}`,
    },
  );
}

export async function revokeTeamInvite(
  teamId: string,
  inviteId: string,
): Promise<{ invite: { id: string; teamId: string; revokedAt: string } }> {
  return apiRequest<{ invite: { id: string; teamId: string; revokedAt: string } }>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
    {
      method: 'POST',
      idempotencyScope: `revoke-invite:${teamId}:${inviteId}`,
    },
  );
}

export async function redeemInviteCode(input: {
  code: string;
  message?: string;
}): Promise<InviteRedeemResultDto> {
  return apiRequest<InviteRedeemResultDto>('/api/v1/invites/redeem', {
    method: 'POST',
    body: input,
    idempotencyScope: 'redeem-invite',
  });
}
