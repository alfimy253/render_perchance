import { config } from '../config.js';
import { ART_STYLES, DEFAULT_ART_STYLE } from '../perchance/art-styles.js';
import { AppError } from './errors.js';

/** Unicode-aware comparison key: "𝗡𝗼 𝘀𝘁𝘆𝗹𝗲" → "no style", "  cinematic " → "cinematic". */
export function normalizeLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const BY_NORMALIZED = new Map(ART_STYLES.map((label) => [normalizeLabel(label), label]));

/**
 * Maps user input to the canonical Perchance label.
 * Exact match first, then a case/Unicode-insensitive match. Returns null when unknown.
 */
export function resolveArtStyle(input) {
  if (typeof input !== 'string') return null;
  if (ART_STYLES.includes(input)) return input;
  return BY_NORMALIZED.get(normalizeLabel(input)) ?? null;
}

/**
 * Validates the /generator input (JSON body or query string).
 * Accepted aliases: type | artStyle | style.
 * @returns {{ prompt: string, type: string }}
 */
export function parseGeneratorInput(source = {}) {
  const raw = source && typeof source === 'object' ? source : {};

  const promptValue = Array.isArray(raw.prompt) ? raw.prompt[0] : raw.prompt;
  if (typeof promptValue !== 'string' || !promptValue.trim()) {
    throw new AppError('INVALID_PROMPT', 'Field "prompt" is required and must be a non-empty string.');
  }
  // Keep the user's wording; only normalise line endings and trim the ends.
  const prompt = promptValue.replace(/\r\n?/g, '\n').trim();
  if (prompt.length > config.maxPromptLength) {
    throw new AppError('INVALID_PROMPT', `Field "prompt" must be at most ${config.maxPromptLength} characters.`, {
      details: { length: prompt.length, max: config.maxPromptLength },
    });
  }

  const typeValue = [raw.type, raw.artStyle, raw.style]
    .map((v) => (Array.isArray(v) ? v[0] : v))
    .find((v) => v !== undefined && v !== null && String(v).trim() !== '');

  if (typeValue === undefined) return { prompt, type: DEFAULT_ART_STYLE };

  const type = resolveArtStyle(String(typeValue));
  if (!type) {
    throw new AppError('INVALID_TYPE', `Unknown type "${String(typeValue).slice(0, 80)}".`, {
      details: { allowed: ART_STYLES },
      hint: 'GET /api/types returns every allowed value (identical to Perchance\'s "Art Style" dropdown).',
    });
  }
  return { prompt, type };
}
