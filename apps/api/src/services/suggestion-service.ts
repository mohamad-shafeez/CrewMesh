import type { Pool } from 'pg';
import {
  CREWMESH_MATCH_ALGORITHM_VERSION,
  CREWMESH_MATCH_WEIGHTS,
  isValidIanaTimeZone,
  normalizeSkillTags,
  type ScoreComponentKey,
  type SkillSignalStatus,
  type SuggestedTeammateCandidateDto,
  type TeammateSuggestionsResponseDto,
  type TimezoneEvidenceDiagnosticsDto,
} from '@crewmesh/shared';
import { getDbPool } from '../db/pool.js';
import { AppError } from '../plugins/error-handler.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TIMEZONE_LIMITATION_NOTE =
  'Time-zone proximity is an estimate based on current UTC-offset distance, not proof of overlapping working hours.';

export interface ScoringMemberInput {
  userId: string;
  skills: readonly string[];
  timezone: string | null | undefined;
  /**
   * When explicitly `false`, indicates the stored timezone has no confirmation provenance
   * (`timezone_confirmed_at IS NULL`) and must be treated as unconfirmed (`null`).
   */
  timezoneConfirmed?: boolean;
}

export interface ScoringCandidateInput {
  userId: string;
  displayName: string;
  skills: readonly string[];
  timezone: string | null | undefined;
  /**
   * When explicitly `false`, indicates the stored timezone has no confirmation provenance
   * (`timezone_confirmed_at IS NULL`) and must be treated as unconfirmed (`null`).
   */
  timezoneConfirmed?: boolean;
}

/**
 * Rounds a number to 1 decimal place consistently.
 */
export function roundToOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/**
 * Computes the UTC offset in minutes for a valid IANA time zone at `referenceDate`
 * using Node.js `Intl.DateTimeFormat`.
 *
 * - Handles daylight saving time transitions at `referenceDate`.
 * - Handles non-whole-hour offsets (e.g. Asia/Kolkata +330m, Asia/Kathmandu +345m, America/St_Johns -210m/-150m).
 * - Returns `null` when `tz` is null, empty, or not a valid IANA time zone (never fabricates UTC).
 */
export function getIanaUtcOffsetMinutes(
  tz: string | null | undefined,
  referenceDate: Date,
  offsetCache?: Map<string, number | null>,
): number | null {
  if (!tz || typeof tz !== 'string') {
    return null;
  }
  const trimmed = tz.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (offsetCache && offsetCache.has(trimmed)) {
    return offsetCache.get(trimmed) ?? null;
  }

  if (!isValidIanaTimeZone(trimmed)) {
    offsetCache?.set(trimmed, null);
    return null;
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: trimmed,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });

    const parts = formatter.formatToParts(referenceDate);
    let year = 0;
    let month = 0;
    let day = 0;
    let hour = 0;
    let minute = 0;
    let second = 0;

    for (const part of parts) {
      if (part.type === 'year') year = Number.parseInt(part.value, 10);
      else if (part.type === 'month') month = Number.parseInt(part.value, 10);
      else if (part.type === 'day') day = Number.parseInt(part.value, 10);
      else if (part.type === 'hour') {
        const parsedHour = Number.parseInt(part.value, 10);
        hour = parsedHour === 24 ? 0 : parsedHour;
      } else if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
      else if (part.type === 'second') second = Number.parseInt(part.value, 10);
    }

    const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const referenceUtcSecondsMs = Math.floor(referenceDate.getTime() / 1000) * 1000;
    const offsetMinutes = Math.round((localAsUtcMs - referenceUtcSecondsMs) / 60_000);

    offsetCache?.set(trimmed, offsetMinutes);
    return offsetMinutes;
  } catch {
    offsetCache?.set(trimmed, null);
    return null;
  }
}

/**
 * Computes circular 24-hour distance in minutes between two UTC offsets:
 * d = min(|o_c - o_m|, 1440 - |o_c - o_m|)
 * Result is bounded in [0, 720].
 */
export function computeCircularOffsetDistanceMinutes(
  candidateOffsetMinutes: number,
  memberOffsetMinutes: number,
): number {
  const absDiff = Math.abs(candidateOffsetMinutes - memberOffsetMinutes) % 1440;
  return Math.min(absDiff, 1440 - absDiff);
}

/**
 * Computes pairwise time-zone compatibility score in [0, 100]:
 * PairScore = 100 * (1 - d / 720)
 */
export function computePairwiseTimezoneScore(
  candidateOffsetMinutes: number,
  memberOffsetMinutes: number,
): number {
  const d = computeCircularOffsetDistanceMinutes(candidateOffsetMinutes, memberOffsetMinutes);
  const raw = 100 * (1 - d / 720);
  return Math.max(0, Math.min(100, raw));
}

interface InternalScoredCandidate {
  dto: SuggestedTeammateCandidateDto;
  rawOverallScore: number;
  rawSkillScore: number | null;
  rawTimezoneScore: number | null;
}

/**
 * Deterministic scoring engine (`crewmesh-match-v1`).
 * Pure function suitable for both live PostgreSQL candidate evaluation and isolated unit tests.
 * Strictly honors `timezoneConfirmed` provenance so unconfirmed legacy timezones are never used.
 */
export function evaluateTeammateCandidates(params: {
  teamDesiredSkills: readonly string[];
  existingMembers: readonly ScoringMemberInput[];
  candidates: readonly ScoringCandidateInput[];
  referenceDate: Date;
  limit?: number;
}): {
  teamSkillSummary: {
    desiredSkills: string[];
    coveredDesiredSkills: string[];
    unmetDesiredSkills: string[];
  };
  skillSignal: SkillSignalStatus;
  unrankableProfiles: number;
  timezoneEvidence: TimezoneEvidenceDiagnosticsDto;
  candidates: SuggestedTeammateCandidateDto[];
} {
  const desiredSkills = normalizeSkillTags(params.teamDesiredSkills);
  const coveredSet = new Set<string>();
  for (const member of params.existingMembers) {
    for (const skill of normalizeSkillTags(member.skills)) {
      coveredSet.add(skill);
    }
  }

  const coveredDesiredSkills = desiredSkills.filter((s) => coveredSet.has(s));
  const unmetDesiredSkills = desiredSkills.filter((s) => !coveredSet.has(s));

  const skillSignal: SkillSignalStatus =
    desiredSkills.length === 0
      ? 'no_team_desired_skills'
      : unmetDesiredSkills.length === 0
        ? 'all_desired_skills_covered'
        : 'available';

  // Memoize IANA timezone offsets at the single server reference timestamp
  const offsetCache = new Map<string, number | null>();
  const validMemberOffsets: number[] = [];
  let confirmedTeamMembersCount = 0;

  for (const member of params.existingMembers) {
    const confirmedTz =
      member.timezoneConfirmed === false ? null : (member.timezone ?? null);
    const offset = getIanaUtcOffsetMinutes(confirmedTz, params.referenceDate, offsetCache);
    if (offset !== null) {
      validMemberOffsets.push(offset);
      confirmedTeamMembersCount += 1;
    }
  }

  const scoredList: InternalScoredCandidate[] = [];
  let unrankableProfiles = 0;
  let eligibleCandidatesWithConfirmedTimezone = 0;

  for (const cand of params.candidates) {
    const candidateSkills = normalizeSkillTags(cand.skills);
    const candidateSkillSet = new Set(candidateSkills);

    const matchedDesiredSkills =
      skillSignal === 'available'
        ? unmetDesiredSkills.filter((s) => candidateSkillSet.has(s))
        : [];

    const rawSkillScore: number | null =
      skillSignal === 'available'
        ? (matchedDesiredSkills.length / unmetDesiredSkills.length) * 100
        : null;

    const confirmedCandTz =
      cand.timezoneConfirmed === false ? null : (cand.timezone ?? null);
    const candOffset = getIanaUtcOffsetMinutes(
      confirmedCandTz,
      params.referenceDate,
      offsetCache,
    );

    if (candOffset !== null) {
      eligibleCandidatesWithConfirmedTimezone += 1;
    }

    let rawTimezoneScore: number | null = null;
    let avgDistanceMinutes: number | null = null;

    if (candOffset !== null && validMemberOffsets.length > 0) {
      let totalPairScore = 0;
      let totalDistance = 0;
      for (const memberOffset of validMemberOffsets) {
        totalDistance += computeCircularOffsetDistanceMinutes(candOffset, memberOffset);
        totalPairScore += computePairwiseTimezoneScore(candOffset, memberOffset);
      }
      rawTimezoneScore = totalPairScore / validMemberOffsets.length;
      avgDistanceMinutes = totalDistance / validMemberOffsets.length;
    }

    const scoreComponentsUsed: ScoreComponentKey[] = [];
    if (rawSkillScore !== null) {
      scoreComponentsUsed.push('skill');
    }
    if (rawTimezoneScore !== null) {
      scoreComponentsUsed.push('timezone');
    }

    if (scoreComponentsUsed.length === 0) {
      unrankableProfiles += 1;
      continue;
    }

    let rawOverallScore: number;
    if (rawSkillScore !== null && rawTimezoneScore !== null) {
      rawOverallScore =
        (rawSkillScore * CREWMESH_MATCH_WEIGHTS.skill +
          rawTimezoneScore * CREWMESH_MATCH_WEIGHTS.timezone) /
        (CREWMESH_MATCH_WEIGHTS.skill + CREWMESH_MATCH_WEIGHTS.timezone);
    } else if (rawSkillScore !== null) {
      rawOverallScore = rawSkillScore;
    } else {
      rawOverallScore = rawTimezoneScore!;
    }

    const displayOverall = roundToOneDecimal(rawOverallScore);
    const displaySkill = rawSkillScore !== null ? roundToOneDecimal(rawSkillScore) : null;
    const displayTz = rawTimezoneScore !== null ? roundToOneDecimal(rawTimezoneScore) : null;

    const explanation: string[] = [];

    if (skillSignal === 'no_team_desired_skills') {
      explanation.push(
        'Team has not declared desired skills yet; skill score is unavailable and ranking is renormalized to time-zone proximity.',
      );
    } else if (skillSignal === 'all_desired_skills_covered') {
      explanation.push(
        'All declared team desired skills are already covered by current members; ranking is renormalized to time-zone proximity.',
      );
    } else if (matchedDesiredSkills.length === unmetDesiredSkills.length) {
      explanation.push(
        `Covers all ${unmetDesiredSkills.length} unmet team skill requirement(s): ${matchedDesiredSkills.join(', ')} (100% skill match).`,
      );
    } else if (matchedDesiredSkills.length > 0) {
      explanation.push(
        `Covers ${matchedDesiredSkills.length} of ${unmetDesiredSkills.length} unmet team skill requirement(s): ${matchedDesiredSkills.join(', ')} (${displaySkill}% skill match).`,
      );
    } else if (candidateSkills.length === 0) {
      explanation.push(
        `Candidate has no declared skills on their profile (0% coverage of ${unmetDesiredSkills.length} unmet skill requirement(s)).`,
      );
    } else {
      explanation.push(
        `Covers 0 of ${unmetDesiredSkills.length} unmet team skill requirement(s) (${unmetDesiredSkills.join(', ')}).`,
      );
    }

    if (rawTimezoneScore !== null && avgDistanceMinutes !== null) {
      const avgHours = roundToOneDecimal(avgDistanceMinutes / 60);
      if (avgDistanceMinutes === 0) {
        explanation.push(
          `Same current UTC offset as existing team members (${confirmedCandTz}, 0h offset difference, 100% time-zone proximity).`,
        );
      } else {
        explanation.push(
          `Average UTC-offset difference of ${avgHours}h (${Math.round(avgDistanceMinutes)} min) from existing team members (${displayTz}% time-zone proximity estimate).`,
        );
      }
    } else if (candOffset === null) {
      explanation.push(
        'Candidate time zone is unavailable or invalid (or not yet confirmed); overall score is renormalized using skill coverage only.',
      );
    } else {
      explanation.push(
        'Existing team members have no valid time-zone data (or not yet confirmed); overall score is renormalized using skill coverage only.',
      );
    }

    scoredList.push({
      dto: {
        userId: cand.userId,
        displayName: cand.displayName,
        skills: candidateSkills,
        timezone: candOffset !== null && confirmedCandTz ? confirmedCandTz.trim() : null,
        overallScore: displayOverall,
        skillScore: displaySkill,
        timezoneScore: displayTz,
        scoreComponentsUsed,
        matchedDesiredSkills,
        unmetDesiredSkills,
        explanation,
      },
      rawOverallScore,
      rawSkillScore,
      rawTimezoneScore,
    });
  }

  // Deterministic ordering:
  // 1. Overall score descending
  // 2. Skill score descending when available
  // 3. Time-zone score descending when available
  // 4. Stable userId ascending
  scoredList.sort((a, b) => {
    if (b.dto.overallScore !== a.dto.overallScore) {
      return b.dto.overallScore - a.dto.overallScore;
    }
    if (Math.abs(b.rawOverallScore - a.rawOverallScore) > 1e-9) {
      return b.rawOverallScore - a.rawOverallScore;
    }

    const aSkill = a.dto.skillScore ?? -1;
    const bSkill = b.dto.skillScore ?? -1;
    if (bSkill !== aSkill) {
      return bSkill - aSkill;
    }

    const aTz = a.dto.timezoneScore ?? -1;
    const bTz = b.dto.timezoneScore ?? -1;
    if (bTz !== aTz) {
      return bTz - aTz;
    }

    return a.dto.userId.localeCompare(b.dto.userId);
  });

  const maxResults = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const teamMembersCount = params.existingMembers.length;
  const totalCandCount = params.candidates.length;

  return {
    teamSkillSummary: {
      desiredSkills,
      coveredDesiredSkills,
      unmetDesiredSkills,
    },
    skillSignal,
    unrankableProfiles,
    timezoneEvidence: {
      teamMembersCount,
      confirmedTeamMembersCount,
      unconfirmedTeamMembersCount: Math.max(0, teamMembersCount - confirmedTeamMembersCount),
      eligibleCandidatesWithConfirmedTimezone,
      eligibleCandidatesWithUnconfirmedTimezone: Math.max(
        0,
        totalCandCount - eligibleCandidatesWithConfirmedTimezone,
      ),
    },
    candidates: scoredList.slice(0, maxResults).map((item) => item.dto),
  };
}

interface TeamLookupRow {
  id: string;
  hackathon_id: string;
  leader_user_id: string;
  desired_skills: string[];
  member_count: number;
  max_team_size: number;
}

interface MemberSkillTzRow {
  user_id: string;
  skills: string[];
  timezone: string | null;
  timezone_confirmed_at: Date | null;
}

interface CandidateQueryRow {
  id: string;
  display_name: string;
  skills: string[];
  timezone: string | null;
  timezone_confirmed_at: Date | null;
}

/**
 * Queries PostgreSQL for eligible registered hackathon participants (`hackathon_participants.status = 'registered'`)
 * and computes deterministic explainable teammate recommendations for the team leader.
 * Uses only confirmed time zones (`timezone_confirmed_at IS NOT NULL`) and existing unique indexes
 * (`team_members_one_team_per_hackathon_unique` and `idx_join_requests_one_pending_per_team_user`).
 */
export async function getTeammateSuggestionsForLeader(
  params: {
    teamId: string;
    actorUserId: string;
    limit?: number;
  },
  pool: Pool = getDbPool(),
): Promise<TeammateSuggestionsResponseDto> {
  if (!UUID_REGEX.test(params.teamId)) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }

  const teamRes = await pool.query<TeamLookupRow>(
    `
    SELECT
      id,
      hackathon_id,
      leader_user_id,
      desired_skills,
      member_count,
      max_team_size
    FROM teams
    WHERE id = $1
    LIMIT 1
    `,
    [params.teamId],
  );

  const team = teamRes.rows[0];
  if (!team) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }

  // Enforce leader-only authorization against PostgreSQL
  if (team.leader_user_id !== params.actorUserId) {
    throw new AppError(
      403,
      'UNAUTHORIZED_TEAM_ACTION',
      'Only the current team leader may view teammate recommendations',
    );
  }

  const membersRes = await pool.query<MemberSkillTzRow & { role: string }>(
    `
    SELECT
      tm.user_id,
      tm.role,
      u.skills,
      u.timezone,
      u.timezone_confirmed_at
    FROM team_members tm
    INNER JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = $1
    ORDER BY tm.joined_at ASC, tm.user_id ASC
    `,
    [team.id],
  );

  const leaderInTeam = membersRes.rows.some(
    (m) => m.user_id === params.actorUserId && m.role === 'leader',
  );
  if (!leaderInTeam) {
    throw new AppError(
      403,
      'UNAUTHORIZED_TEAM_ACTION',
      'Only the current team leader may view teammate recommendations',
    );
  }

  const actualMemberCount = membersRes.rows.length;
  if (actualMemberCount >= team.max_team_size) {
    throw new AppError(
      409,
      'TEAM_FULL',
      `Team is already at full capacity (${actualMemberCount}/${team.max_team_size} members) and cannot accept additional teammates`,
    );
  }

  // Execute candidate eligibility query and exclusion diagnostics in parallel (zero N+1 queries)
  // Candidate pool requires active registration in `hackathon_participants` for this hackathon.
  const [candidatesRes, diagnosticsRes, clockRes] = await Promise.all([
    pool.query<CandidateQueryRow>(
      `
      SELECT
        u.id,
        u.display_name,
        u.skills,
        u.timezone,
        u.timezone_confirmed_at
      FROM hackathon_participants hp
      INNER JOIN users u ON u.id = hp.user_id
      WHERE hp.hackathon_id = $1
        AND hp.status = 'registered'
        AND NOT EXISTS (
          SELECT 1
          FROM team_members tm
          WHERE tm.hackathon_id = $1
            AND tm.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM join_requests jr
          WHERE jr.team_id = $2
            AND jr.user_id = u.id
            AND jr.status = 'pending'
        )
      ORDER BY u.id ASC
      `,
      [team.hackathon_id, team.id],
    ),
    pool.query<{
      excluded_already_in_team: number;
      excluded_existing_requests: number;
    }>(
      `
      SELECT
        (
          SELECT COUNT(DISTINCT tm.user_id)::int
          FROM team_members tm
          WHERE tm.hackathon_id = $1
        ) AS excluded_already_in_team,
        (
          SELECT COUNT(DISTINCT jr.user_id)::int
          FROM join_requests jr
          WHERE jr.team_id = $2
            AND jr.status = 'pending'
            AND NOT EXISTS (
              SELECT 1
              FROM team_members tm2
              WHERE tm2.hackathon_id = $1
                AND tm2.user_id = jr.user_id
            )
        ) AS excluded_existing_requests
      `,
      [team.hackathon_id, team.id],
    ),
    pool.query<{ now: Date }>('SELECT NOW() AS now'),
  ]);

  const referenceDate =
    clockRes.rows[0]?.now instanceof Date ? clockRes.rows[0].now : new Date();

  const evaluated = evaluateTeammateCandidates({
    teamDesiredSkills: Array.isArray(team.desired_skills) ? team.desired_skills : [],
    existingMembers: membersRes.rows.map((m) => ({
      userId: m.user_id,
      skills: Array.isArray(m.skills) ? m.skills : [],
      timezone: m.timezone_confirmed_at !== null ? m.timezone : null,
      timezoneConfirmed: m.timezone !== null && m.timezone_confirmed_at !== null,
    })),
    candidates: candidatesRes.rows.map((c) => ({
      userId: c.id,
      displayName: c.display_name,
      skills: Array.isArray(c.skills) ? c.skills : [],
      timezone: c.timezone_confirmed_at !== null ? c.timezone : null,
      timezoneConfirmed: c.timezone !== null && c.timezone_confirmed_at !== null,
    })),
    referenceDate,
    limit: params.limit ?? 20,
  });

  const diagRow = diagnosticsRes.rows[0];

  return {
    teamId: team.id,
    hackathonId: team.hackathon_id,
    algorithmVersion: CREWMESH_MATCH_ALGORITHM_VERSION,
    calculatedAt: referenceDate.toISOString(),
    scoring: {
      weights: {
        skill: CREWMESH_MATCH_WEIGHTS.skill,
        timezone: CREWMESH_MATCH_WEIGHTS.timezone,
      },
      timezoneMethod: 'current-utc-offset-proximity',
      limitation: TIMEZONE_LIMITATION_NOTE,
    },
    teamSkillSummary: evaluated.teamSkillSummary,
    candidates: evaluated.candidates,
    diagnostics: {
      eligibleCandidatesEvaluated: candidatesRes.rows.length,
      excludedAlreadyInTeam: diagRow?.excluded_already_in_team ?? actualMemberCount,
      excludedExistingRequests: diagRow?.excluded_existing_requests ?? 0,
      unrankableProfiles: evaluated.unrankableProfiles,
      skillSignal: evaluated.skillSignal,
      timezoneEvidence: evaluated.timezoneEvidence,
    },
  };
}
