// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './audioEngine';

function makeFakeStream(trackId: string): MediaStream {
  const track = { id: trackId, kind: 'audio', readyState: 'live' } as unknown as MediaStreamTrack;
  return {
    id: `stream-${trackId}`,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

describe('AudioEngine screen audio routing', () => {
  let origPlay: typeof HTMLMediaElement.prototype.play;
  let origPause: typeof HTMLMediaElement.prototype.pause;

  beforeEach(() => {
    document.body.innerHTML = '';
    origPlay = HTMLMediaElement.prototype.play;
    origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
  });

  afterEach(() => {
    HTMLMediaElement.prototype.play = origPlay;
    HTMLMediaElement.prototype.pause = origPause;
    document.body.innerHTML = '';
  });

  function createEngine() {
    const blockedStates: boolean[] = [];
    const engine = new AudioEngine({
      onSpeakingChange: () => {},
      onMicLevel: () => {},
      onAutoplayBlocked: (blocked) => blockedStates.push(blocked),
    });
    return { engine, blockedStates };
  }

  it('mounts screen audio in #squadvoice-audio-host and only unmutes the active stream user', () => {
    const { engine } = createEngine();

    engine.setScreenAudioStream('alice', makeFakeStream('track-a'));
    engine.setScreenAudioStream('bob', makeFakeStream('track-b'));

    const host = document.getElementById('squadvoice-audio-host');
    expect(host).not.toBeNull();
    const audios = Array.from(host!.querySelectorAll('audio'));
    expect(audios).toHaveLength(2);
    expect(audios[0].muted).toBe(true);
    expect(audios[1].muted).toBe(true);

    engine.setActiveScreenAudio('alice', 0.75, false);
    expect(audios[0].muted).toBe(false);
    expect(audios[0].volume).toBeCloseTo(0.75);
    expect(audios[1].muted).toBe(true);
    expect(audios[1].volume).toBe(0);

    engine.setActiveScreenAudio('bob', 0.5, false);
    expect(audios[0].muted).toBe(true);
    expect(audios[0].volume).toBe(0);
    expect(audios[1].muted).toBe(false);
    expect(audios[1].volume).toBeCloseTo(0.5);
  });

  it('respects deafened state on screen audio and restores volume on undeafen', () => {
    const { engine } = createEngine();

    engine.setScreenAudioStream('alice', makeFakeStream('track-a'));
    engine.setActiveScreenAudio('alice', 0.65, false);

    const audio = document.querySelector('#squadvoice-audio-host audio') as HTMLAudioElement;
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBeCloseTo(0.65);

    engine.setDeafened(true);
    expect(audio.muted).toBe(true);
    expect(audio.volume).toBe(0);

    engine.setDeafened(false);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBeCloseTo(0.65);
  });

  it('applies setOutputDevice via setSinkId to screen audio elements', async () => {
    const { engine } = createEngine();

    engine.setScreenAudioStream('alice', makeFakeStream('track-a'));
    const audio = document.querySelector('#squadvoice-audio-host audio') as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    audio.setSinkId = setSinkId;

    await engine.setOutputDevice('airpods-sink-1');
    expect(setSinkId).toHaveBeenCalledWith('airpods-sink-1');

    await engine.setOutputDevice('default');
    expect(setSinkId).toHaveBeenCalledWith('');
  });

  it('guards removeScreenAudio by trackId and cleans up on removePeer / destroyAll', () => {
    const { engine } = createEngine();

    engine.setScreenAudioStream('alice', makeFakeStream('track-old'));
    engine.setScreenAudioStream('alice', makeFakeStream('track-new'));
    expect(document.querySelectorAll('#squadvoice-audio-host audio')).toHaveLength(1);

    // Stale trackId from an old track ending must not remove the newer screen audio
    engine.removeScreenAudio('alice', 'track-old');
    expect(document.querySelectorAll('#squadvoice-audio-host audio')).toHaveLength(1);

    // Matching trackId removes it
    engine.removeScreenAudio('alice', 'track-new');
    expect(document.querySelectorAll('#squadvoice-audio-host audio')).toHaveLength(0);

    // removePeer also cleans up screen audio
    engine.setScreenAudioStream('alice', makeFakeStream('track-a'));
    engine.setScreenAudioStream('bob', makeFakeStream('track-b'));
    expect(document.querySelectorAll('#squadvoice-audio-host audio')).toHaveLength(2);

    engine.removePeer('alice');
    expect(document.querySelectorAll('#squadvoice-audio-host audio')).toHaveLength(1);

    engine.destroyAll();
    expect(document.querySelectorAll('#squadvoice-audio-host audio')).toHaveLength(0);
  });
});
