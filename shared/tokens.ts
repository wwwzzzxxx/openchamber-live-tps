/**
 * Token counting heuristics.
 *
 * Ported from `opencode-tps-meter` (MIT, ChiR24/opencode-tps-meter,
 * `src/tokenCounter.ts`), which in turn deliberately avoids a real tokenizer:
 * shipping a vocabulary per model family into a bundle that has to load inside
 * a sandboxed guest costs more than a small status readout is worth. The same
 * author's accuracy claims: `chars/4` ~75% on general text, `chars/3` ~70% on
 * code, `words/0.75` ~80% on English prose.
 *
 * Provider-reported token counts are always better than any of these and are
 * preferred whenever they arrive; see the service's `last` value.
 */

/** The algorithms upstream offers. `heuristic` is its default. */
export type TokenizerAlgorithm = 'heuristic' | 'word' | 'code';

export const CHARS_DIV_4 = 4;
export const CHARS_DIV_3 = 3;
export const WORDS_DIV_0_75 = 0.75;

export const countByChars = (text: string, divisor: number): number =>
  !text || text.length === 0 ? 0 : Math.ceil(text.length / divisor);

export const countByWords = (text: string, divisor: number): number => {
  if (!text || text.length === 0) return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.ceil(trimmed.split(/\s+/).length / divisor);
};

export const countTokens = (text: string, algorithm: TokenizerAlgorithm = 'heuristic'): number => {
  if (algorithm === 'word') return countByWords(text, WORDS_DIV_0_75);
  if (algorithm === 'code') return countByChars(text, CHARS_DIV_3);
  return countByChars(text, CHARS_DIV_4);
};

/**
 * The same heuristic applied to a running character total.
 *
 * The service counts characters as deltas arrive and only converts when it
 * reports, so it never holds the streamed text. `ceil` over the accumulated
 * count matches what upstream's incremental counter ends up at, because that
 * one also rounds the cumulative total and diffs it.
 */
export const tokensFromChars = (
  chars: number,
  algorithm: TokenizerAlgorithm = 'heuristic',
): number => {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / (algorithm === 'code' ? CHARS_DIV_3 : CHARS_DIV_4));
};
