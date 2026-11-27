import { describe, expect, it } from 'vitest';
import {
  buildInviteLink,
  extractInviteCode,
  generateInviteCode,
  publicAppOrigin,
  readInviteCode,
  stripInviteParam,
} from './invite';

describe('invite links', () => {
  it('round-trips a code through a link', () => {
    const link = buildInviteLink('https://squad.web.app/', 'SQUAD-AB12');
    expect(link).toBe('https://squad.web.app/?davet=SQUAD-AB12');
    expect(readInviteCode(new URL(link).search)).toBe('SQUAD-AB12');
  });

  it('encodes unusual characters safely', () => {
    const link = buildInviteLink('https://x.app', 'a&b=c');
    expect(readInviteCode(new URL(link).search)).toBe('a&b=c');
  });

  it('ignores missing, blank, oversized or spaced codes', () => {
    expect(readInviteCode('')).toBeNull();
    expect(readInviteCode('?davet=')).toBeNull();
    expect(readInviteCode(`?davet=${'x'.repeat(65)}`)).toBeNull();
    expect(readInviteCode('?davet=a%20b')).toBeNull();
    expect(readInviteCode('?other=1')).toBeNull();
  });

  it('removes only the invite parameter from the address', () => {
    expect(stripInviteParam('https://x.app/?davet=CODE')).toBe('/');
    expect(stripInviteParam('https://x.app/?a=1&davet=CODE#top')).toBe('/?a=1#top');
  });

  it('uses the page origin on the web and Firebase Hosting in the desktop app', () => {
    expect(publicAppOrigin({ protocol: 'https:', origin: 'https://squad.web.app' }, 'x')).toBe(
      'https://squad.web.app',
    );
    expect(publicAppOrigin({ protocol: 'tauri:', origin: 'tauri://localhost' }, 'p.firebaseapp.com')).toBe(
      'https://p.firebaseapp.com',
    );
    expect(publicAppOrigin({ protocol: 'tauri:', origin: 'tauri://localhost' }, undefined)).toBeNull();
  });

  it('extracts invite codes from both full URLs and plain code strings', () => {
    expect(extractInviteCode('https://squad.web.app/?davet=SQUAD-ABCD1234')).toBe('SQUAD-ABCD1234');
    expect(extractInviteCode('?davet=SQUAD-9999')).toBe('SQUAD-9999');
    expect(extractInviteCode('  SQUAD-RAW123  ')).toBe('SQUAD-RAW123');
    expect(extractInviteCode('bad code with spaces')).toBeNull();
    expect(extractInviteCode('')).toBeNull();
  });

  it('generates valid prefixed invite codes', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^SQUAD-[A-Z0-9]{8}$/);
  });
});
