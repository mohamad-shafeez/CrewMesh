import React, { useState } from 'react';
import { isValidIanaTimeZone, type PublicUserProfile } from '@crewmesh/shared';
import { registerAccount } from '../api/auth.js';
import { ApiClientError } from '../api/client.js';

interface RegisterPageProps {
  returnTo: string | null;
  onAuthenticated: (user: PublicUserProfile, redirectPath: string) => void;
  onNavigate: (path: string) => void;
}

export function RegisterPage({
  returnTo,
  onAuthenticated,
  onNavigate,
}: RegisterPageProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [skillsInput, setSkillsInput] = useState<string>('typescript, postgresql, react');
  const [timezone, setTimezone] = useState<string>(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [bio, setBio] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    const nextFieldErrors: Record<string, string> = {};
    if (displayName.trim().length < 2) {
      nextFieldErrors.displayName = 'Display name must be at least 2 characters.';
    }
    if (password.length < 8) {
      nextFieldErrors.password = 'Password must be at least 8 characters.';
    }
    if (!isValidIanaTimeZone(timezone)) {
      nextFieldErrors.timezone = 'Please enter a valid IANA time zone (e.g., Asia/Kolkata or UTC).';
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }

    setSubmitting(true);
    try {
      const parsedSkills = skillsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await registerAccount({
        email,
        password,
        displayName: displayName.trim(),
        skills: parsedSkills,
        timezone: timezone.trim(),
        bio: bio.trim(),
      });
      setPassword('');
      onAuthenticated(res.user, returnTo ?? '/board');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Network error while creating your account.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className="card"
      style={{ maxWidth: '580px', margin: '0 auto', width: '100%' }}
      aria-labelledby="register-heading"
    >
      <h1 id="register-heading" style={{ marginTop: 0, fontSize: '1.5rem' }}>
        Create Participant Account
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
        Set up your profile with your skills and IANA time zone to join or lead a team.
      </p>

      {errorMessage ? (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        <div className="form-field">
          <label htmlFor="reg-displayName">Display Name</label>
          <input
            id="reg-displayName"
            name="displayName"
            type="text"
            required
            minLength={2}
            maxLength={80}
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          {fieldErrors.displayName ? (
            <span className="field-error">{fieldErrors.displayName}</span>
          ) : null}
        </div>

        <div className="form-field">
          <label htmlFor="reg-email">Email Address</label>
          <input
            id="reg-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label htmlFor="reg-password">Password</label>
          <input
            id="reg-password"
            name="password"
            type="password"
            required
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="field-hint">
            8–128 characters. Hashed with Argon2id on the server; never stored in browser storage.
          </span>
          {fieldErrors.password ? (
            <span className="field-error">{fieldErrors.password}</span>
          ) : null}
        </div>

        <div className="form-field">
          <label htmlFor="reg-skills">Skills (comma-separated)</label>
          <input
            id="reg-skills"
            name="skills"
            type="text"
            value={skillsInput}
            onChange={(e) => setSkillsInput(e.target.value)}
          />
          <span className="field-hint">Normalized automatically (e.g., typescript, postgresql, react).</span>
        </div>

        <div className="form-field">
          <label htmlFor="reg-timezone">IANA Time Zone</label>
          <input
            id="reg-timezone"
            name="timezone"
            type="text"
            required
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
          {fieldErrors.timezone ? (
            <span className="field-error">{fieldErrors.timezone}</span>
          ) : null}
        </div>

        <div className="form-field">
          <label htmlFor="reg-bio">Short Bio (optional, max 500 chars)</label>
          <textarea
            id="reg-bio"
            name="bio"
            rows={3}
            maxLength={500}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
          <span className="field-hint">{500 - bio.length} characters remaining</span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="css-loader-orbitra css-loader-orbitra--on-dark" aria-hidden="true" />
                <span>Creating Account...</span>
              </>
            ) : (
              'Create Participant Account'
            )}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              onNavigate(returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login')
            }
          >
            Already registered? Sign In
          </button>
        </div>
      </form>
    </section>
  );
}
