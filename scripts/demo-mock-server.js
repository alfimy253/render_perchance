#!/usr/bin/env node
/**
 * DEMO server: the full app (frontend + /generator + real Playwright automation of the real
 * perchance.org page), but Perchance's IMAGE API is answered by the local mock in
 * lib/mock-perchance-backend.js. Useful where Perchance's anti-bot check blocks the server IP
 * (CI, cloud sandboxes). The UI shows a "Demo mode" banner.
 *
 *   npm run demo:mock        →  http://localhost:3000
 */
import express from 'express';

import { config } from '../src/config.js';
import { configureApp } from '../src/http/configure-app.js';
import { createMockPerchanceBackend } from './lib/mock-perchance-backend.js';

// A fresh mock per browser session, so nothing accumulates between requests.
const generatorHooks = {
  onContext: (context) => createMockPerchanceBackend({ delayMs: 2500 }).onContext(context),
};

const app = configureApp(express(), { generatorHooks, mode: 'mock' });
app.listen(config.port, '0.0.0.0', () => {
  console.log(`DEMO (Perchance image API mocked) listening on http://localhost:${config.port}`);
});
