import { describe, expect, it } from 'vitest';
import { detectDesktopOs, formatFileSize, parseDesktopRelease } from './desktopRelease';

describe('detectDesktopOs', () => {
  it('identifies Windows, macOS, Linux, and mobile user agents', () => {
    expect(
      detectDesktopOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Win32'),
    ).toBe('windows');
    expect(
      detectDesktopOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel'),
    ).toBe('macos');
    expect(
      detectDesktopOs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Linux x86_64'),
    ).toBe('linux');
    expect(
      detectDesktopOs('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone'),
    ).toBe('ios');
    expect(
      detectDesktopOs('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', 'Linux armv8l'),
    ).toBe('android');
  });
});

describe('parseDesktopRelease', () => {
  it('picks Windows exe/msi and prefers universal macOS dmg', () => {
    const parsed = parseDesktopRelease({
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/Kaandnz/SquadVoice/releases/tag/v0.2.0',
      published_at: '2026-11-27T10:00:00Z',
      assets: [
        {
          name: 'SquadVoice_0.2.0_x64-setup.exe',
          browser_download_url: 'https://example.com/win.exe',
          size: 11_500_000,
        },
        {
          name: 'SquadVoice_0.2.0_x64_en-US.msi',
          browser_download_url: 'https://example.com/win.msi',
          size: 12_100_000,
        },
        {
          name: 'SquadVoice_0.2.0_universal.dmg',
          browser_download_url: 'https://example.com/mac-universal.dmg',
          size: 15_200_000,
        },
      ],
    });

    expect(parsed.version).toBe('v0.2.0');
    expect(parsed.windowsExe?.url).toBe('https://example.com/win.exe');
    expect(parsed.windowsMsi?.url).toBe('https://example.com/win.msi');
    expect(parsed.macosDmg?.url).toBe('https://example.com/mac-universal.dmg');
    expect(parsed.macosDmgIntel).toBeNull();
  });

  it('exposes separate Intel dmg when only split macOS builds exist', () => {
    const parsed = parseDesktopRelease({
      tag_name: 'v0.1.0',
      assets: [
        {
          name: 'SquadVoice_0.1.0_aarch64.dmg',
          browser_download_url: 'https://example.com/mac-arm.dmg',
          size: 9_000_000,
        },
        {
          name: 'SquadVoice_0.1.0_x64.dmg',
          browser_download_url: 'https://example.com/mac-intel.dmg',
          size: 9_400_000,
        },
      ],
    });

    expect(parsed.macosDmg?.url).toBe('https://example.com/mac-arm.dmg');
    expect(parsed.macosDmgIntel?.url).toBe('https://example.com/mac-intel.dmg');
  });

  it('parses automated rolling latest release asset names', () => {
    const parsed = parseDesktopRelease({
      tag_name: 'latest',
      assets: [
        {
          name: 'SquadVoice-Windows-Setup.exe',
          browser_download_url: 'https://example.com/SquadVoice-Windows-Setup.exe',
          size: 10_400_000,
        },
        {
          name: 'SquadVoice-Windows.msi',
          browser_download_url: 'https://example.com/SquadVoice-Windows.msi',
          size: 11_100_000,
        },
        {
          name: 'SquadVoice-macOS-Universal.dmg',
          browser_download_url: 'https://example.com/SquadVoice-macOS-Universal.dmg',
          size: 14_800_000,
        },
        {
          name: 'SquadVoice-Android.apk',
          browser_download_url: 'https://example.com/SquadVoice-Android.apk',
          size: 4_800_000,
        },
      ],
    });

    expect(parsed.version).toBe('latest');
    expect(parsed.windowsExe?.name).toBe('SquadVoice-Windows-Setup.exe');
    expect(parsed.windowsMsi?.name).toBe('SquadVoice-Windows.msi');
    expect(parsed.macosDmg?.name).toBe('SquadVoice-macOS-Universal.dmg');
    expect(parsed.androidApk?.name).toBe('SquadVoice-Android.apk');
    expect(parsed.macosDmgIntel).toBeNull();
  });
});

describe('formatFileSize', () => {
  it('formats megabytes and kilobytes cleanly', () => {
    expect(formatFileSize(11_534_336)).toBe('11.0 MB');
    expect(formatFileSize(512_000)).toBe('500 KB');
    expect(formatFileSize(0)).toBe('');
  });
});
