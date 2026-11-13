import React from 'react';
import type { TeamDetailsDto } from '@crewmesh/shared';

interface TeamCardProps {
  team: TeamDetailsDto;
  onSelectTeam: (teamId: string) => void;
}

export function TeamCard({ team, onSelectTeam }: TeamCardProps): React.JSX.Element {
  const fillPercent = Math.min(
    100,
    Math.round((team.memberCount / Math.max(1, team.maxTeamSize)) * 100),
  );

  const meterModifier = team.isFull
    ? 'capacity-meter-fill--full'
    : team.status === 'forming'
      ? 'capacity-meter-fill--forming'
      : '';

  return (
    <article className="team-card" aria-labelledby={`team-title-${team.id}`}>
      <div>
        <div className="section-header-row" style={{ marginBottom: '0.5rem' }}>
          <h3 id={`team-title-${team.id}`} style={{ fontSize: '1.125rem', margin: 0 }}>
            {team.name}
          </h3>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {team.status === 'forming' ? (
              <span className="badge badge-forming" title="Below minimum required team size">
                Forming (min {team.minTeamSize})
              </span>
            ) : (
              <span className="badge badge-ready" title="Meets minimum required team size">
                Ready
              </span>
            )}
            {team.isFull ? (
              <span className="badge badge-full">Full</span>
            ) : (
              <span className="badge badge-ready">
                {team.availableSeats} {team.availableSeats === 1 ? 'seat' : 'seats'} open
              </span>
            )}
          </div>
        </div>

        <p
          style={{
            margin: '0 0 0.85rem',
            color: 'var(--text-secondary)',
            fontSize: '0.92rem',
          }}
        >
          {team.description || 'No description provided.'}
        </p>

        <div className="capacity-meter" style={{ marginBottom: '0.85rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            <span>
              Capacity: {team.memberCount} / {team.maxTeamSize} members
            </span>
            <span>Min required: {team.minTeamSize}</span>
          </div>
          <div className="capacity-meter-track" aria-hidden="true">
            <div
              className={`capacity-meter-fill ${meterModifier}`}
              style={{ width: `${fillPercent}%` }}
            />
          </div>
        </div>

        <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
          <strong>Leader:</strong> {team.leader.displayName} ({team.leader.timezone})
        </div>

        {team.desiredSkills.length > 0 ? (
          <div>
            <span
              style={{
                display: 'block',
                fontSize: '0.775rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                marginBottom: '0.3rem',
              }}
            >
              Desired Skills:
            </span>
            <ul className="skill-list" aria-label={`Desired skills for ${team.name}`}>
              {team.desiredSkills.map((skill) => (
                <li key={skill} className="skill-tag">
                  {skill}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: '0.75rem',
          borderTop: '1px solid var(--border-subtle)',
          gap: '0.5rem',
        }}
      >
        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          Created {new Date(team.createdAt).toLocaleDateString()}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm btn-arrow-push"
          onClick={() => onSelectTeam(team.id)}
        >
          View Team <span className="btn-arrow-icon" aria-hidden="true">→</span>
        </button>
      </div>
    </article>
  );
}
