#!/usr/bin/env node
/**
 * End-to-end test of the full pipeline with Perchance's IMAGE API mocked:
 *
 *   real perchance.org page → real generator iframe → real image-embed iframes (their JS runs)
 *   → our Playwright automation → 2 images → Express /generator JSON
 *
 * Only https://image-generation.perchance.org/api/* is answered locally (see lib/mock-perchance-backend.js),
 * because Perchance's Cloudflare Turnstile rejects data-center IPs such as CI runners.
 *
 *   npm run test:mock-e2e
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';

import { configureApp } from '../src/http/configure-app.js';
import { ART_STYLES } from '../src/perchance/art-styles.js';
import { IMAGE_COUNT, generatePerchanceImages, parseDataUrl } from '../src/perchance/generator.js';
import { createMockPerchanceBackend } from './lib/mock-perchance-backend.js';

const PROMPT = 'a red fox sitting in a snowy forest, golden hour';
const OUT_DIR = join(tmpdir(), 'pig-mock-output');
const results = [];

async function step(name, fn) {
  const started = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await fn();
    results.push({ ok: true, name, ms: Date.now() - started });
    process.stdout.write(`  ✔ passed (${Date.now() - started} ms)\n`);
  } catch (err) {
    results.push({ ok: false, name, ms: Date.now() - started, err });
    process.stdout.write(`  ✘ FAILED: ${err?.stack || err}\n`);
  }
}

const log = (event, data) => process.stdout.write(`    · ${event}${data ? ` ${JSON.stringify(data)}` : ''}\n`);

function assertTwoImages(images) {
  assert.equal(images.length, IMAGE_COUNT, `expected exactly ${IMAGE_COUNT} images`);
  images.forEach((img, i) => {
    assert.equal(img.index, i + 1);
    const parsed = parseDataUrl(img.dataUrl);
    assert.ok(parsed, `image ${i + 1} is not a base64 image data URL`);
    assert.equal(parsed.mimeType, img.mimeType);
    assert.ok(img.sizeBytes > 500, 'image payload suspiciously small');
  });
  assert.equal(new Set(images.map((i) => i.dataUrl)).size, IMAGE_COUNT, 'images must be distinct');
}

await mkdir(OUT_DIR, { recursive: true });

// ───────────────────────── A) Automation layer ─────────────────────────
const bodiesByType = {};
for (const type of ['Cinematic', 'Painted Anime']) {
  await step(`generatePerchanceImages() → 2 images for type "${type}"`, async () => {
    const mock = createMockPerchanceBackend();
    const res = await generatePerchanceImages({ prompt: PROMPT, type, hooks: mock, log });
    assertTwoImages(res.images);
    assert.equal(res.type, type, 'Perchance dropdown must show the requested style');
    assert.equal(res.settings.numImages, IMAGE_COUNT, '"How many?" must be 2');
    assert.equal(mock.generateBodies.length, IMAGE_COUNT, 'Perchance must call /api/generate exactly 2 times');
    for (const body of mock.generateBodies) {
      assert.ok(String(body.prompt).includes('red fox'), 'the user prompt must reach Perchance');
      assert.equal(body.resolution, '768x768', 'Shape stays at Perchance default (Square)');
    }
    bodiesByType[type] = mock.generateBodies;
    log('final prompt sent by Perchance', { prompt: mock.generateBodies[0].prompt.slice(0, 160) });
    log('timings', res.timings);
  });
}

await step('Selected Art Style changes the prompt Perchance builds', async () => {
  const cinematic = bodiesByType.Cinematic?.[0];
  const anime = bodiesByType['Painted Anime']?.[0];
  assert.ok(cinematic && anime, 'previous steps did not produce data');
  assert.notEqual(cinematic.prompt, anime.prompt, 'style had no effect on the prompt');
  log('Cinematic', {
    prompt: cinematic.prompt.slice(0, 140),
    negativePrompt: String(cinematic.negativePrompt).slice(0, 80),
  });
  log('Painted Anime', {
    prompt: anime.prompt.slice(0, 140),
    negativePrompt: String(anime.negativePrompt).slice(0, 80),
  });
});

// ───────────────────────── B) HTTP layer ─────────────────────────
const httpMock = createMockPerchanceBackend();
const app = configureApp(express(), { generatorHooks: httpMock, mode: 'mock' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const postJson = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

await step('GET /api/types returns the Perchance dropdown values', async () => {
  const res = await fetch(`${base}/api/types`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.types, ART_STYLES);
  assert.equal(data.imageCount, 2);
  assert.equal(data.default, 'Painted Anime');
  log('types', { count: data.count, first: data.types.slice(0, 3) });
});

await step('POST /generator without prompt → 400 INVALID_PROMPT', async () => {
  const res = await postJson('/generator', { type: 'Cinematic' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_PROMPT');
});

await step('POST /generator with unknown type → 400 INVALID_TYPE', async () => {
  const res = await postJson('/generator', { prompt: 'x', type: 'Totally Made Up Style' });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_TYPE');
  assert.equal(data.error.details.allowed.length, ART_STYLES.length);
});

await step('PUT /generator → 405', async () => {
  const res = await fetch(`${base}/generator`, { method: 'PUT' });
  assert.equal(res.status, 405);
});

await step('POST /generator { prompt, type: "Watercolor" } → 200 with exactly 2 images', async () => {
  const res = await postJson('/generator', { prompt: PROMPT, type: 'Watercolor' });
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 500));
  const data = JSON.parse(text);
  assert.equal(data.success, true);
  assert.equal(data.type, 'Watercolor');
  assert.equal(data.count, 2);
  assertTwoImages(data.images);
  log('response', { bytes: text.length, timings: data.timings, browserMode: data.browserMode });
  for (const img of data.images) {
    const { base64 } = parseDataUrl(img.dataUrl);
    await writeFile(join(OUT_DIR, `watercolor-${img.index}.${img.extension}`), Buffer.from(base64, 'base64'));
  }
});

await step('GET /generator?type=no style → canonical "𝗡𝗼 𝘀𝘁𝘆𝗹𝗲" + 2 images', async () => {
  const res = await fetch(
    `${base}/generator?prompt=${encodeURIComponent('a lighthouse in a storm')}&type=${encodeURIComponent('no style')}`,
  );
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data).slice(0, 400));
  assert.equal(data.type, '𝗡𝗼 𝘀𝘁𝘆𝗹𝗲');
  assertTwoImages(data.images);
});

await step('GET / serves the frontend', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /AI Image Generator/);
});

server.close();

// ───────────────────────── Summary ─────────────────────────
const failed = results.filter((r) => !r.ok);
process.stdout.write('\n──────── summary ────────\n');
for (const r of results) process.stdout.write(`${r.ok ? '✔' : '✘'} ${r.name} (${r.ms} ms)\n`);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed · sample images in ${OUT_DIR}\n`);
process.exit(failed.length ? 1 : 0);
