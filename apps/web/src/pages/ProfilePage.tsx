import React, { useState } from 'react';
import { isValidIanaTimeZone, type PublicUserProfile } from '@crewmesh/shared';
import { updateProfile } from '../api/auth.js';
import { ApiClientError } from '../api/client.js';

interface ProfilePageProps {
  user: PublicUserProfile;
  onUserUpdated: (updated: PublicUserProfile) => void;
  onNavigate: (path: string) => void;
}

export function ProfilePage({
  user,
  onUserUpdated,
  onNavigate,
}: ProfilePageProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState<string>(user.displayName);
  const [skillsInput, setSkillsInput] = useState<string>(user.skills.join(', '));
  const [timezone, setTimezone] = useState<string>(user.timezone);
  const [bio, setBio] = useState<string>(user.bio);
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSubmit(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!isValidIanaTimeZone(timezone)) {
      setErrorMessage('Please enter a valid IANA time zone (e.g., Asia/Kolkata, UTC, America/New_York).');
      return;
    }

    setSaving(true);
    try {
      const parsedSkills = skillsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await updateProfile({
        displayName: displayName.trim(),
        skills: parsedSkills,
        timezone: timezone.trim(),
        bio: bio.trim(),
      });
      onUserUpdated(res.user);
      setSkillsInput(res.user.skills.join(', '));
      setSuccessMessage('Profile saved to PostgreSQL.');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to update profile.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="card"
      style={{ maxWidth: '640px', margin: '0 auto', width: '100%' }}
      aria-labelledby="profile-heading"
    >
      <div className="section-header-row">
        <h1 id="profile-heading" style={{ fontSize: '1.5rem', margin: 0 }}>
          Participant Profile
        </h1>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onNavigate('/board')}
        >
          Back to Board
        </button>
      </div>

      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
        Signed in as <strong>{user.email}</strong>. Keep your skills and IANA time zone accurate so
        team leaders can evaluate your fit.
      </p>

      {errorMessage ? (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {successMessage ? (
        <div className="alert alert-success" role="status" style={{ marginBottom: '1rem' }}>
          <span>{successMessage}</span>
        </div>
      ) : null}

      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        <div className="form-field">
          <label htmlFor="profile-displayName">Display Name</label>
          <input
            id="profile-displayName"
            name="displayName"
            type="text"
            required
            minLength={2}
            maxLength={80}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label htmlFor="profile-skills">Skills (comma-separated)</label>
          <input
            id="profile-skills"
            name="skills"
            type="text"
            value={skillsInput}
            onChange={(e) => setSkillsInput(e.target.value)}
          />
          <span className="field-hint">Normalized to canonical lowercase tags on save.</span>
        </div>

        <div className="form-field">
          <label htmlFor="profile-timezone">IANA Time Zone</label>
          <input
            id="profile-timezone"
            name="timezone"
            type="text"
            required
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label htmlFor="profile-bio">Biography (max 500 characters)</label>
          <textarea
            id="profile-bio"
            name="bio"
            rows={4}
            maxLength={500}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
          <span className="field-hint">{500 - bio.length} characters remaining</span>
        </div>

        <div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? (
              <>
                <span className="css-loader-orbitra css-loader-orbitra--on-dark" aria-hidden="true" />
                <span>Saving Profile...</span>
              </>
            ) : (
              'Save Profile Changes'
            )}
          </button>
        </div>
      </form>
    </section>
  );
}
