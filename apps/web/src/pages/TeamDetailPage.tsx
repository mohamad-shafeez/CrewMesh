import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeSkillTags,
  type InviteCodeCreatedDto,
  type InviteCodeMetadataDto,
  type JoinRequestDto,
  type PublicUserProfile,
  type TeamDetailsDto,
  type TeammateSuggestionsResponseDto,
  type TeamViewerContextDto,
} from '@crewmesh/shared';
import { ApiClientError } from '../api/client.js';
import {
  createTeamInvite,
  fetchTeamInvites,
  redeemInviteCode,
  revokeTeamInvite,
} from '../api/invites.js';
import {
  acceptJoinRequest,
  createJoinRequest,
  declineJoinRequest,
  fetchTeamDetail,
  fetchTeamJoinRequests,
  fetchTeamSuggestions,
  leaveTeam,
  removeTeamMember,
  updateTeamPreferences,
} from '../api/teams.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { SseStatusBadge } from '../components/SseStatusBadge.js';
import { useTeamEvents } from '../hooks/useTeamEvents.js';

interface TeamDetailPageProps {
  teamId: string;
  user: PublicUserProfile | null;
  onNavigate: (path: string) => void;
}

export function TeamDetailPage({
  teamId,
  user,
  onNavigate,
}: TeamDetailPageProps): React.JSX.Element {
  const [team, setTeam] = useState<TeamDetailsDto | null>(null);
  const [viewerContext, setViewerContext] = useState<TeamViewerContextDto | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Leader-only state: pending requests & invites
  const [pendingRequests, setPendingRequests] = useState<JoinRequestDto[]>([]);
  const [invites, setInvites] = useState<InviteCodeMetadataDto[]>([]);
  const [newlyCreatedInvite, setNewlyCreatedInvite] = useState<InviteCodeCreatedDto | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);

  // Leader-only state: Team Skill Preferences Editor
  const [draftSkills, setDraftSkills] = useState<string[]>([]);
  const [newSkillInput, setNewSkillInput] = useState<string>('');
  const [savingPreferences, setSavingPreferences] = useState<boolean>(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const skillInputRef = useRef<HTMLInputElement | null>(null);

  // Leader-only state: Suggested Teammates (crewmesh-match-v1)
  const [suggestions, setSuggestions] = useState<TeammateSuggestionsResponseDto | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState<boolean>(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);

  // Invite creation form state
  const [inviteMaxUses, setInviteMaxUses] = useState<string>('5');
  const [inviteExpiresHours, setInviteExpiresHours] = useState<string>('48');
  const [creatingInvite, setCreatingInvite] = useState<boolean>(false);

  // Applicant join request & invite redeem state
  const [joinMessage, setJoinMessage] = useState<string>('');
  const [submittingJoin, setSubmittingJoin] = useState<boolean>(false);
  const [redeemCodeInput, setRedeemCodeInput] = useState<string>('');
  const [redeemingCode, setRedeemingCode] = useState<boolean>(false);

  // Confirmation modal state for member removal or leaving team
  const [memberToRemove, setMemberToRemove] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);
  const [removingMember, setRemovingMember] = useState<boolean>(false);
  const [showLeaveModal, setShowLeaveModal] = useState<boolean>(false);
  const [leavingTeam, setLeavingTeam] = useState<boolean>(false);

  const isMember = Boolean(
    user && team && team.members.some((m) => m.userId === user.id),
  );
  const isLeader = Boolean(user && team && team.leaderUserId === user.id);

  const loadSuggestionsForLeader = useCallback(
    async (currentTeam: TeamDetailsDto, signal?: AbortSignal) => {
      if (currentTeam.isFull) {
        setSuggestions(null);
        setSuggestionsError(null);
        setLoadingSuggestions(false);
        return;
      }

      setLoadingSuggestions(true);
      setSuggestionsError(null);
      try {
        const res = await fetchTeamSuggestions(currentTeam.id, { limit: 20 }, signal);
        setSuggestions(res);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        setSuggestionsError(
          err instanceof ApiClientError
            ? err.message
            : 'Unable to load teammate recommendations.',
        );
      } finally {
        setLoadingSuggestions(false);
      }
    },
    [],
  );

  const loadTeamWorkspace = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const detailRes = await fetchTeamDetail(teamId, signal);
        setTeam(detailRes.team);
        setDraftSkills(detailRes.team.desiredSkills);
        setViewerContext(detailRes.viewerContext ?? null);
        setErrorMessage(null);

        if (user && detailRes.team.leaderUserId === user.id) {
          const [jrRes, invRes] = await Promise.all([
            fetchTeamJoinRequests(teamId, { status: 'pending', limit: 50 }, signal),
            fetchTeamInvites(teamId, signal),
          ]);
          setPendingRequests(jrRes.items);
          setInvites(invRes);
          await loadSuggestionsForLeader(detailRes.team, signal);
        } else {
          setPendingRequests([]);
          setInvites([]);
          setSuggestions(null);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        setErrorMessage(
          err instanceof ApiClientError ? err.message : 'Unable to load team details.',
        );
      } finally {
        setLoading(false);
      }
    },
    [teamId, user, loadSuggestionsForLeader],
  );

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    void loadTeamWorkspace(controller.signal);
    return () => controller.abort();
  }, [loadTeamWorkspace]);

  // Connect to private team SSE stream ONLY when viewer is an active member
  const { connectionState: teamSseState } = useTeamEvents({
    teamId,
    enabled: isMember,
    onTeamEvent: (evt) => {
      if (evt.eventType === 'TEAM_DELETED') {
        setActionFeedback({
          type: 'error',
          message: 'This team was deleted because its final member left.',
        });
        setTeam(null);
        return;
      }
      void loadTeamWorkspace();
    },
  });

  function handleAddSkillTag() {
    setPreferencesError(null);
    const rawParts = newSkillInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (rawParts.length === 0) {
      return;
    }

    for (const part of rawParts) {
      if (part.length > 40) {
        setPreferencesError('Each skill tag must be at most 40 characters.');
        return;
      }
    }

    const merged = normalizeSkillTags([...draftSkills, ...rawParts]);
    if (merged.length > 25) {
      setPreferencesError('A team can specify at most 25 desired skills.');
      return;
    }

    setDraftSkills(merged);
    setNewSkillInput('');
  }

  function handleRemoveSkillTag(tagToRemove: string) {
    setPreferencesError(null);
    setDraftSkills((prev) => prev.filter((s) => s !== tagToRemove));
  }

  async function handleSavePreferences(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    if (!team) {
      return;
    }
    setPreferencesError(null);
    setActionFeedback(null);

    // Include any pending text in the input field if the leader typed a skill and clicked Save directly
    let finalSkills = draftSkills;
    if (newSkillInput.trim().length > 0) {
      const extra = newSkillInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      finalSkills = normalizeSkillTags([...draftSkills, ...extra]);
      setNewSkillInput('');
    }

    if (finalSkills.length > 25) {
      setPreferencesError('A team can specify at most 25 desired skills.');
      return;
    }

    const previousSkills = team.desiredSkills;
    setSavingPreferences(true);

    try {
      const res = await updateTeamPreferences(team.id, {
        desiredSkills: finalSkills,
      });
      setTeam(res.team);
      setDraftSkills(res.team.desiredSkills);
      setActionFeedback({
        type: 'success',
        message: 'Team desired skills updated.',
      });
      await loadSuggestionsForLeader(res.team);
    } catch (err) {
      // Roll back draft skills to authoritative server state on failure
      setDraftSkills(previousSkills);
      setPreferencesError(
        err instanceof ApiClientError ? err.message : 'Failed to update team skill preferences.',
      );
    } finally {
      setSavingPreferences(false);
    }
  }

  async function handleJoinRequestSubmit(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    setActionFeedback(null);
    setSubmittingJoin(true);
    try {
      const res = await createJoinRequest(teamId, joinMessage.trim());
      setJoinMessage('');
      setViewerContext((prev) => ({
        myTeamIdInHackathon: prev?.myTeamIdInHackathon ?? null,
        myRoleInTeam: prev?.myRoleInTeam ?? null,
        myJoinRequestForTeam: res.joinRequest,
      }));
      setActionFeedback({
        type: 'success',
        message: 'Join request submitted! Status is pending leader approval.',
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to submit join request.',
      });
    } finally {
      setSubmittingJoin(false);
    }
  }

  async function handleRedeemInviteOnTeam(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    setActionFeedback(null);
    setRedeemingCode(true);
    try {
      const res = await redeemInviteCode({
        code: redeemCodeInput.trim(),
        message: joinMessage.trim(),
      });
      setRedeemCodeInput('');
      setViewerContext((prev) => ({
        myTeamIdInHackathon: prev?.myTeamIdInHackathon ?? null,
        myRoleInTeam: prev?.myRoleInTeam ?? null,
        myJoinRequestForTeam: res.joinRequest,
      }));
      setActionFeedback({
        type: 'success',
        message:
          'Invitation code redeemed! A pending join request has been created and awaits leader approval.',
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to redeem invitation code.',
      });
    } finally {
      setRedeemingCode(false);
    }
  }

  async function handleAcceptRequest(requestId: string) {
    setActionFeedback(null);
    setProcessingRequestId(requestId);
    try {
      const res = await acceptJoinRequest(teamId, requestId);
      setTeam(res.team);
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
      setActionFeedback({
        type: 'success',
        message: `Accepted applicant into ${res.team.name} (${res.team.memberCount} / ${res.team.maxTeamSize} members).`,
      });
      await loadSuggestionsForLeader(res.team);
    } catch (err) {
      setActionFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to accept join request.',
      });
      void loadTeamWorkspace();
    } finally {
      setProcessingRequestId(null);
    }
  }

  async function handleDeclineRequest(requestId: string) {
    setActionFeedback(null);
    setProcessingRequestId(requestId);
    try {
      await declineJoinRequest(teamId, requestId);
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
      setActionFeedback({
        type: 'success',
        message: 'Join request declined.',
      });
      if (team) {
        await loadSuggestionsForLeader(team);
      }
    } catch (err) {
      setActionFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to decline join request.',
      });
      void loadTeamWorkspace();
    } finally {
      setProcessingRequestId(null);
    }
  }

  async function handleCreateInvite(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    setActionFeedback(null);
    setCreatingInvite(true);
    try {
      const parsedMaxUses =
        inviteMaxUses.trim() === '' ? null : Number.parseInt(inviteMaxUses, 10);
      const parsedHours = Number.parseFloat(inviteExpiresHours) || 48;

      const res = await createTeamInvite(teamId, {
        maxUses: parsedMaxUses,
        expiresInHours: parsedHours,
      });
      setNewlyCreatedInvite(res.invite);
      const updatedList = await fetchTeamInvites(teamId);
      setInvites(updatedList);
      setActionFeedback({
        type: 'success',
        message:
          'Invitation code generated. Copy the plaintext token below now — only its SHA-256 hash is stored on the server.',
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to create invitation code.',
      });
    } finally {
      setCreatingInvite(false);
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    setActionFeedback(null);
    setRevokingInviteId(inviteId);
    try {
      await revokeTeamInvite(teamId, inviteId);
      if (newlyCreatedInvite?.id === inviteId) {
        setNewlyCreatedInvite(null);
      }
      const updatedList = await fetchTeamInvites(teamId);
      setInvites(updatedList);
      setActionFeedback({
        type: 'success',
        message: 'Invitation code revoked.',
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to revoke invitation code.',
      });
    } finally {
      setRevokingInviteId(null);
    }
  }

  async function handleConfirmRemoveMember() {
    if (!memberToRemove) {
      return;
    }
    setRemovingMember(true);
    setActionFeedback(null);
    try {
      const res = await removeTeamMember(teamId, memberToRemove.userId);
      setTeam(res.team);
      setActionFeedback({
        type: 'success',
        message: `Removed ${memberToRemove.displayName} from the team.`,
      });
      setMemberToRemove(null);
      await loadSuggestionsForLeader(res.team);
    } catch (err) {
      setActionFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to remove member.',
      });
      setMemberToRemove(null);
      void loadTeamWorkspace();
    } finally {
      setRemovingMember(false);
    }
  }

  async function handleConfirmLeaveTeam() {
    setLeavingTeam(true);
    setActionFeedback(null);
    try {
      const res = await leaveTeam(teamId);
      setShowLeaveModal(false);
      if (res.teamDeleted) {
        onNavigate('/board');
        return;
      }
      if (res.team) {
        setTeam(res.team);
      }
      await loadTeamWorkspace();
      setActionFeedback({
        type: 'success',
        message: res.newLeaderUserId
          ? 'You have left the team and leadership was transferred atomically.'
          : 'You have left the team.',
      });
    } catch (err) {
      setShowLeaveModal(false);
      setActionFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to leave team.',
      });
    } finally {
      setLeavingTeam(false);
    }
  }

  async function handleCopyInviteCode(code: string, inviteId: string) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
        setCopiedInviteId(inviteId);
      }
    } catch {
      // Fallback: user can still copy text directly from code box
    }
  }

  if (loading) {
    return (
      <section className="card">
        <div className="css-loader-scanline" aria-hidden="true" />
        <p className="loader-inline" style={{ marginTop: '0.75rem' }}>
          <span className="css-loader-orbitra" aria-hidden="true" />
          <span>Loading team workspace...</span>
        </p>
      </section>
    );
  }

  if (errorMessage || !team) {
    return (
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Team Unavailable</h1>
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
          <span>{errorMessage ?? 'Team not found.'}</span>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate('/board')}>
          Back to Team Board
        </button>
      </section>
    );
  }

  const nonLeaderMembers = team.members.filter((m) => m.userId !== team.leaderUserId);
  const nextSuccessor = nonLeaderMembers[0] ?? null;

  const leaveModalDescription =
    team.memberCount === 1
      ? `You are the final remaining member of "${team.name}". Leaving will permanently delete the team while preserving its immutable audit log history.`
      : isLeader && nextSuccessor
        ? `As team leader, leaving "${team.name}" will atomically promote the longest-standing remaining member (${nextSuccessor.displayName}) to Team Leader in the same database transaction.`
        : `Are you sure you want to leave "${team.name}"?`;

  const myExistingRequest = viewerContext?.myJoinRequestForTeam ?? null;
  const myOtherTeamId =
    viewerContext?.myTeamIdInHackathon && viewerContext.myTeamIdInHackathon !== team.id
      ? viewerContext.myTeamIdInHackathon
      : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onNavigate('/board')}
        >
          ← Back to Team Board
        </button>

        {isMember ? <SseStatusBadge state={teamSseState} label="Team SSE" /> : null}
      </div>

      {actionFeedback ? (
        <div
          className={`alert ${actionFeedback.type === 'success' ? 'alert-success' : 'alert-error'}`}
          role={actionFeedback.type === 'error' ? 'alert' : 'status'}
        >
          <span>{actionFeedback.message}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setActionFeedback(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="detail-layout">
        {/* Left Column: Team Overview, Member Roster & Leader Suggested Teammates */}
        <div className="detail-stack">
          <section className="card" aria-labelledby="team-detail-heading">
            <div className="section-header-row">
              <div>
                <h1 id="team-detail-heading" style={{ fontSize: '1.6rem', margin: 0 }}>
                  {team.name}
                </h1>
                <span style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                  Created {new Date(team.createdAt).toLocaleString()}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {team.status === 'forming' ? (
                  <span className="badge badge-forming">
                    Forming ({team.memberCount}/{team.minTeamSize} min)
                  </span>
                ) : (
                  <span className="badge badge-ready">Ready</span>
                )}
                {team.isFull ? (
                  <span className="badge badge-full">
                    Full ({team.memberCount} / {team.maxTeamSize})
                  </span>
                ) : (
                  <span className="badge badge-ready">
                    {team.memberCount} / {team.maxTeamSize} members ({team.availableSeats} open)
                  </span>
                )}
              </div>
            </div>

            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              {team.description || 'No team description provided.'}
            </p>

            <div style={{ marginBottom: '1.25rem' }}>
              <strong style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                Desired Skills:
              </strong>
              {team.desiredSkills.length > 0 ? (
                <ul className="skill-list" aria-label="Desired team skills">
                  {team.desiredSkills.map((skill) => (
                    <li key={skill} className="skill-tag">
                      {skill}
                    </li>
                  ))}
                </ul>
              ) : (
                <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>
                  No desired skills specified yet.
                </span>
              )}
            </div>

            {isMember ? (
              <div
                style={{
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: '1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                }}
              >
                <span style={{ fontSize: '0.9rem' }}>
                  Your role:{' '}
                  <strong style={{ textTransform: 'capitalize' }}>
                    {isLeader ? 'Team Leader' : 'Team Member'}
                  </strong>
                </span>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => setShowLeaveModal(true)}
                >
                  {team.memberCount === 1
                    ? 'Leave & Delete Team'
                    : isLeader
                      ? 'Leave Team & Transfer Leadership'
                      : 'Leave Team'}
                </button>
              </div>
            ) : null}
          </section>

          <section className="card" aria-labelledby="roster-heading">
            <div className="section-header-row">
              <h2 id="roster-heading" style={{ fontSize: '1.2rem' }}>
                Team Members ({team.members.length} / {team.maxTeamSize})
              </h2>
            </div>

            <div className="detail-stack" style={{ gap: '0.75rem' }}>
              {team.members.map((member) => (
                <div key={member.userId} className="member-row">
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      <strong>{member.displayName}</strong>
                      {member.role === 'leader' ? (
                        <span className="badge badge-role-leader">Leader</span>
                      ) : (
                        <span className="badge">Member</span>
                      )}
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {member.timezone}
                      </span>
                    </div>

                    {member.bio ? (
                      <p
                        style={{
                          margin: '0.3rem 0',
                          fontSize: '0.86rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {member.bio}
                      </p>
                    ) : null}

                    {member.skills.length > 0 ? (
                      <ul className="skill-list" style={{ marginTop: '0.4rem' }}>
                        {member.skills.map((skill) => (
                          <li key={skill} className="skill-tag">
                            {skill}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  {isLeader && member.userId !== user?.id ? (
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() =>
                        setMemberToRemove({
                          userId: member.userId,
                          displayName: member.displayName,
                        })
                      }
                    >
                      Remove Member
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          {/* Leader-Only Suggested Teammates Section (Batch 05) */}
          {isLeader ? (
            <section
              className="card"
              aria-labelledby="suggested-teammates-heading"
              data-testid="suggested-teammates-panel"
            >
              <div className="section-header-row" style={{ marginBottom: '0.35rem' }}>
                <div>
                  <h2 id="suggested-teammates-heading" style={{ fontSize: '1.25rem', margin: 0 }}>
                    Suggested teammates
                  </h2>
                  <p
                    style={{
                      margin: '0.2rem 0 0',
                      fontSize: '0.88rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Discover participants whose skills complement your team and whose time zones
                    are closer to those of your existing members.
                  </p>
                </div>

                {!team.isFull ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={loadingSuggestions}
                    onClick={() => void loadSuggestionsForLeader(team)}
                  >
                    {loadingSuggestions ? 'Refreshing...' : 'Refresh Suggestions'}
                  </button>
                ) : null}
              </div>

              {team.isFull ? (
                <div className="alert alert-warning" role="status" style={{ marginTop: '0.75rem' }}>
                  <span>
                    This team is at full capacity ({team.memberCount} / {team.maxTeamSize} members).
                    No additional participant can currently join.
                  </span>
                </div>
              ) : loadingSuggestions ? (
                <div style={{ padding: 'var(--space-4) 0' }}>
                  <div className="css-loader-scanline" aria-hidden="true" />
                  <p className="loader-inline" style={{ marginTop: '0.65rem' }}>
                    <span className="css-loader-orbitra" aria-hidden="true" />
                    <span>Calculating explainable skill & time-zone compatibility...</span>
                  </p>
                </div>
              ) : suggestionsError ? (
                <div className="alert alert-error" role="alert" style={{ marginTop: '0.75rem' }}>
                  <span>{suggestionsError}</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void loadSuggestionsForLeader(team)}
                  >
                    Retry
                  </button>
                </div>
              ) : suggestions ? (
                <div className="detail-stack" style={{ gap: '0.9rem', marginTop: '0.75rem' }}>
                  {/* Algorithm & Weight Disclosure Box */}
                  <div
                    style={{
                      backgroundColor: 'var(--bg-subtle)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: '0.75rem 0.95rem',
                      fontSize: '0.82rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.25rem' }}>
                      <span>
                        <strong>Model:</strong> <code>{suggestions.algorithmVersion}</code>
                      </span>
                      <span>
                        <strong>Weights:</strong> Skills {suggestions.scoring.weights.skill}% ·
                        Time zone {suggestions.scoring.weights.timezone}%
                      </span>
                      <span>
                        <strong>Evaluated:</strong>{' '}
                        {suggestions.diagnostics.eligibleCandidatesEvaluated} eligible participant(s)
                      </span>
                    </div>
                    {suggestions.teamSkillSummary.unmetDesiredSkills.length > 0 ? (
                      <div style={{ marginBottom: '0.25rem' }}>
                        <strong>Unmet Team Skills:</strong>{' '}
                        {suggestions.teamSkillSummary.unmetDesiredSkills.join(', ')}
                      </div>
                    ) : null}
                    <div style={{ color: 'var(--text-muted)' }}>
                      <em>Note:</em> {suggestions.scoring.limitation}
                    </div>
                  </div>

                  {team.desiredSkills.length === 0 ||
                  suggestions.diagnostics.skillSignal === 'no_team_desired_skills' ? (
                    <div className="alert alert-warning" role="status">
                      <div>
                        <strong>
                          Add the skills your team needs to get more meaningful teammate
                          recommendations.
                        </strong>
                        <p style={{ margin: '0.2rem 0 0', fontSize: '0.84rem' }}>
                          Without declared desired skills, candidates are ranked by time-zone
                          proximity only.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => skillInputRef.current?.focus()}
                      >
                        Edit Desired Skills
                      </button>
                    </div>
                  ) : null}

                  {suggestions.candidates.length === 0 ? (
                    <div
                      style={{
                        padding: 'var(--space-5)',
                        textAlign: 'center',
                        backgroundColor: 'var(--bg-subtle)',
                        borderRadius: 'var(--radius-md)',
                      }}
                    >
                      <strong>No eligible candidates found right now</strong>
                      <p
                        style={{
                          margin: '0.35rem 0 0',
                          fontSize: '0.86rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        All registered participants are either already in a team for this hackathon
                        or already have a pending join request for your team.
                      </p>
                    </div>
                  ) : (
                    <div className="detail-stack" style={{ gap: '0.75rem' }}>
                      {suggestions.candidates.map((cand) => (
                        <article
                          key={cand.userId}
                          className="member-row"
                          data-testid="suggested-teammate-card"
                          style={{ flexDirection: 'column', alignItems: 'stretch' }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'flex-start',
                              flexWrap: 'wrap',
                              gap: '0.5rem',
                            }}
                          >
                            <div>
                              <strong style={{ fontSize: '1rem' }}>{cand.displayName}</strong>
                              <span
                                style={{
                                  marginLeft: '0.5rem',
                                  fontSize: '0.8rem',
                                  color: 'var(--text-muted)',
                                }}
                              >
                                {cand.timezone ?? 'Time zone unavailable'}
                              </span>
                            </div>

                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <span className="badge badge-ready">
                                Overall match: {cand.overallScore.toFixed(1)}%
                              </span>
                              <span className="badge">
                                Skill coverage:{' '}
                                {cand.skillScore !== null
                                  ? `${cand.skillScore.toFixed(1)}%`
                                  : 'Unavailable'}
                              </span>
                              <span className="badge">
                                Time-zone compatibility:{' '}
                                {cand.timezoneScore !== null
                                  ? `${cand.timezoneScore.toFixed(1)}%`
                                  : 'Unavailable'}
                              </span>
                            </div>
                          </div>

                          {cand.matchedDesiredSkills.length > 0 ? (
                            <div style={{ fontSize: '0.86rem', color: 'var(--accent-primary)' }}>
                              <strong>Fills missing skills:</strong>{' '}
                              {cand.matchedDesiredSkills.join(', ')}
                            </div>
                          ) : null}

                          {cand.skills.length > 0 ? (
                            <div>
                              <span
                                style={{
                                  fontSize: '0.775rem',
                                  fontWeight: 600,
                                  color: 'var(--text-muted)',
                                  marginRight: '0.4rem',
                                }}
                              >
                                Candidate skills:
                              </span>
                              <ul
                                className="skill-list"
                                style={{ display: 'inline-flex', verticalAlign: 'middle' }}
                              >
                                {cand.skills.map((skill) => (
                                  <li key={skill} className="skill-tag">
                                    {skill}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                              No skills listed on participant profile.
                            </div>
                          )}

                          <ul
                            style={{
                              margin: '0.2rem 0 0',
                              paddingLeft: '1.15rem',
                              fontSize: '0.84rem',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {cand.explanation.map((line, idx) => (
                              <li key={idx}>{line}</li>
                            ))}
                          </ul>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        {/* Right Column: Role-Adaptive Actions (Visitor Join Request vs Leader Preferences, Inbox & Invites) */}
        <div className="detail-stack">
          {!user ? (
            <section className="card" aria-labelledby="visitor-join-heading">
              <h2 id="visitor-join-heading" style={{ fontSize: '1.15rem', marginTop: 0 }}>
                Want to Join {team.name}?
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Sign in or create a participant account to submit a join request or redeem an
                invitation code.
              </p>
              <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    onNavigate(`/login?returnTo=${encodeURIComponent(`/teams/${team.id}`)}`)
                  }
                >
                  Sign In
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    onNavigate(`/register?returnTo=${encodeURIComponent(`/teams/${team.id}`)}`)
                  }
                >
                  Create Account
                </button>
              </div>
            </section>
          ) : !isMember ? (
            <section className="card" aria-labelledby="applicant-panel-heading">
              <h2 id="applicant-panel-heading" style={{ fontSize: '1.15rem', marginTop: 0 }}>
                Request to Join {team.name}
              </h2>

              {myOtherTeamId ? (
                <div className="alert alert-warning" role="status">
                  <div>
                    You already belong to another team in this hackathon (one team per participant).
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onNavigate(`/teams/${myOtherTeamId}`)}
                  >
                    View My Team
                  </button>
                </div>
              ) : myExistingRequest && myExistingRequest.status === 'pending' ? (
                <div className="alert alert-success" role="status">
                  <div>
                    <strong>Join Request Pending Approval</strong>
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.86rem' }}>
                      Submitted on {new Date(myExistingRequest.createdAt).toLocaleString()} (Source:{' '}
                      <code>{myExistingRequest.source}</code>). The team leader will review your
                      request.
                    </p>
                  </div>
                </div>
              ) : team.isFull ? (
                <div className="alert alert-warning" role="status">
                  <span>This team is currently at full capacity ({team.maxTeamSize} members).</span>
                </div>
              ) : (
                <>
                  {myExistingRequest && myExistingRequest.status === 'declined' ? (
                    <div
                      className="alert alert-warning"
                      role="status"
                      style={{ marginBottom: '1rem' }}
                    >
                      <span>
                        Your previous join request was declined. You may submit a new request below.
                      </span>
                    </div>
                  ) : null}

                  <form className="form-grid" onSubmit={(e) => void handleJoinRequestSubmit(e)}>
                    <div className="form-field">
                      <label htmlFor="join-request-message">
                        Message to Team Leader (optional, max 500 chars)
                      </label>
                      <textarea
                        id="join-request-message"
                        name="message"
                        rows={3}
                        maxLength={500}
                        placeholder="Introduce your skills, availability, and what you want to build..."
                        value={joinMessage}
                        onChange={(e) => setJoinMessage(e.target.value)}
                      />
                    </div>

                    <div>
                      <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={submittingJoin}
                      >
                        {submittingJoin ? (
                          <>
                            <span
                              className="css-loader-orbitra css-loader-orbitra--on-dark"
                              aria-hidden="true"
                            />
                            <span>Sending Request...</span>
                          </>
                        ) : (
                          'Request to Join Team'
                        )}
                      </button>
                    </div>
                  </form>

                  <hr
                    style={{
                      border: 0,
                      borderTop: '1px solid var(--border-subtle)',
                      margin: '1.25rem 0',
                    }}
                  />

                  <form className="form-grid" onSubmit={(e) => void handleRedeemInviteOnTeam(e)}>
                    <div className="form-field">
                      <label htmlFor="team-redeem-code">Or Redeem an Invitation Code</label>
                      <input
                        id="team-redeem-code"
                        name="code"
                        type="text"
                        required
                        minLength={16}
                        maxLength={128}
                        placeholder="Paste invitation token..."
                        value={redeemCodeInput}
                        onChange={(e) => setRedeemCodeInput(e.target.value)}
                      />
                      <span className="field-hint">
                        Redeeming an invitation code creates a pending join request for leader
                        approval.
                      </span>
                    </div>
                    <div>
                      <button
                        type="submit"
                        className="btn btn-secondary btn-sm"
                        disabled={redeemingCode}
                      >
                        {redeemingCode ? 'Redeeming...' : 'Redeem Invite Code'}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </section>
          ) : null}

          {isLeader ? (
            <>
              {/* Leader Team Skill Preferences Editor (Batch 05) */}
              <section
                className="card"
                aria-labelledby="team-preferences-heading"
                data-testid="team-preferences-card"
              >
                <h2 id="team-preferences-heading" style={{ fontSize: '1.15rem', marginTop: 0 }}>
                  Team Skill Preferences
                </h2>
                <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', marginTop: 0 }}>
                  Specify the skills your team needs (`{draftSkills.length} / 25`). Saving updates
                  the board via SSE and refreshes teammate recommendations.
                </p>

                {preferencesError ? (
                  <div className="alert alert-error" role="alert" style={{ marginBottom: '0.75rem' }}>
                    <span>{preferencesError}</span>
                  </div>
                ) : null}

                <form className="form-grid" onSubmit={(e) => void handleSavePreferences(e)}>
                  <div>
                    {draftSkills.length > 0 ? (
                      <ul
                        className="skill-list"
                        aria-label="Draft desired skills"
                        style={{ marginBottom: '0.75rem' }}
                      >
                        {draftSkills.map((tag) => (
                          <li
                            key={tag}
                            className="skill-tag"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                          >
                            <span>{tag}</span>
                            <button
                              type="button"
                              aria-label={`Remove skill ${tag}`}
                              onClick={() => handleRemoveSkillTag(tag)}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: 0,
                                fontWeight: 700,
                                color: 'var(--text-secondary)',
                              }}
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', marginTop: 0 }}>
                        No desired skills added yet.
                      </p>
                    )}

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        ref={skillInputRef}
                        id="add-desired-skill-input" aria-label="Desired Teammate Skills (comma-separated, max 25)"
                        type="text"
                        maxLength={120}
                        placeholder="Add skill tag (e.g. docker, python)..."
                        value={newSkillInput}
                        onChange={(e) => setNewSkillInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddSkillTag();
                          }
                        }}
                        style={{
                          flex: 1,
                          padding: '0.5rem 0.7rem',
                          border: '1px solid var(--border-strong)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: '0.9rem',
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleAddSkillTag}
                      >
                        Add Skill
                      </button>
                    </div>
                  </div>

                  <div>
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      disabled={savingPreferences}
                    >
                      {savingPreferences ? (
                        <>
                          <span
                            className="css-loader-orbitra css-loader-orbitra--on-dark"
                            aria-hidden="true"
                          />
                          <span>Saving Preferences...</span>
                        </>
                      ) : (
                        'Save Desired Skills'
                      )}
                    </button>
                  </div>
                </form>
              </section>

              {/* Leader Pending Request Inbox */}
              <section className="card" aria-labelledby="leader-inbox-heading">
                <div className="section-header-row">
                  <h2 id="leader-inbox-heading" style={{ fontSize: '1.15rem' }}>
                    Pending Join Requests ({pendingRequests.length})
                  </h2>
                </div>

                {pendingRequests.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
                    No pending join requests right now. New requests appear here live via SSE.
                  </p>
                ) : (
                  <div className="detail-stack" style={{ gap: '0.75rem' }}>
                    {pendingRequests.map((req) => (
                      <div key={req.id} className="request-row">
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.45rem',
                              flexWrap: 'wrap',
                            }}
                          >
                            <strong>{req.applicant?.displayName ?? 'Applicant'}</strong>
                            <span className="badge">
                              {req.source === 'invite_code' ? 'Via Invite Code' : 'Via Board'}
                            </span>
                            {req.applicant?.timezone ? (
                              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                {req.applicant.timezone}
                              </span>
                            ) : null}
                          </div>

                          {req.message ? (
                            <p style={{ margin: '0.35rem 0', fontSize: '0.88rem' }}>
                              {req.message}
                            </p>
                          ) : null}

                          {req.applicant && req.applicant.skills.length > 0 ? (
                            <ul className="skill-list" style={{ marginTop: '0.35rem' }}>
                              {req.applicant.skills.map((skill) => (
                                <li key={skill} className="skill-tag">
                                  {skill}
                                </li>
                              ))}
                            </ul>
                          ) : null}

                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-muted)',
                              marginTop: '0.35rem',
                            }}
                          >
                            Requested {new Date(req.createdAt).toLocaleString()}
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={processingRequestId === req.id || team.isFull}
                            onClick={() => void handleAcceptRequest(req.id)}
                          >
                            {processingRequestId === req.id ? 'Processing...' : 'Accept'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={processingRequestId === req.id}
                            onClick={() => void handleDeclineRequest(req.id)}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Leader Invitation Management */}
              <section className="card" aria-labelledby="leader-invites-heading">
                <h2 id="leader-invites-heading" style={{ fontSize: '1.15rem', marginTop: 0 }}>
                  Team Invitations
                </h2>
                <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', marginTop: 0 }}>
                  Generate a 256-bit invitation token. Plaintext tokens are shown only once upon
                  creation; redeeming a token creates a pending join request for your approval.
                </p>

                {newlyCreatedInvite ? (
                  <div
                    className="alert alert-success"
                    role="status"
                    style={{ flexDirection: 'column', alignItems: 'stretch', marginBottom: '1rem' }}
                  >
                    <div>
                      <strong>New Invitation Token Created (Shown Once Only):</strong>
                    </div>
                    <div className="code-box">
                      <code data-testid="created-invite-code">{newlyCreatedInvite.code}</code>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          void handleCopyInviteCode(
                            newlyCreatedInvite.code,
                            newlyCreatedInvite.id,
                          )
                        }
                      >
                        {copiedInviteId === newlyCreatedInvite.id ? 'Copied!' : 'Copy Code'}
                      </button>
                    </div>
                  </div>
                ) : null}

                <form
                  className="form-grid"
                  style={{ marginBottom: '1.25rem' }}
                  onSubmit={(e) => void handleCreateInvite(e)}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                    <div className="form-field">
                      <label htmlFor="invite-max-uses">Max Uses (blank = unlimited)</label>
                      <input
                        id="invite-max-uses"
                        type="number"
                        min={1}
                        max={100}
                        value={inviteMaxUses}
                        onChange={(e) => setInviteMaxUses(e.target.value)}
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="invite-expires-hours">Expires In (hours)</label>
                      <input
                        id="invite-expires-hours"
                        type="number"
                        min={1}
                        max={720}
                        required
                        value={inviteExpiresHours}
                        onChange={(e) => setInviteExpiresHours(e.target.value)}
                      />
                    </div>
                  </div>

                  <div>
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      disabled={creatingInvite}
                    >
                      {creatingInvite ? 'Generating Token...' : 'Generate Invitation Code'}
                    </button>
                  </div>
                </form>

                {invites.length > 0 ? (
                  <div className="detail-stack" style={{ gap: '0.6rem' }}>
                    {invites.map((inv) => {
                      const active = !inv.isRevoked && !inv.isExpired && !inv.isExhausted;
                      return (
                        <div key={inv.id} className="invite-row">
                          <div style={{ fontSize: '0.84rem' }}>
                            <div>
                              <strong>Prefix:</strong> <code>{inv.tokenPrefix}...</code>{' '}
                              {inv.isRevoked ? (
                                <span className="badge badge-full">Revoked</span>
                              ) : inv.isExpired ? (
                                <span className="badge badge-full">Expired</span>
                              ) : inv.isExhausted ? (
                                <span className="badge badge-full">Max Uses Reached</span>
                              ) : (
                                <span className="badge badge-ready">Active</span>
                              )}
                            </div>
                            <div style={{ color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                              Uses: {inv.useCount} / {inv.maxUses ?? '∞'} · Expires:{' '}
                              {new Date(inv.expiresAt).toLocaleString()}
                            </div>
                          </div>

                          {active ? (
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={revokingInviteId === inv.id}
                              onClick={() => void handleRevokeInvite(inv.id)}
                            >
                              {revokingInviteId === inv.id ? 'Revoking...' : 'Revoke'}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.86rem', color: 'var(--text-muted)', margin: 0 }}>
                    No invitations created for this team yet.
                  </p>
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>

      {/* Confirmation Modals */}
      <ConfirmModal
        open={Boolean(memberToRemove)}
        title="Remove Team Member"
        description={
          memberToRemove
            ? `Remove ${memberToRemove.displayName} from "${team.name}"? This change is recorded in the team audit log.`
            : ''
        }
        confirmLabel="Confirm Removal"
        danger
        busy={removingMember}
        onConfirm={() => void handleConfirmRemoveMember()}
        onCancel={() => setMemberToRemove(null)}
      />

      <ConfirmModal
        open={showLeaveModal}
        title={
          team.memberCount === 1
            ? 'Leave and Delete Team'
            : isLeader
              ? 'Leave Team and Transfer Leadership'
              : 'Leave Team'
        }
        description={leaveModalDescription}
        confirmLabel={
          team.memberCount === 1
            ? 'Delete Team & Leave'
            : isLeader
              ? 'Transfer Leadership & Leave'
              : 'Leave Team'
        }
        danger
        busy={leavingTeam}
        onConfirm={() => void handleConfirmLeaveTeam()}
        onCancel={() => setShowLeaveModal(false)}
      />
    </div>
  );
}
