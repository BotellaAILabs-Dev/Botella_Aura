/**
 * Text chunking for the knowledge base. Targets ~500–1000 tokens per chunk
 * (~2000–4000 chars at ~4 chars/token). We split on paragraph boundaries and
 * accumulate up to the target so chunks stay semantically coherent rather than
 * cut mid-sentence.
 */
const TARGET_CHARS = 3200; // ~800 tokens
// Lowered so genuine-but-short brand copy (e.g. a JS site's meta/OG description)
// still becomes a usable chunk, while true noise fragments are dropped.
const MIN_CHUNK_CHARS = 80;

/** Rough token estimate (avoids a tokenizer dep for storage metadata). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function chunkText(input: string): string[] {
  const normalized = input.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length >= MIN_CHUNK_CHARS) chunks.push(trimmed);
    current = '';
  };

  for (const para of paragraphs) {
    // A single huge paragraph: hard-split by sentence to stay under target.
    if (para.length > TARGET_CHARS) {
      flush();
      for (const piece of splitLong(para)) chunks.push(piece);
      continue;
    }
    if (current.length + para.length + 2 > TARGET_CHARS) flush();
    current += (current ? '\n\n' : '') + para;
  }
  flush();
  return chunks;
}

function splitLong(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length + 1 > TARGET_CHARS) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    }
    cur += (cur ? ' ' : '') + s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
