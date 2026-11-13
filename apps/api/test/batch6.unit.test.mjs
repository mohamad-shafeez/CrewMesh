import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from '../../../scripts/ts-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sharedMod = loadTsModule(path.resolve(__dirname, '../../../packages/shared/src/index.ts'));
const suggestionMod = loadTsModule(
  path.resolve(__dirname, '../src/services/suggestion-service.ts'),
  {
    '@crewmesh/shared': sharedMod,
    '../db/pool.js': {},
    '../plugins/error-handler.js': {},
  },
);
const seedScaleMod = loadTsModule(path.resolve(__dirname, '../src/db/seed-scale.ts'), {
  './pool.js': {},
  './seed.js': {},
  '../security/crypto.js': {},
});

const { evaluateTeammateCandidates } = suggestionMod;
const {
  buildDeterministicScaleDataset,
  assertScaleSeedSafetyGuards,
  assertExactScaleCountsSnapshot,
  SCALE_TOTAL_PARTICIPANTS,
  SCALE_TOTAL_TEAMS,
  SCALE_TOTAL_MEMBERSHIPS,
  SCALE_UNASSIGNED_PARTICIPANTS,
} = seedScaleMod;

const SAMPLE_HACKATHON_ID = '00000000-0000-4000-8000-000000000001';
const EVAL_WINTER = new Date('2026-01-15T12:00:00.000Z');

test('1. buildDeterministicScaleDataset generates exact 10,000 participants, 2,000 teams, 7,000 memberships, and 3,000 unassigned participants', () => {
  const dataset = buildDeterministicScaleDataset(SAMPLE_HACKATHON_ID);

  assert.equal(dataset.participants.length, SCALE_TOTAL_PARTICIPANTS);
  assert.equal(dataset.teams.length, SCALE_TOTAL_TEAMS);
  assert.equal(dataset.memberships.length, SCALE_TOTAL_MEMBERSHIPS);

  const userIds = new Set();
  const emails = new Set();
  for (const p of dataset.participants) {
    assert.match(p.email, /^loadtest-\d{5}@crewmesh\.invalid$/);
    assert.equal(sharedMod.isValidIanaTimeZone(p.timezone), true);
    assert.ok(p.skills.length >= 2 && p.skills.length <= 4);
    assert.equal(typeof p.timezoneConfirmedAt, 'string');
    userIds.add(p.id);
    emails.add(p.email);
  }
  assert.equal(userIds.size, 10000);
  assert.equal(emails.size, 10000);

  const sizeDist = { 2: 0, 3: 0, 4: 0, 5: 0 };
  let openTeams = 0;
  let fullTeams = 0;

  const membershipsByTeam = new Map();
  const assignedUserIds = new Set();

  for (const m of dataset.memberships) {
    assert.equal(
      assignedUserIds.has(m.userId),
      false,
      `Participant ${m.userId} assigned to multiple teams`,
    );
    assignedUserIds.add(m.userId);
    const list = membershipsByTeam.get(m.teamId) ?? [];
    list.push(m);
    membershipsByTeam.set(m.teamId, list);
  }

  assert.equal(assignedUserIds.size, 7000);
  const unassignedCount = dataset.participants.filter((p) => !assignedUserIds.has(p.id)).length;
  assert.equal(unassignedCount, SCALE_UNASSIGNED_PARTICIPANTS);

  for (const t of dataset.teams) {
    const teamMembers = membershipsByTeam.get(t.id) ?? [];
    assert.equal(t.memberCount, teamMembers.length);
    assert.equal(t.status, 'ready');
    sizeDist[t.memberCount] += 1;

    if (t.memberCount === 5) {
      assert.equal(t.lookingForMembers, false);
      fullTeams += 1;
    } else {
      assert.equal(t.lookingForMembers, true);
      openTeams += 1;
    }

    const leaders = teamMembers.filter((m) => m.role === 'leader');
    assert.equal(leaders.length, 1);
    assert.equal(leaders[0].userId, t.leaderUserId);
  }

  assert.deepEqual(sizeDist, { 2: 500, 3: 500, 4: 500, 5: 500 });
  assert.equal(fullTeams, 500);
  assert.equal(openTeams, 1500);

  // Verify assertExactScaleCountsSnapshot enforces exact 500 per team size
  assertExactScaleCountsSnapshot({
    databaseName: 'crewmesh_loadtest',
    hackathonId: SAMPLE_HACKATHON_ID,
    capturedAt: EVAL_WINTER.toISOString(),
    participantsCount: 10000,
    hackathonEligibleParticipantsCount: 10000,
    teamsCount: 2000,
    distinctTeamIdsCount: 2000,
    leadersCount: 2000,
    membershipsCount: 7000,
    teamSizeDistribution: { 2: 500, 3: 500, 4: 500, 5: 500 },
    unassignedParticipantsCount: 3000,
    fullTeamsCount: 500,
    openCapacityTeamsCount: 1500,
    incorrectMemberCounterTeamsCount: 0,
    incorrectLeaderCountTeamsCount: 0,
    duplicateTeamMembershipUsersCount: 0,
  });

  assert.throws(
    () =>
      assertExactScaleCountsSnapshot({
        databaseName: 'crewmesh_loadtest',
        hackathonId: SAMPLE_HACKATHON_ID,
        capturedAt: EVAL_WINTER.toISOString(),
        participantsCount: 10000,
        hackathonEligibleParticipantsCount: 10000,
        teamsCount: 2000,
        distinctTeamIdsCount: 2000,
        leadersCount: 2000,
        membershipsCount: 7000,
        teamSizeDistribution: { 2: 499, 3: 501, 4: 500, 5: 500 },
        unassignedParticipantsCount: 3000,
        fullTeamsCount: 500,
        openCapacityTeamsCount: 1500,
        incorrectMemberCounterTeamsCount: 0,
        incorrectLeaderCountTeamsCount: 0,
        duplicateTeamMembershipUsersCount: 0,
      }),
    /SCALE_SEED_VERIFICATION_FAILED/,
  );
});

test('2. buildDeterministicScaleDataset is 100% deterministic across repeated invocations', () => {
  const run1 = buildDeterministicScaleDataset(SAMPLE_HACKATHON_ID);
  const run2 = buildDeterministicScaleDataset(SAMPLE_HACKATHON_ID);

  assert.deepEqual(run1.participants[0], run2.participants[0]);
  assert.deepEqual(run1.participants[9999], run2.participants[9999]);
  assert.deepEqual(run1.teams[0], run2.teams[0]);
  assert.deepEqual(run1.teams[1999], run2.teams[1999]);
  assert.deepEqual(run1.memberships[0], run2.memberships[0]);
  assert.deepEqual(run1.memberships[6999], run2.memberships[6999]);
});

test('3. assertScaleSeedSafetyGuards refuses production, missing flag, and non-_loadtest databases', async () => {
  const mockLoadtestPool = {
    query: async () => ({ rows: [{ db_name: 'crewmesh_loadtest' }] }),
  };
  const mockDevPool = {
    query: async () => ({ rows: [{ db_name: 'crewmesh_dev' }] }),
  };
  const mockTestPool = {
    query: async () => ({ rows: [{ db_name: 'crewmesh_test' }] }),
  };

  await assert.rejects(
    () =>
      assertScaleSeedSafetyGuards(mockLoadtestPool, {
        NODE_ENV: 'production',
        CREWMESH_ALLOW_SCALE_SEED: 'true',
      }),
    /NODE_ENV=production/,
  );

  await assert.rejects(
    () =>
      assertScaleSeedSafetyGuards(mockLoadtestPool, {
        NODE_ENV: 'development',
        CREWMESH_ALLOW_SCALE_SEED: 'false',
      }),
    /CREWMESH_ALLOW_SCALE_SEED=true/,
  );

  await assert.rejects(
    () =>
      assertScaleSeedSafetyGuards(mockDevPool, {
        NODE_ENV: 'development',
        CREWMESH_ALLOW_SCALE_SEED: 'true',
      }),
    /_loadtest/,
  );

  await assert.rejects(
    () =>
      assertScaleSeedSafetyGuards(mockTestPool, {
        NODE_ENV: 'test',
        CREWMESH_ALLOW_SCALE_SEED: 'true',
      }),
    /_loadtest/,
  );

  const ok = await assertScaleSeedSafetyGuards(mockLoadtestPool, {
    NODE_ENV: 'test',
    CREWMESH_ALLOW_SCALE_SEED: 'true',
  });
  assert.equal(ok.databaseName, 'crewmesh_loadtest');
});

test('4. evaluateTeammateCandidates refuses to use unconfirmed legacy UTC timezones and reports timezoneEvidence diagnostics', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['typescript', 'rust'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'Asia/Kolkata',
        timezoneConfirmed: true,
      },
      {
        userId: '00000000-0000-4000-8000-000000000002',
        skills: ['typescript'],
        timezone: 'UTC',
        timezoneConfirmed: false,
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000010',
        displayName: 'Confirmed Kolkata Candidate',
        skills: ['rust'],
        timezone: 'Asia/Kolkata',
        timezoneConfirmed: true,
      },
      {
        userId: '00000000-0000-4000-8000-000000000011',
        displayName: 'Unconfirmed Legacy UTC Candidate',
        skills: ['rust'],
        timezone: 'UTC',
        timezoneConfirmed: false,
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  assert.deepEqual(evaluation.timezoneEvidence, {
    teamMembersCount: 2,
    confirmedTeamMembersCount: 1,
    unconfirmedTeamMembersCount: 1,
    eligibleCandidatesWithConfirmedTimezone: 1,
    eligibleCandidatesWithUnconfirmedTimezone: 1,
  });

  const candConfirmed = evaluation.candidates.find(
    (c) => c.userId === '00000000-0000-4000-8000-000000000010',
  );
  const candUnconfirmed = evaluation.candidates.find(
    (c) => c.userId === '00000000-0000-4000-8000-000000000011',
  );

  assert.equal(candConfirmed.timezoneScore, 100);
  assert.equal(candConfirmed.overallScore, 100);

  assert.equal(candUnconfirmed.timezone, null);
  assert.equal(candUnconfirmed.timezoneScore, null);
  assert.deepEqual(candUnconfirmed.scoreComponentsUsed, ['skill']);
  assert.equal(candUnconfirmed.skillScore, 100);
  assert.equal(candUnconfirmed.overallScore, 100);
});

test('5. Migration 005 enforces timezone provenance, drops redundant 004 indexes, and creates hackathon_participants', () => {
  const upSql = fs.readFileSync(
    path.resolve(
      __dirname,
      '../migrations/005_scale_performance_and_timezone_provenance.up.sql',
    ),
    'utf8',
  );
  const downSql = fs.readFileSync(
    path.resolve(
      __dirname,
      '../migrations/005_scale_performance_and_timezone_provenance.down.sql',
    ),
    'utf8',
  );

  assert.match(upSql, /ADD COLUMN IF NOT EXISTS timezone_confirmed_at TIMESTAMPTZ NULL/);
  assert.match(upSql, /ALTER COLUMN timezone DROP DEFAULT/);
  assert.match(upSql, /ALTER COLUMN timezone DROP NOT NULL/);
  assert.match(upSql, /ADD CONSTRAINT users_timezone_provenance_chk/);
  assert.match(upSql, /DROP INDEX IF EXISTS idx_team_members_hackathon_user_lookup/);
  assert.match(upSql, /DROP INDEX IF EXISTS idx_join_requests_team_pending_user_lookup/);
  assert.match(upSql, /CREATE TABLE IF NOT EXISTS hackathon_participants/);
  assert.match(upSql, /CREATE INDEX IF NOT EXISTS idx_teams_hackathon_open_capacity_cursor/);

  assert.match(downSql, /DROP TABLE IF EXISTS hackathon_participants/);
  assert.match(downSql, /DROP COLUMN IF EXISTS timezone_confirmed_at/);
});
