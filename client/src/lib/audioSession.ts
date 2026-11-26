export type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

export interface AudioSessionLike {
  type: AudioSessionType;
}

function getAudioSession(nav?: unknown): AudioSessionLike | null {
  const source = nav !== undefined ? nav : typeof navigator !== 'undefined' ? navigator : undefined;
  if (!source || typeof source !== 'object') return null;
  const session = (source as { audioSession?: unknown }).audioSession;
  if (!session || typeof session !== 'object') return null;
  if (!('type' in session)) return null;
  return session as AudioSessionLike;
}

/**
 * Resets Safari's audioSession before opening a microphone stream so iOS does not lock
 * onto the handset mic / speaker from a stale session state.
 */
export function prepareAudioSessionForMic(nav?: unknown): void {
  const session = getAudioSession(nav);
  if (!session) return;
  try {
    if (session.type !== 'auto') {
      session.type = 'auto';
    }
  } catch {
    // Ignore unsupported or read-only audioSession implementations
  }
}

/**
 * Kicks iOS Safari into 'play-and-record' after getUserMedia succeeds so AirPods /
 * Bluetooth routes stay active for both mic input and remote voice/stream output.
 */
export function enterCallAudioSession(nav?: unknown): void {
  const session = getAudioSession(nav);
  if (!session) return;
  try {
    if (session.type !== 'play-and-record') {
      session.type = 'play-and-record';
    }
  } catch {
    // Ignore unsupported or read-only audioSession implementations
  }
}

/**
 * Steps iOS Safari out of 'play-and-record' once the mic is released so subsequent
 * media playback recovers full-bandwidth A2DP quality instead of staying in HFP.
 */
export function leaveCallAudioSession(nav?: unknown): void {
  const session = getAudioSession(nav);
  if (!session) return;
  try {
    if (session.type === 'play-and-record') {
      session.type = 'playback';
      session.type = 'auto';
    }
  } catch {
    // Ignore unsupported or read-only audioSession implementations
  }
}
