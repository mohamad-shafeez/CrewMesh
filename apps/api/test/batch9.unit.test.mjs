import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getActiveTranspilerKind, loadTsModule } from '../../../scripts/ts-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

const sharedMod = loadTsModule(path.join(repoRoot, 'packages/shared/src/index.ts'));
const poolMod = loadTsModule(path.join(repoRoot, 'apps/api/src/db/pool.ts'), {
  pg: { Pool: class MockPool {} },
  '../config/env.js': {
    getEnv: () => ({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://crewmesh:test@localhost:5432/crewmesh_test',
      DATABASE_SSL: 'disable',
      DB_POOL_MAX: 10,
    }),
  },
});

test('1. scripts/ts-loader.mjs and .eslintrc.js contain zero OS-specific fallback paths or Module._load shims and execute real production TypeScript modules', () => {
  const loaderSource = fs.readFileSync(path.join(repoRoot, 'scripts/ts-loader.mjs'), 'utf8');
  assert.equal(
    loaderSource.includes('usr/share'),
    false,
    'scripts/ts-loader.mjs must not reference OS-specific share directories',
  );
  assert.equal(
    loaderSource.includes('usr/local/lib'),
    false,
    'scripts/ts-loader.mjs must not reference OS-specific lib directories',
  );

  const eslintConfig = fs.readFileSync(path.join(repoRoot, '.eslintrc.js'), 'utf8');
  assert.equal(
    eslintConfig.includes('Module._load'),
    false,
    '.eslintrc.js must not monkey-patch Module._load',
  );
  assert.equal(
    eslintConfig.includes('@babel/eslint-parser'),
    false,
    '.eslintrc.js must not silently fall back to @babel/eslint-parser',
  );

  const kind = getActiveTranspilerKind();
  assert.equal(
    kind === 'typescript' || kind === 'babel',
    true,
    `Expected declared transpiler kind ('typescript' or 'babel'), got ${kind}`,
  );

  // Exercise production shared module functions through the loader
  assert.equal(sharedMod.normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  assert.deepEqual(sharedMod.normalizeSkillTags(['TypeScript', '  typescript ', 'Rust']), [
    'typescript',
    'rust',
  ]);
});

test('2. resolvePgSslOptions in apps/api/src/db/pool.ts resolves disable, require, and verify-full TLS modes', () => {
  const { resolvePgSslOptions } = poolMod;
  assert.equal(typeof resolvePgSslOptions, 'function');

  assert.equal(
    resolvePgSslOptions('disable', 'postgresql://user:pass@localhost:5432/crewmesh_dev'),
    undefined,
  );
  assert.deepEqual(
    resolvePgSslOptions('require', 'postgresql://user:pass@db.example.com:5432/crewmesh'),
    { rejectUnauthorized: false },
  );
  assert.deepEqual(
    resolvePgSslOptions(
      'disable',
      'postgresql://user:pass@db.example.com:5432/crewmesh?sslmode=require',
    ),
    { rejectUnauthorized: false },
  );
  assert.deepEqual(
    resolvePgSslOptions('verify-full', 'postgresql://user:pass@db.example.com:5432/crewmesh'),
    { rejectUnauthorized: true },
  );
  assert.deepEqual(
    resolvePgSslOptions(
      'disable',
      'postgresql://user:pass@db.example.com:5432/crewmesh?sslmode=verify-full',
    ),
    { rejectUnauthorized: true },
  );
});

test('3. .github/workflows/ci.yml enforces package-lock.json presence and npm ci without npm install fallback', () => {
  const ciYaml = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

  assert.match(ciYaml, /workflow_dispatch:/);
  assert.match(ciYaml, /if \[ ! -f package-lock\.json \]; then/);
  assert.match(ciYaml, /run:\s*npm ci/);
  assert.equal(
    ciYaml.includes('npm install'),
    false,
    'ci.yml must not fall back to npm install when package-lock.json is missing',
  );
  assert.equal(
    ciYaml.includes('continue-on-error: true'),
    false,
    'ci.yml must not weaken test gates with continue-on-error: true',
  );
});

test('4. Workspace script matrix and dependency declarations in root, shared, api, and web package.json files are clean and complete', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const sharedPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/shared/package.json'), 'utf8'),
  );
  const apiPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/api/package.json'), 'utf8'));
  const webPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/package.json'), 'utf8'));

  const requiredRootScripts = [
    'build',
    'dev:api',
    'dev:web',
    'lint',
    'lint:scripts',
    'typecheck',
    'test',
    'test:integration',
    'test:race',
    'test:sse',
    'test:suggestions',
    'test:scale',
    'test:hardening',
    'test:e2e',
    'test:unit:sandbox',
    'verify:sandbox',
    'db:migrate',
    'db:migrate:down',
    'db:migrate:status',
    'db:seed',
    'db:seed:scale',
    'bench:board:k6',
    'healthcheck',
  ];

  for (const scriptName of requiredRootScripts) {
    assert.equal(
      typeof rootPkg.scripts[scriptName],
      'string',
      `Root package.json is missing required script "${scriptName}"`,
    );
  }

  assert.equal(
    rootPkg.scripts.typecheck.includes('--if-present'),
    false,
    'Root typecheck script must not silently skip workspaces via --if-present',
  );
  assert.equal(
    rootPkg.scripts.typecheck.startsWith('npm run build --workspace=@crewmesh/shared'),
    true,
    'Root typecheck must build @crewmesh/shared declarations first',
  );

  assert.equal(typeof sharedPkg.scripts.build, 'string');
  assert.equal(typeof sharedPkg.scripts.typecheck, 'string');
  assert.equal(typeof sharedPkg.devDependencies?.typescript, 'string');
  assert.equal('@fastify/cookie' in (apiPkg.dependencies ?? {}), false);
  assert.equal(apiPkg.scripts.prebuild, 'npm --prefix ../../packages/shared run build');
  assert.equal(apiPkg.scripts.pretypecheck, 'npm --prefix ../../packages/shared run build');
  assert.equal(webPkg.scripts.prebuild, 'npm --prefix ../../packages/shared run build');
  assert.equal(webPkg.scripts.pretypecheck, 'npm --prefix ../../packages/shared run build');
});

test('5. Complete Batches 1-10 regression inventory and pre-deployment hygiene checks pass', () => {
  const expectedFiles = [
    'apps/api/migrations/001_initial_schema.up.sql',
    'apps/api/migrations/001_initial_schema.down.sql',
    'apps/api/migrations/002_team_engine_and_integrity.up.sql',
    'apps/api/migrations/002_team_engine_and_integrity.down.sql',
    'apps/api/migrations/003_nullable_deadline_and_outbox_notify.up.sql',
    'apps/api/migrations/003_nullable_deadline_and_outbox_notify.down.sql',
    'apps/api/migrations/004_suggestions_and_preferences.up.sql',
    'apps/api/migrations/004_suggestions_and_preferences.down.sql',
    'apps/api/migrations/005_scale_performance_and_timezone_provenance.up.sql',
    'apps/api/migrations/005_scale_performance_and_timezone_provenance.down.sql',
    'apps/api/migrations/006_outbox_commit_order_and_participant_fk.up.sql',
    'apps/api/migrations/006_outbox_commit_order_and_participant_fk.down.sql',
    'apps/api/migrations/007_strict_outbox_id_and_rate_limit_cleanup.up.sql',
    'apps/api/migrations/007_strict_outbox_id_and_rate_limit_cleanup.down.sql',
    'apps/api/test/phase1.integration.test.ts',
    'apps/api/test/batch2.integration.test.ts',
    'apps/api/test/batch2.race.test.ts',
    'apps/api/test/batch3.sse.integration.test.ts',
    'apps/api/test/batch5.suggestions.integration.test.ts',
    'apps/api/test/scale/scale-seed.integration.test.ts',
    'apps/api/test/batch7.hardening.integration.test.ts',
    'apps/web/src/App.test.tsx',
    'apps/web/e2e/crewmesh.spec.ts',
    'apps/api/load/board.k6.js',
    'docs/transaction-lock-order.md',
    'docs/workspace-script-matrix.md',
    'docs/deployment-architecture.md',
    'reports/load-test/benchmark-environment.md',
  ];

  for (const relPath of expectedFiles) {
    const fullPath = path.join(repoRoot, relPath);
    assert.equal(fs.existsSync(fullPath), true, `Missing required repository file: ${relPath}`);
    assert.equal(fs.statSync(fullPath).size > 0, true, `File is empty: ${relPath}`);
  }

  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  assert.match(envExample, /DATABASE_SSL=disable/);
  assert.match(envExample, /SERVE_WEB_DIST=false/);
});
