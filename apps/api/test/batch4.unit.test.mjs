import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from '../../../scripts/ts-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sharedMod = loadTsModule(path.resolve(__dirname, '../../../packages/shared/src/index.ts'));
const webClientMod = loadTsModule(path.resolve(__dirname, '../../web/src/api/client.ts'), {
  '@crewmesh/shared': sharedMod,
});
const routerMod = loadTsModule(path.resolve(__dirname, '../../web/src/hooks/useRouter.ts'), {
  react: {
    useState: () => [{ pathname: '/', search: '' }, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn) => fn,
  },
});

const { getOrCreateIdempotencyKey, resetAllIdempotencyKeys } = webClientMod;
const { matchRoute } = routerMod;

test('1. Frontend logical idempotency key manager reuses key on identical payload and rotates on payload change', () => {
  resetAllIdempotencyKeys();

  const k1 = getOrCreateIdempotencyKey('create-team:h1', {
    name: 'Alpha',
    skills: ['ts', 'pg'],
  });
  const k2 = getOrCreateIdempotencyKey('create-team:h1', {
    skills: ['ts', 'pg'],
    name: 'Alpha',
  });
  assert.equal(k1, k2);

  const k3 = getOrCreateIdempotencyKey('create-team:h1', {
    name: 'Beta',
    skills: ['ts', 'pg'],
  });
  assert.notEqual(k1, k3);

  resetAllIdempotencyKeys();
});

test('2. Router matches all 7 application routes and blocks external open-redirect returnTo URLs', () => {
  assert.deepEqual(matchRoute('/', ''), { name: 'landing' });
  assert.deepEqual(matchRoute('/board/', ''), { name: 'board' });
  assert.deepEqual(matchRoute('/teams/new', ''), { name: 'create-team' });
  assert.deepEqual(matchRoute('/profile', ''), { name: 'profile' });
  assert.deepEqual(
    matchRoute('/teams/123e4567-e89b-12d3-a456-426614174000', ''),
    { name: 'team-detail', teamId: '123e4567-e89b-12d3-a456-426614174000' },
  );
  assert.deepEqual(matchRoute('/login', '?returnTo=%2Fteams%2Fnew'), {
    name: 'login',
    returnTo: '/teams/new',
  });
  assert.deepEqual(matchRoute('/login', '?returnTo=https://malicious.example.org'), {
    name: 'login',
    returnTo: null,
  });
  assert.deepEqual(matchRoute('/unknown/page', ''), {
    name: 'not-found',
    path: '/unknown/page',
  });
});

test('3. Design system tokens and components enforce light botanical palette, Colorion loaders/buttons, and reduced-motion', () => {
  const tokensCss = fs.readFileSync(
    path.resolve(__dirname, '../../web/src/styles/tokens.css'),
    'utf8',
  );
  const componentsCss = fs.readFileSync(
    path.resolve(__dirname, '../../web/src/styles/components.css'),
    'utf8',
  );
  const mainCss = fs.readFileSync(
    path.resolve(__dirname, '../../web/src/styles/main.css'),
    'utf8',
  );

  // Verify Colorion 2Colors palette tokens
  assert.match(tokensCss, /--bg-page:\s*#faf8f4/i);
  assert.match(tokensCss, /--accent-primary:\s*#07553b/i);
  assert.match(tokensCss, /--accent-secondary:\s*#ced46a/i);

  // Verify Colorion CSS Loaders (Orbitra & Scan-Line) and Animated Buttons (Hover Lift & Arrow Push)
  assert.match(componentsCss, /\.css-loader-orbitra\b/);
  assert.match(componentsCss, /\.css-loader-scanline\b/);
  assert.match(componentsCss, /\.btn-arrow-push\b/);

  // Verify responsive mobile rules and prefers-reduced-motion
  assert.match(mainCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(mainCss, /overflow-x:\s*hidden/);
});

test('4. Backend GET /api/v1/teams/:teamId/invites endpoint is registered and never returns token_hash', () => {
  const inviteRoutes = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/invites.ts'),
    'utf8',
  );
  const inviteService = fs.readFileSync(
    path.resolve(__dirname, '../src/services/invite-service.ts'),
    'utf8',
  );

  assert.match(inviteRoutes, /app\.get\(\s*'\/api\/v1\/teams\/:teamId\/invites'/);
  const startIdx = inviteService.indexOf('export async function listTeamInvitesForLeader');
  const afterStart = inviteService.slice(startIdx);
  const endIdx = afterStart.indexOf('\n/**\n * Generates a 256-bit');
  const listFnBody = afterStart.slice(0, endIdx);

  assert.equal(
    listFnBody.includes('token_hash'),
    false,
    'listTeamInvitesForLeader must not select or return token_hash',
  );
  assert.match(listFnBody, /token_prefix/);
});
