/**
 * Entry point.
 *
 * - On Vercel: zero-config Express detection picks up this file (src/index.js) and uses
 *   the default export as a single Vercel Function (Fluid compute).
 * - Locally: `npm run dev` / `npm start` runs this file directly and starts a server.
 */
import { pathToFileURL } from 'node:url';

import express from 'express';

import { setAppHandlesShutdownSignals } from './browser/launch.js';
import { config as appConfig } from './config.js';
import { configureApp } from './http/configure-app.js';

const app = configureApp(express());

export default app;

/**
 * Vercel Function settings, read statically by Vercel's Express builder at build time
 * (a `functions` entry in vercel.json is NOT applied to zero-config Express apps).
 * 300 s is the Hobby maximum; on Pro you may raise it (≤ 800) together with GENERATION_TIMEOUT_MS.
 */
export const config = { maxDuration: 300 };

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun && !process.env.VERCEL) {
  const server = app.listen(appConfig.port, '0.0.0.0', () => {
    console.log(`Perchance image generator listening on http://localhost:${appConfig.port}`);
  });

  // Long-running hosts (Render, Docker, `npm start`) send SIGTERM before replacing an instance,
  // e.g. during a zero-downtime deploy. Stop accepting connections, let in-flight generations
  // finish (up to SHUTDOWN_TIMEOUT_MS), then exit. A second signal (Ctrl+C twice) exits at once.
  // Playwright must not kill the in-flight browsers on the first signal, hence the flag.
  setAppHandlesShutdownSignals();
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      console.log(`${signal} received again: exiting now`);
      process.exit(1); // 'exit' handlers still run, so Playwright kills its browsers
    }
    shuttingDown = true;
    console.log(
      `${signal} received: not accepting new requests, waiting up to ${appConfig.shutdownTimeoutMs} ms for in-flight generations`,
    );
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), appConfig.shutdownTimeoutMs).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
