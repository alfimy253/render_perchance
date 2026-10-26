# Deploy to Vercel — Simple Guide (2 minutes)

No config files needed. All settings are already in code.

> For Render/Docker see `DEPLOY_RENDER.md`.

---

## Option A: GitHub + Vercel website (recommended)

**1. Put on GitHub**
- Make empty GitHub repo (no README).
- In this folder run:
```bash
git init
git add .
git commit -m "Perchance generator"
git branch -M main
git remote add origin https://github.com/YOUR_USER/perchance-image-generator.git
git push -u origin main
```
No git? On GitHub click "uploading an existing file" → drag all files (package.json must be at top).

**2. Import to Vercel**
- Go to https://vercel.com/new → Import your repo → Deploy. Keep defaults.
- Framework = Express (auto), Root = `./`, no build step.
- Optional: add `API_KEY` now (see below).

Done! URL like `https://your-app.vercel.app`. Every push to `main` auto-deploys.

---

## Option B: Command line (no GitHub)

```bash
npm i -g vercel   # or npx vercel
vercel login
vercel            # follow prompts (Project name: perchance-image-generator, dir: ./)
vercel --prod     # push live
```

Answers: Set up? Yes → Scope? yours → Link existing? No → Project name? anything → Dir? `./` → Modify settings? No (Express).

---

## Important setting

**Project → Settings → Functions → Fluid compute = ON** (default ON for new projects). If OFF, build fails with "maxDuration between 1 and 60" and limit is 60s not 300s.

Other settings auto from `package.json`: Node 22, maxDuration 300s (Hobby max), Chromium bundled (~75 MB).

---

## Env vars (Project → Settings → Environment Variables → Redeploy)

| Var | When | Example |
|---|---|---|
| `API_KEY` | **Recommended.** Public API uses a full browser for 5 min — anyone can burn your quota. When set, site shows 🔑 box. | `openssl rand -hex 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PROXY_SERVER` etc | If you see `502 ANTI_BOT...` — Vercel IP blocked. Use residential proxy HTTP endpoint. | `http://gate.proxy.com:7000` |
| `BROWSER_WS_ENDPOINT` | Alternative: run browser elsewhere (Browserless/Browserbase/your PC). | `wss://...?token=...` |

No `openssl`? Use node command above. Change needs Redeploy.

---

## Remote Browser — Explained Like You're 5

**Problem:** Perchance blocks Vercel/Render data-center IPs with `502 ANTI_BOT_VERIFICATION_FAILED` (Turnstile 600010 or 110600). Also free plans have too little RAM/CPU.

**What Remote Browser means:**
Think of it like this:
- **Normal:** Your app runs Chrome *on the same computer* as the app (Vercel function or Render server). That computer is in a data-center → Perchance says "robot!" → blocked.
- **Remote:** Your app does NOT run Chrome. It *calls* Chrome running *somewhere else* via a WebSocket URL `wss://...` . That somewhere else has a home/residential IP → Perchance says "human!" → allowed.

Your Vercel/Render app becomes tiny: it only runs Express + Playwright client (almost no RAM). The heavy Chrome runs at the provider.

**When to use what:**
- `PROXY_SERVER` = keep Chrome on Vercel/Render, but internet goes through proxy. Good if you have proxy.
- `BROWSER_WS_ENDPOINT` = move Chrome itself elsewhere. Good if free plan (saves RAM/CPU) or proxy doesn't work. If you use this, DON'T set `PROXY_SERVER` — set proxy at provider instead.

**How to set it:**
1. Get a WebSocket URL from provider:
   - **Browserless.io:** `wss://production-sfo.browserless.io?token=YOUR_TOKEN`
   - **Browserbase:** `wss://connect.browserbase.com?apiKey=YOUR_KEY`
   - **Local PC with residential IP:** Run `chrome --remote-debugging-port=9222 --headless` then expose via `ngrok`/`cloudflare tunnel` → `wss://your-tunnel/wss`
2. In Vercel/Render env vars set: `BROWSER_WS_ENDPOINT=wss://...` (and optionally `BROWSER_MODE=remote` — auto if this var exists).
3. Keep `SPOOF_CLIENT_HINTS=true` unless provider says they handle it.
4. Redeploy. Check `GET /api/health` → should show `"browserMode":"remote"` not `serverless/local`.

Code: `src/browser/launch.js → openRemoteSession()` does `chromium.connectOverCDP(BROWSER_WS_ENDPOINT)` → `browser.newContext()` → reuses if provider blocks → closes both context+ browser after request.

**Costs:**
- Browserless free ~30 min/mo, paid $10-$50/mo. Browserbase similar. Local PC = free but must stay on.
- Still needs 1 Chrome per request (≈0.6 GB at provider, but not on your server).

**Test:** After setting, generate → should get 2 images instead of 502. Logs show `browser.ready mode:remote`.

All other vars have defaults (see `.env.example`).

---

## Test it worked

1. **Health:** open `https://your-app.vercel.app/api/health` → should see `"runtime":"vercel"`, `"browserMode":"serverless"`, node v22.
2. **Website:** open `https://your-app.vercel.app` → type prompt → generate → get 2 images.
3. **API:**
```bash
curl -X POST https://your-app.vercel.app/generator \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_KEY' \
  -d '{"prompt":"a red fox in snow","type":"Cinematic"}' -o result.json
head -c 200 result.json
# should start with {"success":true, "count":2
```
Remove `X-API-Key` line if you didn't set `API_KEY`. Test **production** domain, not preview (preview needs Vercel login).

`npm run smoke:live` tests YOUR computer's IP, not Vercel's.

---

## If something breaks

| You see | Meaning | Fix |
|---|---|---|
| `502 ANTI_BOT...` or `502 CLOUDFLARE_CHALLENGE` | Perchance blocked Vercel IP | Set proxy or remote browser, redeploy |
| Build fails maxDuration 1-60 | Fluid compute OFF | Turn ON, redeploy |
| Vercel login page | You used preview URL | Use production domain |
| `401 UNAUTHORIZED` | Wrong/missing API_KEY | Put correct key in 🔑 or header |
| `429 BUSY` | One generation already running | Wait a bit |
| `504 GENERATION_TIMEOUT` | Perchance slow, didn't send 2 images in 240s | Retry; on Pro raise maxDuration + GENERATION_TIMEOUT_MS |
| `504 FUNCTION_INVOCATION_TIMEOUT` | Hit Vercel 300s limit | Keep GENERATION_TIMEOUT_MS 30-60s below maxDuration |
| Out of memory | >2 GB used (often anti-bot retry loop) | Keep MAX_CONCURRENT_JOBS=1, lower ANTI_BOT_GRACE_MS, or Pro 4GB |

Logs: Vercel Dashboard → Project → Logs.

Plans: Hobby 300s/2GB (free, personal only), Pro up to 800s/4GB (commercial allowed).
