/**
 * Text handling for retrieval (BUILD_PLAN 6.D), deterministic and unit-tested. PostgreSQL's text search has no Arabic
 * configuration, so keyword search runs on a normalized copy: diacritics and tatweel removed, alef/ya/ta marbuta
 * forms unified, Arabic-Indic digits folded to ASCII, Latin lower-cased, punctuation turned into spaces, and the
 * Arabic definite article stripped from words (light stemming). The same function normalizes queries.
 */
export function normalizeForSearch(text: string): string {
  return (
    text
      .normalize('NFKC')
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // harakat, superscript alef, Quranic marks
      .replace(/\u0640/g, '') // tatweel
      .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // alef forms → bare alef
      .replace(/\u0649/g, '\u064A') // alef maqsura → ya
      .replace(/\u0629/g, '\u0647') // ta marbuta → ha
      .replace(/\u0624/g, '\u0648') // waw with hamza → waw
      .replace(/\u0626/g, '\u064A') // ya with hamza → ya
      // Arabic-Indic and Eastern Arabic-Indic digits → ASCII digits.
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(' ')
      // Light stemming: the definite article, alone or after و ب ك ف (and لل), is not part of the word.
      .map((w) =>
        w.replace(/^(?:[\u0648\u0628\u0643\u0641]?\u0627\u0644|\u0644\u0644)(?=\p{L}{2,})/u, ''),
      )
      .join(' ')
  );
}

const SENTENCE = /(?<=[.!?؟。\n])\s+/u;

/**
 * Splits a document body into chunks of about `target` characters: paragraphs are kept whole when they fit, long ones
 * are cut at sentence boundaries, and each chunk after the first of a paragraph repeats the previous sentence so a
 * fact split across a boundary is still found.
 */
export function chunkText(body: string, target = 800): string[] {
  const paragraphs = body
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > target) {
      flush();
      const sentences = paragraph.split(SENTENCE).filter(Boolean);
      let piece = '';
      let previous = '';
      for (const sentence of sentences) {
        if (piece && piece.length + sentence.length + 1 > target) {
          chunks.push(piece.trim());
          piece = previous ? `${previous} ` : '';
        }
        piece += `${sentence} `;
        previous = sentence;
      }
      if (piece.trim()) chunks.push(piece.trim());
      continue;
    }
    if (current && current.length + paragraph.length + 2 > target) flush();
    current += current ? `\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

/** Reciprocal rank fusion (k = 60): combines rankings without comparing their raw scores. */
export function fuseRanks(rankings: ReadonlyArray<readonly string[]>, k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return scores;
}
