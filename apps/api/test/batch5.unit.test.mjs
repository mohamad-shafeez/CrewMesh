import assert from 'node:assert/strict';
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

const { normalizeSkillTags, isValidIanaTimeZone } = sharedMod;
const {
  getIanaUtcOffsetMinutes,
  computeCircularOffsetDistanceMinutes,
  computePairwiseTimezoneScore,
  evaluateTeammateCandidates,
} = suggestionMod;

const EVAL_WINTER = new Date('2026-01-15T12:00:00.000Z');
const EVAL_SUMMER = new Date('2026-07-15T12:00:00.000Z');

test('1. Exact skill normalization trims, lowercases, and normalizes internal whitespace', () => {
  assert.deepEqual(normalizeSkillTags(['  PostgreSQL  ']), ['postgresql']);
  assert.deepEqual(normalizeSkillTags(['  Distributed   Systems  ']), ['distributed-systems']);
  assert.deepEqual(normalizeSkillTags(['React.JS']), ['react.js']);
  assert.deepEqual(normalizeSkillTags(['   ']), []);
});

test('2. Duplicate skill removal during normalization preserves first-seen normalized order', () => {
  const normalized = normalizeSkillTags([
    ' TypeScript ',
    'typescript',
    'POSTGRESQL',
    '  postgresql  ',
    'React   Native',
    'react-native',
    '',
  ]);
  assert.deepEqual(normalized, ['typescript', 'postgresql', 'react-native']);
});

test('3. Complete unmet-skill coverage yields 100% skill score', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['typescript', 'postgresql', 'rust', 'redis'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript', 'postgresql'],
        timezone: 'Asia/Kolkata',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000010',
        displayName: 'Aarav',
        skills: ['rust', 'redis', 'docker'],
        timezone: 'Asia/Kolkata',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  assert.deepEqual(evaluation.teamSkillSummary.unmetDesiredSkills, ['rust', 'redis']);
  assert.equal(evaluation.skillSignal, 'available');
  assert.equal(evaluation.candidates.length, 1);
  const candidate = evaluation.candidates[0];
  assert.equal(candidate.skillScore, 100);
  assert.deepEqual(candidate.matchedDesiredSkills, ['rust', 'redis']);
  assert.deepEqual(candidate.unmetDesiredSkills, ['rust', 'redis']);
  assert.deepEqual(candidate.scoreComponentsUsed, ['skill', 'timezone']);
});

test('4. Partial unmet-skill coverage yields exact proportional score', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['rust', 'go', 'kubernetes'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'UTC',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000011',
        displayName: 'Priya',
        skills: ['rust', 'go'],
        timezone: 'UTC',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  const candidate = evaluation.candidates[0];
  assert.equal(candidate.skillScore, 66.7);
  assert.equal(candidate.overallScore, 76.7);
});

test('5. Zero unmet-skill coverage yields 0% skill score', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['rust', 'solidity'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'UTC',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000012',
        displayName: 'Rohan',
        skills: ['python', 'figma'],
        timezone: 'UTC',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  const candidate = evaluation.candidates[0];
  assert.equal(candidate.skillScore, 0);
  assert.equal(candidate.timezoneScore, 100);
  assert.equal(candidate.overallScore, 30);
});

test('6. Team with no declared desired skills returns skillScore = null and skillSignal = no_team_desired_skills', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: [],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'Asia/Kolkata',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000013',
        displayName: 'Vikram',
        skills: ['rust'],
        timezone: 'Asia/Kolkata',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  assert.equal(evaluation.skillSignal, 'no_team_desired_skills');
  const candidate = evaluation.candidates[0];
  assert.equal(candidate.skillScore, null);
  assert.equal(candidate.timezoneScore, 100);
  assert.equal(candidate.overallScore, 100);
  assert.deepEqual(candidate.scoreComponentsUsed, ['timezone']);
  assert.match(candidate.explanation[0], /Team has not declared desired skills yet/);
});

test('7. Team whose existing members already cover all desired skills returns skillScore = null and skillSignal = all_desired_skills_covered', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['typescript', 'postgresql'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript', 'postgresql'],
        timezone: 'Asia/Kolkata',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000014',
        displayName: 'Meera',
        skills: ['typescript', 'docker'],
        timezone: 'Asia/Kolkata',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  assert.deepEqual(evaluation.teamSkillSummary.unmetDesiredSkills, []);
  assert.equal(evaluation.skillSignal, 'all_desired_skills_covered');
  const candidate = evaluation.candidates[0];
  assert.equal(candidate.skillScore, null);
  assert.deepEqual(candidate.matchedDesiredSkills, []);
  assert.equal(candidate.overallScore, 100);
  assert.deepEqual(candidate.scoreComponentsUsed, ['timezone']);
});

test('8. Candidate with missing or invalid time zone returns timezoneScore = null and renormalizes to skillScore', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['rust'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'Asia/Kolkata',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000015',
        displayName: 'NoTzUser',
        skills: ['rust'],
        timezone: null,
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  const candidate = evaluation.candidates[0];
  assert.equal(candidate.timezoneScore, null);
  assert.equal(candidate.skillScore, 100);
  assert.equal(candidate.overallScore, 100);
  assert.deepEqual(candidate.scoreComponentsUsed, ['skill']);
  assert.match(candidate.explanation[1], /Candidate time zone is unavailable or invalid/);
});

test('9. Team with no valid member time zones returns timezoneScore = null and renormalizes to skillScore', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['rust'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: null,
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000016',
        displayName: 'ValidTzCandidate',
        skills: ['rust'],
        timezone: 'Asia/Kolkata',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  const candidate = evaluation.candidates[0];
  assert.equal(candidate.timezoneScore, null);
  assert.equal(candidate.skillScore, 100);
  assert.equal(candidate.overallScore, 100);
  assert.deepEqual(candidate.scoreComponentsUsed, ['skill']);
  assert.match(candidate.explanation[1], /Existing team members have no valid time-zone data/);
});

test('10. Same-time-zone candidate receives 100% time-zone compatibility and 0h difference explanation', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['rust'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'Asia/Kolkata',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000017',
        displayName: 'SameTz',
        skills: ['rust'],
        timezone: 'Asia/Kolkata',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  const candidate = evaluation.candidates[0];
  assert.equal(candidate.timezoneScore, 100);
  assert.match(candidate.explanation[1], /0h offset difference, 100% time-zone proximity/);
});

test('11. Opposite-offset candidate (12 hours = 720 minutes apart) receives 0% time-zone compatibility', () => {
  const dist = computeCircularOffsetDistanceMinutes(0, 720);
  assert.equal(dist, 720);
  assert.equal(computePairwiseTimezoneScore(0, 720), 0);

  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['rust'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'UTC',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000018',
        displayName: 'OppositeTz',
        skills: ['rust'],
        timezone: 'Etc/GMT-12',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  const candidate = evaluation.candidates[0];
  assert.equal(candidate.timezoneScore, 0);
  assert.equal(candidate.overallScore, 70);
});

test('12. Circular 24-hour distance handles UTC+12 vs UTC-12 and UTC+14 vs UTC-10 as 0 minutes (100% compatibility)', () => {
  assert.equal(computeCircularOffsetDistanceMinutes(720, -720), 0);
  assert.equal(computePairwiseTimezoneScore(720, -720), 100);

  const kiritimatiOffset = getIanaUtcOffsetMinutes('Pacific/Kiritimati', EVAL_WINTER);
  const honoluluOffset = getIanaUtcOffsetMinutes('Pacific/Honolulu', EVAL_WINTER);
  assert.equal(kiritimatiOffset, 840);
  assert.equal(honoluluOffset, -600);
  assert.equal(computeCircularOffsetDistanceMinutes(kiritimatiOffset, honoluluOffset), 0);
  assert.equal(computePairwiseTimezoneScore(kiritimatiOffset, honoluluOffset), 100);
});

test('13. Non-whole-hour offsets (Asia/Kolkata +330m, Asia/Kathmandu +345m, Australia/Eucla +525m) are calculated accurately in minutes', () => {
  const kolkataOffset = getIanaUtcOffsetMinutes('Asia/Kolkata', EVAL_WINTER);
  const kathmanduOffset = getIanaUtcOffsetMinutes('Asia/Kathmandu', EVAL_WINTER);
  const euclaOffset = getIanaUtcOffsetMinutes('Australia/Eucla', EVAL_WINTER);

  assert.equal(kolkataOffset, 330);
  assert.equal(kathmanduOffset, 345);
  assert.equal(euclaOffset, 525);

  const diffMin = computeCircularOffsetDistanceMinutes(kolkataOffset, kathmanduOffset);
  assert.equal(diffMin, 15);

  const score = computePairwiseTimezoneScore(kolkataOffset, kathmanduOffset);
  assert.ok(Math.abs(score - 97.9166666667) < 1e-6);
});

test('14. DST-aware offset calculation uses the evaluation timestamp rather than hardcoded static offsets', () => {
  const nyWinter = getIanaUtcOffsetMinutes('America/New_York', EVAL_WINTER);
  const nySummer = getIanaUtcOffsetMinutes('America/New_York', EVAL_SUMMER);

  assert.equal(nyWinter, -300);
  assert.equal(nySummer, -240);
});

test('15. Tie-breaking order (overallScore DESC, skillScore DESC NULLS LAST, timezoneScore DESC NULLS LAST, userId ASC) is deterministic', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['rust', 'go'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'UTC',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000099',
        displayName: 'Zara (Higher UUID)',
        skills: ['rust'],
        timezone: 'UTC',
      },
      {
        userId: '00000000-0000-4000-8000-000000000010',
        displayName: 'Aarav (Lower UUID)',
        skills: ['rust'],
        timezone: 'UTC',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  assert.equal(evaluation.candidates[0].userId, '00000000-0000-4000-8000-000000000010');
  assert.equal(evaluation.candidates[1].userId, '00000000-0000-4000-8000-000000000099');
});

test('16. Weighted overall score matches the 70 / 30 formula prior to display rounding', () => {
  const evaluation = evaluateTeammateCandidates({
    teamDesiredSkills: ['typescript', 'postgresql', 'react', 'redis'],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript', 'postgresql'],
        timezone: 'Asia/Kolkata',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000021',
        displayName: 'Candidate A',
        skills: ['react', 'redis', 'docker'],
        timezone: 'Asia/Kolkata',
      },
      {
        userId: '00000000-0000-4000-8000-000000000022',
        displayName: 'Candidate B',
        skills: ['react'],
        timezone: 'Europe/London',
      },
    ],
    referenceDate: EVAL_WINTER,
  });

  const candA = evaluation.candidates[0];
  const candB = evaluation.candidates[1];

  assert.equal(candA.skillScore, 100);
  assert.equal(candA.timezoneScore, 100);
  assert.equal(candA.overallScore, 100);

  assert.equal(candB.skillScore, 50);
  assert.equal(candB.timezoneScore, 54.2);
  assert.equal(candB.overallScore, 51.3);
});

test('17. Weight renormalization works when one component is null and excludes unrankable profiles when both are null', () => {
  const tzOnly = evaluateTeammateCandidates({
    teamDesiredSkills: [],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: 'Asia/Kolkata',
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000031',
        displayName: 'LondonTzOnly',
        skills: ['react'],
        timezone: 'Europe/London',
      },
    ],
    referenceDate: EVAL_WINTER,
  });
  assert.equal(tzOnly.candidates[0].skillScore, null);
  assert.equal(tzOnly.candidates[0].timezoneScore, 54.2);
  assert.equal(tzOnly.candidates[0].overallScore, 54.2);

  const bothNull = evaluateTeammateCandidates({
    teamDesiredSkills: [],
    existingMembers: [
      {
        userId: '00000000-0000-4000-8000-000000000001',
        skills: ['typescript'],
        timezone: null,
      },
    ],
    candidates: [
      {
        userId: '00000000-0000-4000-8000-000000000032',
        displayName: 'BothNullCandidate',
        skills: ['react'],
        timezone: null,
      },
    ],
    referenceDate: EVAL_WINTER,
  });
  assert.equal(bothNull.candidates.length, 0);
  assert.equal(bothNull.unrankableProfiles, 1);
});

test('18. Score bounds are always within [0, 100] across diverse time zones and skill combinations', () => {
  const sampleZones = [
    'UTC',
    'Asia/Kolkata',
    'Asia/Kathmandu',
    'America/New_York',
    'America/Los_Angeles',
    'Europe/Berlin',
    'Pacific/Auckland',
    'Pacific/Honolulu',
    'Pacific/Kiritimati',
    'Australia/Eucla',
  ];

  for (const z1 of sampleZones) {
    assert.equal(isValidIanaTimeZone(z1), true);
    const o1 = getIanaUtcOffsetMinutes(z1, EVAL_WINTER);
    assert.equal(typeof o1, 'number');
    for (const z2 of sampleZones) {
      const o2 = getIanaUtcOffsetMinutes(z2, EVAL_WINTER);
      const dist = computeCircularOffsetDistanceMinutes(o1, o2);
      assert.ok(dist >= 0 && dist <= 720, `Distance ${dist} out of [0, 720]`);
      const score = computePairwiseTimezoneScore(o1, o2);
      assert.ok(score >= 0 && score <= 100, `Score ${score} out of [0, 100]`);
    }
  }
});
