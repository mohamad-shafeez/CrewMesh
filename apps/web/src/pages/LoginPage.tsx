import React, { useState } from 'react';
import type { PublicUserProfile } from '@crewmesh/shared';
import { loginAccount } from '../api/auth.js';
import { ApiClientError } from '../api/client.js';

interface LoginPageProps {
  returnTo: string | null;
  onAuthenticated: (user: PublicUserProfile, redirectPath: string) => void;
  onNavigate: (path: string) => void;
}

export function LoginPage({
  returnTo,
  onAuthenticated,
  onNavigate,
}: LoginPageProps): React.JSX.Element {
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    setErrorMessage(null);
    setSubmitting(true);

    try {
      const res = await loginAccount({ email, password });
      setPassword('');
      onAuthenticated(res.user, returnTo ?? '/board');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Network error while signing in. Please check your connection.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card" style={{ maxWidth: '520px', margin: '0 auto', width: '100%' }} aria-labelledby="login-heading">
      <h1 id="login-heading" style={{ marginTop: 0, fontSize: '1.5rem' }}>
        Sign In to CrewMesh
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
        Access your hackathon profile, request to join teams, or manage your team inbox.
      </p>

      {errorMessage ? (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        <div className="form-field">
          <label htmlFor="login-email">Email Address</label>
          <input
            id="login-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            required
            minLength={8}
            maxLength={128}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="css-loader-orbitra css-loader-orbitra--on-dark" aria-hidden="true" />
                <span>Signing In...</span>
              </>
            ) : (
              'Sign In'
            )}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              onNavigate(returnTo ? `/register?returnTo=${encodeURIComponent(returnTo)}` : '/register')
            }
          >
            Need an account? Register
          </button>
        </div>
      </form>
    </section>
  );
}
