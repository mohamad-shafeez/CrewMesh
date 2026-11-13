#!/usr/bin/env node
/**
 * CrewMesh Health & Readiness CLI Check
 * Verifies /health (liveness) and /ready (PostgreSQL connectivity) endpoints.
 */

const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

async function checkEndpoint(path) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  const body = await response.json().catch(() => ({}));
  return { path, status: response.status, ok: response.ok, body };
}

async function main() {
  try {
    const health = await checkEndpoint('/health');
    const ready = await checkEndpoint('/ready');

    console.info(JSON.stringify({ health, ready }, null, 2));

    if (!health.ok || !ready.ok) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        error: 'HEALTHCHECK_FAILED',
        message: err instanceof Error ? err.message : String(err),
        baseUrl,
      }),
    );
    process.exitCode = 1;
  }
}

main();
