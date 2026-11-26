import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('parses bold, italic, inline code, mentions, and links safely', () => {
    const tokens = parseMarkdown(
      'Selam @kagan **oyun** *basladi* `ping` https://squadvoice-kaandnz.web.app',
    );
    expect(tokens).toEqual([
      { type: 'text', text: 'Selam ' },
      { type: 'mention', text: '@kagan' },
      { type: 'text', text: ' ' },
      { type: 'bold', text: 'oyun' },
      { type: 'text', text: ' ' },
      { type: 'italic', text: 'basladi' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'ping' },
      { type: 'text', text: ' ' },
      { type: 'link', url: 'https://squadvoice-kaandnz.web.app' },
    ]);
  });

  it('parses fenced code blocks alongside prose', () => {
    const tokens = parseMarkdown('Bak:\n```ts\nconst x = 1;\n```\ntamam');
    expect(tokens[0]).toEqual({ type: 'text', text: 'Bak:\n' });
    expect(tokens[1]).toEqual({ type: 'codeblock', lang: 'ts', text: 'const x = 1;' });
    expect(tokens[2]).toEqual({ type: 'text', text: '\ntamam' });
  });
});
