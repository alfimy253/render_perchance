# 🌌 Perchance Image Generator (Express + Playwright, for Vercel or Render)

A **stateless Node.js / Express** web app and API. It drives the
[Perchance AI Text-to-Image generator](https://perchance.org/ai-text-to-image-generator) with **Playwright**:
- types your prompt;
- selects the image **type** (Perchance's own "🎨 Art Style" values);
- returns **exactly 2 images**.

- **Frontend:** prompt box, a copy of Perchance's Art Style dropdown (79 styles), "How many?" locked to 2, a results grid, a lightbox and downloads.
- **API:** `POST /generator` (or `GET`) with `{ prompt, type }` returns 2 base64 images.
- **Deploys to Vercel with zero config:** Express in `src/index.js`, with Chromium from `@sparticuz/chromium`.
- **Or to Render (or any Docker host):** `Dockerfile` + `render.yaml`. It runs as a long-running server with Playwright's Chromium and shuts down gracefully.

> 📘 How it works in detail (architecture, selectors, rules, limits): **[`system_rule.md`](./system_rule.md)**

---

## Quick start (local)

Requires **Node.js 22.17+**.

```bash
npm install
npm run browsers:install      # Chrome Headless Shell 153 (same engine as on Vercel)
                              # Linux may also need: npx playwright-core install-deps chromium
npm run dev                   # http://localhost:3000
```

## Deploy to Vercel

1. Push this folder to a GitHub repo and import it at <https://vercel.com/new>, or run `npx vercel --prod` in this folder.
2. Keep the default settings. Vercel detects Express (`src/index.js`), uses Node 22 from `package.json`, serves `public/` from its CDN, and bundles Chromium (function size about 75 MB).
3. Recommended: set the `API_KEY` environment variable under Settings → Environment Variables, then redeploy. It is a password you make up yourself, for example the output of `openssl rand -hex 32`. Once it is set, the site shows a 🔑 field, and only people who enter that key can generate. Fluid compute must be on, which is the default for new projects.

📦 **Step-by-step guide, settings, testing and troubleshooting: [`DEPLOY.md`](./DEPLOY.md)**

The function runs for up to 300 s (`export const config = { maxDuration: 300 }` in `src/index.js`), which is the Hobby maximum.

## Deploy to Render

1. Push this folder to GitHub, then in Render choose **New → Blueprint**, connect the repo and click **Deploy Blueprint**. `render.yaml` defines a Docker web service.
2. Copy the generated `API_KEY` from the service's **Environment** page.

⚠️ **Plan:** the app runs on Render's free plan (0.1 CPU / 512 MB), but in measurements Perchance's anti-bot check did not finish there. It timed out on 0.1 CPU and ran out of memory on 512 MB. Real generation needs the **1 CPU / 2 GB** plan, or a remote browser via `BROWSER_WS_ENDPOINT`.

📦 **Measurements, step-by-step guide and troubleshooting: [`DEPLOY_RENDER.md`](./DEPLOY_RENDER.md)**

## API

### `POST /generator`
```bash
curl -X POST https://<your-app>.vercel.app/generator \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a red fox in a snowy forest, golden hour","type":"Cinematic"}'
```

### `GET /generator`
```bash
curl 'https://<your-app>.vercel.app/generator?prompt=a%20lighthouse%20in%20a%20storm&type=Watercolor'
```

- `prompt` (required): up to 2000 characters.
- `type` (optional, default `Painted Anime`): one of the values from `GET /api/types`, which are identical to Perchance's dropdown. Case and Unicode are forgiven (`"no style"` becomes `𝗡𝗼 𝘀𝘁𝘆𝗹𝗲`).
- If `API_KEY` is set, send `X-API-Key: <key>`.

**Response:**
```json
{
  "success": true,
  "type": "Cinematic",
  "count": 2,
  "images": [
    { "index": 1, "mimeType": "image/jpeg", "extension": "jpg", "sizeBytes": 123456, "seed": 42, "dataUrl": "data:image/jpeg;base64,…" }
  ],
  "timings": { "totalMs": 23300 }
}
```
`images` always contains 2 entries. Errors look like `{ "success": false, "error": { "code", "message", "hint" } }`. The codes are listed in `system_rule.md` §6.

### Other routes
- `GET /api/types`: the Art Style list (`types`), the `default` and `imageCount: 2`.
- `GET /api/health`: liveness and runtime info.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` / `npm start` | Local server (`PORT`, default 3000) |
| `npm test` | Unit and HTTP contract tests (no browser) |
| `npm run test:mock-e2e` | Full pipeline on the real Perchance page with only its image API mocked |
| `npm run smoke:live -- "prompt" "Type"` | Real generation against Perchance (no mocks) |
| `npm run sync:types` | Refresh the Art Style list from the live Perchance dropdown |
| `npm run demo:mock` | Full app with the image API mocked (for IPs that Perchance blocks) |

## ⚠️ Important: Perchance's anti-bot check

Perchance protects image generation with Cloudflare Turnstile. From **data-center IPs** the check can fail every time. The API then returns `502 ANTI_BOT_VERIFICATION_FAILED` after about 45 s instead of hanging.

The sandbox this was built in was blocked this way. Everything up to that point was verified live, and the full flow was verified with Perchance's image API mocked. Vercel's IPs may or may not pass. If they don't:

- set `PROXY_SERVER` (plus `PROXY_USERNAME` / `PROXY_PASSWORD`) to route the browser through a residential proxy, or
- set `BROWSER_WS_ENDPOINT` to use a remote Chromium (Browserless, Browserbase, or your own machine on a residential connection).

To check Vercel, call the deployed `/generator` (see [`DEPLOY.md` → Test the deployment](./DEPLOY.md#test-the-deployment)). `npm run smoke:live` only checks the machine it runs on.

### Terms

Perchance's [Terms of Service](https://perchance.org/terms-of-service) allow commercial use of the generated **images**. The same terms forbid accessing the site "through automated or non-human means, whether through a bot, script or otherwise", and forbid circumventing its security measures. This project is exactly such an automation. Treat it as a personal or experimental tool, not as the basis of a commercial service. See [`DEPLOY_RENDER.md` → Terms and commercial use](./DEPLOY_RENDER.md#terms-and-commercial-use).

## Project structure

```
src/
  index.js                 Vercel entry (default-exports the Express app) + local server
  config.js                environment configuration
  http/configure-app.js    routes, middleware, error handling
  perchance/
    generator.js           Playwright automation (2 images)
    selectors.js           every Perchance selector/URL in one place
    art-styles.js          generated copy of Perchance's Art Style dropdown
  browser/
    launch.js              local / serverless (@sparticuz/chromium) / remote browser
    fingerprint.js         user-agent + client-hint override
  utils/                   validation, errors, semaphore
public/                    frontend (index.html, styles.css, app.js)
scripts/                   sync, smoke, mock E2E, demo server
test/                      node:test suites
system_rule.md             technical system description and rules
DEPLOY.md                  step-by-step Vercel deployment guide
DEPLOY_RENDER.md           Render deployment guide, free-tier measurements, terms
Dockerfile, render.yaml    container image and Render Blueprint
```
