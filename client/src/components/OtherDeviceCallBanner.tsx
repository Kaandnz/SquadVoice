import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { firebaseBackend } from '../lib/firebaseBackend';
import { findCallOnOtherDevice } from '../lib/voiceSession';
import { useAppStore } from '../store/useAppStore';

/**
 * Shown when this account is in a voice room on another device/tab but not here,
 * with a one-click "move the call to this device" (like Discord's "join on this device").
 */
export function OtherDeviceCallBanner() {
  const { firebaseMode, user, voiceMembers, channels, activeVoiceChannelId, joinVoice } =
    useAppStore();
  const [moving, setMoving] = useState(false);

  if (!firebaseMode || !user) return null;
  const remote = findCallOnOtherDevice({
    voiceMembers,
    userId: user.id,
    mySessionId: firebaseBackend.sessionId(),
    inVoiceLocally: Boolean(activeVoiceChannelId),
  });
  if (!remote) return null;

  const roomName = channels.find((c) => c.id === remote.channel_id)?.name ?? 'bir ses odası';

  return (
    <div className="other-device-banner" role="status">
      <MonitorSmartphone size={16} className="accent-green" />
      <span>
        Başka bir cihazda ya da sekmede <strong>{roomName}</strong> odasındasın.
      </span>
      <button
        type="button"
        className="primary-btn small"
        disabled={moving}
        onClick={async () => {
          setMoving(true);
          try {
            await joinVoice(remote.channel_id);
          } finally {
            setMoving(false);
          }
        }}
      >
        {moving ? 'Aktarılıyor…' : 'Görüşmeyi bu cihaza al'}
      </button>
    </div>
  );
}
