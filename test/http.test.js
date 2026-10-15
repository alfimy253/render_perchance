/**
 * HTTP contract tests. The Playwright generator is replaced by a stub, so these run in
 * milliseconds without a browser. (The real automation is covered by `npm run test:mock-e2e`.)
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { configureApp } from '../src/http/configure-app.js';
import { ART_STYLES } from '../src/perchance/art-styles.js';
import { AppError } from '../src/utils/errors.js';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const calls = [];
async function fakeGenerate({ prompt, type }) {
  calls.push({ prompt, type });
  if (prompt === 'please fail')
    throw new AppError('ANTI_BOT_VERIFICATION_FAILED', undefined, { details: { turnstileErrorCode: '600010' } });
  if (prompt === 'please crash') throw new Error('unexpected');
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

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /api/types', () => {
  it('returns the Perchance dropdown values', async () => {
    const res = await fetch(`${base}/api/types`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.types, ART_STYLES);
    assert.equal(data.imageCount, 4);
    assert.equal(data.default, 'Painted Anime');
    assert.equal(data.authRequired, false);
  });
});

describe('GET /api/health', () => {
  it('reports ok', async () => {
    const res = await fetch(`${base}/api/health`);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.maxConcurrentJobs, 1);
  });
});

describe('/generator', () => {
  it('POST JSON → 4 images', async () => {
    const res = await post('/generator', { prompt: 'a cat', type: 'cinematic' });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('x-request-id'));
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.type, 'Cinematic');
    assert.equal(data.count, 4);
    assert.equal(data.images.length, 4);
    assert.deepEqual(calls.at(-1), { prompt: 'a cat', type: 'Cinematic' });
  });

  it('GET query string → 4 images', async () => {
    const res = await fetch(
      `${base}/generator?prompt=${encodeURIComponent('a dog')}&type=${encodeURIComponent('no style')}`,
    );
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.type, '𝗡𝗼 𝘀𝘁𝘆𝗹𝗲');
  });

  it('/api/generator alias works', async () => {
    const res = await post('/api/generator', { prompt: 'a bird' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).type, 'Painted Anime');
  });

  it('400 on invalid JSON / prompt / type', async () => {
    const bad = await post('/generator', '{"prompt": ');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_JSON');

    const noPrompt = await post('/generator', { type: 'Anime' });
    assert.equal((await noPrompt.json()).error.code, 'INVALID_PROMPT');

    const badType = await post('/generator', { prompt: 'x', type: 'Nope' });
    assert.equal(badType.status, 400);
    assert.equal((await badType.json()).error.code, 'INVALID_TYPE');
  });

  it('maps generator failures to typed errors', async () => {
    const res = await post('/generator', { prompt: 'please fail' });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error.code, 'ANTI_BOT_VERIFICATION_FAILED');
    assert.ok(data.error.hint);

    const crash = await post('/generator', { prompt: 'please crash' });
    assert.equal(crash.status, 500);
    assert.equal((await crash.json()).error.code, 'INTERNAL_ERROR');
  });

  it('405 for other methods, 204 for CORS preflight, 404 for unknown routes', async () => {
    assert.equal((await fetch(`${base}/generator`, { method: 'DELETE' })).status, 405);
    const preflight = await fetch(`${base}/generator`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'NOT_FOUND');
  });

  it('serves the frontend', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /🎨 Art Style/);
  });
});
