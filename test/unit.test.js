import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildUserAgent } from '../src/browser/fingerprint.js';
import { mergeChromiumArgs } from '../src/browser/launch.js';
import { parseArgList } from '../src/config.js';
import { ART_STYLES, DEFAULT_ART_STYLE } from '../src/perchance/art-styles.js';
import { IMAGE_COUNT, parseDataUrl } from '../src/perchance/generator.js';
import { AppError, ERROR_CATALOG, toAppError } from '../src/utils/errors.js';
import { Semaphore } from '../src/utils/semaphore.js';
import { normalizeLabel, parseGeneratorInput, resolveArtStyle } from '../src/utils/validate.js';

describe('art styles (copied from Perchance)', () => {
  it('has the Perchance default and unique labels', () => {
    assert.ok(ART_STYLES.length >= 50);
    assert.equal(DEFAULT_ART_STYLE, 'Painted Anime');
    assert.equal(ART_STYLES[0], 'Painted Anime');
    assert.equal(new Set(ART_STYLES).size, ART_STYLES.length);
  });

  it('keeps Unicode-bold labels verbatim', () => {
    assert.ok(ART_STYLES.includes('𝗡𝗼 𝘀𝘁𝘆𝗹𝗲'));
    assert.ok(ART_STYLES.includes('Cute 3D Icon 𝗦𝗲𝘁'));
  });

  it('always generates exactly 2 images', () => {
    assert.equal(IMAGE_COUNT, 2);
  });
});

describe('resolveArtStyle()', () => {
  it('accepts exact labels', () => {
    assert.equal(resolveArtStyle('Cinematic'), 'Cinematic');
    assert.equal(resolveArtStyle('Oil Painting - 70s Pulp'), 'Oil Painting - 70s Pulp');
  });

  it('matches case/Unicode-insensitively and returns the canonical label', () => {
    assert.equal(resolveArtStyle('cinematic'), 'Cinematic');
    assert.equal(resolveArtStyle('  studio   ghibli '), 'Studio Ghibli');
    assert.equal(resolveArtStyle('No style'), '𝗡𝗼 𝘀𝘁𝘆𝗹𝗲');
    assert.equal(resolveArtStyle('cute 3d icon set'), 'Cute 3D Icon 𝗦𝗲𝘁');
  });

  it('rejects unknown values', () => {
    assert.equal(resolveArtStyle('Nonexistent'), null);
    assert.equal(resolveArtStyle(42), null);
    assert.equal(normalizeLabel('𝗡𝗼 𝘀𝘁𝘆𝗹𝗲'), 'no style');
  });
});

describe('parseGeneratorInput()', () => {
  it('returns prompt + canonical type', () => {
    assert.deepEqual(parseGeneratorInput({ prompt: '  a cat \r\n on a mat ', type: 'anime' }), {
      prompt: 'a cat \n on a mat',
      type: 'Anime',
    });
  });

  it('defaults the type to Perchance’s default', () => {
    assert.equal(parseGeneratorInput({ prompt: 'x' }).type, DEFAULT_ART_STYLE);
  });

  it('supports the artStyle / style aliases and query arrays', () => {
    assert.equal(parseGeneratorInput({ prompt: 'x', artStyle: 'Watercolor' }).type, 'Watercolor');
    assert.equal(parseGeneratorInput({ prompt: ['x', 'y'], style: ['Pixel Art'] }).type, 'Pixel Art');
  });

  it('rejects missing / blank / oversized prompts', () => {
    for (const bad of [{}, { prompt: '' }, { prompt: '   ' }, { prompt: 5 }, null]) {
      assert.throws(
        () => parseGeneratorInput(bad),
        (e) => e instanceof AppError && e.code === 'INVALID_PROMPT',
      );
    }
    assert.throws(
      () => parseGeneratorInput({ prompt: 'x'.repeat(5000) }),
      (e) => e.code === 'INVALID_PROMPT' && e.details.max === 2000,
    );
  });

  it('rejects unknown types with the allowed list', () => {
    assert.throws(
      () => parseGeneratorInput({ prompt: 'x', type: 'Nope' }),
      (e) => e.code === 'INVALID_TYPE' && e.status === 400 && e.details.allowed.length === ART_STYLES.length,
    );
  });
});

describe('Semaphore', () => {
  it('limits concurrency and hands slots over in FIFO order', async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();
    const order = [];
    const p2 = sem.acquire({ timeoutMs: 1000 }).then((r) => (order.push(2), r));
    const p3 = sem.acquire({ timeoutMs: 1000 }).then((r) => (order.push(3), r));
    assert.equal(sem.pending, 2);
    release1();
    const release2 = await p2;
    release2();
    const release3 = await p3;
    release3();
    assert.deepEqual(order, [2, 3]);
    assert.equal(sem.active, 0);
  });

  it('rejects with BUSY after the queue timeout', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    await assert.rejects(sem.acquire({ timeoutMs: 20 }), (e) => e.code === 'BUSY' && e.status === 429);
    release();
  });

  it('rejects immediately when no waiting is allowed, and on abort', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    await assert.rejects(sem.acquire({ timeoutMs: 0 }), (e) => e.code === 'BUSY');
    const controller = new AbortController();
    const pending = sem.acquire({ timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (e) => e.code === 'CLIENT_ABORTED');
    release();
    assert.equal(sem.active, 0);
  });
});

describe('parseDataUrl()', () => {
  it('parses base64 image data URLs', () => {
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const parsed = parseDataUrl(png);
    assert.equal(parsed.mimeType, 'image/png');
    assert.equal(parsed.sizeBytes, Buffer.from(parsed.base64, 'base64').length);
  });

  it('rejects non-image / malformed input', () => {
    assert.equal(parseDataUrl('data:text/plain;base64,aGVsbG8='), null);
    assert.equal(parseDataUrl('https://example.com/a.png'), null);
    assert.equal(parseDataUrl('data:image/png;base64,***'), null);
    assert.equal(parseDataUrl(undefined), null);
  });
});

describe('mergeChromiumArgs()', () => {
  it('collapses feature switches into one and drops unwanted serverless flags', () => {
    const args = mergeChromiumArgs(
      [
        '--no-sandbox',
        '--disable-features=AudioServiceOutOfProcess,IsolateOrigins',
        '--disable-web-security',
        "--headless='shell'",
        '--enable-features=SharedArrayBuffer',
      ],
      ['--disable-site-isolation-trials', '--no-sandbox'],
    );
    const disable = args.filter((a) => a.startsWith('--disable-features='));
    const enable = args.filter((a) => a.startsWith('--enable-features='));
    assert.equal(disable.length, 1);
    assert.equal(enable.length, 1);
    for (const f of ['AudioServiceOutOfProcess', 'IsolateOrigins', 'site-per-process', 'Translate', 'HttpsUpgrades']) {
      assert.ok(disable[0].includes(f), `missing ${f}`);
    }
    assert.ok(enable[0].includes('SharedArrayBuffer') && enable[0].includes('CDPScreenshotNewSurface'));
    assert.ok(!args.includes('--disable-web-security'));
    assert.ok(!args.some((a) => a.startsWith('--headless')));
    assert.equal(args.filter((a) => a === '--no-sandbox').length, 1);
    assert.ok(args.includes('--disable-site-isolation-trials'));
  });

  it('merges CHROMIUM_EXTRA_ARGS (e.g. from the Docker image) without losing the default feature list', () => {
    const extra = parseArgList(
      '  --disable-dev-shm-usage\n --disable-features=Foo,Bar   --js-flags=--max-old-space-size=256 ',
    );
    assert.deepEqual(extra, [
      '--disable-dev-shm-usage',
      '--disable-features=Foo,Bar',
      '--js-flags=--max-old-space-size=256',
    ]);
    const args = mergeChromiumArgs([], ['--disable-site-isolation-trials'], extra);
    const disable = args.filter((a) => a.startsWith('--disable-features='));
    assert.equal(disable.length, 1);
    for (const f of ['Foo', 'Bar', 'IsolateOrigins', 'site-per-process', 'Translate']) {
      assert.ok(disable[0].includes(f), `missing ${f}`);
    }
    assert.ok(args.includes('--disable-dev-shm-usage'));
    assert.ok(args.includes('--js-flags=--max-old-space-size=256'));
    assert.deepEqual(parseArgList(undefined), []);
    assert.deepEqual(parseArgList(''), []);
  });
});

describe('buildUserAgent()', () => {
  it('produces a regular Chrome UA without the HeadlessChrome brand', () => {
    const ua = buildUserAgent('153.0.8010.12');
    assert.match(ua.userAgent, /Chrome\/153\.0\.0\.0 Safari\/537\.36$/);
    assert.ok(!ua.userAgent.includes('Headless'));
    assert.deepEqual(
      ua.userAgentMetadata.brands.map((b) => b.brand),
      ['Google Chrome', 'Chromium', 'Not.A/Brand'],
    );
    assert.equal(ua.userAgentMetadata.fullVersion, '153.0.8010.12');
  });

  it('falls back on garbage input', () => {
    assert.equal(buildUserAgent('nonsense').major, '153');
  });
});

describe('errors', () => {
  it('maps codes to HTTP statuses and serialises hints', () => {
    const e = new AppError('ANTI_BOT_VERIFICATION_FAILED', undefined, { details: { a: 1 } });
    assert.equal(e.status, 502);
    assert.deepEqual(Object.keys(e.toJSON()), ['code', 'message', 'hint', 'details']);
    assert.equal(new AppError('GENERATION_TIMEOUT').status, 504);
    assert.equal(toAppError(new Error('boom')).code, 'INTERNAL_ERROR');
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      assert.ok(entry.status >= 400 && entry.status < 600, code);
      assert.ok(entry.message, code);
    }
  });
});
