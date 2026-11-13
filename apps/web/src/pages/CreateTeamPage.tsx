import React, { useState } from 'react';
import type { HackathonSummary, PublicUserProfile } from '@crewmesh/shared';
import { ApiClientError } from '../api/client.js';
import { createTeam } from '../api/teams.js';

interface CreateTeamPageProps {
  user: PublicUserProfile | null;
  hackathon: HackathonSummary | null;
  onNavigate: (path: string) => void;
}

export function CreateTeamPage({
  user,
  hackathon,
  onNavigate,
}: CreateTeamPageProps): React.JSX.Element {
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [desiredSkillsInput, setDesiredSkillsInput] = useState<string>('typescript, postgresql, react');
  const [lookingForMembers, setLookingForMembers] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!user) {
    return (
      <section className="card" style={{ maxWidth: '540px', margin: '0 auto', width: '100%' }}>
        <h1 style={{ marginTop: 0 }}>Sign In Required</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          You must be signed in to create a team and become its leader.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onNavigate('/login?returnTo=%2Fteams%2Fnew')}
        >
          Sign In to Continue
        </button>
      </section>
    );
  }

  async function handleSubmit(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    if (!hackathon) {
      setErrorMessage('Hackathon configuration is not loaded yet.');
      return;
    }

    setErrorMessage(null);
    setSubmitting(true);

    try {
      const desiredSkills = desiredSkillsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await createTeam(hackathon.id, {
        name: name.trim(),
        description: description.trim(),
        desiredSkills,
        lookingForMembers,
      });

      onNavigate(`/teams/${res.team.id}`);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Network error while creating team.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className="card"
      style={{ maxWidth: '640px', margin: '0 auto', width: '100%' }}
      aria-labelledby="create-team-heading"
    >
      <div className="section-header-row">
        <h1 id="create-team-heading" style={{ fontSize: '1.5rem', margin: 0 }}>
          Create a Hackathon Team
        </h1>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onNavigate('/board')}
        >
          Cancel
        </button>
      </div>

      <div
        style={{
          backgroundColor: 'var(--bg-subtle)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: '0.85rem 1rem',
          fontSize: '0.88rem',
          color: 'var(--text-secondary)',
          marginBottom: '1.25rem',
        }}
      >
        <p style={{ margin: '0 0 0.35rem' }}>
          <strong>Team Rules & Leadership:</strong> You will become the initial{' '}
          <strong>Team Leader</strong> (1 / {hackathon?.maxTeamSize ?? 5} members).
        </p>
        <p style={{ margin: 0 }}>
          Teams start in <strong>Forming</strong> status and automatically become{' '}
          <strong>Ready</strong> once they reach at least{' '}
          <strong>{hackathon?.minTeamSize ?? 2} members</strong>. All join requests and redeemed
          invitations require your explicit leader approval.
        </p>
      </div>

      {errorMessage ? (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        <div className="form-field">
          <label htmlFor="team-name">Team Name (2–80 characters)</label>
          <input
            id="team-name"
            name="name"
            type="text"
            required
            minLength={2}
            maxLength={80}
            placeholder="e.g. Zero-Deadlock Systems"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <span className="field-hint">{80 - name.length} characters remaining</span>
        </div>

        <div className="form-field">
          <label htmlFor="team-description">Team Pitch & Goals (max 1000 characters)</label>
          <textarea
            id="team-description"
            name="description"
            rows={4}
            maxLength={1000}
            placeholder="Describe what you are building and what roles you are recruiting..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="field-hint">{1000 - description.length} characters remaining</span>
        </div>

        <div className="form-field">
          <label htmlFor="team-skills">Desired Teammate Skills (comma-separated)</label>
          <input
            id="team-skills"
            name="desiredSkills"
            type="text"
            value={desiredSkillsInput}
            onChange={(e) => setDesiredSkillsInput(e.target.value)}
          />
          <span className="field-hint">
            Used for board filtering and skill matching (e.g. typescript, postgresql, react).
          </span>
        </div>

        <div className="form-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
          <input
            id="team-looking"
            name="lookingForMembers"
            type="checkbox"
            style={{ width: 'auto' }}
            checked={lookingForMembers}
            onChange={(e) => setLookingForMembers(e.target.checked)}
          />
          <label htmlFor="team-looking" style={{ margin: 0 }}>
            Actively recruiting new members on the public board
          </label>
        </div>

        <div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="css-loader-orbitra css-loader-orbitra--on-dark" aria-hidden="true" />
                <span>Creating Team...</span>
              </>
            ) : (
              'Create Team & Become Leader'
            )}
          </button>
        </div>
      </form>
    </section>
  );
}
