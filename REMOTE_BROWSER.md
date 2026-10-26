# Remote Browser — Oversimplified

> 1-page cheat sheet. Works for Vercel + Render + local Docker.

## What?
Your app normally launches Chrome on the same server. **Remote** means Chrome lives elsewhere and your app talks to it via WebSocket `wss://...`.

```
Normal:  [Your App + Chrome on Vercel] → Perchance (blocked: data-center IP)
Remote:  [Your App on Vercel] --wss--> [Chrome on Browserless/home PC with home IP] → Perchance (allowed)
```

## Why?
- Perchance blocks data-center IPs (`502 ANTI_BOT 600010` or timeout `110600`).
- Free plans lack RAM/CPU (need ~0.6GB, free has 0.5GB or kills Turnstile).
Remote solves both: heavy Chrome not on your server, and uses residential IP.

## vs Proxy?
- `PROXY_SERVER` = keep Chrome here, internet via proxy (needs HTTP proxy).
- `BROWSER_WS_ENDPOINT` = move Chrome there entirely (better for free, no extra config). Pick ONE.

## How code uses it (simple)
- `src/config.js` reads `BROWSER_WS_ENDPOINT`. If set, `resolveBrowserMode()` returns `remote`.
- `src/browser/launch.js` instead of `launchPersistentContext`, does `chromium.connectOverCDP(wsEndpoint)` → `browser.newContext({viewport,locale,userAgent})` → reuses first context if provider forbids creation → closes context+ browser after 2 images.
- `src/browser/fingerprint.js` may still spoof UA unless `SPOOF_CLIENT_HINTS=false` (some providers do it).

## Setup in 3 steps
1. **Get URL:**
   - Browserless: `wss://production-sfo.browserless.io?token=TOKEN`
   - Browserbase: `wss://connect.browserbase.com?apiKey=KEY`
   - Home PC: `google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox` → tunnel via `npx ngrok http 9222` or `cloudflared tunnel` → `wss://tunnel-url`
2. **Set env:** `BROWSER_WS_ENDPOINT=wss://...` (+ optional `BROWSER_MODE=remote`, `SPOOF_CLIENT_HINTS=true`)
3. **Redeploy & test:** `GET /api/health` → `"browserMode":"remote"` → generate → should get `count:2` not 502. Logs: `browser.ready mode:remote`.

## Costs
Browserless ~30min free, $10-50/mo; Browserbase similar; home PC free but must stay on. Still ~1 Chrome at a time.

## Troubleshooting
| Error | Fix |
|---|---|
| `BROWSER_LAUNCH_FAILED could not connect` | WS URL wrong/expired, firewall, provider down |
| Still 502 600010 | Remote IP also blocked → use provider's residential proxy option |
| `no usable context` | Provider allows only default context → code auto-reuses (already handled) |
| Slow first request | Cold provider → wait, raise `GENERATION_TIMEOUT_MS` |

Env example:
```
BROWSER_WS_ENDPOINT=wss://production-sfo.browserless.io?token=abc123
# Don't also set PROXY_SERVER if using remote with provider proxy
```

Test: `curl /api/health` → remote; `curl -X POST /generator -d '{"prompt":"a cat"}'` → 2 images.

That's it — move Chrome elsewhere, keep app tiny.
