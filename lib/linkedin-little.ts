/**
 * LinkedIn's "little" text format — the Posts API `commentary` field.
 *
 * LinkedIn: "All reserved characters need to be escaped with a backslash,
 * even if those characters are not used in one of the supported elements or
 * templates." Reserved: | { } @ [ ] ( ) < > # \ * _ ~
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 *
 * Unescaped, ordinary punctuation — "(still warm)", "*", "_", "@" — is read as
 * markup, and the post is cut or garbled. Aura posts plain text, so every
 * reserved character is escaped, except `#` starting a word: that is
 * LinkedIn's hashtag element (`#coding`), and stays a live hashtag.
 *
 * Applied only to what is sent to LinkedIn; previews and the manual copy show
 * the text as written.
 */
const RESERVED = new Set(['|', '{', '}', '@', '[', ']', '(', ')', '<', '>', '#', '\\', '*', '_', '~']);

export function escapeLittleText(text: string): string {
  let out = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === '#' && /[\p{L}\p{N}]/u.test(chars[i + 1] ?? '')) {
      out += c; // a hashtag: #word
      continue;
    }
    out += RESERVED.has(c) ? `\\${c}` : c;
  }
  return out;
}
