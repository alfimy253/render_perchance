import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { resolveBrowserMode } from '../browser/launch.js';
import { config } from '../config.js';
import { ART_STYLES, ART_STYLES_SYNCED_AT, DEFAULT_ART_STYLE } from '../perchance/art-styles.js';
import { IMAGE_COUNT, generatePerchanceImages } from '../perchance/generator.js';
import { AppError, toAppError } from '../utils/errors.js';
import { Semaphore } from '../utils/semaphore.js';
import { parseGeneratorInput } from '../utils/validate.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));
const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

/**
 * Registers all middleware and routes on an Express app.
 *
 * @param {import('express').Express} app
 * @param {object} [options]
 * @param {object} [options.generatorHooks]  Test seam forwarded to generatePerchanceImages (mock E2E only).
 * @param {string} [options.mode]            Label reported by /api/health and /api/types ("live" | "mock").
 * @param {(params: object) => Promise<object>} [options.generate]  Override of the generator (unit tests).
 */
export function configureApp(app, { generatorHooks, mode = 'live', generate = generatePerchanceImages } = {}) {
  const slots = new Semaphore(config.maxConcurrentJobs);

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(requestContext);
  app.use(cors);
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  // Local development only – on Vercel everything in /public is served by the CDN
  // and express.static() is ignored.
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '5m' }));

  app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      mode,
      runtime: config.isVercel ? 'vercel' : config.isServerless ? 'serverless' : config.isRender ? 'render' : 'node',
      browserMode: resolveBrowserMode(),
      node: process.version,
      busySlots: slots.active,
      maxConcurrentJobs: slots.max,
      time: new Date().toISOString(),
    });
  });

  app.get(['/api/types', '/types'], (req, res) => {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=3600').json({
      source: config.perchanceUrl,
      syncedAt: ART_STYLES_SYNCED_AT,
      default: DEFAULT_ART_STYLE,
      imageCount: IMAGE_COUNT,
      authRequired: Boolean(config.apiKey),
      mode,
      count: ART_STYLES.length,
      types: ART_STYLES,
    });
  });

  const generatorHandler = async (req, res) => {
    const input = parseGeneratorInput(req.method === 'GET' ? req.query : req.body);

    // Abort the browser job if the client goes away.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    const release = await slots.acquire({ timeoutMs: config.queueTimeoutMs, signal: controller.signal });
    const log = (event, data) => logLine('info', event, { requestId: req.id, ...data });
    log('generate.start', { type: input.type, promptLength: input.prompt.length });

    try {
      const result = await generate({
        prompt: input.prompt,
        type: input.type,
        signal: controller.signal,
        hooks: generatorHooks,
        log,
      });
      log('generate.done', { ms: result.timings?.totalMs, images: result.images.length });
      res.set('Cache-Control', 'no-store').json({
        success: true,
        requestId: req.id,
        prompt: input.prompt,
        type: result.type,
        count: result.images.length,
        images: result.images,
        settings: result.settings,
        timings: result.timings,
        browserMode: result.browserMode,
        source: config.perchanceUrl,
      });
    } finally {
      release();
    }
  };

  for (const path of ['/generator', '/api/generator']) {
    app.route(path).get(requireApiKey, generatorHandler).post(requireApiKey, generatorHandler).all(methodNotAllowed);
  }

  // Fallback for "/" when the CDN did not answer it (also used by tests).
  app.get('/', (req, res, next) => (existsSync(INDEX_HTML) ? res.sendFile(INDEX_HTML) : next()));

  app.use((req, res, next) => next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}.`)));
  app.use(errorHandler);

  return app;
}

function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = (incoming && /^[\w.:-]{6,100}$/.test(incoming) ? incoming : null) || randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', config.corsOrigin);
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-Request-Id');
  res.set('Access-Control-Expose-Headers', 'X-Request-Id');
  res.set('Access-Control-Max-Age', '600');
  if (config.corsOrigin !== '*') res.append('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  const header = req.get('x-api-key') || '';
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const query = typeof req.query.key === 'string' ? req.query.key : '';
  const provided = header || bearer || query;
  if (provided && safeEqual(provided, config.apiKey)) return next();
  return next(new AppError('UNAUTHORIZED'));
}

function methodNotAllowed(req, res, next) {
  res.set('Allow', 'GET, POST, OPTIONS');
  next(new AppError('METHOD_NOT_ALLOWED'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const error = toAppError(err);
  const level = error.status >= 500 ? 'error' : 'warn';
  logLine(level, 'request.failed', {
    requestId: req.id,
    code: error.code,
    status: error.status,
    message: error.message,
    ...(error.status >= 500 && err?.cause ? { cause: String(err.cause?.message || err.cause).slice(0, 500) } : {}),
    ...(error.code === 'INTERNAL_ERROR' && err?.stack ? { stack: String(err.stack).slice(0, 1500) } : {}),
  });
  if (res.headersSent) return res.end();
  // 499 is not a real HTTP status for clients; nobody is listening anyway.
  return res
    .status(error.status === 499 ? 408 : error.status)
    .set('Cache-Control', 'no-store')
    .json({ success: false, requestId: req.id, error: error.toJSON() });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function logLine(level, msg, data) {
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
