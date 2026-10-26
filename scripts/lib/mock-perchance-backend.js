/**
 * TEST/DEMO ONLY – a stand-in for Perchance's image backend (https://image-generation.perchance.org/api/*).
 *
 * The real Perchance page, generator iframe and image-embed iframes are still loaded from
 * perchance.org and run their own JavaScript. Only the embed's API calls are answered locally:
 *
 *   /api/verifyUser                   → { status: "success", userKey: <64 hex> }   (skips Turnstile)
 *   /api/checkUserVerificationStatus  → { status: "verified" }
 *   /api/generate (POST)              → { status: "success", imageId: sha256(bytes), fileExtension, seed, prompt, … }
 *   /api/downloadTemporaryImage       → the image bytes (SVG placeholder showing the final prompt)
 *
 * This exercises 100% of our Playwright automation (frame discovery, prompt entry, Art Style +
 * "How many?" selection, generate click, collecting 2 results) without Perchance's anti-bot check.
 */
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const ORIGIN = 'https://image-generation.perchance.org';

export function createMockPerchanceBackend({ delayMs = 1200 } = {}) {
  /** Every POST body Perchance sent to /api/generate (prompt, negativePrompt, resolution, …). */
  const generateBodies = [];
  const images = new Map();
  const calls = {};
  let counter = 0;

  async function onContext(context) {
    await context.route(`${ORIGIN}/api/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const name = url.pathname.replace(/^\/api\//, '');
      calls[name] = (calls[name] || 0) + 1;

      switch (name) {
        case 'verifyUser':
          return route.fulfill({ json: { status: 'success', userKey: randomBytes(32).toString('hex') } });

        case 'checkUserVerificationStatus':
          return route.fulfill({ json: { status: 'verified' } });

        case 'generate': {
          let body = {};
          try {
            body = JSON.parse(request.postData() || '{}');
          } catch {
            // keep {}
          }
          generateBodies.push(body);
          counter += 1;
          const index = counter;
          const seed =
            Number.isFinite(Number(body.seed)) && Number(body.seed) >= 0 ? Number(body.seed) : 100000 + index * 7919;
          const bytes = Buffer.from(
            renderPlaceholderSvg({ index, seed, prompt: body.prompt, resolution: body.resolution }),
          );
          const imageId = createHash('sha256').update(bytes).digest('hex');
          images.set(imageId, bytes);
          await sleep(delayMs + Math.round(Math.random() * 400));
          return route.fulfill({
            json: {
              status: 'success',
              imageId,
              fileExtension: 'svg+xml',
              seed,
              prompt: body.prompt ?? '',
              negativePrompt: body.negativePrompt ?? '',
              guidanceScale: body.guidanceScale ?? 7,
              maybeNsfw: false,
            },
          });
        }

        case 'downloadTemporaryImage': {
          const bytes = images.get(url.searchParams.get('imageId') || '');
          if (!bytes) return route.fulfill({ status: 404, body: 'not found' });
          return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: bytes });
        }

        default:
          // Queue polling, telemetry, etc. – nothing to do.
          return route.fulfill({ json: {} });
      }
    });
  }

  return {
    onContext,
    generateBodies,
    calls,
    get generatedCount() {
      return counter;
    },
  };
}

function renderPlaceholderSvg({ index, seed, prompt = '', resolution = '768x768' }) {
  const [w, h] = String(resolution || '768x768')
    .split('x')
    .map((n) => Number.parseInt(n, 10) || 768);
  const hue = (index * 67 + (seed % 360)) % 360;
  const lines = wrap(String(prompt).replace(/\s+/g, ' ').trim(), Math.max(24, Math.round(w / 17))).slice(0, 14);
  const text = lines.map((line, i) => `<tspan x="48" dy="${i === 0 ? 0 : 34}">${escapeXml(line)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},70%,38%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 80) % 360},75%,22%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${w - 120}" cy="120" r="70" fill="rgba(255,255,255,0.12)"/>
  <text x="48" y="96" font-family="Arial, Helvetica, sans-serif" font-size="56" font-weight="700" fill="#fff">MOCK #${index}</text>
  <text x="48" y="140" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="rgba(255,255,255,0.8)">final prompt Perchance sent to its image API:</text>
  <text x="48" y="196" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#fff">${text}</text>
  <text x="48" y="${h - 40}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="rgba(255,255,255,0.75)">${escapeXml(`${w}×${h} · seed ${seed} · image API mocked`)}</text>
</svg>`;
}

function wrap(text, width) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      if (line) lines.push(line);
      line = word.length > width ? word.slice(0, width) : word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

function escapeXml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
}
