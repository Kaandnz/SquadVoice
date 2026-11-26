import { describe, expect, it } from 'vitest';
import { shouldReacquireMic } from './micDevices';

const laptopMic = { kind: 'audioinput' as const, deviceId: 'laptop', groupId: 'g-laptop' };
const headsetMic = { kind: 'audioinput' as const, deviceId: 'headset', groupId: 'g-headset' };
const speakers = { kind: 'audiooutput' as const, deviceId: 'spk', groupId: 'g-spk' };
const defaultIs = (groupId: string) => ({
  kind: 'audioinput' as const,
  deviceId: 'default',
  groupId,
});

describe('shouldReacquireMic', () => {
  it('re-opens when the mic track ended or never existed', () => {
    expect(
      shouldReacquireMic({ track: null, selectedDeviceId: 'default', devices: [laptopMic] }),
    ).toBe(true);
    expect(
      shouldReacquireMic({
        track: { readyState: 'ended', groupId: 'g-laptop' },
        selectedDeviceId: 'default',
        devices: [laptopMic],
      }),
    ).toBe(true);
  });

  it('follows the system default when a headset is plugged in', () => {
    expect(
      shouldReacquireMic({
        track: { readyState: 'live', groupId: 'g-laptop' },
        selectedDeviceId: 'default',
        devices: [defaultIs('g-headset'), laptopMic, headsetMic, speakers],
      }),
    ).toBe(true);
  });

  it('ignores unrelated changes such as a new output device', () => {
    expect(
      shouldReacquireMic({
        track: { readyState: 'live', groupId: 'g-laptop' },
        selectedDeviceId: 'default',
        devices: [defaultIs('g-laptop'), laptopMic, speakers],
      }),
    ).toBe(false);
  });

  it('keeps a chosen mic while it is present and falls back when it is removed', () => {
    const track = { readyState: 'live' as const, deviceId: 'headset', groupId: 'g-headset' };
    expect(
      shouldReacquireMic({
        track,
        selectedDeviceId: 'headset',
        devices: [defaultIs('g-laptop'), laptopMic, headsetMic],
      }),
    ).toBe(false);
    expect(
      shouldReacquireMic({
        track,
        selectedDeviceId: 'headset',
        devices: [defaultIs('g-laptop'), laptopMic],
      }),
    ).toBe(true);
  });

  it('does nothing when device ids are hidden (no permission yet)', () => {
    expect(
      shouldReacquireMic({
        track: { readyState: 'live', groupId: 'g-laptop' },
        selectedDeviceId: 'default',
        devices: [{ kind: 'audioinput', deviceId: '', groupId: '' }],
      }),
    ).toBe(false);
  });
});
