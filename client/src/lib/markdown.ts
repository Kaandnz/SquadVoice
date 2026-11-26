export type MarkdownToken =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'codeblock'; lang: string; text: string }
  | { type: 'mention'; text: string }
  | { type: 'link'; url: string };

const BLOCK_REGEX = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
const INLINE_REGEX =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|https?:\/\/[^\s<]+|@[a-zA-Z0-9_.-]{2,24})/g;

export function parseMarkdown(input: string): MarkdownToken[] {
  if (!input) return [];

  const tokens: MarkdownToken[] = [];
  let cursor = 0;

  for (const match of input.matchAll(BLOCK_REGEX)) {
    const idx = match.index ?? 0;
    if (idx > cursor) {
      tokens.push(...parseInline(input.slice(cursor, idx)));
    }
    tokens.push({
      type: 'codeblock',
      lang: (match[1] || '').trim(),
      text: match[2].replace(/\n$/, ''),
    });
    cursor = idx + match[0].length;
  }

  if (cursor < input.length) {
    tokens.push(...parseInline(input.slice(cursor)));
  }

  return tokens;
}

function parseInline(chunk: string): MarkdownToken[] {
  const out: MarkdownToken[] = [];
  let last = 0;

  for (const match of chunk.matchAll(INLINE_REGEX)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      out.push({ type: 'text', text: chunk.slice(last, idx) });
    }
    const raw = match[0];
    if (raw.startsWith('`') && raw.endsWith('`')) {
      out.push({ type: 'code', text: raw.slice(1, -1) });
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      out.push({ type: 'bold', text: raw.slice(2, -2) });
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      out.push({ type: 'italic', text: raw.slice(1, -1) });
    } else if (raw.startsWith('@')) {
      out.push({ type: 'mention', text: raw });
    } else if (/^https?:\/\//i.test(raw)) {
      out.push({ type: 'link', url: raw });
    } else {
      out.push({ type: 'text', text: raw });
    }
    last = idx + raw.length;
  }

  if (last < chunk.length) {
    out.push({ type: 'text', text: chunk.slice(last) });
  }
  return out;
}
