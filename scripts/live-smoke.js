#!/usr/bin/env node
/**
 * Live smoke test against the REAL Perchance site (no mocks).
 *
 *   npm run smoke:live -- "a lighthouse in a storm" "Cinematic"
 *
 * Exit codes: 0 = 4 images generated · 2 = blocked by Perchance's anti-bot / Cloudflare
 * (environment/IP problem, not a code problem) · 1 = any other failure.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBrowserMode } from '../src/browser/launch.js';
import { generatePerchanceImages, parseDataUrl } from '../src/perchance/generator.js';
import { AppError } from '../src/utils/errors.js';
import { parseGeneratorInput } from '../src/utils/validate.js';

const [promptArg = 'a red fox sitting in a snowy forest, golden hour', typeArg = 'Cinematic'] = process.argv.slice(2);
const { prompt, type } = parseGeneratorInput({ prompt: promptArg, type: typeArg });
const outDir = join(tmpdir(), 'pig-live-output');

console.log(`Live smoke test · browser mode: ${resolveBrowserMode()} · type: ${type}\nprompt: ${prompt}\n`);
const started = Date.now();
try {
  const result = await generatePerchanceImages({
    prompt,
    type,
    log: (event, data) =>
      console.log(
        `  ${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${event}`,
        data ? JSON.stringify(data) : '',
      ),
  });
  await mkdir(outDir, { recursive: true });
  for (const img of result.images) {
    const file = join(outDir, `live-${img.index}.${img.extension}`);
    await writeFile(file, Buffer.from(parseDataUrl(img.dataUrl).base64, 'base64'));
    console.log(`  ✔ image ${img.index}: ${img.mimeType}, ${img.sizeBytes} bytes, seed ${img.seed} → ${file}`);
  }
  console.log(`\nSUCCESS – ${result.images.length} images in ${result.timings.totalMs} ms`, result.timings);
  process.exit(0);
} catch (err) {
  const e = err instanceof AppError ? err : new AppError('INTERNAL_ERROR', String(err?.message || err));
  const details = e.details ? { ...e.details, partialImages: e.details.partialImages?.length } : undefined;
  console.log(`\nFAILED after ${Date.now() - started} ms → ${e.code} (HTTP ${e.status})\n  ${e.message}`);
  if (e.hint) console.log(`  hint: ${e.hint}`);
  if (details) console.log('  details:', JSON.stringify(details, null, 2).slice(0, 1200));
  process.exit(['ANTI_BOT_VERIFICATION_FAILED', 'CLOUDFLARE_CHALLENGE'].includes(e.code) ? 2 : 1);
}
