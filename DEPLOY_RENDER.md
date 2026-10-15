# Deploying to Render

The same app also runs on [Render](https://render.com) as a normal long-running Node.js server inside a Docker container. The Vercel setup keeps working unchanged (see `DEPLOY.md`).

| File | Purpose |
|------|---------|
| `Dockerfile` | `node:22-bookworm-slim`, plus Playwright's Chrome Headless Shell 153 and its system libraries. Runs as the non-root `node` user with `tini` as PID 1. |
| `.dockerignore` | Keeps the build context small. |
| `render.yaml` | Render Blueprint: one Docker web service, health check `/api/health`, a random `API_KEY`, and a 300 s graceful-shutdown window. |

---

## Can the free tier handle it? (measured)

Render's free web service has **0.1 CPU and 512 MB RAM** and spins down after 15 minutes without traffic ([Render docs](https://render.com/docs/free)). Chromium is the heavy part, so each Render plan was emulated with Linux cgroup limits (the same mechanism containers use) and tested two ways:

- **Mocked image API:** the real perchance.org page, generator and image embeds, with only Perchance's image API answered locally. This exercises everything except Perchance's anti-bot check.
- **Real Perchance:** no mocks, so Cloudflare Turnstile (Perchance's anti-bot check) runs inside the browser.

| Render plan | Mocked image API (4 images) | Real Perchance (anti-bot check) |
|---|---|---|
| **Free**: 0.1 CPU, 512 MB | ✅ about 58 s (73 s in the Docker image), peak 281–338 MiB | ❌ Turnstile **timed out** (error `110600`) after 256 s. Memory peaked at 503 of 512 MiB. |
| **0.5c-512mb** ($7/mo) | ✅ 9.4 s, peak 251 MiB | ❌ The browser **ran out of memory** after 50 s and the page crashed. |
| **1c-2g** ($25/mo) | ✅ 7.5 s, peak 275 MiB | ✅ The check **completed** in 67 s, peak 1.13 GB, no crash. |

On 1c-2g, Turnstile still rejected the test machine's data-center IP (`600010`), the same verdict as on an unlimited machine. Whether it accepts Render's IP addresses can only be tested on Render.

**Conclusion**

- On the **free** plan the app deploys and runs (frontend, API, browser automation), but it is **very unlikely to produce real images**. In testing, 0.1 CPU was too slow for Perchance's anti-bot check to finish, and every request starts a fresh browser that has to pass that check again.
- **512 MB** of memory is too little once the check runs at normal speed.
- **1c-2g (Standard, $25/mo)** is the smallest plan on which the check completes.
- To stay on the free plan, offload the browser: set `BROWSER_WS_ENDPOINT` to a remote browser service. The Render instance then runs only Express and the Playwright client, and the CPU- and memory-heavy Chromium runs at the provider.

---

## Deploy with the Blueprint (recommended)

You need a GitHub account and a Render account. The free plan needs no card. Render asks for card details when the Blueprint uses a paid plan, and occasionally as an anti-abuse check.

1. **Put the project on GitHub** (see `DEPLOY.md`, Option A, step 1). `render.yaml`, `Dockerfile` and `package.json` must be at the **top level** of the repository, not inside a subfolder.
2. In the [Render Dashboard](https://dashboard.render.com), click **New → Blueprint**.
3. Click **Connect** next to the repository. The first time, Render asks you to connect your GitHub account and choose which repositories it can see.
4. Enter any name for the Blueprint, keep the branch `main`, and leave **Blueprint Path** empty so Render uses `render.yaml`.
5. Render lists what it will create: one web service, `perchance-image-generator` (Docker, Free, Singapore). Click **Deploy Blueprint**.
6. Open the service and watch **Logs**. The first Docker build takes several minutes because it downloads Chromium. When the service shows **Live**, its URL is at the top of the page, for example `https://perchance-image-generator.onrender.com`. Render adds a suffix if the name is taken.
7. Go to **Environment** and copy the generated **`API_KEY`**. Paste it into the web page's 🔑 field, or send it as the `X-API-Key` header.

After that, every push to `main` redeploys automatically.

**Changing the plan:** edit `plan:` in `render.yaml` (`free`, `0.5c-512mb`, `1c-2g`, …) and push. **Settings → Instance Type** in the dashboard also works, but a dashboard change that conflicts with `render.yaml` is overwritten at the next Blueprint sync, so keep the file in step.

**Testing a paid plan cheaply:** paid compute is prorated by the second, so an hour on 1c-2g ($25/mo) costs a few cents. You can switch to it in the dashboard, try a few generations to see whether Perchance accepts Render's IP, and switch back to Free if it doesn't. If you keep the paid plan, also change `render.yaml`.

**Deleting the service:** first remove it from `render.yaml` and push (or delete the Blueprint), then delete the service. Otherwise the next Blueprint sync recreates it.

`region: singapore` is the closest region to the Philippines. Render cannot change a service's region after it is created, so edit it **before** the first deploy if you want another region.

## Deploy without the Blueprint

**New → Web Service**, connect the repository, then set:

- **Language:** Docker (the `Dockerfile` is detected)
- **Instance Type:** Free, or Standard (1 CPU / 2 GB) for real generation
- **Health Check Path:** `/api/health` (under Advanced)
- **Environment Variables:** `API_KEY` = a long random string

---

## Environment variables

The Docker image already sets `BROWSER_MODE=local`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, `CHROMIUM_EXTRA_ARGS=--disable-dev-shm-usage` and `PORT=10000`. Add the variables below in **Environment** when you need them; Render redeploys automatically.

| Variable | When |
|----------|------|
| `API_KEY` | Created by the Blueprint. It protects `/generator`. |
| `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD` | If Perchance rejects Render's IP (`ANTI_BOT_VERIFICATION_FAILED` with code `600010`). Use the provider's HTTP endpoint. |
| `BROWSER_WS_ENDPOINT` | To run the browser at a remote provider. This is the only way real generation can work on the free plan. Set up that browser's proxy at the provider. |
| `QUEUE_TIMEOUT_MS` | Default 60 s. A single instance runs one generation at a time, and extra requests wait this long before getting `429 BUSY`. |
| `GENERATION_TIMEOUT_MS` | Default 240 s. Render has no 300 s function limit (HTTP responses may take up to 100 minutes), so this may be raised. |
| `SHUTDOWN_TIMEOUT_MS` | Default 280 s. How long a stopping instance waits for in-flight generations. Keep it below `maxShutdownDelaySeconds` (300). |

---

## How the app behaves on Render

- **Long-running server:** `node src/index.js` listens on `PORT` (10000). It is the same Express app that Vercel runs as a function, and it stays stateless: every request gets a fresh browser profile.
- **Free-plan sleep:** after 15 idle minutes the service spins down. The next request waits about a minute for it to start, plus about 10 s for Node to boot on 0.1 CPU.
- **Zero-downtime deploys:** before replacing an instance, Render sends SIGTERM. The app stops accepting new connections, lets in-flight generations finish, then exits. Playwright's own SIGTERM handler, which would kill the browsers immediately, is switched off for this. Verified in the container: a request that was running when SIGTERM arrived still received its full response, and the process then exited with code 0.
- **One generation at a time** (`MAX_CONCURRENT_JOBS=1`). Raise it only on plans with enough memory, roughly 1.2 GB per concurrent job when the anti-bot check runs.

### Free-plan limits worth knowing

- 750 free instance hours per workspace per month. One free service running around the clock fits, and spun-down time doesn't count.
- The Hobby workspace includes 5 GB of outbound bandwidth per month. A 4-image response is roughly 0.5–1.5 MB. Without a payment method, Render suspends free services for the rest of the month once the bandwidth is used up.
- Render may restart a free service at any time. There is also no shell access, so `scripts/live-smoke.js` can't be run there.
- Render may suspend a free service that generates an unusually high volume of outbound traffic.

---

## Test the deployment

1. `https://<service>.onrender.com/api/health` should show `"runtime":"render"` and `"browserMode":"local"` (or `"remote"`).
2. Open the site, enter the API key in 🔑, and generate.
3. On paid instances you can test Perchance access from Render's own IP: open **Shell** and run `node scripts/live-smoke.js`. Exit code `0` means 4 images, `2` means blocked by the anti-bot check, `1` means another error.

| Result | Meaning | Fix |
|---|---|---|
| `502 ANTI_BOT_VERIFICATION_FAILED`, `turnstileErrorCode: 110600` | The anti-bot check **timed out**: not enough CPU (typical on the free plan). | Use 1c-2g, or `BROWSER_WS_ENDPOINT`. |
| `502 ANTI_BOT_VERIFICATION_FAILED`, `turnstileErrorCode: 600010` | The check finished and **rejected the IP**. | `PROXY_SERVER` (residential) or `BROWSER_WS_ENDPOINT`. |
| `500 INTERNAL_ERROR`: "page crashed" or "browser closed unexpectedly" | The browser **ran out of memory** (typical on 512 MB plans). | Use 1c-2g. |
| `429 BUSY` | Another generation is running. | Retry, or raise `QUEUE_TIMEOUT_MS`. |
| The first request takes over a minute | The free service was asleep. | Expected on the free plan. |

---

## Run the container yourself

```bash
docker build -t perchance-image-generator .
docker run --rm -p 10000:10000 -e API_KEY=change-me perchance-image-generator
# Emulate Render's free plan:
docker run --rm -p 10000:10000 --memory=512m --cpus=0.1 perchance-image-generator
# Demo mode (Perchance's image API mocked, no anti-bot check):
docker run --rm -p 10000:10000 perchance-image-generator node scripts/demo-mock-server.js
```

---

## Terms and commercial use

This is a summary of the published terms as of October 2026, not legal advice.

- **Render:** its [Terms of Service](https://render.com/terms) have no non-commercial clause, so commercial apps are allowed on any plan, including free. Vercel's Hobby plan is the opposite: personal, non-commercial use only. Render does say free instances are for testing and hobby projects ("Do not use them for production applications"). Its [Acceptable Use Policy](https://render.com/acceptable-use) forbids attempts to "bypass, circumvent, or defeat any access or usage restrictions, authentication, or security measures", which is worth keeping in mind before routing a browser around another site's anti-bot protection.
- **Perchance:** the [Terms of Service](https://perchance.org/terms-of-service) (updated July 18, 2026) let you use AI-generated images **commercially**, without attribution. The same terms also say you "will not access the Services through automated or non-human means, whether through a bot, script or otherwise". They also forbid circumventing security features and bypassing measures that restrict access. Automating the page with Playwright is exactly that kind of access, whichever host runs it. For a commercial product, the Perchance-compliant route is to build and monetize your own generator *on* Perchance (its terms explicitly allow that), or to switch the image source to an API that licenses commercial use.
