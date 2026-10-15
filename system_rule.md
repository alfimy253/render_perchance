# system_rule.md: Perchance Image Generator

Technical description of the system, its code and the rules every change must respect.
Read this before modifying anything. `README.md` covers usage; this file covers **how and why it works**.

---

## 0. Summary

A **stateless Node.js/Express app**, deployed either as a single Vercel Function or as a long-running server in a Docker container (Render, see §9.2). For every request it:

1. Starts a fresh headless Chromium via **Playwright** (`playwright-core`).
2. Opens `https://perchance.org/ai-text-to-image-generator`.
3. Types the user's prompt into Perchance's **📝 Description** box.
4. Selects the requested **🎨 Art Style** (the "type"), sets **🔢 How many? = 4** and clicks **✨ generate**.
5. Collects the 4 finished images as base64 data URLs and returns them as JSON.

A small vanilla-JS frontend (`public/`) copies Perchance's Art Style dropdown, takes a prompt and shows the 4 results.

---

## 1. Rules (must always hold)

| # | Rule | Where it is enforced |
|---|------|----------------------|
| R1 | **Exactly 4 images per generation.** The API never accepts a count. Perchance's "How many?" is forced to `4`. Fewer than 4 means failure (`GENERATION_TIMEOUT`, partial images attached). | `IMAGE_COUNT` in `src/perchance/generator.js`, `waitForImages()`, `collectImages()` |
| R2 | **`type` must be one of Perchance's own Art Style dropdown values, verbatim** (including Unicode-bold labels such as `𝗡𝗼 𝘀𝘁𝘆𝗹𝗲`). Lenient input (`"no style"`, `"cinematic"`) is mapped to the canonical label; anything else gets HTTP 400. | `src/perchance/art-styles.js` (generated), `src/utils/validate.js` |
| R3 | **The frontend dropdown is a copy of Perchance's dropdown.** It is served from the same list via `GET /api/types`, never hard-coded in HTML. | `public/app.js → loadTypes()` |
| R4 | **Images come from Perchance through UI automation only.** Playwright types, selects and clicks like a user. Server code never calls Perchance's private image API directly. | `src/perchance/generator.js` |
| R5 | **Stateless.** No database, no stored files and no shared cache. Every request gets a brand-new browser profile (unique temp dir), which is deleted afterwards. The only in-memory structure is a per-instance concurrency semaphore. Nothing about a request survives it. | `src/browser/launch.js`, `src/utils/semaphore.js` |
| R6 | **The browser is always closed**, on success, error, timeout or client abort (`try/finally`). | `generatePerchanceImages()` |
| R7 | **Every failure leaves the API as a typed error** `{ success:false, error:{ code, message, hint?, details? } }` with a fixed HTTP status. | `src/utils/errors.js`, `errorHandler` in `src/http/configure-app.js` |
| R8 | **Vercel-deployable with zero config:** Express default-exported from `src/index.js`, Node 22, `export const config = { maxDuration: 300 }`. **Also deployable as a container (Render):** the same entry file listens on `PORT` when run directly, and Render-specific changes must not break the Vercel build. | `src/index.js`, `package.json`, `Dockerfile`, `render.yaml` |

---

## 2. Architecture

```
Browser (public/index.html + app.js)            any HTTP client (curl, other services)
        │  GET /api/types   POST /generator {prompt,type}        │
        └───────────────────────────┬────────────────────────────┘
                                    ▼
                 Vercel Function (Fluid compute) = Express app
                 src/index.js → src/http/configure-app.js
                   ├─ API key check, only if API_KEY is set (requireApiKey)
                   ├─ validate (src/utils/validate.js)
                   ├─ per-instance slot (src/utils/semaphore.js)
                   └─ generatePerchanceImages() (src/perchance/generator.js)
                                    │
                                    ▼
                 openBrowserSession() (src/browser/launch.js)
                   local      → playwright-core's Chrome Headless Shell
                   serverless → @sparticuz/chromium (bundled in the function)
                   remote     → chromium.connectOverCDP(BROWSER_WS_ENDPOINT)
                                    │  + applyClientHints() (src/browser/fingerprint.js)
                                    ▼
   perchance.org/ai-text-to-image-generator   (top page)
   └─ iframe https://<hash>.perchance.org/ai-text-to-image-generator   ("generator frame")
        ├─ textarea[data-name="description"]   ← prompt
        ├─ select[data-name="artStyle"]        ← type
        ├─ select[data-name="numImages"]       ← "4"
        ├─ button#generateButtonEl             ← click
        └─ 4 × iframe https://image-generation.perchance.org/embed#{…}   ("embeds")
              Turnstile → /api/verifyUser → POST /api/generate → download image
              → <img id="resultImgEl" src="data:image/…">
              → parent.postMessage({type:"finished", dataUrl, seedUsed, id})
```

Static files in `public/**` are served by Vercel's CDN. Every other path goes to the Express function.

---

## 3. Code map

| Path | Responsibility |
|------|----------------|
| `src/index.js` | Entry point. Creates the Express app, **default-exports it** (Vercel), and exports `config = { maxDuration: 300 }`. When run directly (local dev, Docker/Render) it listens on `PORT` and shuts down gracefully on SIGTERM/SIGINT (§9.2). Must import `express` itself, because Vercel's detection looks for that. |
| `src/http/configure-app.js` | Middleware (request id, CORS, JSON body ≤ 32 KB, static files for local dev) and routes (`/api/health`, `/api/types`, `/generator`, `/api/generator`). Optional API key, error handler, structured JSON logs. Accepts `generatorHooks` and `generate` for tests. |
| `src/config.js` | All environment variables, parsed once with clamped defaults. |
| `src/perchance/selectors.js` | **Single place for every Perchance URL, selector and marker.** Edit only this file when Perchance changes its markup. |
| `src/perchance/art-styles.js` | **Generated** list of the Art Style labels plus the default. Do not edit by hand; run `npm run sync:types`. |
| `src/perchance/generator.js` | The Playwright automation: open the page → find the generator frame → fill the form → install the result collector → click generate → wait for and collect 4 images. Also exports `openGenerator`, `readLiveOptions` and `parseDataUrl`. |
| `src/browser/launch.js` | Browser strategy (local/serverless/remote) and Chromium flags (merged into one `--disable-features`, plus `CHROMIUM_EXTRA_ARGS`). One persistent context per request in a unique `/tmp` profile, cleanup of stale profiles, close with a timeout. `setAppHandlesShutdownSignals()` turns off Playwright's SIGINT/SIGTERM browser-killing for the graceful-shutdown server. |
| `src/browser/fingerprint.js` | Builds a regular-Chrome User-Agent and UA client-hint metadata, and applies them through CDP (`Network.setUserAgentOverride`). |
| `src/utils/validate.js` | Input parsing: prompt rules, `type` / `artStyle` / `style` aliases, and NFKC/case-insensitive matching to the canonical label. |
| `src/utils/errors.js` | `ERROR_CATALOG` (code → HTTP status, message, hint) and the `AppError` class. |
| `src/utils/semaphore.js` | In-memory counting semaphore with queue timeout and abort support. |
| `public/index.html`, `styles.css`, `app.js` | Frontend. No external assets or dependencies. |
| `scripts/sync-art-styles.js` | Reads the live dropdown from Perchance and rewrites `art-styles.js`. |
| `scripts/live-smoke.js` | Real end-to-end run against Perchance (no mocks). |
| `scripts/mock-e2e.js` + `scripts/lib/mock-perchance-backend.js` | Full pipeline test with only Perchance's image API mocked. |
| `scripts/demo-mock-server.js` | The full app with the mocked image API, for demos where the anti-bot check blocks the IP. |
| `test/*.test.js` | `node:test` unit and HTTP contract tests (the generator is stubbed, so no browser is needed). |
| `vercel.json` | Security headers only. Function settings live in `src/index.js` (see §9). |
| `DEPLOY.md` | Step-by-step Vercel deployment (GitHub import or CLI), settings, environment variables, post-deploy test, troubleshooting. |
| `Dockerfile` | Container image for Render or any Docker host: `node:22-bookworm-slim`, plus Chrome Headless Shell 153 and its system libraries installed by `playwright-core install --with-deps --only-shell chromium` into `/ms-playwright`. `tini` is PID 1, the app runs as the non-root `node` user, and `CHROMIUM_EXTRA_ARGS=--disable-dev-shm-usage` is set. |
| `.dockerignore` | Excludes `node_modules`, tests, docs, Vercel files and secrets from the build context. |
| `render.yaml` | Render Blueprint: one Docker web service (`plan: free` by default, region `singapore`, `healthCheckPath: /api/health`, `maxShutdownDelaySeconds: 300`, generated `API_KEY`). |
| `DEPLOY_RENDER.md` | Render guide: measured plan feasibility, Blueprint and manual setup, variables, tests, troubleshooting, terms and commercial use. |

---

## 4. Request lifecycle (`POST /generator`)

1. **Auth (optional).** The global `express.json()` parser runs first, so a malformed body gets `400 INVALID_JSON`. Then, if `API_KEY` is set, `requireApiKey` requires `X-API-Key`, `Authorization: Bearer` or `?key=` (first non-empty wins), compared in constant time; otherwise `401 UNAUTHORIZED`. This runs **before** validation, so a request without the key gets 401 even if its input is also invalid, and no browser is started. `/`, `/api/types` and `/api/health` are never protected; `/api/types` reports `authRequired` so the frontend knows to show its 🔑 field.
2. **Validate.** `parseGeneratorInput(req.body | req.query)`:
   - `prompt`: required string, trimmed, CRLF normalised, at most `MAX_PROMPT_LENGTH` (2000).
   - `type`: `type`, `artStyle` or `style`; optional, defaulting to `Painted Anime`. It is mapped to the canonical Perchance label. An unknown type gets `400 INVALID_TYPE` with the allowed list.
3. **Acquire a slot.** `Semaphore(MAX_CONCURRENT_JOBS=1)`. Requests wait up to `QUEUE_TIMEOUT_MS`, then get `429 BUSY`. A client disconnect (`res.on('close')`) aborts the wait and the job.
4. **`generatePerchanceImages()`.** The overall deadline is `GENERATION_TIMEOUT_MS` (240 s):
   1. `openBrowserSession()`: launch Chromium with a fresh profile.
   2. `applyClientHints()`: override the UA and client hints on the page.
   3. `page.goto(perchanceUrl, domcontentloaded)`, then poll `page.frames()` for the generator frame (URL `^https://<sub>.perchance.org/ai-text-to-image-generator`) until `artStyle` has more than 1 option and `numImages`, `description` and `#generateButtonEl` exist. A Cloudflare interstitial title ("Just a moment…") that never clears gives `CLOUDFLARE_CHALLENGE`.
   4. **Fill the form.**
      - `locator.fill(prompt)`, then verify with `inputValue()`.
      - In-page `applySelections()`: choose the Art Style option by exact label, then by normalised label. Set the value and dispatch bubbling `input` and `change` events, then do the same for `numImages = "4"`.
      - Errors: a missing label gives `TYPE_NOT_AVAILABLE`, a missing "4" gives `IMAGE_COUNT_UNAVAILABLE`.
   5. **Install the result collector.** It is a `message` listener in the generator frame that stores every `{type:"finished", dataUrl}` posted by an embed, de-duplicated by embed id.
   6. **Click generate.** Use Playwright's click, falling back to `element.click()` in the page.
   7. **`waitForImages()`.** Poll every 750 ms:
      - Read the collector count.
      - Every 2 s, scan the embeds' text and `#resultImgEl`.
      - Track the image API's network activity (embed status codes, `/api/generate` calls, `turnstileClientFail` codes).
      - Stop with success at 4 images.
      - Fail fast with `ANTI_BOT_VERIFICATION_FAILED` if "Anti-bot verification failed" persists for `ANTI_BOT_GRACE_MS` (45 s) while no `/api/generate` call was ever made.
      - Fail fast with `CLOUDFLARE_CHALLENGE` if every embed got a Cloudflare 403.
      - Fail with `GENERATION_TIMEOUT` (with partial images) at the deadline.
   8. **`collectImages()`.** Merge collector results with the `#resultImgEl` fallback, de-duplicate by content hash, cap at 4. Return `{index, mimeType, extension, sizeBytes, seed, dataUrl}`.
   9. `finally`: close the context (10 s timeout) and delete the profile dir.
5. **Respond.** `200 { success, requestId, prompt, type, count: 4, images, settings, timings, browserMode, source }` with `Cache-Control: no-store`.

Typical timings:
- Locally: browser 0.1–0.4 s, page ready about 0.6 s, generation 6–60 s depending on Perchance's queue.
- On Vercel: a cold start adds about 1.5 s for Chromium decompression.

---

## 5. Playwright automation details

### 5.1 Why the client-hint / user-agent override exists
Headless Chromium sends `HeadlessChrome` in **both** the `User-Agent` header and `sec-ch-ua`. Perchance's Cloudflare rules answer requests for `image-generation.perchance.org/embed` that carry that brand with **403 + `cf-mitigated: challenge`**. The challenge page sends `X-Frame-Options: SAMEORIGIN`, so the embed iframe dies (`chrome-error://`) and no image can ever load.

Fix, verified on 2026-10-15:
- `launchPersistentContext({ userAgent })` sets a regular Chrome UA string. Playwright applies it to every target, including out-of-process iframes.
- `applyClientHints()` sets `Network.setUserAgentOverride` with full `userAgentMetadata` (brands `Google Chrome`, `Chromium`, `Not.A/Brand`; platform Linux) on the page.
- Measured: before the fix, all embeds returned 403. After it, all 4 return 200.

### 5.2 Why site isolation is disabled
Perchance's generator frame lives on a different origin (`<hash>.perchance.org`) under a COOP/COEP page, so Chromium normally runs it out-of-process, where the page-level metadata override does not reach. The fix needs **both** switches:
- `--disable-features=…,IsolateOrigins,site-per-process`
- `--disable-site-isolation-trials`

Without the second, the generator frame still reports `HeadlessChrome` brands. These switches also put the Turnstile iframe in-process, so it sees consistent values.

### 5.3 Chromium flags (`mergeChromiumArgs`)
- Chromium honours only the **last** `--disable-features` and `--enable-features` switch. Playwright, @sparticuz/chromium and we each add one, so they are merged into a single switch each.
- `PLAYWRIGHT_DISABLED_FEATURES` copies Playwright 1.63's own list. **Update it when upgrading playwright-core.**
- Dropped from @sparticuz's defaults: `--disable-web-security`, `--allow-running-insecure-content` and its `--headless='shell'` (Playwright adds `--headless`).
- Added: `--disable-blink-features=AutomationControlled` (`navigator.webdriver` becomes false) and `--lang=en-US`.

### 5.4 Robustness rules
- **Never call `frame.evaluate()` directly in the polling path.** Use `evaluateSafe()` (timeout plus fallback). A frame that is navigating, crashed or starved of CPU can otherwise hang forever. This was observed under memory pressure.
- Functions passed to `evaluate` must be self-contained (they are serialised).
- Frames are re-queried on every poll (`page.frames()`), and detached frames are skipped.
- Every wait respects both the overall deadline and the abort signal.
- **A dead browser fails fast.** `trackPageCrash()` records the page's `crash` event (renderer out of memory) and its `close` event (the browser process died or the context closed). `waitForImages()` checks both on every poll and throws `INTERNAL_ERROR` at once. Without the `close` check, `evaluateSafe()` would swallow the errors and the request would hang until the deadline. Verified by killing the browser process mid-generation: the error arrived about 1 s later.
- New failure modes get a code in `ERROR_CATALOG`, never a bare `throw new Error`.

### 5.5 Result capture
- **Primary:** Perchance's embed calls `window.parent.postMessage({type:"finished", dataUrl, seedUsed, id}, "*")`. This is the contract between Perchance's own generator and its embeds, so it is the most stable signal.
- **Fallback:** `#resultImgEl.src` inside each embed (the seed is parsed from its `title`).
- The image bytes are the ones Perchance downloaded and hash-checked (SHA-256 equals `imageId`), so no second download is needed.

---

## 6. HTTP API contract

| Method & path | Purpose |
|---------------|---------|
| `POST /generator` (alias `POST /api/generator`) | JSON body `{ "prompt": string, "type"?: string }`. Returns 4 images. |
| `GET /generator?prompt=…&type=…` | Same, via query string. |
| `GET /api/types` (alias `/types`) | `{ source, syncedAt, default, imageCount: 4, authRequired, mode, count, types: [...] }` |
| `GET /api/health` | `{ ok, mode, runtime, browserMode, node, busySlots, maxConcurrentJobs, time }` |
| `OPTIONS *` | CORS preflight, returns 204 |

**Success (200):**
```json
{
  "success": true,
  "requestId": "…",
  "prompt": "a red fox in a snowy forest",
  "type": "Cinematic",
  "count": 4,
  "images": [{ "index": 1, "mimeType": "image/jpeg", "extension": "jpg", "sizeBytes": 123456, "seed": 42, "dataUrl": "data:image/jpeg;base64,…" }],
  "settings": { "artStyle": "Cinematic", "numImages": 4, "shape": "Square" },
  "timings": { "browserLaunchMs": 1400, "pageReadyMs": 850, "generationMs": 21000, "totalMs": 23300 },
  "browserMode": "serverless",
  "source": "https://perchance.org/ai-text-to-image-generator"
}
```
(`images` always has exactly 4 entries; one is shown here.)

**Error codes:**

| Code | HTTP | Meaning |
|------|------|---------|
| `INVALID_JSON` | 400 | Malformed JSON body |
| `INVALID_PROMPT` | 400 | Missing, blank or too long (413 if the body exceeds 32 KB) |
| `INVALID_TYPE` | 400 | Not a Perchance Art Style (`details.allowed` lists all) |
| `UNAUTHORIZED` | 401 | `API_KEY` set and not provided or wrong |
| `NOT_FOUND` / `METHOD_NOT_ALLOWED` | 404 / 405 | Routing |
| `BUSY` | 429 | No free slot within `QUEUE_TIMEOUT_MS` |
| `CLIENT_ABORTED` | 408 | Client disconnected (logged, nobody receives it) |
| `BROWSER_LAUNCH_FAILED` | 500 | Chromium could not start or connect |
| `INTERNAL_ERROR` | 500 | Unexpected (stack logged) |
| `CLOUDFLARE_CHALLENGE` | 502 | Cloudflare challenged the page (`details.stage: "page"`) or every embed (`"embed"`) |
| `ANTI_BOT_VERIFICATION_FAILED` | 502 | Perchance's Turnstile kept failing (`details.turnstileErrorCode`, e.g. `600010`) |
| `GENERATOR_UI_NOT_FOUND` | 502 | Page or markup changed, or the form could not be filled |
| `TYPE_NOT_AVAILABLE` | 502 | Style missing from the **live** dropdown (run `sync:types`) |
| `IMAGE_COUNT_UNAVAILABLE` | 502 | Perchance removed "4" from "How many?" |
| `GENERATION_TIMEOUT` | 504 | Fewer than 4 images before the deadline (`details.partialImages`) |

Response size: 4 JPEG/WebP images of 768×768 are typically 0.5–1.5 MB as base64, under Vercel's **4.5 MB** response limit.

---

## 7. Frontend (`public/`)
- Mirrors Perchance's controls: **📝 Description**, **🎨 Art Style** (filled from `/api/types`, option value = label = Perchance text), **🔢 How many?** fixed to 4 (disabled), and **✨ generate**.
- Shows a loading state (spinner, elapsed timer, 4 shimmer placeholders) and then a 2×2 grid with a lightbox, per-image download, "Download all" and seed/size info.
- Errors show `code`, `message` and `hint`; partial images are shown when present.
- Remembers only UI preferences (last prompt, style, API key) in `localStorage`. The server stays stateless.
- Shows the 🔑 API key field when `/api/types` reports `authRequired`, and also after any `401 UNAUTHORIZED`. The second case covers a browser that still has a cached `/api/types` (5 min) from before `API_KEY` was set. The key is sent as `X-API-Key`.
- Shows a demo banner when `mode === "mock"`.
- No external fonts, scripts or images (CSP- and offline-friendly).

---

## 8. Configuration (environment variables)

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | Local server only |
| `BROWSER_MODE` | `auto` | `auto` / `local` / `serverless` / `remote` |
| `BROWSER_WS_ENDPOINT` | – | Remote Chromium (CDP). `auto` switches to `remote` when set |
| `CHROME_EXECUTABLE_PATH` | – | Local custom Chrome/Chromium |
| `HEADLESS` | `true` | Local mode only |
| `CHROMIUM_EXTRA_ARGS` | – (Docker image: `--disable-dev-shm-usage`) | Extra Chromium switches, whitespace-separated (`parseArgList`), merged by `mergeChromiumArgs` (local/serverless modes) |
| `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD` | – | Browser proxy (e.g. residential) |
| `SPOOF_CLIENT_HINTS` | `true` | See §5.1. Consider `false` for remote providers that manage fingerprints themselves |
| `GENERATION_TIMEOUT_MS` | `240000` | On Vercel, must stay below `maxDuration` (300 s). Render has no such cap |
| `PAGE_LOAD_TIMEOUT_MS` | `45000` | Page and generator frame readiness |
| `ANTI_BOT_GRACE_MS` | `45000` | Early abort when Turnstile keeps failing |
| `MAX_CONCURRENT_JOBS` | `1` | Chromium jobs per instance (about 0.6 GB each in the success path) |
| `QUEUE_TIMEOUT_MS` | `60000` | Wait for a slot before `429` |
| `SHUTDOWN_TIMEOUT_MS` | `280000` | Long-running server only: after SIGTERM, wait this long for in-flight generations (keep below Render's `maxShutdownDelaySeconds` = 300) |
| `RENDER` | set by Render | Detected only to report `"runtime":"render"` in `/api/health` |
| `API_KEY` | – | Protects `/generator`. Leading and trailing whitespace is ignored; an empty or whitespace-only value means no key. |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` |
| `MAX_PROMPT_LENGTH` | `2000` | Characters |
| `PERCHANCE_URL` | the generator URL | Override only for testing |

---

## 9. Deployment

### 9.1 Vercel (serverless function)

- **Detection:** Vercel's zero-config Express support finds `src/index.js` (it imports `express` and default-exports the app). It becomes **one Vercel Function on Fluid compute**, and `public/**` goes to the CDN (`express.static` is ignored there).
- **Function settings:** `export const config = { maxDuration: 300 }` in `src/index.js`. This was verified with `vercel build` (CLI 64.2.0): `.vc-config.json` shows `maxDuration: 300` and `runtime: nodejs22.x`. A `functions` entry in `vercel.json` is **not** applied by the Express builder, so don't put it there.
- **Chromium:**
  - `@sparticuz/chromium@153.0.0` provides a brotli-packed `chromium.br` plus `al2023`, `fonts` and `swiftshader`, about 70 MB. Vercel's file tracer bundles its `bin/` automatically; the function bundle is about 75 MB, under the 250 MB limit. No `includeFiles` is needed.
  - On first use it decompresses to `/tmp/chromium` (about 1.5 s) and adds the AL2023 libraries (`VERCEL` and Node ≥ 20 are detected).
- **Version pairing (pinned exactly):**
  - `playwright-core@1.63.0` bundles **Chromium 153.0.8010.12**, which matches `@sparticuz/chromium@153.0.0`.
  - Local development therefore runs the same engine (`npm run browsers:install` installs Chrome Headless Shell 153).
- **Node:** `engines.node = "22.x"` (@sparticuz/chromium 153 needs ≥ 22.17).
- **Limits to keep in mind:**
  - Hobby: 300 s max duration, 2 GB / 1 vCPU.
  - Pro: up to 800 s and 4 GB.
  - Response body: 4.5 MB.
- **Memory:** one generation peaked at about 0.6 GB of Chromium RSS (summed, so an upper bound). A failing Turnstile retry loop can grow much larger, which is one reason for `ANTI_BOT_GRACE_MS` and `MAX_CONCURRENT_JOBS=1`.
- **Fluid concurrency:** several requests may share one instance. The semaphore makes extra requests wait (or get 429) instead of starting a second Chromium that could exhaust memory.
- **Fluid compute is required** (the default for new projects). Without it, Hobby caps functions at 60 s and the build rejects `maxDuration: 300`.
- **How to deploy, test and troubleshoot:** see [`DEPLOY.md`](./DEPLOY.md). `npm run smoke:live` tests the machine it runs on, not Vercel; test a deployment through its `/generator` endpoint.

### 9.2 Render / Docker (long-running server)

- **Same code, different host.** `node src/index.js` (the image's `CMD`) listens on `PORT` (10000 in the image). `BROWSER_MODE=local` uses Playwright's Chrome Headless Shell 153 from `/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`). That is the build `playwright-core@1.63.0` expects, so `bundledChromiumVersion()` and the UA override stay correct. `@sparticuz/chromium` is installed but unused in this mode.
- **Image:** `node:22-bookworm-slim`. The `npm ci` and browser-install layer is cached until `package*.json` changes. About 920 MB.
- **Container specifics:**
  - `/dev/shm` is only about 64 MB in containers, so the image sets `CHROMIUM_EXTRA_ARGS=--disable-dev-shm-usage`.
  - `tini` is PID 1: it forwards signals and reaps Chromium zombies.
  - The process runs as `node` (uid 1000). Chromium runs with Playwright's default `--no-sandbox`.
- **Graceful shutdown** (`src/index.js`, direct run only, never on Vercel):
  - On SIGTERM or SIGINT the server stops accepting connections, waits for in-flight requests (up to `SHUTDOWN_TIMEOUT_MS`, 280 s), then exits. A second signal exits immediately; `process.exit` still runs Playwright's exit hook, which kills its browsers.
  - `setAppHandlesShutdownSignals()` makes `launch.js` pass `handleSIGINT: false, handleSIGTERM: false`. Otherwise Playwright would kill in-flight browsers on the first signal. This was observed: the request then hung until the deadline, which is what led to the fail-fast `close` check in §5.4.
  - `render.yaml` sets `maxShutdownDelaySeconds: 300`.
  - Verified with Podman: SIGTERM arrived during a live request; new connections were refused; the in-flight request still returned its complete response (66 s); the container exited with code 0.
- **Plan feasibility.** Measured with cgroup v2 limits that emulate Render's plans; details in `DEPLOY_RENDER.md`.

  | Plan | Mocked image API | Real Perchance (anti-bot check runs) |
  |------|------------------|--------------------------------------|
  | `free` (0.1 CPU / 512 MB) | 4 images in about 58 s, peak 281–338 MiB | Turnstile timed out (`110600`) after 256 s, memory at 503/512 MiB |
  | `0.5c-512mb` | 9.4 s, 251 MiB | Browser OOM-killed after 50 s (page crash, HTTP 500) |
  | `1c-2g` | 7.5 s, 275 MiB | Check completed (verdict `600010` for the test IP) in 67 s, peak 1.13 GB |

  Real generation therefore needs at least `1c-2g`. Alternatively, run the free plan with `BROWSER_WS_ENDPOINT` so that Chromium runs elsewhere.
- **Concurrency:** a single instance with `MAX_CONCURRENT_JOBS=1`. Allow about 1.2 GB per extra concurrent job before raising it.

---

## 10. Testing

| Command | What it proves | Needs network / browser |
|---------|----------------|-------------------------|
| `npm test` | 36 unit and HTTP contract tests: validation, type mapping, semaphore, flag merging (including `CHROMIUM_EXTRA_ARGS`), UA builder, error mapping, every route, API key protection (generator stubbed) | No / no |
| `npm run test:mock-e2e` | The **whole pipeline** against the real perchance.org page, generator iframe and embed JavaScript; only `image-generation.perchance.org/api/*` is mocked. It checks: prompt reaches Perchance, chosen style changes Perchance's final prompt, exactly 4 `/api/generate` calls, 4 distinct images, HTTP `/generator` 200/400/405 | Yes / yes |
| `npm run smoke:live` | Real generation with no mocks. Exit code 0 means 4 images; 2 means blocked by anti-bot or Cloudflare (environment/IP); 1 means another failure | Yes / yes |
| `npm run sync:types` | Live dropdown is readable; refreshes `art-styles.js` | Yes / yes |

Verified on 2026-10-15:
- `npm test` 29/29 and mock E2E 10/10.
- Mock flow passes with local Chromium and with the **@sparticuz Vercel binary**.
- The **traced Vercel bundle** (`.vercel/output/functions/index.func`, run with `VERCEL=1`) returned 4 images.
- Example final prompts Perchance built:
  - *Cinematic*: "…golden hour, cinematic shot, dynamic lighting, 75mm, Technicolor, Panavision, cinemascope…"
  - *Painted Anime*: "…art in the style of atey ghailan, painterly anime style at pixiv…"
- `smoke:live` from the build sandbox (a data-center IP) returned `ANTI_BOT_VERIFICATION_FAILED` (Turnstile 600010) after about 72 s, the expected typed failure (see §12).

Verified on 2026-10-16 (Render support):
- `npm test` 30/30 and mock E2E 10/10.
- `vercel build` is unchanged: one `index.func` (`nodejs22.x`, `maxDuration` 300, 75 MB). The traced bundle loads with `VERCEL=1`.
- The Docker image was built with Podman and run with `--memory=512m --cpus=0.1`:
  - `/api/health` reports `"runtime":"render"`, and requests run as the non-root user with `tini` as PID 1.
  - Demo mode returned 4 images in 73 s (peak 338 MiB).
- Graceful shutdown and the fail-fast browser-death check behave as described in §9.2 and §5.4.

Verified on 2026-10-16 (API key):
- `npm test` 36/36 (adds `test/auth.test.js`).
- In a browser, the 🔑 field appears only when `API_KEY` is set. A wrong key shows `401 UNAUTHORIZED`, an empty field is caught before anything is sent, and the key is still there after a reload.
- Turning `API_KEY` on while the browser still had a cached `/api/types` used to leave the field hidden. The field now appears after the first 401.
- Plan measurements: see §9.2.

---

## 11. Maintenance runbooks

- **Perchance added or renamed styles:** `npm run sync:types`, review the diff of `src/perchance/art-styles.js`, commit.
- **Perchance changed its markup:** run `npm run smoke:live` (or `test:mock-e2e`), then update `src/perchance/selectors.js`. All selectors and markers live there.
- **Upgrading Playwright / Chromium:**
  - Keep the pair aligned: `playwright-core@X` must bundle Chromium N, and `@sparticuz/chromium@N` must match. Check with `npm pack playwright-core@X` and read `browsers.json`.
  - Update `PLAYWRIGHT_DISABLED_FEATURES` from Playwright's `chromiumSwitches`.
  - Run `npm test`, `npm run test:mock-e2e` and `BROWSER_MODE=serverless npm run test:mock-e2e`.
- **Timeouts on Pro:** raise `config.maxDuration` in `src/index.js` (≤ 800) and `GENERATION_TIMEOUT_MS` (keep 30–60 s below it).
- **Out-of-memory on Vercel:** keep `MAX_CONCURRENT_JOBS=1`, lower `ANTI_BOT_GRACE_MS`, or raise function memory (Pro).
- **Docker / Render after a Playwright upgrade:** the Dockerfile installs the browser that matches the `playwright-core` version in `package-lock.json`, so a rebuild picks it up automatically. Re-run the container checks: `/api/health`, then demo mode (`node scripts/demo-mock-server.js`).

---

## 12. Known limitations and risks

1. **Perchance's anti-bot protection (Cloudflare + Turnstile)** decides whether a browser may generate. From data-center IPs, including the sandbox where this was built, Turnstile can fail permanently (error `600010`, "Anti-bot verification failed. VPNs may cause this"). The app then returns `502 ANTI_BOT_VERIFICATION_FAILED` after `ANTI_BOT_GRACE_MS` instead of hanging. Vercel (AWS) IPs may or may not pass. Mitigations, all configuration only:
   - `PROXY_SERVER`: route the browser through a residential proxy.
   - `BROWSER_WS_ENDPOINT`: use a remote browser service or a machine with a residential IP.
2. **Perchance is a third-party site without an official API.** Markup and flows can change at any time (see §11). Respect Perchance's terms and fair use, and do not run high-volume or abusive traffic.
   - Perchance's Terms of Service (updated 2026-07-18) allow **commercial use of generated images**, without attribution.
   - The same terms also say users "will not access the Services through automated or non-human means, whether through a bot, script or otherwise" (§3). They also prohibit circumventing security features and bypassing access-restricting measures (§5).
   - This app is such an automation, so it is unsuitable as the basis of a commercial service regardless of host. Render's Acceptable Use Policy also forbids using its service to "bypass, circumvent, or defeat any … security measures".
   - Details are in `DEPLOY_RENDER.md` → Terms and commercial use.
3. **Cold starts:** first request on a new instance adds about 1.5–3 s (Chromium decompression and launch).
4. **No global rate limiting** (stateless by design). Use `API_KEY` and/or Vercel Firewall rate-limit rules.
5. **Perchance's own content filtering** applies. Images flagged by Perchance may be blurred or replaced by Perchance itself.

---

## 13. Conventions for contributors

- ES modules, Node 22, no build step and no TypeScript. Express 5 (async errors reach the error handler automatically).
- Keep the server **stateless**: no module-level caches of user data, no writes outside the per-request temp profile.
- Perchance specifics go in `selectors.js`, and generated data in `art-styles.js`.
- In-page code goes through `evaluateSafe()`. Every wait honours the deadline and the `AbortSignal`.
- New errors are added to `ERROR_CATALOG`, with a `hint` when the user can act on it.
- `IMAGE_COUNT` stays `4` (rule R1). Don't add a count parameter.
- Run `npm test` and `npm run test:mock-e2e` before every deploy.
