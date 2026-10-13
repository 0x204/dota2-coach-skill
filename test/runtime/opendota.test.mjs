import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenDotaClient, hasReplayData } from '../../dota2-match-coach/scripts/lib/opendota.mjs';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('loads and validates the OpenDota hero constants used by hero-name selection', async () => {
  const calls = [];
  const client = createOpenDotaClient({ fetchImpl: async (url) => {
    calls.push(url);
    return jsonResponse({ 107: { id: 107, name: 'npc_dota_hero_earth_spirit', localized_name: 'Earth Spirit' } });
  } });

  assert.equal(typeof client.loadHeroConstants, 'function');
  assert.deepEqual(await client.loadHeroConstants(), {
    status: 'ready',
    heroes: { 107: { id: 107, name: 'npc_dota_hero_earth_spirit', localized_name: 'Earth Spirit' } },
  });
  assert.match(calls[0], /\/constants\/heroes$/);
});

for (const payload of [{}, [], { 107: { localized_name: 'Earth Spirit' } }]) {
  test(`rejects malformed hero constants payload ${JSON.stringify(payload)}`, async () => {
    const client = createOpenDotaClient({ fetchImpl: async () => jsonResponse(payload) });

    const result = await client.loadHeroConstants();

    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'invalid_response');
  });
}

test('parsed state requires version and replay-derived player series', () => {
  assert.equal(hasReplayData({ version: 22, players: [{ gold_t: [0, 100] }] }), true);
  assert.equal(hasReplayData({ players: [{ kills: 4 }] }), false);
});

test('returns not_found when the match endpoint returns 404', async () => {
  const client = createOpenDotaClient({ fetchImpl: async () => jsonResponse({}, 404) });

  const result = await client.loadMatch(404);

  assert.equal(result.status, 'not_found');
  assert.equal(result.parse.requested, false);
  assert.equal(result.error.code, 'http');
});

test('returns invalid_response when OpenDota responds with HTML', async () => {
  const client = createOpenDotaClient({
    fetchImpl: async () => new Response('<html>down</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  });

  const result = await client.loadMatch(123);

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_response');
});

test('returns rate_limited when the initial OpenDota match fetch responds with 429', async () => {
  const client = createOpenDotaClient({ fetchImpl: async () => jsonResponse({}, 429) });

  const result = await client.loadMatch(123);

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'rate_limited');
});

test('classifies advertised JSON that cannot be decoded as invalid_response', async () => {
  const client = createOpenDotaClient({
    fetchImpl: async () => new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await client.loadMatch(123);

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_response');
});

test('preserves the base scoreboard when the parse deadline elapses before polling', async () => {
  const calls = [];
  const replies = [{ players: [{ account_id: 7 }] }, { jobId: 'job-1' }];
  const client = createOpenDotaClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(replies.shift());
    },
    sleep: async () => { throw new Error('sleep should not run after timeout'); },
  });

  const result = await client.loadMatch(123, { parseTimeoutMs: 0, pollIntervalMs: 1 });

  assert.equal(result.status, 'ready');
  assert.equal(result.match.players[0].account_id, 7);
  assert.equal(result.parse.state, 'timeout');
  assert.equal(result.error.code, 'parse_timeout');
  assert.equal(calls.length, 1);
});

test('caps parse polling sleep to the remaining deadline', async () => {
  const originalNow = Date.now;
  const sleeps = [];
  const replies = [
    { players: [{ account_id: 7 }] },
    { jobId: 'job-1' },
    null,
    { version: 22, players: [{ gold_t: [0, 100] }] },
  ];
  Date.now = () => 1_000;
  try {
    const client = createOpenDotaClient({
      fetchImpl: async () => jsonResponse(replies.shift()),
      sleep: async (ms) => { sleeps.push(ms); },
    });

    const result = await client.loadMatch(123, { parseTimeoutMs: 5, pollIntervalMs: 1_000 });

    assert.equal(result.status, 'ready');
    assert.deepEqual(sleeps, [5]);
  } finally {
    Date.now = originalNow;
  }
});

test('bounds poll HTTP timeout to the remaining parse deadline', async () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const requestTimeouts = [];
  const replies = [
    { players: [{ account_id: 7 }] },
    { jobId: 'job-1' },
    null,
    { version: 22, players: [{ gold_t: [0, 100] }] },
  ];
  Date.now = () => 1_000;
  globalThis.setTimeout = (callback, ms, ...args) => {
    requestTimeouts.push(ms);
    return originalSetTimeout(callback, ms, ...args);
  };
  try {
    const client = createOpenDotaClient({
      fetchImpl: async () => jsonResponse(replies.shift()),
      sleep: async () => {},
    });

    const result = await client.loadMatch(123, { parseTimeoutMs: 5, pollIntervalMs: 1 });

    assert.equal(result.status, 'ready');
    assert.equal(requestTimeouts.at(2), 5);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('preserves the base scoreboard when OpenDota does not return a parse job ID', async () => {
  const replies = [{ players: [{ account_id: 7 }] }, { job: {} }];
  const client = createOpenDotaClient({ fetchImpl: async () => jsonResponse(replies.shift()) });

  const result = await client.loadMatch(123);

  assert.equal(result.status, 'ready');
  assert.equal(result.match.players[0].account_id, 7);
  assert.equal(result.parse.state, 'unavailable');
  assert.equal(result.error.code, 'parse_unavailable');
});

test('preserves the base scoreboard when the finished parse job left no replay data', async () => {
  const unparsed = { players: [{ account_id: 7, kills: 4 }] };
  const replies = [unparsed, { jobId: 'job-1' }, null, unparsed];
  const client = createOpenDotaClient({ fetchImpl: async () => jsonResponse(replies.shift()), sleep: async () => {} });

  const result = await client.loadMatch(123, { pollIntervalMs: 1 });

  assert.equal(result.status, 'ready');
  assert.equal(result.match.players[0].kills, 4);
  assert.equal(result.parse.state, 'failed');
  assert.equal(result.error.code, 'parse_failed');
});

test('honors an integer Retry-After inside the parse deadline', async () => {
  const sleeps = [];
  let now = 1_000;
  const replies = [
    jsonResponse({ players: [{ account_id: 7 }] }),
    new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } }),
    jsonResponse({ jobId: 'job-1' }),
    jsonResponse(null),
    jsonResponse({ version: 22, players: [{ account_id: 7, gold_t: [0, 1] }] }),
  ];
  const client = createOpenDotaClient({
    fetchImpl: async () => replies.shift(),
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });

  const result = await client.loadMatch(123, { parseTimeoutMs: 5_000, pollIntervalMs: 1 });

  assert.equal(result.status, 'ready');
  assert.equal(result.parse.state, 'completed');
  assert.deepEqual(sleeps, [2_000, 1]);
});

test('honors an HTTP-date Retry-After inside the parse deadline', async () => {
  const sleeps = [];
  let now = Date.parse('2026-08-26T10:00:00.000Z');
  const retryAt = new Date(now + 2_000).toUTCString();
  const replies = [
    jsonResponse({ players: [{ account_id: 7 }] }),
    new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': retryAt } }),
    jsonResponse({ jobId: 'job-1' }),
    jsonResponse(null),
    jsonResponse({ version: 22, players: [{ account_id: 7, gold_t: [0, 1] }] }),
  ];
  const client = createOpenDotaClient({
    fetchImpl: async () => replies.shift(),
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });

  const result = await client.loadMatch(123, { parseTimeoutMs: 5_000, pollIntervalMs: 1 });

  assert.equal(result.status, 'ready');
  assert.equal(result.parse.state, 'completed');
  assert.deepEqual(sleeps, [2_000, 1]);
});

for (const retryAfter of ['nonsense', '10']) {
  test(`fails safely without waiting for Retry-After ${retryAfter}`, async () => {
    const sleeps = [];
    let now = 1_000;
    const replies = [
      jsonResponse({ players: [{ account_id: 7 }] }),
      new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': retryAfter } }),
    ];
    const client = createOpenDotaClient({
      fetchImpl: async () => replies.shift(),
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });

    const result = await client.loadMatch(123, { parseTimeoutMs: 5_000, pollIntervalMs: 1 });

    assert.equal(result.status, 'ready');
    assert.equal(result.match.players[0].account_id, 7);
    assert.equal(result.error.code, 'rate_limited');
    assert.deepEqual(sleeps, []);
  });
}

// The live API answers a queued job with its queue row, which carries no state,
// and a job that has left the queue, whether the parse succeeded or not, with null.
function queuedJob(jobId) {
  return {
    id: jobId, type: 'parse', timestamp: '2026-10-13T09:30:12.256Z', attempts: 1,
    data: { match_id: 123 }, next_attempt_time: '2026-10-13T09:30:12.256Z', priority: -2, job_key: 'parse:123', jobId,
  };
}

test('polls the parse job every five seconds and reloads the match once the job leaves the queue', async () => {
  const sleeps = [];
  let now = 0;
  const replies = [
    jsonResponse({ players: [{ account_id: 7 }] }),
    jsonResponse({ job: { jobId: 582091373 } }),
    jsonResponse(queuedJob(582091373)),
    jsonResponse(null),
    jsonResponse({ version: 22, players: [{ account_id: 7, gold_t: [0, 1] }] }),
  ];
  const client = createOpenDotaClient({
    fetchImpl: async () => replies.shift(),
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });

  const result = await client.loadMatch(123, { parseTimeoutMs: 120_000 });

  assert.equal(result.status, 'ready');
  assert.equal(result.parse.state, 'completed');
  assert.deepEqual(result.match.players[0].gold_t, [0, 1]);
  assert.deepEqual(sleeps, [5_000, 5_000]);
  assert.equal(replies.length, 0);
});

test('gives up on a parse job still queued at the deadline', async () => {
  const sleeps = [];
  let now = 0;
  const client = createOpenDotaClient({
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST') return jsonResponse({ job: { jobId: 1 } });
      return jsonResponse(url.endsWith('/request/1') ? queuedJob(1) : { players: [{ account_id: 7 }] });
    },
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });

  const result = await client.loadMatch(123, { parseTimeoutMs: 12_000 });

  assert.equal(result.status, 'ready');
  assert.equal(result.match.players[0].account_id, 7);
  assert.equal(result.parse.state, 'timeout');
  assert.equal(result.error.code, 'parse_timeout');
  assert.deepEqual(sleeps, [5_000, 5_000, 2_000]);
});

test('requests parse, polls job, then reloads the match', async () => {
  const calls = [];
  const replies = [
    { players: [{ account_id: 7 }] },
    { job: { jobId: 'job-1' } },
    null,
    { version: 22, players: [{ account_id: 7, gold_t: [0, 100] }] },
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options.method ?? 'GET']);
    return new Response(JSON.stringify(replies.shift()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createOpenDotaClient({ fetchImpl, sleep: async () => {} });
  const result = await client.loadMatch(123, { parseTimeoutMs: 1000, pollIntervalMs: 1 });
  assert.equal(result.status, 'ready');
  assert.equal(result.parse.state, 'completed');
  assert.deepEqual(calls.map(([, method]) => method), ['GET', 'POST', 'GET', 'GET']);
});
