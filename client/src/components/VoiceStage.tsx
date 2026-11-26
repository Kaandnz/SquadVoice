import { useEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  HeadphoneOff,
  Headphones,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Music2,
  PhoneOff,
  RefreshCw,
  UserX,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import { canUseDisplayMedia } from '../lib/platform';
import { SOUNDBOARD_ITEMS } from '../lib/sounds';
import { useAppStore } from '../store/useAppStore';

interface VoiceStageProps {
  onOpenShareModal: () => void;
}

function CameraTileVideo({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => {});
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className="camera-tile-video"
    />
  );
}

export function VoiceStage({ onOpenShareModal }: VoiceStageProps) {
  const {
    firebaseMode,
    user,
    channels,
    activeTextChannelId,
    activeDmUserId,
    unreadByChannel,
    activeVoiceChannelId,
    voiceMembers,
    muted,
    forceMuted,
    deafened,
    needsAudioUnlock,
    peerVolumes,
    peerStats,
    localScreenStream,
    remoteScreenStreams,
    localCameraStream,
    remoteCameraStreams,
    focusedStreamUserId,
    turnEnabled,
    lastSoundboard,
    selectTextChannel,
    toggleMute,
    toggleDeafen,
    startCamera,
    stopCamera,
    stopScreenShare,
    leaveVoice,
    reconnectVoicePeers,
    playRoomSoundboard,
    setFocusedStreamUser,
    setPeerVolume,
    unlockAudio,
    adminForceMute,
    adminDisconnectVoice,
    adminMoveVoice,
  } = useAppStore();

  const [streamVolume, setStreamVolume] = useState(0.8);
  const [showSelfPreview, setShowSelfPreview] = useState(false);
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);

  const voiceChannel = channels.find((c) => c.id === activeVoiceChannelId);
  const voiceChannels = channels.filter((c) => c.kind === 'voice');
  const roomMembers = voiceMembers.filter((m) => m.channel_id === activeVoiceChannelId);

  const availableStreams: Array<{ id: string; label: string; stream: MediaStream }> = [];
  if (localScreenStream) {
    availableStreams.push({ id: 'self', label: 'Senin Ekranın', stream: localScreenStream });
  }
  for (const [uid, stream] of Object.entries(remoteScreenStreams)) {
    const member = roomMembers.find((m) => m.user_id === uid);
    availableStreams.push({
      id: uid,
      label: `${member?.display_name || 'Arkadaşın'} Ekranı`,
      stream,
    });
  }

  const activeStreamEntry =
    availableStreams.find((s) => s.id === focusedStreamUserId) || availableStreams[0] || null;
  const activeStream = activeStreamEntry?.stream ?? null;
  const activeStreamId = activeStreamEntry?.id ?? null;
  const isSelfStream = activeStreamId === 'self';
  const shouldRenderVideo = Boolean(activeStream && (!isSelfStream || showSelfPreview));

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (shouldRenderVideo && activeStream) {
      if (el.srcObject !== activeStream) {
        el.srcObject = activeStream;
        el.play().catch(() => {});
      }
    } else if (el.srcObject) {
      el.srcObject = null;
    }
  }, [activeStream, shouldRenderVideo]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = isSelfStream;
    el.volume = isSelfStream ? 0 : streamVolume;
  }, [streamVolume, isSelfStream, shouldRenderVideo]);

  if (!activeVoiceChannelId) {
    return null;
  }

  const focusedStats =
    activeStreamId && activeStreamId !== 'self' ? peerStats[activeStreamId] : null;

  const handleFullscreen = () => {
    const target = viewerRef.current;
    if (!target) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      target.requestFullscreen?.().catch(() => {});
    }
  };

  const soundMeta = lastSoundboard
    ? SOUNDBOARD_ITEMS.find((i) => i.id === lastSoundboard.sound)
    : null;
  const isVoiceChatOpen = !activeDmUserId && activeTextChannelId === activeVoiceChannelId;
  const roomUnread = unreadByChannel[activeVoiceChannelId] || 0;

  return (
    <section
      className="voice-stage"
      onClick={() => {
        if (needsAudioUnlock) unlockAudio().catch(() => {});
      }}
    >
      <div className="voice-stage-header">
        <div className="voice-stage-title">
          <Volume2 size={17} className="accent-green" />
          <span>{voiceChannel?.name || 'Ses Odası'}</span>
          <span className="badge-subtle">
            {turnEnabled ? 'P2P + TURN Hazır' : 'P2P Direct'}
          </span>
          {lastSoundboard && soundMeta && (
            <span className="soundboard-toast">
              {soundMeta.emoji} {lastSoundboard.display_name}: {soundMeta.label}
            </span>
          )}
        </div>

        <div className="voice-actions" style={{ position: 'relative' }}>
          <button
            type="button"
            className={`action-pill ${muted || forceMuted ? 'danger' : ''}`}
            onClick={toggleMute}
            title={forceMuted ? 'Yönetici susturdu' : undefined}
          >
            {muted || forceMuted ? <MicOff size={15} /> : <Mic size={15} />}
            <span>{forceMuted ? 'Sunucu Susturdu' : muted ? 'Sessiz' : 'Mikrofon'}</span>
          </button>

          <button
            type="button"
            className={`action-pill ${deafened ? 'danger' : ''}`}
            onClick={toggleDeafen}
          >
            {deafened ? <HeadphoneOff size={15} /> : <Headphones size={15} />}
            <span>{deafened ? 'Sağır' : 'Kulaklık'}</span>
          </button>

          {firebaseMode && (
            <button
              type="button"
              className={`action-pill ${localCameraStream ? 'primary' : ''}`}
              onClick={() => (localCameraStream ? stopCamera() : startCamera())}
            >
              {localCameraStream ? <VideoOff size={15} /> : <Video size={15} />}
              <span>{localCameraStream ? 'Kamerayı Kapat' : 'Kamera'}</span>
            </button>
          )}

          {localScreenStream ? (
            <button type="button" className="action-pill danger" onClick={stopScreenShare}>
              <MonitorOff size={15} />
              <span>Yayını Durdur</span>
            </button>
          ) : (
            <button
              type="button"
              className="action-pill primary"
              onClick={onOpenShareModal}
              disabled={!canUseDisplayMedia()}
              title={
                canUseDisplayMedia()
                  ? 'Ekran ve oyun paylaş'
                  : 'Bu mobil tarayıcı/webview ekran paylaşımını desteklemiyor'
              }
            >
              <Monitor size={15} />
              <span>Ekran Paylaş</span>
            </button>
          )}

          {firebaseMode && (
            <button
              type="button"
              className={`action-pill ${soundboardOpen ? 'primary' : ''}`}
              onClick={() => setSoundboardOpen((v) => !v)}
              title="Ses Tahtası (Soundboard)"
            >
              <Music2 size={15} />
              <span>Sesler</span>
            </button>
          )}

          <button
            type="button"
            className={`action-pill ${isVoiceChatOpen ? 'primary' : ''}`}
            onClick={() => selectTextChannel(activeVoiceChannelId)}
            title="Bu ses odasının özel sohbetini aç"
          >
            <MessageSquare size={15} />
            <span>Oda Sohbeti</span>
            {roomUnread > 0 && <span className="unread-badge">{roomUnread}</span>}
          </button>

          <button
            type="button"
            className="action-pill"
            onClick={reconnectVoicePeers}
            title="Ses bağlantısını sıfırla ve yeniden kur"
          >
            <RefreshCw size={14} />
          </button>

          <button type="button" className="action-pill danger" onClick={leaveVoice}>
            <PhoneOff size={15} />
            <span>Ayrıl</span>
          </button>

          {soundboardOpen && (
            <div className="soundboard-popover" onClick={(e) => e.stopPropagation()}>
              <div className="field-label" style={{ marginBottom: 6 }}>
                Oda Soundboard
              </div>
              <div className="soundboard-grid">
                {SOUNDBOARD_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="soundboard-btn"
                    onClick={() => {
                      playRoomSoundboard(item.id);
                      setSoundboardOpen(false);
                    }}
                  >
                    <span>{item.emoji}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {needsAudioUnlock && (
        <div className="audio-unlock-banner">
          <span>Telefon/tarayıcı ses oynatmayı bekliyor — duymak için dokun!</span>
          <button
            type="button"
            className="primary-btn small"
            onClick={(e) => {
              e.stopPropagation();
              unlockAudio();
            }}
          >
            Sesi Etkinleştir
          </button>
        </div>
      )}

      {activeStreamEntry && (
        <div className="stream-theater" ref={viewerRef}>
          <div className="stream-topbar">
            <div className="stream-tabs">
              {availableStreams.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={s.id === activeStreamEntry.id ? 'active' : ''}
                  onClick={() => setFocusedStreamUser(s.id)}
                >
                  <Monitor size={13} />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>

            <div className="stream-controls">
              {focusedStats && (
                <span className="stream-telemetry">
                  {focusedStats.videoResolution || 'Canlı'}
                  {focusedStats.videoFps ? ` • ${focusedStats.videoFps} FPS` : ''}
                  {focusedStats.videoKbps > 0
                    ? ` • ${(focusedStats.videoKbps / 1000).toFixed(1)} Mbps`
                    : ''}
                  {focusedStats.rttMs !== null ? ` • ${focusedStats.rttMs} ms` : ''}
                </span>
              )}
              {isSelfStream ? (
                <button
                  type="button"
                  className="secondary-btn small"
                  onClick={() => setShowSelfPreview((v) => !v)}
                >
                  {showSelfPreview ? <EyeOff size={13} /> : <Eye size={13} />}
                  <span>{showSelfPreview ? 'Önizlemeyi Gizle' : 'Önizlemeyi Göster'}</span>
                </button>
              ) : (
                <>
                  <label className="stream-vol" title="Yayın Sesi">
                    <Volume2 size={14} />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={streamVolume}
                      onChange={(e) => setStreamVolume(Number(e.target.value))}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-btn tiny"
                    title="Tam Ekran"
                    onClick={handleFullscreen}
                  >
                    <Maximize2 size={15} />
                  </button>
                </>
              )}
            </div>
          </div>

          {shouldRenderVideo ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              onLoadedMetadata={(e) => {
                e.currentTarget.play().catch(() => {});
              }}
              className="stream-video"
            />
          ) : (
            <div className="self-stream-placeholder">
              <Monitor size={18} className="accent-green" />
              <span>
                Ekranını paylaşıyorsun • Sonsuz ayna/titreşimi önlemek için yerel önizleme gizlendi.
              </span>
            </div>
          )}
        </div>
      )}

      <div className="participant-grid">
        {roomMembers.map((member) => {
          const isSelf = member.user_id === user?.id;
          const stats = peerStats[member.user_id];
          const vol = peerVolumes[member.user_id] ?? 1.0;
          const camStream = isSelf
            ? localCameraStream
            : remoteCameraStreams[member.user_id] || null;

          const iceConnected =
            stats?.iceState === 'connected' || stats?.iceState === 'completed';
          const iceFailed =
            stats?.iceState === 'failed' || stats?.iceState === 'disconnected';

          const pingClass = iceFailed
            ? 'bad'
            : !iceConnected
              ? 'warn'
              : stats?.rttMs !== null && stats?.rttMs !== undefined
                ? stats.rttMs < 50
                  ? 'good'
                  : stats.rttMs < 120
                    ? 'warn'
                    : 'bad'
                : 'good';

          const audioOk = Boolean(stats && (stats.audioKbps > 0 || stats.hasAudioTrack));
          const statusText = !stats
            ? 'Bağlanıyor...'
            : iceFailed
              ? turnEnabled
                ? 'Bağlantı Koptu'
                : 'Bağlanamadı (TURN Gerekli)'
              : !iceConnected
                ? 'El sıkışıyor...'
                : `${stats.rttMs !== null ? `${stats.rttMs} ms` : 'Bağlı'}${audioOk ? ' • Ses Aktif' : ''}${stats.usingRelay ? ' • TURN' : ''}`;

          return (
            <div
              key={member.user_id}
              className={`participant-card ${member.speaking ? 'speaking' : ''}`}
            >
              {camStream && <CameraTileVideo stream={camStream} muted />}

              <div className="participant-top">
                <span
                  className={`avatar-circle lg ${member.speaking ? 'speaking' : ''}`}
                  style={{ backgroundColor: member.avatar_color }}
                >
                  {member.avatar_url ? (
                    <img src={member.avatar_url} alt={member.display_name} />
                  ) : (
                    member.display_name.slice(0, 1).toUpperCase()
                  )}
                </span>
                <div className="participant-info">
                  <div className="participant-name">
                    {member.display_name}
                    {isSelf && <span className="you-tag">(Sen)</span>}
                  </div>
                  <div className="participant-status">
                    {member.screen_sharing && (
                      <button
                        type="button"
                        className="live-pill clickable"
                        onClick={() => {
                          const targetId = isSelf ? 'self' : member.user_id;
                          if (!isSelf && !remoteScreenStreams[member.user_id]) {
                            reconnectVoicePeers();
                          }
                          setFocusedStreamUser(targetId);
                        }}
                        title="Yayına odaklan / yenile"
                      >
                        <Monitor size={10} /> YAYIN
                      </button>
                    )}
                    {(member.muted || member.force_muted) && (
                      <MicOff size={13} className="muted-icon" />
                    )}
                    {member.deafened && <HeadphoneOff size={13} className="muted-icon" />}
                    {!isSelf && <span className={`ping-badge ${pingClass}`}>{statusText}</span>}
                  </div>
                </div>
              </div>

              {!isSelf && (
                <div className="participant-volume">
                  <Volume2 size={13} />
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={vol}
                    onChange={(e) => setPeerVolume(member.user_id, Number(e.target.value))}
                  />
                  <span>{Math.round(vol * 100)}%</span>
                </div>
              )}

              {firebaseMode && user?.role === 'admin' && !isSelf && (
                <div className="admin-voice-actions">
                  <button
                    type="button"
                    className={`mini-mod-btn ${member.force_muted ? 'active' : ''}`}
                    onClick={() => adminForceMute(member.user_id, !member.force_muted)}
                    title={member.force_muted ? 'Susturmayı Kaldır' : 'Sunucuda Sustur'}
                  >
                    <MicOff size={12} />
                    <span>{member.force_muted ? 'Aç' : 'Sustur'}</span>
                  </button>

                  {voiceChannels.length > 1 && (
                    <select
                      value={member.channel_id}
                      onChange={(e) => adminMoveVoice(member.user_id, e.target.value)}
                      className="mini-mod-select"
                      title="Başka ses kanalına taşı"
                    >
                      {voiceChannels.map((vc) => (
                        <option key={vc.id} value={vc.id}>
                          {vc.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    className="mini-mod-btn danger"
                    onClick={() => adminDisconnectVoice(member.user_id)}
                    title="Ses odasından at"
                  >
                    <UserX size={12} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
