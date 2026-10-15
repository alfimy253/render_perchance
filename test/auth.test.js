/**
 * API key tests. `config` is read once at import time, so API_KEY is set before the app modules
 * are imported (each test file runs in its own process). The generator is a stub, so no browser is used.
 * The trailing newline checks that the configured key is trimmed.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';

process.env.API_KEY = 'test-secret-123\n';

const { default: express } = await import('express');
const { configureApp } = await import('../src/http/configure-app.js');

const KEY = 'test-secret-123';
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let generateCalls = 0;
async function fakeGenerate({ type }) {
  generateCalls += 1;
  return {
    type,
    images: [1, 2, 3, 4].map((index) => ({
      index,
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: 70,
      seed: index,
      dataUrl: PIXEL,
    })),
    settings: { artStyle: type, numImages: 4, shape: 'Square' },
    timings: { totalMs: 5 },
    browserMode: 'stub',
  };
}

let server;
let base;

before(async () => {
  server = configureApp(express(), { generate: fakeGenerate }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (body, headers = {}, query = '') =>
  fetch(`${base}/generator${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const VALID = { prompt: 'a red fox', type: 'Cinematic' };

describe('API_KEY protection', () => {
  it('reports authRequired so the frontend shows the 🔑 field', async () => {
    const data = await (await fetch(`${base}/api/types`)).json();
    assert.equal(data.authRequired, true);
  });

  it('keeps the page, /api/types and /api/health public', async () => {
    for (const path of ['/', '/api/types', '/api/health']) assert.equal((await fetch(base + path)).status, 200, path);
  });

  it('rejects a missing or wrong key with 401 UNAUTHORIZED, without generating', async () => {
    const before = generateCalls;
    for (const headers of [
      {},
      { 'X-API-Key': 'wrong' },
      { 'X-API-Key': `${KEY}x` },
      { Authorization: 'Bearer wrong' },
    ]) {
      const res = await post(VALID, headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error.code, 'UNAUTHORIZED');
    }
    assert.equal(generateCalls, before);
  });

  it('checks the key before validating the input', async () => {
    const res = await post({ prompt: '', type: 'NotAStyle' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED');
  });

  it('accepts the key as X-API-Key, Bearer token or ?key=', async () => {
    for (const [headers, query] of [
      [{ 'X-API-Key': KEY }, ''],
      [{ Authorization: `Bearer ${KEY}` }, ''],
      [{}, `?key=${KEY}`],
    ]) {
      const res = await post(VALID, headers, query);
      assert.equal(res.status, 200, JSON.stringify({ headers, query }));
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.count, 4);
    }
  });

  it('validates the input once the key is correct', async () => {
    const res = await post({ prompt: 'a fox', type: 'NotAStyle' }, { 'X-API-Key': KEY });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_TYPE');
  });
});
