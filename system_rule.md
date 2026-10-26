# system_rule.md — How It Works (Simple Version)

> This is the simple brain of the project. For usage see `README.md`.

---

## 0. What happens per request (5 steps)

1. Open a **fresh invisible Chrome** (Playwright).
2. Go to `perchance.org/ai-text-to-image-generator`.
3. Type your prompt → pick Art Style → set How many=**2** → click **✨ generate**.
4. Wait for 2 images (each comes in its own small iframe).
5. Return them as `data:image/jpeg;base64,...` + close browser.

No database. No saved files. One browser per request, deleted after.

---

## 1. The 8 Rules (keep these true)

1. **Always 2 images.** `IMAGE_COUNT = 2` in `src/perchance/generator.js`. No `count` parameter allowed. Fail if <2.
2. **Style must be real.** `type` must exactly match Perchance's Art Style dropdown (e.g. `Cinematic`, `𝗡𝗼 𝘀𝘁𝘆𝗹𝗲`). We allow `no style` → auto-fix to `𝗡𝗼 𝘀𝘁𝘆𝗹𝗲`. Else 400.
3. **Frontend dropdown = real dropdown.** Loaded from `GET /api/types`, never hardcoded.
4. **Never call Perchance API directly.** Only click like a human in Playwright.
5. **Stateless.** Fresh browser profile in `/tmp` per request, deleted after. Only in-memory semaphore.
6. **Always close browser.** `try/finally`, even on error/timeout/abort.
7. **Errors are typed.** `{success:false, error:{code, message, hint}}` with correct HTTP code.
8. **Deploys everywhere.** `src/index.js` default-exports Express for Vercel, and listens on `PORT` for Render/Docker.

---

## 2. Simple Architecture

```
Browser (public/index.html)  ----\
                                 v
                     Express App (src/index.js → src/http/configure-app.js)
                        |  check API key → validate → wait for slot → run robot
                        v
                     src/perchance/generator.js (Playwright)
                        |
             opens https://perchance.org/ai-text-to-image-generator
                        |
               iframe https://<hash>.perchance.org/ai-text-to-image-generator
                 ├─ textarea[description]  ← prompt
                 ├─ select[artStyle]       ← style
                 ├─ select[numImages]      ← 2
                 ├─ button#generateButtonEl
                 └─ 2× iframe https://image-generation.perchance.org/embed
                      → <img id="resultImgEl" src="data:image/...">
                      → postMessage {type:"finished", dataUrl, seedUsed}
```

- `public/` is served by Vercel CDN (ignored locally).
- `src/browser/launch.js` picks browser: local (your Chrome) / serverless (@sparticuz/chromium on Vercel) / remote (BROWSER_WS_ENDPOINT).
- `src/browser/fingerprint.js` hides HeadlessChrome so Perchance doesn't block us.

---

## 3. Where is what? (Code Map — simple)

| File | Job |
|---|---|
| `src/index.js` | Start app. Vercel uses it as function, Docker runs `node src/index.js`. |
| `src/http/configure-app.js` | Routes: `/api/health`, `/api/types`, `/generator`. Handle errors. |
| `src/config.js` | Read env vars once (PORT, API_KEY, timeouts). |
| `src/perchance/selectors.js` | **ALL Perchance URLs/selectors here.** Fix only this if Perchance changes design. |
| `src/perchance/art-styles.js` | List of 79 styles. Don't edit — run `npm run sync:types`. |
| `src/perchance/generator.js` | The robot: open page → fill form → click → wait 2 images → return them. |
| `src/browser/launch.js` | Start Chrome correctly (flags, temp profile). |
| `src/browser/fingerprint.js` | Fake User-Agent so Perchance thinks it's normal Chrome. |
| `src/utils/validate.js` | Check prompt + fix style spelling. |
| `src/utils/errors.js` | List of error codes + HTTP numbers. |
| `src/utils/semaphore.js` | Allow only 1 browser at a time. Others wait or get 429. |
| `public/index.html/app.js` | Website. No extra libraries. |
| `scripts/sync-art-styles.js` | Download fresh styles from Perchance. |
| `scripts/live-smoke.js` | Real test (no mocks). |
| `scripts/mock-e2e.js` | Test with fake images (no anti-bot). |
| `test/*.test.js` | Fast tests (no browser). |

---

## 4. API in 10 seconds

| URL | What |
|---|---|
| `POST /generator` | Body `{prompt, type?}` → 2 images |
| `GET /generator?prompt=...&type=...` | Same, via URL |
| `GET /api/types` | `{default, imageCount:2, types:[79 styles]}` |
| `GET /api/health` | `{ok:true, runtime, browserMode}` |

Success: `200 {success:true, count:2, images:[{index,mimeType,extension,sizeBytes,seed,dataUrl}], settings, timings}`
Fail: `4xx/5xx {success:false, error:{code,message,hint}}`

Common codes: `INVALID_PROMPT` 400, `INVALID_TYPE` 400, `UNAUTHORIZED` 401, `BUSY` 429, `ANTI_BOT_VERIFICATION_FAILED` 502, `CLOUDFLARE_CHALLENGE` 502, `GENERATION_TIMEOUT` 504.

2 images ≈ 0.5–1.5 MB base64, fits Vercel 4.5 MB limit.

---

## 5. Why we fake the browser identity

Perchance blocks `HeadlessChrome`. We:
- Set normal Chrome User-Agent (`launchPersistentContext`)
- Set `Network.setUserAgentOverride` with real brands (Google Chrome, Chromium)
- Disable site isolation so all iframes see same identity

Result: Before fix all embeds 403, after fix all 2 embeds 200.

Chromium flags are merged into one `--disable-features` (Chromium only respects last one).

---

## 6. Safety rules

- Never use `frame.evaluate()` directly — use `evaluateSafe()` with timeout (hangs under low memory).
- Re-find frames each poll, skip detached.
- Respect deadline + abort signal.
- If browser crashes/closes → fail fast (`INTERNAL_ERROR`), don't hang till timeout.

Images: primary = `postMessage {finished, dataUrl}`, fallback = `#resultImgEl.src`. Dedup by SHA1, keep first 2.

---

## 7. Settings (env vars) — simple

| Var | Default | When to change |
|---|---|---|
| `PORT` | 3000 | Local only |
| `API_KEY` | none | Set to protect `/generator` (you invent it) |
| `GENERATION_TIMEOUT_MS` | 240000 (4 min) | Keep < Vercel maxDuration (300s) |
| `PAGE_LOAD_TIMEOUT_MS` | 45000 | Perchance slow? Increase |
| `ANTI_BOT_GRACE_MS` | 45000 | Give up early if anti-bot keeps failing |
| `MAX_CONCURRENT_JOBS` | 1 | 1 browser at a time (uses ~0.6 GB) |
| `QUEUE_TIMEOUT_MS` | 60000 | Wait for slot before 429 |
| `BROWSER_WS_ENDPOINT` | none | Use remote browser (fixes free-plan) |
| `PROXY_SERVER` | none | Residential proxy (fixes anti-bot) |
| `PERCHANCE_URL` | perchance.org/... | For tests only |

---

## 8. How to fix common problems

- **New style added:** `npm run sync:types` → commit `art-styles.js`
- **Perchance changed design:** run `npm run smoke:live`, update `src/perchance/selectors.js`
- **Upgrade Chrome:** keep `playwright-core` + `@sparticuz/chromium` same version (both 153), update `PLAYWRIGHT_DISABLED_FEATURES`, test all.
- **Timeout on Pro:** raise `maxDuration` in `src/index.js` + `GENERATION_TIMEOUT_MS`
- **Out of memory:** keep `MAX_CONCURRENT_JOBS=1`, lower `ANTI_BOT_GRACE_MS`

---

## 9. Testing (simple)

| Command | What it checks | Needs net/browser? |
|---|---|---|
| `npm test` | 36 fast tests (validation, routes, errors) | No |
| `npm run test:mock-e2e` | Real page + fake images → check 2 images, 2 API calls | Yes/Yes |
| `npm run smoke:live` | Real images (0=2 images, 2=blocked, 1=fail) | Yes/Yes |

---

## 10. Limits to know

- **Anti-bot:** Data-center IPs often blocked (Turnstile 600010). Fix: proxy or remote browser.
- **Perchance can change anytime** — no official API.
- **Cold start:** +1.5–3s first request (Vercel decompresses Chrome).
- **No rate limit** — use `API_KEY`.
- Perchance may blur flagged images.

That's all. Keep `IMAGE_COUNT = 2`. Don't add count param.
