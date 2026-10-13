import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../lib/http.mjs';

for (const [status, contentType, code] of [[503, 'application/json', 'http'], [200, 'text/html', 'invalid_response']]) {
  test(`releases the unread body of a rejected ${status} ${contentType} response`, async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const response = new Response(body, { status, headers: { 'content-type': contentType } });

    await assert.rejects(() => requestJson('https://test.invalid', { fetchImpl: async () => response }), (error) => error.code === code);
    assert.equal(cancelled, true);
  });
}
