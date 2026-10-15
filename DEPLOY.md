# Deploying to Vercel

> Deploying to Render instead? See [`DEPLOY_RENDER.md`](./DEPLOY_RENDER.md).

The app needs **no Vercel configuration files or build settings**. Everything Vercel needs is already in the code:

| What | Where it is set |
|------|-----------------|
| Express, zero-config | `src/index.js` imports `express` and default-exports the app |
| Node.js 22.x | `package.json` → `engines.node` (this overrides the dashboard setting) |
| Max duration 300 s | `src/index.js` → `export const config = { maxDuration: 300 }` |
| Chromium that runs on Vercel | `@sparticuz/chromium`. Vercel bundles it automatically; the function is about 75 MB, under the 250 MB limit. |
| Frontend | `public/`, served from Vercel's CDN |

Choose **one** of the two options below.

---

## Option A: GitHub and the Vercel dashboard (recommended)

### 1. Put the project on GitHub

Create an **empty** repository on GitHub, without a README or .gitignore. Then run this in the project folder:

```bash
git init
git add .
git commit -m "Perchance image generator"
git branch -M main
git remote add origin https://github.com/<your-user>/perchance-image-generator.git
git push -u origin main
```

`.gitignore` already keeps `node_modules/`, `.env` and `.vercel/` out of the repository.

> **No git installed?** On the new repository's page on GitHub, click **"uploading an existing file"**. Drag in the *contents* of the project folder, so that `package.json` sits at the top level of the repository.

### 2. Import the repository into Vercel

1. Go to <https://vercel.com/new> and sign in. Signing in with GitHub is easiest.
2. Find the repository and click **Import**.
3. On the configuration screen:
   - **Framework Preset:** `Express`. It is detected automatically; choose it by hand if the screen shows "Other".
   - **Root Directory:** `./`. Change it only if `package.json` is in a subfolder of the repository.
   - **Build and Output Settings:** leave them at their defaults. There is no build step.
   - **Environment Variables:** optional (see [Environment variables](#environment-variables)). Adding `API_KEY` now is recommended.
4. Click **Deploy**. The build takes about a minute.

You get a production URL such as `https://perchance-image-generator.vercel.app`. The project's overview page shows it.

After that, every push to `main` deploys to production automatically. Pushes to other branches create preview deployments.

---

## Option B: Vercel CLI (no GitHub needed)

This needs Node.js on your computer (22.17 or later recommended).

```bash
cd perchance-image-generator
npx vercel login          # opens the browser so you can sign in
npx vercel                # first run: creates the project and a preview deployment
npx vercel --prod         # deploys to production
```

Answers to the first-run prompts (the wording can differ slightly between CLI versions):

| Prompt | Answer |
|--------|--------|
| Set up and deploy? | **Yes** |
| Which scope? | your account or team |
| Link to existing project? | **No** |
| Project name | anything, for example `perchance-image-generator` |
| In which directory is your code located? | `./` |
| Want to modify these settings? | **No**. The detected settings should say *Express*. |

The CLI uploads the folder. `.vercelignore` keeps `.env*` files and `test/` out of the upload. Run `npx vercel --prod` again whenever you want to publish changes.

---

## Settings worth checking (Project → Settings)

| Setting | Where | What to do |
|---------|-------|------------|
| **Fluid compute** | Functions | It must be **on**, which is the default for new projects. Without it, Hobby functions are capped at 60 s and the build fails with *"maxDuration … between 1 and 60"*. |
| Node.js version | Build and Deployment | Nothing to do: `package.json` forces 22.x. |
| Function CPU (Pro only) | Functions → Advanced Settings | *Standard* (2 GB / 1 vCPU) is enough for one generation at a time. Choose *Performance* (4 GB / 2 vCPU) only if you raise `MAX_CONCURRENT_JOBS`. Hobby is fixed at 2 GB. |
| Max duration | in the code | 300 s is the Hobby maximum. On Pro you can raise `maxDuration` in `src/index.js` (up to 800) together with `GENERATION_TIMEOUT_MS`. |
| Deployment Protection | Deployment Protection | New projects put *preview* URLs behind a Vercel login. The production domain stays public. |

---

## Environment variables

Set them in **Project → Settings → Environment Variables**, or with `npx vercel env add NAME production`.

**Changes only apply to new deployments.** Redeploy afterwards, either from Deployments → ⋯ → Redeploy or with `npx vercel --prod`.

| Variable | When to set it | Example |
|----------|----------------|---------|
| `API_KEY` | **Recommended.** Every request runs a full Chromium for up to 5 minutes, so a public endpoint can use up your compute allowance quickly. When it is set, the web page shows a 🔑 field, and API callers must send `X-API-Key: <key>`. | the output of `openssl rand -hex 32` |
| `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD` | Only if Perchance blocks Vercel (see [Troubleshooting](#troubleshooting)). Use your proxy provider's **HTTP** endpoint, because Chromium does not support SOCKS proxies that need a password. | `http://gate.example-proxy.com:7000` |
| `BROWSER_WS_ENDPOINT` | An alternative to a proxy: the browser runs somewhere else (Browserless, Browserbase or your own machine). Set up that browser's proxy with the provider; `PROXY_SERVER` is not used in this mode. | `wss://…?token=…` |

All other variables (timeouts, concurrency, CORS and so on) have sensible defaults. See `.env.example`.

Without openssl you can generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

---

## Test the deployment

1. **Health check:** open `https://<your-app>.vercel.app/api/health`.
   You should see `"runtime":"vercel"`, `"browserMode":"serverless"` (or `"remote"` if `BROWSER_WS_ENDPOINT` is set), and a `node` version starting with `v22`.
2. **Web page:** open `https://<your-app>.vercel.app`, type a prompt, pick an Art Style and click Generate. The first request after a deploy is a cold start, so it takes a few seconds longer.
3. **API (macOS/Linux):**

   ```bash
   curl -s -X POST https://<your-app>.vercel.app/generator \
     -H 'Content-Type: application/json' \
     -H 'X-API-Key: <your key>' \
     -d '{"prompt":"a red fox in a snowy forest, golden hour","type":"Cinematic"}' \
     -o result.json
   head -c 200 result.json; echo
   ```

   Output beginning `{"success":true, … "count":4` means it works. Leave out the `X-API-Key` line if you did not set `API_KEY`.

Run these tests against the **production** domain. Preview URLs are behind a Vercel login by default, so curl gets Vercel's login page or a `401` instead of the app.

> `npm run smoke:live` runs on **your own computer**, so it tests your IP address, not Vercel's. To test Vercel, use the steps above.

---

## Troubleshooting

| What you see | Meaning | Fix |
|---|---|---|
| `502 ANTI_BOT_VERIFICATION_FAILED` or `502 CLOUDFLARE_CHALLENGE` | Perchance's Cloudflare / Turnstile check rejected Vercel's data-center IP. | Set `PROXY_SERVER` (a residential proxy) or `BROWSER_WS_ENDPOINT`, redeploy and test again. |
| The build fails with *"maxDuration … between 1 and 60"* | Fluid compute is off. | Turn it on under Settings → Functions, then redeploy. |
| A Vercel login page, or a `401` that is not JSON | You opened a protected preview URL. | Use the production domain, or change Settings → Deployment Protection. |
| `401 UNAUTHORIZED` (JSON) | `API_KEY` is set and the key is missing or wrong. | Enter it in the 🔑 field, or send the `X-API-Key` header. |
| `429 BUSY` | Another generation is already running on the same instance. | Retry when it finishes. |
| `504 GENERATION_TIMEOUT` | Perchance did not deliver 4 images within 240 s (`GENERATION_TIMEOUT_MS`). | Retry later. On Pro, raise `maxDuration` and `GENERATION_TIMEOUT_MS`. |
| Vercel's own `504 FUNCTION_INVOCATION_TIMEOUT` page | The function reached `maxDuration`. | Keep `GENERATION_TIMEOUT_MS` at least 30–60 s below `maxDuration`. |
| `500 BROWSER_LAUNCH_FAILED` | Chromium did not start, or the remote browser could not be reached. | Check the logs, confirm that `/api/health` shows Node `v22`, and check `BROWSER_WS_ENDPOINT` if it is set. |
| The logs show the function was killed or ran out of memory | It exceeded the 2 GB memory limit, most likely during repeated anti-bot failures. | Keep `MAX_CONCURRENT_JOBS=1`, lower `ANTI_BOT_GRACE_MS`, or use *Performance* (4 GB) on Pro. |

Runtime logs are under **Project → Logs** in the dashboard.

---

## Plans at a glance

| | Hobby (free) | Pro |
|---|---|---|
| Max duration | 300 s | 300 s default, up to 800 s |
| Memory / CPU | 2 GB / 1 vCPU (fixed) | 2 GB, or 4 GB / 2 vCPU |
| Allowed use | personal, non-commercial | commercial use allowed |

Vercel references: [Express on Vercel](https://vercel.com/docs/frameworks/backend/express) · [Function limits](https://vercel.com/docs/functions/limitations) · [Memory and CPU](https://vercel.com/docs/functions/configuring-functions/memory) · [Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
