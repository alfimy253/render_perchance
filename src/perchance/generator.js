import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';

import { applyClientHints } from '../browser/fingerprint.js';
import { openBrowserSession } from '../browser/launch.js';
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';
import { PERCHANCE } from './selectors.js';

/** Product rule: every generation returns exactly this many images – no more, no less. */
export const IMAGE_COUNT = 4;

const POLL_MS = 750;
const EMBED_SCAN_MS = 2_000;

/**
 * Drives https://perchance.org/ai-text-to-image-generator with Playwright and returns
 * exactly IMAGE_COUNT images as data URLs.
 *
 * One call = one isolated browser session (fresh profile) that is always closed again.
 *
 * @param {object} params
 * @param {string} params.prompt  Text typed into Perchance's "Description" box.
 * @param {string} params.type    Exact label of Perchance's "Art Style" dropdown (see art-styles.js).
 * @param {AbortSignal} [params.signal]  Aborts the job (e.g. client disconnected).
 * @param {{ onContext?: (context: import('playwright-core').BrowserContext) => Promise<void> }} [params.hooks]
 *        Test seam – lets the mock E2E install network routes. Never used in production.
 * @param {(event: string, data?: object) => void} [params.log]
 */
export async function generatePerchanceImages({ prompt, type, signal, hooks = {}, log = () => {} }) {
  const startedAt = Date.now();
  const deadline = startedAt + config.generationTimeoutMs;
  const timings = {};

  throwIfAborted(signal);
  const session = await openBrowserSession();
  timings.browserLaunchMs = Date.now() - startedAt;
  log('browser.ready', { mode: session.mode, ms: timings.browserLaunchMs });

  try {
    throwIfAborted(signal);
    const { context } = session;
    if (hooks.onContext) await hooks.onContext(context);

    const page = context.pages()[0] ?? (await context.newPage());
    const crash = trackPageCrash(page);
    if (config.spoofClientHints) await applyClientHints(context, page);
    const net = watchImageNetwork(page);

    // 1) Open Perchance and wait for the generator iframe.
    const navStart = Date.now();
    const frame = await openGenerator(page, { signal, deadline });
    timings.pageReadyMs = Date.now() - navStart;
    log('generator.ready', { ms: timings.pageReadyMs });

    // 2) Prompt + Art Style + "How many?" = 4.
    const form = await fillForm(frame, { prompt, type });
    log('form.filled', form);

    // 3) Listen for the embeds' "finished" messages, then click "✨ generate".
    await installResultCollector(frame);
    const clickedAt = Date.now();
    await clickGenerate(frame);
    log('generate.clicked');

    // 4) Wait until all 4 images are delivered.
    const images = await waitForImages({ page, frame, net, crash, signal, deadline, clickedAt, log });
    timings.generationMs = Date.now() - clickedAt;
    timings.totalMs = Date.now() - startedAt;

    return { images, type: form.artStyle, settings: form, timings, browserMode: session.mode };
  } finally {
    await session.close();
  }
}

/** Navigate to Perchance and resolve with the generator frame once its controls exist. */
export async function openGenerator(page, { signal, deadline = Number.POSITIVE_INFINITY } = {}) {
  const timeout = Math.max(5_000, Math.min(config.pageLoadTimeoutMs, deadline - Date.now()));
  try {
    await page.goto(config.perchanceUrl, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    throw new AppError('GENERATOR_UI_NOT_FOUND', `Could not open ${config.perchanceUrl}: ${firstLine(err)}`, {
      cause: err,
    });
  }
  return waitForGeneratorFrame(page, { signal, until: Date.now() + timeout });
}

/** Perchance renders its UI inside a per-generator subdomain iframe; poll until it is interactive. */
export async function waitForGeneratorFrame(page, { signal, until }) {
  let challenged = false;
  while (Date.now() < until) {
    throwIfAborted(signal);
    for (const frame of page.frames()) {
      if (frame.isDetached() || !PERCHANCE.generatorFramePattern.test(frame.url())) continue;
      const ready = await evaluateSafe(frame, isGeneratorReady, PERCHANCE.selectors, { fallback: false });
      if (ready) return frame;
    }
    const title = await evaluateSafe(page.mainFrame(), () => document.title, undefined, {
      timeoutMs: 3_000,
      fallback: '',
    });
    if (PERCHANCE.challengeTitlePattern.test(title)) challenged = true;
    await sleep(400);
  }
  if (challenged) throw new AppError('CLOUDFLARE_CHALLENGE', undefined, { details: { stage: 'page' } });
  throw new AppError('GENERATOR_UI_NOT_FOUND');
}

/** Runs inside the generator frame. Must be self-contained (it is serialised by Playwright). */
function isGeneratorReady(sel) {
  const art = document.querySelector(sel.artStyle);
  const num = document.querySelector(sel.numImages);
  return Boolean(
    art &&
    art.options.length > 1 &&
    num &&
    num.options.length > 0 &&
    document.querySelector(sel.description) &&
    document.querySelector(sel.generateButton),
  );
}

/** Reads the live dropdown options (used by scripts/sync-art-styles.js and the live smoke test). */
export async function readLiveOptions(frame) {
  return evaluateSafe(
    frame,
    (sel) => {
      const read = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return [];
        return [...el.options].map((o) => ({
          label: (o.textContent || '').trim(),
          value: o.value,
          selected: o.selected,
        }));
      };
      return { artStyle: read(sel.artStyle), shape: read(sel.shape), numImages: read(sel.numImages) };
    },
    PERCHANCE.selectors,
    { timeoutMs: 10_000, fallback: { artStyle: [], shape: [], numImages: [] } },
  );
}

async function fillForm(frame, { prompt, type }) {
  const textarea = frame.locator(PERCHANCE.selectors.description);
  await textarea.fill(prompt, { timeout: 10_000 });

  const result = await evaluateSafe(
    frame,
    applySelections,
    { sel: PERCHANCE.selectors, type, count: String(IMAGE_COUNT) },
    { timeoutMs: 10_000, fallback: { ok: false, reason: 'ui' } },
  );

  if (!result.ok && result.reason === 'type') {
    throw new AppError('TYPE_NOT_AVAILABLE', `"${type}" is not present in the live Perchance Art Style dropdown.`, {
      details: { available: result.available },
    });
  }
  if (!result.ok && result.reason === 'count') {
    throw new AppError('IMAGE_COUNT_UNAVAILABLE', undefined, { details: { available: result.available } });
  }
  if (!result.ok) throw new AppError('GENERATOR_UI_NOT_FOUND', 'Could not set the Perchance dropdowns.');

  const entered = await textarea.inputValue({ timeout: 10_000 }).catch(() => null);
  if (entered !== prompt) {
    throw new AppError('GENERATOR_UI_NOT_FOUND', 'The prompt could not be entered into the Perchance description box.');
  }
  return { artStyle: result.artStyle, numImages: Number(result.numImages), shape: result.shape };
}

/** Runs inside the generator frame. Selects the Art Style + "How many?" and fires the events Perchance listens to. */
function applySelections({ sel, type, count }) {
  const norm = (s) =>
    String(s || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const label = (o) => (o.textContent || '').trim();
  const choose = (select, option) => {
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === option.value;
  };

  const art = document.querySelector(sel.artStyle);
  const num = document.querySelector(sel.numImages);
  if (!art || !num) return { ok: false, reason: 'ui' };

  const artOptions = [...art.options];
  const artOption = artOptions.find((o) => label(o) === type) || artOptions.find((o) => norm(label(o)) === norm(type));
  if (!artOption) return { ok: false, reason: 'type', available: artOptions.map(label) };

  const numOptions = [...num.options];
  const numOption = numOptions.find((o) => o.value.trim() === count) || numOptions.find((o) => label(o) === count);
  if (!numOption) return { ok: false, reason: 'count', available: numOptions.map(label) };

  if (!choose(art, artOption) || !choose(num, numOption)) return { ok: false, reason: 'ui' };

  const shape = document.querySelector(sel.shape);
  return {
    ok: true,
    artStyle: label(artOption),
    numImages: num.value,
    shape: shape && shape.selectedIndex >= 0 ? label(shape.options[shape.selectedIndex]) : null,
  };
}

/** Every embed posts { type: "finished", dataUrl, seedUsed, id } to the generator frame when its image is ready. */
async function installResultCollector(frame) {
  const installed = await evaluateSafe(
    frame,
    (finishedType) => {
      if (window.__pigCollector) {
        window.__pigCollector.results.length = 0;
        window.__pigCollector.keys.clear();
        return true;
      }
      const store = { results: [], keys: new Set() };
      window.__pigCollector = store;
      window.addEventListener('message', (event) => {
        const d = event.data;
        if (!d || d.type !== finishedType || typeof d.dataUrl !== 'string' || !d.dataUrl.startsWith('data:image/'))
          return;
        const key =
          d.id !== undefined && d.id !== null ? `id:${d.id}` : `len:${d.dataUrl.length}:${d.dataUrl.slice(-48)}`;
        if (store.keys.has(key)) return;
        store.keys.add(key);
        store.results.push({ seed: d.seedUsed ?? null, dataUrl: d.dataUrl });
      });
      return true;
    },
    PERCHANCE.finishedMessageType,
    { timeoutMs: 10_000, fallback: false },
  );
  if (!installed)
    throw new AppError('GENERATOR_UI_NOT_FOUND', 'Could not attach the result listener to the generator frame.');
}

async function clickGenerate(frame) {
  try {
    await frame.click(PERCHANCE.selectors.generateButton, { timeout: 15_000 });
  } catch {
    // Fallback if an overlay intercepts the pointer event.
    const clicked = await evaluateSafe(
      frame,
      (selector) => {
        const btn = document.querySelector(selector);
        if (!btn) return false;
        btn.click();
        return true;
      },
      PERCHANCE.selectors.generateButton,
      { fallback: false },
    );
    if (!clicked) throw new AppError('GENERATOR_UI_NOT_FOUND', 'Could not click the Perchance "generate" button.');
  }
}

async function waitForImages({ page, frame, net, crash, signal, deadline, clickedAt, log }) {
  let firstAntiBotAt = null;
  let lastScanAt = 0;
  let lastStatuses = [];
  let domCount = 0;
  let lastReported = -1;

  for (;;) {
    throwIfAborted(signal);
    if (crash.crashed) throw new AppError('INTERNAL_ERROR', 'The browser page crashed while generating.');
    // Without this, a dead browser would only be noticed at the deadline (evaluateSafe swallows errors).
    if (crash.closed) throw new AppError('INTERNAL_ERROR', 'The browser closed unexpectedly while generating.');

    const collected = await evaluateSafe(
      frame,
      () => (window.__pigCollector ? window.__pigCollector.results.length : 0),
      undefined,
      { fallback: 0 },
    );

    const now = Date.now();
    if (collected < IMAGE_COUNT && now - lastScanAt >= EMBED_SCAN_MS) {
      lastScanAt = now;
      const scan = await scanEmbeds(page);
      lastStatuses = scan.map((s) => s.status);
      domCount = scan.filter((s) => s.hasImage).length;
      if (scan.some((s) => PERCHANCE.antiBotTextPattern.test(s.status))) firstAntiBotAt ??= now;
    }

    const have = Math.max(collected, domCount);
    if (have !== lastReported) {
      lastReported = have;
      log('images.progress', { have, of: IMAGE_COUNT });
    }
    if (have >= IMAGE_COUNT) break;

    // Turnstile keeps failing and Perchance never got as far as calling /api/generate → give up early.
    if (
      have === 0 &&
      net.generateRequests === 0 &&
      firstAntiBotAt !== null &&
      now - firstAntiBotAt > config.antiBotGraceMs
    ) {
      throw new AppError('ANTI_BOT_VERIFICATION_FAILED', undefined, {
        details: {
          turnstileErrorCode: net.lastTurnstileCode,
          turnstileFailures: net.turnstileFailures,
          embedStatuses: lastStatuses,
        },
      });
    }

    // Every embed iframe was answered with a Cloudflare 403 challenge.
    if (have === 0 && net.embedOk === 0 && net.embedChallenges >= IMAGE_COUNT && now - clickedAt > 10_000) {
      throw new AppError('CLOUDFLARE_CHALLENGE', "Perchance's image embeds were blocked by a Cloudflare challenge.", {
        details: { stage: 'embed', blockedEmbeds: net.embedChallenges },
      });
    }

    if (now >= deadline) {
      const partial = await collectImages(page, frame);
      throw new AppError('GENERATION_TIMEOUT', undefined, {
        details: {
          received: partial.length,
          expected: IMAGE_COUNT,
          embedStatuses: lastStatuses,
          partialImages: partial,
        },
      });
    }

    await sleep(POLL_MS);
  }

  const images = await collectImages(page, frame);
  if (images.length < IMAGE_COUNT) {
    throw new AppError('GENERATION_TIMEOUT', 'Perchance reported finished images but fewer than 4 could be read.', {
      details: { received: images.length, expected: IMAGE_COUNT, partialImages: images },
    });
  }
  return images;
}

/** Status text + "has image" flag of every embed iframe (cheap, no image payload). */
async function scanEmbeds(page) {
  const frames = page.frames().filter((f) => !f.isDetached() && PERCHANCE.embedFramePattern.test(f.url()));
  const results = await Promise.all(
    frames.map((f) =>
      evaluateSafe(
        f,
        (selector) => {
          const img = document.querySelector(selector);
          return {
            status: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 160),
            hasImage: Boolean(img && img.src && img.src.startsWith('data:image/')),
          };
        },
        PERCHANCE.selectors.embedResultImage,
        { timeoutMs: 5_000 },
      ),
    ),
  );
  return results.filter(Boolean);
}

/** Fallback reader: <img id="resultImgEl"> inside each embed. */
async function readEmbedImages(page) {
  const frames = page.frames().filter((f) => !f.isDetached() && PERCHANCE.embedFramePattern.test(f.url()));
  const results = await Promise.all(
    frames.map((f) =>
      evaluateSafe(
        f,
        (selector) => {
          const img = document.querySelector(selector);
          if (!img || !img.src || !img.src.startsWith('data:image/')) return null;
          const m = /seed=(-?\d+)/.exec(img.title || '');
          return { dataUrl: img.src, seed: m ? Number(m[1]) : null };
        },
        PERCHANCE.selectors.embedResultImage,
        { timeoutMs: 10_000 },
      ),
    ),
  );
  return results.filter(Boolean);
}

/** Merge postMessage results with the DOM fallback, de-duplicate by content and cap at IMAGE_COUNT. */
async function collectImages(page, frame) {
  const fromMessages = await evaluateSafe(
    frame,
    () => (window.__pigCollector ? window.__pigCollector.results.map((r) => ({ ...r })) : []),
    undefined,
    { timeoutMs: 15_000, fallback: [] },
  );
  const candidates = [...fromMessages];
  if (candidates.length < IMAGE_COUNT) candidates.push(...(await readEmbedImages(page)));

  const seen = new Set();
  const images = [];
  for (const candidate of candidates) {
    const parsed = parseDataUrl(candidate.dataUrl);
    if (!parsed) continue;
    const fingerprint = createHash('sha1').update(parsed.base64).digest('hex');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    images.push({
      index: images.length + 1,
      mimeType: parsed.mimeType,
      extension: extensionFor(parsed.mimeType),
      sizeBytes: parsed.sizeBytes,
      seed: Number.isFinite(candidate.seed) ? candidate.seed : (candidate.seed ?? null),
      dataUrl: candidate.dataUrl,
    });
    if (images.length === IMAGE_COUNT) break;
  }
  return images;
}

/** Tracks what Perchance's image backend is doing (all frames of the page). */
function watchImageNetwork(page) {
  const origin = PERCHANCE.imageApiOrigin;
  const state = {
    embedOk: 0,
    embedChallenges: 0,
    generateRequests: 0,
    verified: false,
    turnstileFailures: 0,
    lastTurnstileCode: null,
  };

  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith(`${origin}/api/generate`)) {
      state.generateRequests += 1;
    } else if (url.startsWith(`${origin}/api/turnstileClientFail`)) {
      state.turnstileFailures += 1;
      try {
        state.lastTurnstileCode = new URL(url).searchParams.get('code');
      } catch {
        // ignore malformed URL
      }
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.startsWith(origin)) return;
    if (PERCHANCE.embedFramePattern.test(url)) {
      if (response.status() === 403 || response.headers()['cf-mitigated']) state.embedChallenges += 1;
      else if (response.ok()) state.embedOk += 1;
    } else if (url.startsWith(`${origin}/api/verifyUser`)) {
      try {
        const body = await response.json();
        if (body && (body.status === 'success' || body.status === 'already_verified')) state.verified = true;
      } catch {
        // body not available / not JSON
      }
    }
  });

  return state;
}

/** Watches for a renderer crash (e.g. out of memory) and for the page/browser going away. */
function trackPageCrash(page) {
  const state = { crashed: false, closed: false };
  page.on('crash', () => {
    state.crashed = true;
  });
  // Fires when the browser process dies (e.g. killed by the OOM killer) or the context is closed.
  page.on('close', () => {
    state.closed = true;
  });
  return state;
}

/** Parses `data:image/<type>;base64,<payload>`. Returns null for anything else. */
export function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const header = dataUrl.slice(0, comma);
  const match = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(header);
  if (!match) return null;
  const base64 = dataUrl.slice(comma + 1).replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return { mimeType: match[1].toLowerCase(), base64, sizeBytes: Math.floor((base64.length * 3) / 4) - padding };
}

function extensionFor(mimeType) {
  const sub = mimeType.split('/')[1] || 'bin';
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  return sub.replace(/[^a-z0-9]/gi, '') || 'bin';
}

/**
 * frame.evaluate() has no timeout and can hang forever on a frame that is navigating,
 * crashed or starved of CPU. Every in-page call goes through this guard instead.
 */
async function evaluateSafe(frame, fn, arg, { timeoutMs = 8_000, fallback = null } = {}) {
  let timer;
  try {
    return await Promise.race([
      frame.evaluate(fn, arg),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new AppError('CLIENT_ABORTED');
}

function firstLine(err) {
  return String(err?.message || err)
    .split('\n')[0]
    .slice(0, 300);
}
