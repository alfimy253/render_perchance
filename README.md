# 🌌 Perchance Image Generator — Simple Guide

**What is this?**  
A tiny website + API that asks Perchance (https://perchance.org/ai-text-to-image-generator) to make pictures for you. You give a prompt, pick a style, you get **2 images** back.

No login. No database. Each request opens a fresh browser, does the clicking for you, then closes it.

---

## 1. Try it locally (2 minutes)

You need **Node 22**.

```bash
npm install
npm run browsers:install   # installs Chrome for the robot
npm run dev                # open http://localhost:3000
```

Type a prompt like `a cozy cabin in snow at dusk`, pick `Cinematic`, click **✨ generate**. Wait ~20–60s. Done.

---

## 2. Deploy (pick one)

### Vercel (easiest)
1. Push this folder to GitHub.
2. Go to https://vercel.com/new → Import your repo → click Deploy. Keep defaults.
3. (Optional but recommended) Set `API_KEY` in Settings → Environment Variables → Redeploy. This adds a 🔑 box on the site.

Done. Your URL is `https://your-app.vercel.app`.

> Full steps + troubleshooting: `DEPLOY.md`

### Render / Docker
1. Push to GitHub.
2. In Render click **New → Blueprint** → connect repo → Deploy.
3. Copy the `API_KEY` from Render → Environment.

Free plan runs but Perchance's anti-bot check needs **1 CPU / 2 GB** ($25/mo) or a remote browser. Or set `BROWSER_WS_ENDPOINT` to use a browser elsewhere.

> Full steps + plans: `DEPLOY_RENDER.md`

---

## 3. API — super simple

You only need `prompt`. `type` is optional.

**POST**
```bash
curl -X POST https://your-app.vercel.app/generator \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a red fox in snowy forest","type":"Cinematic"}'
```

**GET**
```bash
curl 'https://your-app.vercel.app/generator?prompt=a%20lighthouse&type=Watercolor'
```

If you set `API_KEY`, add header: `-H 'X-API-Key: YOUR_KEY'`

**Success looks like this:**
```json
{
  "success": true,
  "type": "Cinematic",
  "count": 2,
  "images": [
    {"index":1, "seed":123, "mimeType":"image/jpeg", "dataUrl":"data:image/jpeg;base64,..."},
    {"index":2, "seed":456, "mimeType":"image/jpeg", "dataUrl":"data:image/jpeg;base64,..."}
  ]
}
```
Always 2 images. `dataUrl` is the picture — save it as a file or show it in `<img>`.

**Other URLs:**
- `GET /api/types` → list of all Art Styles (79) + `imageCount:2` + `default`
- `GET /api/health` → is server alive?

**Errors are simple:**
`{success:false, error:{code, message, hint}}`
Codes: `INVALID_PROMPT` (400), `INVALID_TYPE` (400), `UNAUTHORIZED` (401), `BUSY` (429), `CLOUDFLARE_CHALLENGE` / `ANTI_BOT_VERIFICATION_FAILED` (502 — Perchance blocked the server IP, try proxy), `GENERATION_TIMEOUT` (504).

---

## 4. Frontend

- **Prompt box** → your description.
- **Art Style dropdown** → same 79 styles as Perchance. Comes from `/api/types`.
- **How many?** → always **2** (locked).
- Results → 2 pictures in grid → lightbox, download buttons.

Your last prompt/style/key is saved only in your browser (`localStorage`). Server saves nothing.

---

## 5. Commands

| Do this | Run |
|---|---|
| Start locally | `npm run dev` |
| Run tests (no browser) | `npm test` |
| Real test with mocked images | `npm run test:mock-e2e` |
| Real live test (needs good IP) | `npm run smoke:live -- "a lighthouse" "Cinematic"` |
| Update styles from Perchance | `npm run sync:types` |

---

## 6. Important warnings

- Perchance has **Cloudflare anti-bot**. Data-center IPs (Vercel, Render free) often get `502 ANTI_BOT_VERIFICATION_FAILED`. Fix: set `PROXY_SERVER` (residential proxy) or `BROWSER_WS_ENDPOINT` (remote browser like Browserless).
- Perchance can change its page anytime — if it breaks, update `src/perchance/selectors.js` (all selectors in one file).
- Perchance terms allow **using the images commercially** but **forbid bots**. This project *is* a bot — use for personal/experiments only, not a commercial product.

---

## 7. Files at a glance

```
src/index.js              → start server (Vercel + Render)
src/http/configure-app.js → API routes
src/perchance/generator.js→ robot that clicks Perchance (makes 2 images)
src/perchance/selectors.js→ all CSS selectors in one place
src/perchance/art-styles.js→ list of 79 styles (auto-generated)
public/                   → website (index.html, app.js, styles.css)
scripts/                  → helpers (sync, smoke, mock)
test/                     → tests
system_rule.md            → how it works inside (technical)
```

That's it! Type prompt → get 2 pictures.
