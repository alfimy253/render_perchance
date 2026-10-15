/**
 * Typed application errors. Every failure that leaves the API is mapped to one of
 * these codes so clients can react programmatically (see system_rule.md → "Error contract").
 */

export const ERROR_CATALOG = Object.freeze({
  INVALID_JSON: { status: 400, message: 'Request body is not valid JSON.' },
  INVALID_PROMPT: { status: 400, message: 'A non-empty text prompt is required.' },
  INVALID_TYPE: { status: 400, message: 'Unknown image type. Use one of the Perchance "Art Style" dropdown values.' },
  UNAUTHORIZED: { status: 401, message: 'Missing or invalid API key.' },
  NOT_FOUND: { status: 404, message: 'Route not found.' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Method not allowed. Use GET or POST.' },
  BUSY: {
    status: 429,
    message: 'All generation slots on this instance are busy.',
    hint: 'Retry in a few seconds.',
  },
  CLIENT_ABORTED: { status: 499, message: 'The client closed the connection before generation finished.' },
  BROWSER_LAUNCH_FAILED: {
    status: 500,
    message: 'Could not start the headless browser.',
    hint: 'Locally run "npm run browsers:install" (or set CHROME_EXECUTABLE_PATH). On Vercel check the function logs.',
  },
  INTERNAL_ERROR: { status: 500, message: 'Unexpected server error.' },
  CLOUDFLARE_CHALLENGE: {
    status: 502,
    message: "Perchance's Cloudflare protection challenged this server's browser.",
    hint: 'The server IP/browser was flagged as a bot. Retry later, set PROXY_SERVER (residential proxy) or BROWSER_WS_ENDPOINT (remote browser).',
  },
  ANTI_BOT_VERIFICATION_FAILED: {
    status: 502,
    message: "Perchance's anti-bot (Cloudflare Turnstile) verification kept failing, so no images were generated.",
    hint: 'Data-center IPs are often rejected. Retry, or route the browser through PROXY_SERVER / BROWSER_WS_ENDPOINT.',
  },
  GENERATOR_UI_NOT_FOUND: {
    status: 502,
    message: 'The Perchance generator UI did not load or its markup changed.',
    hint: 'Run "npm run smoke:live" and update src/perchance/selectors.js if Perchance changed its page.',
  },
  TYPE_NOT_AVAILABLE: {
    status: 502,
    message: 'The requested type is no longer present in the live Perchance dropdown.',
    hint: 'Run "npm run sync:types" to refresh src/perchance/art-styles.js.',
  },
  IMAGE_COUNT_UNAVAILABLE: {
    status: 502,
    message: 'Perchance no longer offers "4" in its "How many?" dropdown.',
  },
  GENERATION_TIMEOUT: {
    status: 504,
    message: 'Perchance did not deliver 4 images before the time budget ran out.',
    hint: 'Perchance may be busy. Retry, or raise GENERATION_TIMEOUT_MS (keep it below the Vercel maxDuration).',
  },
});

export class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_CATALOG} code
   * @param {string} [message]
   * @param {{ details?: object, hint?: string, cause?: unknown, status?: number }} [options]
   */
  constructor(code, message, { details, hint, cause, status } = {}) {
    const entry = ERROR_CATALOG[code] ?? ERROR_CATALOG.INTERNAL_ERROR;
    super(message || entry.message, cause ? { cause } : undefined);
    this.name = 'AppError';
    this.code = ERROR_CATALOG[code] ? code : 'INTERNAL_ERROR';
    this.status = status ?? entry.status;
    this.hint = hint ?? entry.hint;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Normalises anything thrown into an AppError. */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError) && err.status === 400) {
    return new AppError('INVALID_JSON');
  }
  if (err && err.type === 'entity.too.large') {
    return new AppError('INVALID_PROMPT', 'Request body is too large.', { status: 413 });
  }
  return new AppError('INTERNAL_ERROR', undefined, { cause: err });
}
