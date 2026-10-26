/**
 * Central, environment-driven configuration.
 *
 * Everything is read once at module load. The app keeps NO other state between
 * requests (see system_rule.md → "Statelessness").
 */

const toInt = (value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

const toBool = (value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

/**
 * Splits a whitespace-separated list of command-line switches (e.g. CHROMIUM_EXTRA_ARGS).
 * Commas are NOT separators, because switches such as `--disable-features=A,B` contain them.
 */
export const parseArgList = (value) =>
  String(value ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const env = process.env;

/** True when running inside a Vercel Function (or any AWS Lambda-like runtime). */
const isServerless = Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_EXECUTION_ENV);

export const config = Object.freeze({
  /** Local dev server port (ignored on Vercel). */
  port: toInt(env.PORT, 3000, { max: 65535 }),

  isVercel: Boolean(env.VERCEL),
  /** Render sets RENDER=true in every service (see DEPLOY_RENDER.md). */
  isRender: Boolean(env.RENDER),
  isServerless,

  /**
   * Browser strategy:
   *  - auto       → "remote" if BROWSER_WS_ENDPOINT is set, "serverless" on Vercel/Lambda, else "local"
   *  - local      → playwright-core's installed Chromium (npm run browsers:install) or CHROME_EXECUTABLE_PATH
   *  - serverless → @sparticuz/chromium (the binary that ships inside the Vercel Function)
   *  - remote     → connect to an existing Chromium over CDP (Browserless, Browserbase, your own box…)
   */
  browserMode: String(env.BROWSER_MODE || 'auto')
    .trim()
    .toLowerCase(),
  browserWsEndpoint: String(env.BROWSER_WS_ENDPOINT || '').trim(),
  chromeExecutablePath: String(env.CHROME_EXECUTABLE_PATH || '').trim(),
  /** Only honoured in "local" mode (serverless Chromium is always headless). */
  headless: toBool(env.HEADLESS, true),
  /**
   * Extra Chromium switches for launched browsers (local/serverless modes), whitespace-separated.
   * The Docker image sets `--disable-dev-shm-usage` (containers often have a tiny /dev/shm).
   */
  chromiumExtraArgs: parseArgList(env.CHROMIUM_EXTRA_ARGS),

  /** Optional outbound proxy for the browser (e.g. a residential proxy). */
  proxy: env.PROXY_SERVER
    ? {
        server: String(env.PROXY_SERVER).trim(),
        ...(env.PROXY_USERNAME ? { username: String(env.PROXY_USERNAME) } : {}),
        ...(env.PROXY_PASSWORD ? { password: String(env.PROXY_PASSWORD) } : {}),
      }
    : undefined,

  /** Make the browser's client hints look like regular Chrome (removes the "HeadlessChrome" brand). */
  spoofClientHints: toBool(env.SPOOF_CLIENT_HINTS, true),

  /** Hard budget for one /generator call (browser launch → 2 images). Keep below Vercel maxDuration (300s). */
  generationTimeoutMs: toInt(env.GENERATION_TIMEOUT_MS, 240_000, { min: 30_000, max: 1_700_000 }),
  /** How long Perchance's page/generator UI may take to become ready. */
  pageLoadTimeoutMs: toInt(env.PAGE_LOAD_TIMEOUT_MS, 45_000, { min: 5_000 }),
  /** Give up early when Perchance keeps rejecting the browser's anti-bot check and no image has arrived. */
  antiBotGraceMs: toInt(env.ANTI_BOT_GRACE_MS, 45_000, { min: 5_000 }),

  /** Per-instance concurrency guard (each job runs its own Chromium). */
  maxConcurrentJobs: toInt(env.MAX_CONCURRENT_JOBS, 1, { max: 16 }),
  /** Max time a request waits for a free slot before getting HTTP 429. */
  queueTimeoutMs: toInt(env.QUEUE_TIMEOUT_MS, 60_000, { min: 0 }),

  /**
   * Long-running server only (Render, Docker, `npm start`): after SIGTERM, how long to wait for
   * in-flight generations before exiting. Keep below Render's maxShutdownDelaySeconds (300 s in render.yaml).
   */
  shutdownTimeoutMs: toInt(env.SHUTDOWN_TIMEOUT_MS, 280_000, { min: 0, max: 3_600_000 }),

  /**
   * Optional shared secret for /generator (header X-API-Key, Bearer token or ?key=).
   * Trimmed, because a value pasted or piped with a trailing newline would otherwise never match.
   */
  apiKey: String(env.API_KEY || '').trim(),
  corsOrigin: String(env.CORS_ORIGIN || '*'),
  maxPromptLength: toInt(env.MAX_PROMPT_LENGTH, 2000, { min: 10, max: 10_000 }),

  perchanceUrl: String(env.PERCHANCE_URL || 'https://perchance.org/ai-text-to-image-generator'),
});
