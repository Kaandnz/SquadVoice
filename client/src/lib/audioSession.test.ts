import { describe, expect, it } from 'vitest';
import {
  enterCallAudioSession,
  leaveCallAudioSession,
  prepareAudioSessionForMic,
  type AudioSessionType,
} from './audioSession';

function createFakeNav(initial: AudioSessionType = 'auto') {
  const writes: AudioSessionType[] = [];
  let current: AudioSessionType = initial;
  const nav = {
    audioSession: {
      get type() {
        return current;
      },
      set type(next: AudioSessionType) {
        current = next;
        writes.push(next);
      },
    },
  };
  return { nav, writes, getCurrent: () => current };
}

describe('audioSession helpers', () => {
  it('follows the full call lifecycle: auto -> play-and-record -> playback -> auto', () => {
    const { nav, writes, getCurrent } = createFakeNav('playback');

    prepareAudioSessionForMic(nav);
    expect(getCurrent()).toBe('auto');

    enterCallAudioSession(nav);
    expect(getCurrent()).toBe('play-and-record');

    leaveCallAudioSession(nav);
    expect(getCurrent()).toBe('auto');

    expect(writes).toEqual(['auto', 'play-and-record', 'playback', 'auto']);
  });

  it('is a no-op when already in the target state or when audioSession is missing', () => {
    const fake = createFakeNav('auto');
    prepareAudioSessionForMic(fake.nav);
    leaveCallAudioSession(fake.nav);
    expect(fake.writes).toEqual([]);

    enterCallAudioSession(fake.nav);
    enterCallAudioSession(fake.nav);
    expect(fake.writes).toEqual(['play-and-record']);

    expect(() => prepareAudioSessionForMic({})).not.toThrow();
    expect(() => enterCallAudioSession(null)).not.toThrow();
    expect(() => leaveCallAudioSession({})).not.toThrow();
  });

  it('swallows errors when setting audioSession.type throws', () => {
    const throwingNav = {
      audioSession: {
        get type(): AudioSessionType {
          return 'play-and-record';
        },
        set type(_v: AudioSessionType) {
          throw new Error('Read-only in this context');
        },
      },
    };

    expect(() => prepareAudioSessionForMic(throwingNav)).not.toThrow();
    expect(() => enterCallAudioSession(throwingNav)).not.toThrow();
    expect(() => leaveCallAudioSession(throwingNav)).not.toThrow();
  });
});
