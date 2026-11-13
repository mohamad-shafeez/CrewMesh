/**
 * CrewMesh — Batch 06 Real Grafana k6 Board Load Test
 * Target Endpoint: GET /api/v1/hackathons/:hackathonId/teams
 * Dataset: 10,000 persisted participants, 2,000 persisted teams, 7,000 memberships
 * Requirement: 100 concurrent virtual users, 60-second measured run, p95 < 200 ms, failure rate < 1%
 */

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.API_BASE_URL || 'http://127.0.0.1:3001';
const HACKATHON_SLUG = __ENV.HACKATHON_SLUG || 'hack4hack-crew-2026';
const SUMMARY_DIR = __ENV.K6_REPORT_DIR || 'reports/load-test';

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    board_warmup: {
      executor: 'constant-vus',
      vus: 20,
      duration: '10s',
      exec: 'warmupBoard',
      tags: { phase: 'warmup' },
    },
    board_load: {
      executor: 'constant-vus',
      vus: 100,
      duration: '60s',
      startTime: '10s',
      exec: 'benchmarkBoard',
      tags: { phase: 'measured' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:board_load}': ['p(95)<200'],
    'http_req_failed{scenario:board_load}': ['rate<0.01'],
    'checks{scenario:board_load}': ['rate>0.99'],
  },
};

export function setup() {
  const readyRes = http.get(`${BASE_URL}/ready`);
  if (readyRes.status !== 200) {
    throw new Error(`API readiness check failed with status ${readyRes.status}: ${readyRes.body}`);
  }

  const page1Url = `${BASE_URL}/api/v1/hackathons/${encodeURIComponent(HACKATHON_SLUG)}/teams?limit=20`;
  const page1Res = http.get(page1Url);
  if (page1Res.status !== 200) {
    throw new Error(`Initial board verification failed with status ${page1Res.status}: ${page1Res.body}`);
  }

  const page1Data = page1Res.json();
  if (!page1Data || !Array.isArray(page1Data.items) || page1Data.items.length !== 20 || !page1Data.nextCursor) {
    throw new Error(
      `Scale dataset verification failed on board page 1: expected 20 items and a valid nextCursor, got ${page1Res.body}`,
    );
  }

  return {
    hackathonSlug: HACKATHON_SLUG,
    secondPageCursor: page1Data.nextCursor,
  };
}

export function warmupBoard(data) {
  const url = `${BASE_URL}/api/v1/hackathons/${encodeURIComponent(data.hackathonSlug)}/teams?limit=20`;
  const res = http.get(url, {
    headers: { Accept: 'application/json' },
  });
  check(res, {
    'warmup status is 200': (r) => r.status === 200,
  });
}

export function benchmarkBoard(data) {
  // Exercise realistic public board query patterns across the 2,000 seeded teams:
  // 0: Default page 1 (20 teams + hydrated members)
  // 1: Keyset cursor page 2 (using real cursor from page 1)
  // 2: Open-capacity recruiting teams (lookingForMembers=true&hasCapacity=true)
  // 3: Skill-filtered teams (skill=typescript)
  const variant = (__ITER + __VU) % 4;
  let query = 'limit=20';

  if (variant === 1 && data.secondPageCursor) {
    query = `limit=20&cursor=${encodeURIComponent(data.secondPageCursor)}`;
  } else if (variant === 2) {
    query = 'limit=20&lookingForMembers=true&hasCapacity=true';
  } else if (variant === 3) {
    query = 'limit=20&skill=typescript';
  }

  const url = `${BASE_URL}/api/v1/hackathons/${encodeURIComponent(data.hackathonSlug)}/teams?${query}`;
  const res = http.get(url, {
    headers: { Accept: 'application/json' },
  });

  check(res, {
    'HTTP 200 status': (r) => r.status === 200,
    'valid JSON board envelope with items array': (r) => {
      if (r.status !== 200) return false;
      const body = r.json();
      return (
        body !== null &&
        typeof body === 'object' &&
        Array.isArray(body.items) &&
        body.items.length > 0 &&
        body.items.length <= 20 &&
        typeof body.hasMore === 'boolean'
      );
    },
    'hydrated team members match memberCount and omit private fields': (r) => {
      if (r.status !== 200) return false;
      const body = r.json();
      const first = body && Array.isArray(body.items) ? body.items[0] : null;
      if (!first) return false;
      return (
        typeof first.id === 'string' &&
        typeof first.name === 'string' &&
        Array.isArray(first.members) &&
        first.members.length === first.memberCount &&
        first.leader &&
        first.leader.email === undefined &&
        first.leader.password_hash === undefined
      );
    },
  });
}

export function handleSummary(data) {
  const m = data.metrics['http_req_duration{scenario:board_load}'] || data.metrics.http_req_duration || {};
  const vals = m.values || {};
  const reqs = data.metrics.http_reqs ? data.metrics.http_reqs.values : {};
  const failed = data.metrics['http_req_failed{scenario:board_load}'] || data.metrics.http_req_failed || {};
  const failedVals = failed.values || {};

  const textLines = [
    '================================================================================',
    'CrewMesh Batch 06 — Grafana k6 Board Endpoint Benchmark Summary',
    '================================================================================',
    `Endpoint:          GET ${BASE_URL}/api/v1/hackathons/${HACKATHON_SLUG}/teams`,
    'Virtual Users:     100 concurrent VUs (constant-vus)',
    'Measured Duration: 60s (following 10s warmup)',
    `Total Requests:    ${reqs.count ?? 'N/A'}`,
    `Throughput (RPS):  ${typeof reqs.rate === 'number' ? reqs.rate.toFixed(2) : 'N/A'} req/s`,
    `Average Latency:   ${typeof vals.avg === 'number' ? vals.avg.toFixed(2) : 'N/A'} ms`,
    `p50 Latency:       ${typeof vals['p(50)'] === 'number' ? vals['p(50)'].toFixed(2) : 'N/A'} ms`,
    `p90 Latency:       ${typeof vals['p(90)'] === 'number' ? vals['p(90)'].toFixed(2) : 'N/A'} ms`,
    `p95 Latency:       ${typeof vals['p(95)'] === 'number' ? vals['p(95)'].toFixed(2) : 'N/A'} ms`,
    `p99 Latency:       ${typeof vals['p(99)'] === 'number' ? vals['p(99)'].toFixed(2) : 'N/A'} ms`,
    `Max Latency:       ${typeof vals.max === 'number' ? vals.max.toFixed(2) : 'N/A'} ms`,
    `Failed Rate:       ${typeof failedVals.rate === 'number' ? (failedVals.rate * 100).toFixed(4) : 'N/A'}%`,
    `Threshold p95<200: ${typeof vals['p(95)'] === 'number' && vals['p(95)'] < 200 ? 'PASS' : 'FAIL'}`,
    '================================================================================',
    '',
  ].join('\n');

  return {
    stdout: textLines,
    [`${SUMMARY_DIR}/k6-summary.json`]: JSON.stringify(data, null, 2),
    [`${SUMMARY_DIR}/k6-summary.txt`]: textLines,
  };
}
