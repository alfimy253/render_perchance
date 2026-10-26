# Deploy to Render / Docker — Simple Guide

> Vercel guide is in `DEPLOY.md`.

---

## What Render does

Same code as Vercel, but runs as **always-on server** (not a function). `node src/index.js` listens on `PORT=10000`. Free plan has tiny CPU/RAM — it *runs* but Perchance's anti-bot check needs **1 CPU / 2 GB** ($25/mo) to pass. Free can still work if you offload browser elsewhere.

**Plan test results (2 images):**
| Plan | Fake images (mock) | Real Perchance |
|---|---|---|
| Free 0.1c/512MB | ✅ ~58s, peak 300MB | ❌ Timeout (110600) or OOM |
| 0.5c/512MB $7 | ✅ 9s | ❌ OOM crash |
| **1c/2g $25** | ✅ 7.5s | ✅ 67s pass (may still reject IP 600010) |

Conclusion: Need 1c-2g, or set `BROWSER_WS_ENDPOINT` (browser runs at provider, Render just runs Express).

---

## 1. Deploy with Blueprint (easiest)

1. Push folder to GitHub (see DEPLOY.md step 1). `render.yaml`, `Dockerfile`, `package.json` must be at repo top.
2. https://dashboard.render.com → **New → Blueprint** → Connect GitHub → pick repo.
3. Keep branch `main`, Blueprint Path empty → **Deploy Blueprint**.
4. Watch Logs — first build takes minutes (downloads Chrome). When **Live**, copy URL `https://xxx.onrender.com`.
5. Go to **Environment** → copy generated `API_KEY` → paste into site 🔑 box.

Every push to `main` redeploys. To change plan, edit `plan: free` in `render.yaml` and push (or Dashboard → Instance Type, but file overwrites on next sync). 1c-2g $25/mo is billed per second, so you can test for cents and switch back.

`region: singapore` is default (near Philippines). Can't change after create, so set before first deploy.

## 2. Deploy without Blueprint

**New → Web Service** → connect repo →
- Language: Docker
- Instance: Free or Standard 1c/2g
- Health Check Path: `/api/health`
- Env var: `API_KEY=your-long-random-string`

---

## 2. Env vars (Render Dashboard → Environment → Redeploy)

Docker image already sets `BROWSER_MODE=local`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, `CHROMIUM_EXTRA_ARGS=--disable-dev-shm-usage`, `PORT=10000`.

| Var | When |
|---|---|
| `API_KEY` | Blueprint creates it. Protects `/generator`. |
| `PROXY_SERVER` (+ user/pass) | If `502 ANTI_BOT... 600010` — IP rejected. Use HTTP proxy. |
| `BROWSER_WS_ENDPOINT` | To make free plan work — browser at remote provider (Browserless etc). |
| `QUEUE_TIMEOUT_MS` | Default 60s — wait before 429 BUSY. |
| `GENERATION_TIMEOUT_MS` | Default 240s — no 300s limit on Render (can raise, HTTP can take 100 min). |
| `SHUTDOWN_TIMEOUT_MS` | Default 280s — wait for running jobs on SIGTERM (keep <300). |

---

## 3. How it behaves

- **Sleep:** Free spins down after 15 min idle → next request takes ~1 min + 10s boot.
- **Zero-downtime:** Render sends SIGTERM before replace → app stops new requests but finishes running generations → exits. Playwright's SIGTERM killer is disabled for this.
- **One at a time:** `MAX_CONCURRENT_JOBS=1`. Need ~1.2 GB per extra job if you raise it.

**Free limits:**
- 750 hrs/month free (one service 24/7 fits, sleep doesn't count).
- 5 GB bandwidth/month — 2-image reply ~0.5–1.5 MB. No card → suspended after 5 GB.
- May restart anytime, no shell on free.

---

## 4. Test it

1. `https://xxx.onrender.com/api/health` → `"runtime":"render"`, `"browserMode":"local"` or `"remote"`.
2. Open site → enter API key → generate → expect 2 images.
3. On paid (has Shell): `node scripts/live-smoke.js` → 0=2 images, 2=blocked, 1=fail.

| Result | Fix |
|---|---|
| `502 ...110600` (timeout) | Not enough CPU → use 1c-2g or remote browser |
| `502 ...600010` (rejected) | IP blocked → proxy or remote browser |
| `500 page crashed` | OOM → use 1c-2g |
| `429 BUSY` | Wait or raise QUEUE_TIMEOUT_MS |
| First request slow | Free was asleep — normal |

---

## 5. Run locally with Docker

```bash
docker build -t perchance-image-generator .
docker run --rm -p 10000:10000 -e API_KEY=change-me perchance-image-generator
# Emulate free plan:
docker run --rm -p 10000:10000 --memory=512m --cpus=0.1 perchance-image-generator
# Fake images (no anti-bot):
docker run --rm -p 10000:10000 perchance-image-generator node scripts/demo-mock-server.js
```

---

## 6. Terms (short)

- **Render:** Free for hobby/test ("Don't use for production"), commercial allowed on any plan. But forbids bypassing others' security — keep in mind.
- **Perchance:** Images you get are **commercially usable**. But terms say "no bots, no bypassing security" — this project *is* a bot. Don't build commercial product on it. For money, make your own generator *on* Perchance (allowed) or use licensed API.

