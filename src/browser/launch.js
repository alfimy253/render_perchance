import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { config } from '../config.js';
import { AppError } from '../utils/errors.js';
import { buildUserAgent } from './fingerprint.js';

/**
 * Playwright 1.63's own `--disable-features` list. Chromium only honours the LAST
 * `--disable-features` switch, so when we (or @sparticuz/chromium) add one, the
 * Playwright defaults would silently be dropped. We therefore merge everything into
 * a single switch. Keep in sync when upgrading playwright-core.
 */
const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
];
const PLAYWRIGHT_ENABLED_FEATURES = ['CDPScreenshotNewSurface'];

/**
 * Site isolation is disabled so that Perchance's iframes (the generator frame, the image
 * embeds and Cloudflare's Turnstile widget inside them) run in the page's renderer and
 * inherit the page-level user-agent / client-hint override (see fingerprint.js).
 * Both the feature switch AND --disable-site-isolation-trials are required – without the
 * latter the generator iframe stays out-of-process and keeps the "HeadlessChrome" brand.
 */
const EXTRA_DISABLED_FEATURES = ['IsolateOrigins', 'site-per-process'];
const EXTRA_ARGS = ['--disable-site-isolation-trials', '--disable-blink-features=AutomationControlled', '--lang=en-US'];

/** Serverless defaults we do not want (they make the browser look less like a normal one). */
const DROPPED_ARGS = new Set(['--disable-web-security', '--allow-running-insecure-content']);

/**
 * By default Playwright kills every browser it launched as soon as the process receives
 * SIGINT/SIGTERM. The long-running server (src/index.js) shuts down gracefully instead, letting
 * in-flight generations finish, so it switches that behaviour off through this flag.
 * Browsers are still killed when the process finally exits.
 */
let appHandlesShutdownSignals = false;
export function setAppHandlesShutdownSignals(value = true) {
  appHandlesShutdownSignals = Boolean(value);
}

const VIEWPORT = Object.freeze({ width: 1366, height: 1600 });
const PROFILE_PREFIX = 'pig-profile-';
const STALE_PROFILE_MS = 15 * 60 * 1000;

/** Merge argument lists, collapsing every --disable-features / --enable-features into one switch each. */
export function mergeChromiumArgs(...lists) {
  const disabled = new Set([...PLAYWRIGHT_DISABLED_FEATURES, ...EXTRA_DISABLED_FEATURES]);
  const enabled = new Set(PLAYWRIGHT_ENABLED_FEATURES);
  const out = [];
  for (const arg of lists.flat()) {
    if (typeof arg !== 'string' || !arg) continue;
    if (arg.startsWith('--disable-features=')) {
      arg
        .slice('--disable-features='.length)
        .split(',')
        .filter(Boolean)
        .forEach((f) => disabled.add(f));
    } else if (arg.startsWith('--enable-features=')) {
      arg
        .slice('--enable-features='.length)
        .split(',')
        .filter(Boolean)
        .forEach((f) => enabled.add(f));
    } else if (arg.startsWith('--headless') || DROPPED_ARGS.has(arg)) {
      // Playwright adds its own --headless flag; dropped args are listed above.
    } else if (!out.includes(arg)) {
      out.push(arg);
    }
  }
  for (const f of disabled) enabled.delete(f);
  out.push(`--disable-features=${[...disabled].join(',')}`);
  if (enabled.size) out.push(`--enable-features=${[...enabled].join(',')}`);
  return out;
}

export function resolveBrowserMode() {
  const mode = config.browserMode;
  if (mode === 'local' || mode === 'serverless' || mode === 'remote') return mode;
  if (config.browserWsEndpoint) return 'remote';
  return config.isServerless ? 'serverless' : 'local';
}

/**
 * Opens a fresh, isolated browser session for ONE request.
 *
 * @returns {Promise<{ mode: string, context: import('playwright-core').BrowserContext, close: () => Promise<void> }>}
 */
export async function openBrowserSession() {
  const mode = resolveBrowserMode();
  if (mode === 'remote') return openRemoteSession();

  await removeStaleProfiles({ includePlaywrightProfiles: mode === 'serverless' });
  // A unique profile directory per request: no cookies/localStorage ever leak between requests.
  const userDataDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));

  try {
    const { executablePath, args } = mode === 'serverless' ? await serverlessChromium() : localChromium();
    // Context-level UA string: Playwright applies it to EVERY target, including out-of-process
    // iframes. The full client-hint metadata is added per page by applyClientHints().
    const version = bundledChromiumVersion(mode);
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: mode === 'serverless' ? true : config.headless,
      args: mergeChromiumArgs(args, EXTRA_ARGS, config.chromiumExtraArgs),
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'en-US',
      ...(config.spoofClientHints && version ? { userAgent: buildUserAgent(version).userAgent } : {}),
      proxy: config.proxy,
      timeout: 60_000,
      ...(appHandlesShutdownSignals ? { handleSIGINT: false, handleSIGTERM: false } : {}),
    });

    return {
      mode,
      context,
      close: async () => {
        await closeWithTimeout(() => context.close());
        await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (err) {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw new AppError('BROWSER_LAUNCH_FAILED', `Could not start Chromium (${mode} mode): ${firstLine(err)}`, {
      cause: err,
      details: { mode },
    });
  }
}

/** Chromium bundled in the deployment (Vercel / Lambda). */
async function serverlessChromium() {
  // Imported lazily: the package decompresses a ~65 MB brotli binary into /tmp on first use.
  const { default: sparticuz } = await import('@sparticuz/chromium');
  return { executablePath: await sparticuz.executablePath(), args: sparticuz.args };
}

/** Local development: CHROME_EXECUTABLE_PATH or the Chromium installed by `npm run browsers:install`. */
function localChromium() {
  return { executablePath: config.chromeExecutablePath || undefined, args: [] };
}

/**
 * Chromium version of the binary we are about to launch, read from package metadata
 * (no process spawn). Returns null when unknown (e.g. custom CHROME_EXECUTABLE_PATH).
 */
export function bundledChromiumVersion(mode) {
  if (mode === 'serverless') {
    // @sparticuz/chromium versions follow Chromium's major (e.g. 153.0.0 → Chromium 153).
    const pkg = readJsonNextTo('@sparticuz/chromium', '../package.json');
    const major = String(pkg?.version || '').split('.')[0];
    return /^\d+$/.test(major) ? `${major}.0.0.0` : null;
  }
  if (mode === 'local' && !config.chromeExecutablePath) {
    const manifest = readJsonNextTo('playwright-core', 'browsers.json');
    const entry =
      manifest?.browsers?.find((b) => b.name === 'chromium-headless-shell') ??
      manifest?.browsers?.find((b) => b.name === 'chromium');
    return entry?.browserVersion ?? null;
  }
  return null;
}

function readJsonNextTo(specifier, relativePath) {
  try {
    const entry = fileURLToPath(import.meta.resolve(specifier));
    return JSON.parse(readFileSync(join(dirname(entry), relativePath), 'utf8'));
  } catch {
    return null;
  }
}

/** Remote Chromium over CDP (Browserless, Browserbase, a VM with a residential IP, …). */
async function openRemoteSession() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(config.browserWsEndpoint, { timeout: 30_000 });
  } catch (err) {
    throw new AppError('BROWSER_LAUNCH_FAILED', `Could not connect to BROWSER_WS_ENDPOINT: ${firstLine(err)}`, {
      cause: err,
      details: { mode: 'remote' },
    });
  }

  let context;
  let ownsContext = true;
  try {
    const userAgent = config.spoofClientHints ? buildUserAgent(browser.version()).userAgent : undefined;
    context = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US', ...(userAgent ? { userAgent } : {}) });
  } catch {
    // Some providers only allow their default context.
    context = browser.contexts()[0];
    ownsContext = false;
  }
  if (!context) {
    await browser.close().catch(() => {});
    throw new AppError('BROWSER_LAUNCH_FAILED', 'Remote browser exposed no usable context.', {
      details: { mode: 'remote' },
    });
  }

  return {
    mode: 'remote',
    context,
    close: async () => {
      if (ownsContext) await closeWithTimeout(() => context.close());
      await closeWithTimeout(() => browser.close());
    },
  };
}

async function closeWithTimeout(fn, ms = 10_000) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } catch {
    // Closing is best effort.
  } finally {
    clearTimeout(timer);
  }
}

/** Warm serverless instances reuse /tmp: delete profiles left behind by crashed/timed-out invocations. */
async function removeStaleProfiles({ includePlaywrightProfiles = false } = {}) {
  const dir = tmpdir();
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter(
        (name) =>
          name.startsWith(PROFILE_PREFIX) ||
          (includePlaywrightProfiles && name.startsWith('playwright_chromiumdev_profile-')),
      )
      .map(async (name) => {
        const full = join(dir, name);
        try {
          const info = await stat(full);
          if (now - info.mtimeMs > STALE_PROFILE_MS) await rm(full, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }),
  );
}

function firstLine(err) {
  return String(err?.message || err)
    .split('\n')[0]
    .slice(0, 300);
}
