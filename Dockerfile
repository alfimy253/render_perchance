# syntax=docker/dockerfile:1
#
# Container image for Render (render.yaml) or any Docker host.
# It runs the same Express app as on Vercel, as a normal long-running server, with
# Playwright's Chrome Headless Shell 153 (the build that playwright-core 1.63 expects).
#
#   docker build -t perchance-image-generator .
#   docker run --rm -p 10000:10000 perchance-image-generator     →  http://localhost:10000
#
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    BROWSER_MODE=local \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CHROMIUM_EXTRA_ARGS="--disable-dev-shm-usage"

WORKDIR /app

# tini runs as PID 1: it forwards SIGTERM to Node (graceful shutdown) and reaps exited
# Chromium child processes, so they don't pile up as zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first (cached between deploys unless package*.json changes):
# npm packages, then Chrome Headless Shell plus the system libraries it needs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright-core install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /tmp/*

COPY . .

# Never run the browser as root.
USER node

EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
