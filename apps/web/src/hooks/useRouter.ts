import { useCallback, useEffect, useState } from 'react';

export type RouteMatch =
  | { name: 'landing' }
  | { name: 'board' }
  | { name: 'create-team' }
  | { name: 'team-detail'; teamId: string }
  | { name: 'login'; returnTo: string | null }
  | { name: 'register'; returnTo: string | null }
  | { name: 'profile' }
  | { name: 'not-found'; path: string };

/**
 * Ensures a returnTo path is a safe internal relative route (`/...`) and not an open redirect.
 */
export function sanitizeReturnToPath(rawReturnTo: string | null | undefined): string | null {
  if (!rawReturnTo) {
    return null;
  }
  const trimmed = rawReturnTo.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return null;
  }
  return trimmed;
}

export function matchRoute(pathname: string, search: string): RouteMatch {
  const cleanPath = pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search);
  const returnTo = sanitizeReturnToPath(params.get('returnTo'));

  if (cleanPath === '/') {
    return { name: 'landing' };
  }
  if (cleanPath === '/board') {
    return { name: 'board' };
  }
  if (cleanPath === '/teams/new') {
    return { name: 'create-team' };
  }
  if (cleanPath === '/login') {
    return { name: 'login', returnTo };
  }
  if (cleanPath === '/register') {
    return { name: 'register', returnTo };
  }
  if (cleanPath === '/profile') {
    return { name: 'profile' };
  }

  const teamDetailMatch = /^\/teams\/([0-9a-fA-F-]{36})$/.exec(cleanPath);
  if (teamDetailMatch && teamDetailMatch[1]) {
    return { name: 'team-detail', teamId: teamDetailMatch[1] };
  }

  return { name: 'not-found', path: cleanPath };
}

export function useRouter(): {
  route: RouteMatch;
  currentPath: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
} {
  const [locationState, setLocationState] = useState<{ pathname: string; search: string }>(() => ({
    pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
    search: typeof window !== 'undefined' ? window.location.search : '',
  }));

  useEffect(() => {
    const handlePopState = () => {
      setLocationState({
        pathname: window.location.pathname,
        search: window.location.search,
      });
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (typeof window === 'undefined') {
      return;
    }
    const url = new URL(to, window.location.origin);
    if (options?.replace) {
      window.history.replaceState({}, '', `${url.pathname}${url.search}`);
    } else {
      window.history.pushState({}, '', `${url.pathname}${url.search}`);
    }
    setLocationState({
      pathname: url.pathname,
      search: url.search,
    });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const route = matchRoute(locationState.pathname, locationState.search);
  return {
    route,
    currentPath: `${locationState.pathname}${locationState.search}`,
    navigate,
  };
}
