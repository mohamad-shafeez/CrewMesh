import React, { useCallback, useEffect, useState } from 'react';
import type {
  HackathonSummary,
  JoinRequestDto,
  PublicUserProfile,
  TeamDetailsDto,
  TeamStatus,
} from '@crewmesh/shared';
import { ApiClientError } from '../api/client.js';
import { redeemInviteCode } from '../api/invites.js';
import { fetchTeamBoard } from '../api/teams.js';
import { SseStatusBadge } from '../components/SseStatusBadge.js';
import { TeamCard } from '../components/TeamCard.js';
import { useBoardEvents } from '../hooks/useBoardEvents.js';

interface TeamBoardPageProps {
  user: PublicUserProfile | null;
  hackathon: HackathonSummary | null;
  onNavigate: (path: string) => void;
}

export function TeamBoardPage({
  user,
  hackathon,
  onNavigate,
}: TeamBoardPageProps): React.JSX.Element {
  const [teams, setTeams] = useState<TeamDetailsDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [skillFilter, setSkillFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'' | TeamStatus>('');
  const [capacityFilter, setCapacityFilter] = useState<'all' | 'open' | 'full'>('all');

  // Invitation redemption drawer/form state
  const [showRedeemPanel, setShowRedeemPanel] = useState<boolean>(false);
  const [inviteCodeInput, setInviteCodeInput] = useState<string>('');
  const [inviteMessageInput, setInviteMessageInput] = useState<string>('');
  const [redeemingInvite, setRedeemingInvite] = useState<boolean>(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemedJoinRequest, setRedeemedJoinRequest] = useState<JoinRequestDto | null>(null);

  const loadFirstPage = useCallback(
    async (signal?: AbortSignal) => {
      if (!hackathon) {
        return;
      }
      setLoading(true);
      setErrorMessage(null);

      try {
        const res = await fetchTeamBoard(
          hackathon.id,
          {
            limit: 12,
            status: statusFilter || undefined,
            hasCapacity:
              capacityFilter === 'open'
                ? true
                : capacityFilter === 'full'
                  ? false
                  : undefined,
            skill: skillFilter.trim() || undefined,
            search: searchQuery.trim() || undefined,
          },
          signal,
        );
        setTeams(res.items);
        setNextCursor(res.nextCursor);
        setHasMore(res.hasMore);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        setErrorMessage(
          err instanceof ApiClientError ? err.message : 'Unable to load the team board.',
        );
      } finally {
        setLoading(false);
      }
    },
    [hackathon, statusFilter, capacityFilter, skillFilter, searchQuery],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadFirstPage(controller.signal);
    return () => controller.abort();
  }, [loadFirstPage]);

  // Live SSE board stream subscription
  const { connectionState } = useBoardEvents({
    hackathonIdOrSlug: hackathon?.id ?? null,
    enabled: Boolean(hackathon),
    onBoardChanged: () => {
      void loadFirstPage();
    },
  });

  async function handleLoadMore() {
    if (!hackathon || !nextCursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setErrorMessage(null);
    try {
      const res = await fetchTeamBoard(hackathon.id, {
        cursor: nextCursor,
        limit: 12,
        status: statusFilter || undefined,
        hasCapacity:
          capacityFilter === 'open'
            ? true
            : capacityFilter === 'full'
              ? false
              : undefined,
        skill: skillFilter.trim() || undefined,
        search: searchQuery.trim() || undefined,
      });
      setTeams((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        const uniqueNew = res.items.filter((t) => !existingIds.has(t.id));
        return [...prev, ...uniqueNew];
      });
      setNextCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiClientError ? err.message : 'Failed to load next page of teams.',
      );
    } finally {
      setLoadingMore(false);
    }
  }

  function handleResetFilters() {
    setSearchQuery('');
    setSkillFilter('');
    setStatusFilter('');
    setCapacityFilter('all');
  }

  async function handleRedeemSubmit(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    setRedeemError(null);
    setRedeemedJoinRequest(null);
    setRedeemingInvite(true);

    try {
      const res = await redeemInviteCode({
        code: inviteCodeInput.trim(),
        message: inviteMessageInput.trim(),
      });
      setRedeemedJoinRequest(res.joinRequest);
      setInviteCodeInput('');
      setInviteMessageInput('');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setRedeemError(err.message);
      } else {
        setRedeemError('Failed to redeem invitation code.');
      }
    } finally {
      setRedeemingInvite(false);
    }
  }

  const hasActiveFilters =
    searchQuery.trim() !== '' ||
    skillFilter.trim() !== '' ||
    statusFilter !== '' ||
    capacityFilter !== 'all';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <section className="card" aria-labelledby="board-page-heading">
        <div className="section-header-row" style={{ marginBottom: '0.5rem' }}>
          <div>
            <h1 id="board-page-heading" style={{ fontSize: '1.55rem', margin: 0 }}>
              Looking for Teammates Board
            </h1>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.925rem' }}>
              {hackathon
                ? `${hackathon.name} · Team size ${hackathon.minTeamSize}–${hackathon.maxTeamSize} members`
                : 'Discover forming and ready teams'}
            </p>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.65rem' }}>
            <SseStatusBadge state={connectionState} label="Board SSE" />
            {user ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowRedeemPanel((prev) => !prev)}
                  aria-expanded={showRedeemPanel}
                >
                  {showRedeemPanel ? 'Hide Invite Code Form' : 'Have an Invite Code?'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => onNavigate('/teams/new')}
                >
                  + Create Team
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onNavigate('/login?returnTo=%2Fboard')}
              >
                Sign In to Create or Join
              </button>
            )}
          </div>
        </div>
      </section>

      {showRedeemPanel && user ? (
        <section className="card" aria-labelledby="redeem-invite-heading">
          <h2 id="redeem-invite-heading" style={{ fontSize: '1.15rem', marginTop: 0 }}>
            Redeem Team Invitation Code
          </h2>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginTop: 0 }}>
            Redeeming a valid invitation code submits a <strong>pending join request</strong> for
            the team leader to review and approve. You become a member only after leader acceptance.
          </p>

          {redeemError ? (
            <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
              <span>{redeemError}</span>
            </div>
          ) : null}

          {redeemedJoinRequest ? (
            <div className="alert alert-success" role="status" style={{ marginBottom: '1rem' }}>
              <div>
                <strong>Pending join request created!</strong> Status:{' '}
                <code>{redeemedJoinRequest.status}</code> (Source:{' '}
                <code>{redeemedJoinRequest.source}</code>). The team leader must approve your
                request before you are added to the team.
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onNavigate(`/teams/${redeemedJoinRequest.teamId}`)}
              >
                View Target Team
              </button>
            </div>
          ) : null}

          <form className="form-grid" style={{ maxWidth: '540px' }} onSubmit={(e) => void handleRedeemSubmit(e)}>
            <div className="form-field">
              <label htmlFor="board-invite-code">Invitation Code</label>
              <input
                id="board-invite-code"
                name="code"
                type="text"
                required
                minLength={16}
                maxLength={128}
                placeholder="Paste 256-bit invitation token..."
                value={inviteCodeInput}
                onChange={(e) => setInviteCodeInput(e.target.value)}
              />
            </div>

            <div className="form-field">
              <label htmlFor="board-invite-message">Note to Team Leader (optional)</label>
              <input
                id="board-invite-message"
                name="message"
                type="text"
                maxLength={500}
                placeholder="Share your role or skills..."
                value={inviteMessageInput}
                onChange={(e) => setInviteMessageInput(e.target.value)}
              />
            </div>

            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={redeemingInvite}>
                {redeemingInvite ? (
                  <>
                    <span className="css-loader-orbitra css-loader-orbitra--on-dark" aria-hidden="true" />
                    <span>Submitting Request...</span>
                  </>
                ) : (
                  'Submit Join Request with Invite Code'
                )}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="filter-bar" aria-label="Filter and search teams">
        <div className="form-field">
          <label htmlFor="filter-search">Search Teams</label>
          <input
            id="filter-search"
            type="search"
            placeholder="Team name or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label htmlFor="filter-skill">Desired Skill Tag</label>
          <input
            id="filter-skill"
            type="text"
            placeholder="e.g. typescript, rust, react"
            value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label htmlFor="filter-status">Team Status</label>
          <select
            id="filter-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | TeamStatus)}
          >
            <option value="">All Statuses (Forming & Ready)</option>
            <option value="forming">Forming (Below Minimum)</option>
            <option value="ready">Ready (Meets Minimum)</option>
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="filter-capacity">Seat Availability</label>
          <select
            id="filter-capacity"
            value={capacityFilter}
            onChange={(e) => setCapacityFilter(e.target.value as 'all' | 'open' | 'full')}
          >
            <option value="all">All Teams</option>
            <option value="open">Has Available Seats</option>
            <option value="full">Full Teams Only</option>
          </select>
        </div>

        {hasActiveFilters ? (
          <div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleResetFilters}
            >
              Clear Filters
            </button>
          </div>
        ) : null}
      </section>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <span>{errorMessage}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void loadFirstPage()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="card">
          <div className="css-loader-scanline" aria-hidden="true" />
          <p className="loader-inline" style={{ marginTop: '0.75rem' }}>
            <span className="css-loader-orbitra" aria-hidden="true" />
            <span>Loading teams from PostgreSQL...</span>
          </p>
        </div>
      ) : teams.length === 0 ? (
        <section className="card" style={{ textAlign: 'center', padding: 'var(--space-8)' }}>
          <h2 style={{ marginTop: 0, fontSize: '1.25rem' }}>
            {hasActiveFilters ? 'No teams match your current filters' : 'No teams on the board yet'}
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
            {hasActiveFilters
              ? 'Try clearing your search or skill filter, or start your own team.'
              : 'Create the first team for this hackathon and start recruiting collaborators.'}
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {hasActiveFilters ? (
              <button type="button" className="btn btn-secondary" onClick={handleResetFilters}>
                Reset All Filters
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                onNavigate(user ? '/teams/new' : '/login?returnTo=%2Fteams%2Fnew')
              }
            >
              Create a Team
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="board-grid">
            {teams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                onSelectTeam={(teamId) => onNavigate(`/teams/${teamId}`)}
              />
            ))}
          </div>

          {hasMore && nextCursor ? (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--space-4)' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <>
                    <span className="css-loader-orbitra" aria-hidden="true" />
                    <span>Loading More Teams...</span>
                  </>
                ) : (
                  'Load More Teams'
                )}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
