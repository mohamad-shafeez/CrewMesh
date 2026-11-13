import { describe, expect, it } from 'vitest';
import {
  clearIdempotencyKey,
  getActiveCsrfToken,
  getOrCreateIdempotencyKey,
  resetAllIdempotencyKeys,
  setActiveCsrfToken,
} from './api/client.js';
import { matchRoute, sanitizeReturnToPath } from './hooks/useRouter.js';

describe('Batch 4 Web Client, Idempotency Key Manager & Router Unit Suite', () => {
  it('stores and clears active CSRF token in memory', () => {
    setActiveCsrfToken('test_csrf_token_value');
    expect(getActiveCsrfToken()).toBe('test_csrf_token_value');
    setActiveCsrfToken(null);
    expect(getActiveCsrfToken()).toBeNull();
  });

  it('reuses the same Idempotency-Key for retries of the same payload and rotates when payload changes', () => {
    resetAllIdempotencyKeys();

    const scope = 'create-team:hack4hack-crew-2026';
    const payload1 = { name: 'Team Alpha', desiredSkills: ['typescript', 'postgresql'] };
    const payload1Reordered = { desiredSkills: ['typescript', 'postgresql'], name: 'Team Alpha' };
    const payload2 = { name: 'Team Beta', desiredSkills: ['typescript', 'postgresql'] };

    const keyA = getOrCreateIdempotencyKey(scope, payload1);
    const keyB = getOrCreateIdempotencyKey(scope, payload1Reordered);
    expect(keyA).toBe(keyB);

    const keyC = getOrCreateIdempotencyKey(scope, payload2);
    expect(keyC).not.toBe(keyA);

    clearIdempotencyKey(scope);
    const keyAfterClear = getOrCreateIdempotencyKey(scope, payload2);
    expect(keyAfterClear).not.toBe(keyC);
  });

  it('matches shareable routes and sanitizes returnTo paths against open redirects', () => {
    expect(matchRoute('/', '').name).toBe('landing');
    expect(matchRoute('/board', '').name).toBe('board');
    expect(matchRoute('/teams/new', '').name).toBe('create-team');
    expect(matchRoute('/profile', '').name).toBe('profile');

    const teamMatch = matchRoute('/teams/11111111-2222-3333-4444-555555555555', '');
    expect(teamMatch).toEqual({
      name: 'team-detail',
      teamId: '11111111-2222-3333-4444-555555555555',
    });

    const loginMatch = matchRoute('/login', '?returnTo=%2Fteams%2Fnew');
    expect(loginMatch).toEqual({
      name: 'login',
      returnTo: '/teams/new',
    });

    expect(sanitizeReturnToPath('https://evil.example.com/phish')).toBeNull();
    expect(sanitizeReturnToPath('//evil.example.com')).toBeNull();
    expect(sanitizeReturnToPath('/board')).toBe('/board');
  });
});
