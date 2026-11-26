export interface MicTrackInfo {
  readyState: MediaStreamTrackState;
  deviceId?: string;
  groupId?: string;
}

/**
 * Decides whether the call's mic must be re-opened after a `devicechange` event:
 * - the track ended (device unplugged, Bluetooth dropped)
 * - the chosen device is gone (fall back to the default one)
 * - we follow the system default and it now points at another device; Chrome does not
 *   move an open 'default' track, so plugging in a headset would otherwise be ignored
 */
export function shouldReacquireMic(input: {
  track: MicTrackInfo | null;
  selectedDeviceId: string;
  devices: Array<Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'groupId'>>;
}): boolean {
  const { track, selectedDeviceId, devices } = input;
  if (!track || track.readyState === 'ended') return true;

  const inputs = devices.filter((d) => d.kind === 'audioinput');
  // Labels/ids are hidden before permission; nothing reliable to compare then
  if (inputs.length === 0 || inputs.every((d) => !d.deviceId)) return false;

  if (selectedDeviceId && selectedDeviceId !== 'default') {
    return !inputs.some((d) => d.deviceId === selectedDeviceId);
  }

  const systemDefault = inputs.find((d) => d.deviceId === 'default');
  if (!systemDefault?.groupId || !track.groupId) return false;
  return systemDefault.groupId !== track.groupId;
}
