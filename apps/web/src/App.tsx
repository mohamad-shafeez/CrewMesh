import React, { useEffect, useState } from 'react';
import type { HackathonSummary, PublicUserProfile } from '@crewmesh/shared';
import { fetchCurrentUser, logoutAccount } from './api/auth.js';
import { fetchCurrentHackathon } from './api/teams.js';
import { useRouter } from './hooks/useRouter.js';
import { CreateTeamPage } from './pages/CreateTeamPage.js';
import { LandingPage } from './pages/LandingPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { TeamBoardPage } from './pages/TeamBoardPage.js';
import { TeamDetailPage } from './pages/TeamDetailPage.js';

export function App(): React.JSX.Element {
  const { route, navigate } = useRouter();
  const [user, setUser] = useState<PublicUserProfile | null>(null);
  const [hackathon, setHackathon] = useState<HackathonSummary | null>(null);
  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [loggingOut, setLoggingOut] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    async function bootstrap() {
      try {
        const [sessionRes, hackathonRes] = await Promise.allSettled([
          fetchCurrentUser(),
          fetchCurrentHackathon(),
        ]);

        if (!mounted) {
          return;
        }
        if (sessionRes.status === 'fulfilled' && sessionRes.value) {
          setUser(sessionRes.value.user);
        }
        if (hackathonRes.status === 'fulfilled') {
          setHackathon(hackathonRes.value);
        }
      } finally {
        if (mounted) {
          setInitialLoading(false);
        }
      }
    }
    void bootstrap();
    return () => {
      mounted = false;
    };
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logoutAccount();
      setUser(null);
      navigate('/');
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <header className="app-header">
        <div className="app-header-inner">
          <a
            href="/"
            className="brand-link"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
          >
            <span className="brand-mark" aria-hidden="true">
              CM
            </span>
            <div>
              <span className="brand-title">CrewMesh</span>
              <span className="brand-tagline" style={{ display: 'block' }}>
                Find your people. Build your team.
              </span>
            </div>
          </a>

          <nav className="nav-links" aria-label="Primary navigation">
            <button
              type="button"
              className="nav-link"
              aria-current={route.name === 'landing' ? 'page' : undefined}
              onClick={() => navigate('/')}
            >
              Home
            </button>
            <button
              type="button"
              className="nav-link"
              aria-current={route.name === 'board' ? 'page' : undefined}
              onClick={() => navigate('/board')}
            >
              Team Board
            </button>

            {user ? (
              <>
                <button
                  type="button"
                  className="nav-link"
                  aria-current={route.name === 'create-team' ? 'page' : undefined}
                  onClick={() => navigate('/teams/new')}
                >
                  Create Team
                </button>
                <button
                  type="button"
                  className="nav-link"
                  aria-current={route.name === 'profile' ? 'page' : undefined}
                  onClick={() => navigate('/profile')}
                >
                  {user.displayName}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void handleLogout()}
                  disabled={loggingOut}
                >
                  {loggingOut ? 'Signing Out...' : 'Sign Out'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="nav-link"
                  aria-current={route.name === 'login' ? 'page' : undefined}
                  onClick={() => navigate('/login')}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => navigate('/register')}
                >
                  Create Account
                </button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main id="main-content" className="app-main">
        {initialLoading ? (
          <section className="card" aria-busy="true">
            <div className="css-loader-scanline" aria-hidden="true" />
            <p className="loader-inline" style={{ marginTop: '0.75rem' }}>
              <span className="css-loader-orbitra" aria-hidden="true" />
              <span>Restoring session and hackathon configuration...</span>
            </p>
          </section>
        ) : route.name === 'landing' ? (
          <LandingPage user={user} hackathon={hackathon} onNavigate={navigate} />
        ) : route.name === 'board' ? (
          <TeamBoardPage user={user} hackathon={hackathon} onNavigate={navigate} />
        ) : route.name === 'create-team' ? (
          <CreateTeamPage user={user} hackathon={hackathon} onNavigate={navigate} />
        ) : route.name === 'team-detail' ? (
          <TeamDetailPage teamId={route.teamId} user={user} onNavigate={navigate} />
        ) : route.name === 'login' ? (
          <LoginPage
            returnTo={route.returnTo}
            onAuthenticated={(authUser, redirectPath) => {
              setUser(authUser);
              navigate(redirectPath, { replace: true });
            }}
            onNavigate={navigate}
          />
        ) : route.name === 'register' ? (
          <RegisterPage
            returnTo={route.returnTo}
            onAuthenticated={(authUser, redirectPath) => {
              setUser(authUser);
              navigate(redirectPath, { replace: true });
            }}
            onNavigate={navigate}
          />
        ) : route.name === 'profile' ? (
          user ? (
            <ProfilePage
              user={user}
              onUserUpdated={(updated) => setUser(updated)}
              onNavigate={navigate}
            />
          ) : (
            <LoginPage
              returnTo="/profile"
              onAuthenticated={(authUser) => {
                setUser(authUser);
                navigate('/profile', { replace: true });
              }}
              onNavigate={navigate}
            />
          )
        ) : (
          <NotFoundPage path={route.path} onNavigate={navigate} />
        )}
      </main>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <span>
            <strong>CrewMesh</strong> — Race-proof team formation service
          </span>
          <span>
            {hackathon
              ? `${hackathon.name} (${hackathon.minTeamSize}–${hackathon.maxTeamSize} members)`
              : 'Hack4Hack Crew Hiring Challenge 2026'}
          </span>
        </div>
      </footer>
    </div>
  );
}
