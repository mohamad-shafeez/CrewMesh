import React, { useEffect, useState } from 'react';
import type { HackathonSummary, PublicUserProfile, TeamDetailsDto } from '@crewmesh/shared';
import { fetchTeamBoard } from '../api/teams.js';
import { TeamCard } from '../components/TeamCard.js';

interface LandingPageProps {
  user: PublicUserProfile | null;
  hackathon: HackathonSummary | null;
  onNavigate: (path: string) => void;
}

export function LandingPage({
  user,
  hackathon,
  onNavigate,
}: LandingPageProps): React.JSX.Element {
  const [previewTeams, setPreviewTeams] = useState<TeamDetailsDto[]>([]);
  const [loadingPreview, setLoadingPreview] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!hackathon) {
      return;
    }
    const controller = new AbortController();
    setLoadingPreview(true);
    setPreviewError(null);

    fetchTeamBoard(hackathon.id, { limit: 3 }, controller.signal)
      .then((res) => {
        setPreviewTeams(res.items);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        setPreviewError(err instanceof Error ? err.message : 'Unable to load board preview.');
      })
      .finally(() => {
        setLoadingPreview(false);
      });

    return () => controller.abort();
  }, [hackathon]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <section className="hero-banner" aria-labelledby="landing-hero-heading">
        <div>
          <span className="badge badge-ready" style={{ marginBottom: '0.75rem' }}>
            {hackathon ? hackathon.name : 'Hack4Hack Crew Hiring Challenge 2026'}
          </span>
          <h1 id="landing-hero-heading" className="hero-headline">
            Find your people. Build your team.
          </h1>
          <p className="hero-subtitle">
            Find teammates, discover teams looking for members, and build your hackathon crew
            without endless messages or manual coordination.
          </p>

          <div className="hero-cta-row">
            <button
              type="button"
              className="btn btn-primary btn-arrow-push"
              onClick={() => onNavigate('/board')}
            >
              Explore Team Board <span className="btn-arrow-icon" aria-hidden="true">→</span>
            </button>
            {user ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onNavigate('/teams/new')}
              >
                Create a Team
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onNavigate('/register')}
                >
                  Create Account
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onNavigate('/login')}
                >
                  Sign In
                </button>
              </>
            )}
          </div>
        </div>

        <aside className="hero-rules-card" aria-label="How CrewMesh team formation works">
          <h2 style={{ fontSize: '1.05rem', margin: 0 }}>How CrewMesh Works</h2>
          <ul style={{ margin: 0, paddingLeft: '1.15rem', fontSize: '0.9rem', display: 'grid', gap: '0.5rem' }}>
            <li>
              <strong>Team Size Rules:</strong> Teams require{' '}
              <strong>
                {hackathon ? `${hackathon.minTeamSize}–${hackathon.maxTeamSize}` : '2–5'} members
              </strong>
              . Teams below the minimum are labelled <em>Forming</em> and transition to{' '}
              <em>Ready</em> once minimum capacity is reached.
            </li>
            <li>
              <strong>Leader Approval on Every Join:</strong> Submitting a board join request or
              redeeming an invitation code creates a pending join request for the team leader to
              accept or decline.
            </li>
            <li>
              <strong>One Team Per Participant:</strong> PostgreSQL constraints guarantee each
              participant belongs to at most one active team per hackathon.
            </li>
            <li>
              <strong>Race-Proof Final Seat:</strong> Simultaneous acceptances for the last open
              seat are serialized inside PostgreSQL row locks so capacity is never exceeded.
            </li>
          </ul>
        </aside>
      </section>

      <section className="card" aria-labelledby="live-preview-heading">
        <div className="section-header-row">
          <div>
            <h2 id="live-preview-heading" style={{ fontSize: '1.25rem' }}>
              Recent Teams on the Board
            </h2>
            <p style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Real persisted teams from the PostgreSQL board.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-arrow-push"
            onClick={() => onNavigate('/board')}
          >
            Open Full Board <span className="btn-arrow-icon" aria-hidden="true">→</span>
          </button>
        </div>

        {loadingPreview ? (
          <div style={{ padding: 'var(--space-4) 0' }}>
            <div className="css-loader-scanline" aria-hidden="true" />
            <p className="loader-inline" style={{ marginTop: '0.75rem' }}>
              <span className="css-loader-orbitra" aria-hidden="true" />
              <span>Loading teams from PostgreSQL...</span>
            </p>
          </div>
        ) : previewError ? (
          <div className="alert alert-error" role="alert">
            <span>{previewError}</span>
          </div>
        ) : previewTeams.length === 0 ? (
          <div
            style={{
              padding: 'var(--space-6)',
              textAlign: 'center',
              backgroundColor: 'var(--bg-subtle)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>No teams have been created yet</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Be the first participant to start a team and recruit collaborators.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onNavigate(user ? '/teams/new' : '/register')}
            >
              {user ? 'Create the First Team' : 'Register to Create a Team'}
            </button>
          </div>
        ) : (
          <div className="board-grid">
            {previewTeams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                onSelectTeam={(teamId) => onNavigate(`/teams/${teamId}`)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
