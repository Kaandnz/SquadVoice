import {
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  ChevronsUp,
  ChevronUp,
  Eye,
  EyeOff,
  HeadphoneOff,
  Headphones,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  Music2,
  PhoneOff,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Upload,
  UserX,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { canUseDisplayMedia } from '../lib/platform';
import { ConnectionDetails } from './ConnectionDetails';
import {
  playSoundboard,
  readCustomAudioFile,
  SOUNDBOARD_ITEMS,
  stopAllSoundboard,
} from '../lib/sounds';
import {
  clampPan,
  clampZoom,
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  touchDistance,
  zoomStep,
} from '../lib/streamZoom';
import { useAppStore } from '../store/useAppStore';

interface VoiceStageProps {
  onOpenShareModal: () => void;
}

const STAGE_COLLAPSED_KEY = 'squadvoice.voiceStageCollapsed';

function readStageCollapsed(): boolean {
  try {
    return localStorage.getItem(STAGE_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStageCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(STAGE_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Private mode / storage full: the toggle still works for this visit
  }
}

function isOverlayTarget(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.('[data-overlay-control]'));
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
    peerQualityHistory,
    localScreenStream,
    remoteScreenStreams,
    localCameraStream,
    remoteCameraStreams,
    focusedStreamUserId,
    turnEnabled,
    wsStatus,
    audioSettings,
    lastSoundboard,
    customSounds,
    selectTextChannel,
    toggleMute,
    toggleDeafen,
    startCamera,
    stopCamera,
    stopScreenShare,
    leaveVoice,
    reconnectVoicePeers,
    playRoomSoundboard,
    addCustomSound,
    deleteCustomSound,
    updateAudioSettings,
    setFocusedStreamUser,
    setScreenAudioConfig,
    setPeerVolume,
    unlockAudio,
    adminForceMute,
    adminDisconnectVoice,
    adminMoveVoice,
  } = useAppStore();

  const [streamVolume, setStreamVolume] = useState(0.8);
  const [streamMuted, setStreamMuted] = useState(false);
  const [showSelfPreview, setShowSelfPreview] = useState(false);
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const [soundTab, setSoundTab] = useState<'all' | 'meme' | 'tepki' | 'efekt' | 'custom'>('all');
  const [addingSound, setAddingSound] = useState(false);
  const [newSoundLabel, setNewSoundLabel] = useState('');
  const [newSoundEmoji, setNewSoundEmoji] = useState('🔊');
  const [newSoundDataUrl, setNewSoundDataUrl] = useState<string | null>(null);
  const [newSoundFileName, setNewSoundFileName] = useState<string>('');
  const [soundUploadErr, setSoundUploadErr] = useState<string | null>(null);
  const [soundUploadBusy, setSoundUploadBusy] = useState(false);
  const soundFileRef = useRef<HTMLInputElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [expandedStatsUserId, setExpandedStatsUserId] = useState<string | null>(null);
  // Phones have little height: the whole stage can shrink to one bar, and a stream can be
  // tucked away on its own. Remembered per device.
  const [stageCollapsed, setStageCollapsed] = useState(readStageCollapsed);
  // Id of the stream the user hid; a different stream showing up is visible again
  const [hiddenStreamKey, setHiddenStreamKey] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const nativeFsRef = useRef(false);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const movedRef = useRef(false);
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<number | null>(null);
  const pinchRef = useRef<{
    startDist: number;
    startZoom: number;
    startPan: { x: number; y: number };
    startMidX: number;
    startMidY: number;
  } | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startPan: { x: number; y: number };
  } | null>(null);

  zoomRef.current = zoom;
  panRef.current = pan;

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
  const videoOnlyStream = useMemo(() => {
    if (!activeStream) return null;
    if (activeStream.getAudioTracks().length === 0) return activeStream;
    return new MediaStream(activeStream.getVideoTracks());
  }, [activeStream]);
  const shouldRenderVideo = Boolean(activeStream && (!isSelfStream || showSelfPreview));
  const streamKey = activeStream ? `${activeStreamId}:${activeStream.id}` : null;
  const streamHidden = Boolean(streamKey && hiddenStreamKey === streamKey);
  const streamers = roomMembers.filter((m) => m.screen_sharing);

  const toggleStage = () => {
    const next = !stageCollapsed;
    writeStageCollapsed(next);
    setStageCollapsed(next);
  };

  const applyZoom = (nextZoom: number) => {
    const clamped = clampZoom(nextZoom);
    setZoom(clamped);
    if (clamped <= MIN_ZOOM) {
      setPan({ x: 0, y: 0 });
      return;
    }
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) {
      setPan(clampPan(panRef.current, clamped, rect.width, rect.height));
    }
  };

  useEffect(() => {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
    setControlsVisible(true);
    if (!activeStreamId) {
      setIsFullscreen(false);
    }
  }, [activeStreamId]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && nativeFsRef.current) {
        nativeFsRef.current = false;
        setIsFullscreen(false);
        setZoom(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
        setControlsVisible(true);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        nativeFsRef.current = false;
        setIsFullscreen(false);
        setZoom(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
        setControlsVisible(true);
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = true;
    if (shouldRenderVideo && videoOnlyStream) {
      if (el.srcObject !== videoOnlyStream) {
        el.srcObject = videoOnlyStream;
        el.play().catch(() => {});
      }
    } else if (el.srcObject) {
      el.srcObject = null;
    }
  }, [videoOnlyStream, shouldRenderVideo]);

  const remoteActiveStreamId = activeStreamId && !isSelfStream ? activeStreamId : null;
  useEffect(() => {
    setScreenAudioConfig(remoteActiveStreamId, streamVolume, streamMuted);
  }, [remoteActiveStreamId, streamVolume, streamMuted, setScreenAudioConfig]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !shouldRenderVideo) return;
    const onWheel = (e: WheelEvent) => {
      if (!isFullscreen && zoomRef.current <= MIN_ZOOM && !e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      const clamped = zoomStep(zoomRef.current, delta);
      setZoom(clamped);
      if (clamped <= MIN_ZOOM) {
        setPan({ x: 0, y: 0 });
      } else {
        const rect = el.getBoundingClientRect();
        setPan(clampPan(panRef.current, clamped, rect.width, rect.height));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isFullscreen, shouldRenderVideo]);

  if (!activeVoiceChannelId) {
    return null;
  }

  const toggleFullscreen = () => {
    if (!isFullscreen) {
      setIsFullscreen(true);
      setControlsVisible(true);
      const target = viewerRef.current;
      if (target?.requestFullscreen) {
        target
          .requestFullscreen()
          .then(() => {
            nativeFsRef.current = true;
          })
          .catch(() => {});
      }
    } else {
      nativeFsRef.current = false;
      setIsFullscreen(false);
      setZoom(MIN_ZOOM);
      setPan({ x: 0, y: 0 });
      setControlsVisible(true);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }
  };

  const handleTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (!shouldRenderVideo || isOverlayTarget(e.target)) return;
    if (e.touches.length === 2) {
      if (tapTimerRef.current !== null) {
        window.clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      movedRef.current = true;
      dragRef.current = null;
      pinchRef.current = {
        startDist: touchDistance(e.touches[0], e.touches[1]),
        startZoom: zoomRef.current,
        startPan: panRef.current,
        startMidX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        startMidY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    } else if (e.touches.length === 1) {
      movedRef.current = false;
      pinchRef.current = null;
      dragRef.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startPan: panRef.current,
      };
    }
  };

  const handleTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (!shouldRenderVideo) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (e.touches.length === 2 && pinchRef.current) {
      movedRef.current = true;
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const nextZoom = clampZoom(
        pinchRef.current.startZoom * (dist / Math.max(10, pinchRef.current.startDist)),
      );
      setZoom(nextZoom);
      if (nextZoom <= MIN_ZOOM || !rect) {
        setPan({ x: 0, y: 0 });
      } else {
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        setPan(
          clampPan(
            {
              x: pinchRef.current.startPan.x + (midX - pinchRef.current.startMidX),
              y: pinchRef.current.startPan.y + (midY - pinchRef.current.startMidY),
            },
            nextZoom,
            rect.width,
            rect.height,
          ),
        );
      }
      return;
    }

    if (e.touches.length === 1 && dragRef.current) {
      const dx = e.touches[0].clientX - dragRef.current.startX;
      const dy = e.touches[0].clientY - dragRef.current.startY;
      if (Math.hypot(dx, dy) > 6) {
        movedRef.current = true;
      }
      if (zoomRef.current > MIN_ZOOM && rect) {
        setIsDragging(true);
        setPan(
          clampPan(
            {
              x: dragRef.current.startPan.x + dx,
              y: dragRef.current.startPan.y + dy,
            },
            zoomRef.current,
            rect.width,
            rect.height,
          ),
        );
      }
    }
  };

  const handleTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      pinchRef.current = null;
    }
    if (e.touches.length === 0) {
      dragRef.current = null;
      setIsDragging(false);
      if (!movedRef.current && shouldRenderVideo && !isOverlayTarget(e.target)) {
        const now = Date.now();
        if (now - lastTapRef.current < 280) {
          if (tapTimerRef.current !== null) {
            window.clearTimeout(tapTimerRef.current);
            tapTimerRef.current = null;
          }
          lastTapRef.current = 0;
          applyZoom(zoomRef.current > MIN_ZOOM ? MIN_ZOOM : DOUBLE_TAP_ZOOM);
        } else {
          lastTapRef.current = now;
          if (isFullscreen) {
            tapTimerRef.current = window.setTimeout(() => {
              tapTimerRef.current = null;
              setControlsVisible((v) => !v);
            }, 285);
          }
        }
      }
    }
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !shouldRenderVideo || isOverlayTarget(e.target)) return;
    if (zoomRef.current <= MIN_ZOOM) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPan: panRef.current,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !dragRef.current || zoomRef.current <= MIN_ZOOM) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPan(
      clampPan(
        {
          x: dragRef.current.startPan.x + (e.clientX - dragRef.current.startX),
          y: dragRef.current.startPan.y + (e.clientY - dragRef.current.startY),
        },
        zoomRef.current,
        rect.width,
        rect.height,
      ),
    );
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    dragRef.current = null;
    setIsDragging(false);
  };

  const soundMeta = lastSoundboard
    ? (() => {
        const builtin = SOUNDBOARD_ITEMS.find((i) => i.id === lastSoundboard.sound);
        if (builtin) return { emoji: builtin.emoji, label: builtin.label };
        const custom = customSounds.find((i) => i.id === lastSoundboard.sound);
        if (custom) return { emoji: custom.emoji, label: custom.label };
        if (lastSoundboard.label) {
          return { emoji: lastSoundboard.emoji || '🔊', label: lastSoundboard.label };
        }
        return null;
      })()
    : null;
  const sbVolume = audioSettings.soundboardVolume ?? 0.85;
  const filteredBuiltins =
    soundTab === 'all'
      ? SOUNDBOARD_ITEMS
      : soundTab === 'custom'
        ? []
        : SOUNDBOARD_ITEMS.filter((i) => i.category === soundTab);
  const showCustomSounds = soundTab === 'all' || soundTab === 'custom';
  const isVoiceChatOpen = !activeDmUserId && activeTextChannelId === activeVoiceChannelId;
  const roomUnread = unreadByChannel[activeVoiceChannelId] || 0;
  const displayMediaAvailable = canUseDisplayMedia();

  const roomName = voiceChannel?.name || 'Ses Odası';

  const renderCollapseButton = (placement: 'in-title' | 'in-actions') => (
    <button
      type="button"
      className={`icon-btn stage-collapse-btn ${placement}`}
      onClick={() => {
        setSoundboardOpen(false);
        toggleStage();
      }}
      aria-expanded={true}
      title="Ses odasını küçült (sohbete yer aç)"
      aria-label="Ses odasını küçült"
    >
      <ChevronUp size={18} />
    </button>
  );

  return (
    <section
      className={`voice-stage ${activeStreamEntry ? 'has-stream' : ''} ${stageCollapsed ? 'collapsed' : ''}`}
      onClick={() => {
        if (needsAudioUnlock) unlockAudio().catch(() => {});
      }}
    >
      {stageCollapsed ? (
        <div className="voice-bar">
          <button
            type="button"
            className="voice-bar-main"
            onClick={toggleStage}
            aria-expanded={false}
            title="Ses odasını genişlet"
          >
            <Volume2 size={16} className="accent-green" />
            <span className="voice-bar-name">{roomName}</span>
            <span className="voice-bar-avatars" aria-label={`${roomMembers.length} kişi`}>
              {roomMembers.slice(0, 4).map((m) => (
                <span
                  key={m.user_id}
                  className={`mini-avatar ${m.speaking ? 'speaking' : ''}`}
                  style={{ backgroundColor: m.avatar_color }}
                  title={m.display_name}
                >
                  {m.avatar_url ? (
                    <img src={m.avatar_url} alt={m.display_name} />
                  ) : (
                    m.display_name.slice(0, 1).toUpperCase()
                  )}
                </span>
              ))}
              {roomMembers.length > 4 && (
                <span className="voice-bar-more">+{roomMembers.length - 4}</span>
              )}
            </span>
            {streamers.length > 0 && (
              <span className="live-pill" title={`${streamers.map((s) => s.display_name).join(', ')} yayında`}>
                <Monitor size={10} /> YAYIN
              </span>
            )}
          </button>
          <button
            type="button"
            className={`action-pill icon-only ${muted || forceMuted ? 'danger' : ''}`}
            onClick={toggleMute}
            title={forceMuted ? 'Yönetici susturdu' : muted ? 'Mikrofonu Aç' : 'Sustur'}
            aria-label={muted || forceMuted ? 'Mikrofonu aç' : 'Sustur'}
          >
            {muted || forceMuted ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
          <button
            type="button"
            className={`action-pill icon-only ${deafened ? 'danger' : ''}`}
            onClick={toggleDeafen}
            title={deafened ? 'Kulaklığı Aç' : 'Sağırlaştır'}
            aria-label={deafened ? 'Kulaklığı aç' : 'Sağırlaştır'}
          >
            {deafened ? <HeadphoneOff size={15} /> : <Headphones size={15} />}
          </button>
          <button
            type="button"
            className="action-pill icon-only danger"
            onClick={leaveVoice}
            title="Ses odasından ayrıl"
            aria-label="Ses odasından ayrıl"
          >
            <PhoneOff size={15} />
          </button>
          <button
            type="button"
            className="action-pill icon-only"
            onClick={toggleStage}
            aria-expanded={false}
            title="Ses odasını genişlet"
            aria-label="Ses odasını genişlet"
          >
            <ChevronDown size={16} />
          </button>
        </div>
      ) : (
      <div className="voice-stage-header" style={{ position: 'relative' }}>
        <div className="voice-stage-title">
          <Volume2 size={17} className="accent-green" />
          <span className="voice-stage-name">{roomName}</span>
          <span
            className="badge-subtle"
            title={
              turnEnabled
                ? 'Ses önce doğrudan P2P gider; TURN yalnızca doğrudan bağlantı kurulamazsa devreye girer. Kişi kartında "TURN" yazıyorsa o kişiyle relay kullanılıyordur.'
                : 'Doğrudan P2P bağlantı (TURN yapılandırılmamış).'
            }
          >
            {turnEnabled ? 'P2P • TURN yedekte' : 'P2P Direct'}
          </span>
          {lastSoundboard && soundMeta && (
            <span className="soundboard-toast">
              {soundMeta.emoji} {lastSoundboard.display_name}: {soundMeta.label}
            </span>
          )}
          {/* Phones: top-right of the title row (desktop has it at the end of the actions) */}
          {renderCollapseButton('in-title')}
        </div>

        <div className="voice-actions">
          <button
            type="button"
            className={`action-pill ${muted || forceMuted ? 'danger' : ''}`}
            onClick={toggleMute}
            title={forceMuted ? 'Yönetici susturdu' : muted ? 'Mikrofonu Aç' : 'Sustur'}
          >
            {muted || forceMuted ? <MicOff size={15} /> : <Mic size={15} />}
            <span className="btn-label">
              {forceMuted ? 'Sunucu Susturdu' : muted ? 'Sessiz' : 'Mikrofon'}
            </span>
          </button>

          <button
            type="button"
            className={`action-pill ${deafened ? 'danger' : ''}`}
            onClick={toggleDeafen}
            title={deafened ? 'Kulaklığı Aç' : 'Sağırlaştır'}
          >
            {deafened ? <HeadphoneOff size={15} /> : <Headphones size={15} />}
            <span className="btn-label">{deafened ? 'Sağır' : 'Kulaklık'}</span>
          </button>

          {firebaseMode && (
            <button
              type="button"
              className={`action-pill ${localCameraStream ? 'primary' : ''}`}
              onClick={() => (localCameraStream ? stopCamera() : startCamera())}
              title={localCameraStream ? 'Kamerayı Kapat' : 'Kamera Aç'}
            >
              {localCameraStream ? <VideoOff size={15} /> : <Video size={15} />}
              <span className="btn-label">{localCameraStream ? 'Kamerayı Kapat' : 'Kamera'}</span>
            </button>
          )}

          {localScreenStream ? (
            <button
              type="button"
              className="action-pill danger"
              onClick={stopScreenShare}
              title="Yayını Durdur"
            >
              <MonitorOff size={15} />
              <span className="btn-label">Yayını Durdur</span>
            </button>
          ) : (
            displayMediaAvailable && (
              <button
                type="button"
                className="action-pill primary"
                onClick={onOpenShareModal}
                title="Ekran ve oyun paylaş"
              >
                <Monitor size={15} />
                <span className="btn-label">Ekran Paylaş</span>
              </button>
            )
          )}

          {firebaseMode && (
            <button
              type="button"
              className={`action-pill ${soundboardOpen ? 'primary' : ''}`}
              onClick={() => setSoundboardOpen((v) => !v)}
              title="Ses Tahtası (Soundboard)"
            >
              <Music2 size={15} />
              <span className="btn-label">Sesler</span>
            </button>
          )}

          <button
            type="button"
            className={`action-pill ${isVoiceChatOpen ? 'primary' : ''}`}
            onClick={() => selectTextChannel(activeVoiceChannelId)}
            title="Bu ses odasının özel sohbetini aç"
          >
            <MessageSquare size={15} />
            <span className="btn-label">Oda Sohbeti</span>
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

          <button
            type="button"
            className="action-pill danger"
            onClick={leaveVoice}
            title="Ses odasından ayrıl"
          >
            <PhoneOff size={15} />
            <span className="btn-label">Ayrıl</span>
          </button>
          {renderCollapseButton('in-actions')}
        </div>

        {soundboardOpen && (
          <div className="soundboard-popover wide" onClick={(e) => e.stopPropagation()}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <div className="field-label" style={{ margin: 0 }}>
                Ses Tahtası (Soundboard)
              </div>
              <div className="row-gap">
                <button
                  type="button"
                  className="icon-btn tiny"
                  title="Çalan sesleri durdur"
                  onClick={stopAllSoundboard}
                >
                  <Square size={12} />
                </button>
                <button
                  type="button"
                  className={`secondary-btn tiny-pill ${addingSound ? 'active' : ''}`}
                  onClick={() => {
                    setAddingSound((v) => !v);
                    setSoundUploadErr(null);
                  }}
                >
                  <Plus size={12} /> Ses Ekle
                </button>
                <button
                  type="button"
                  className="icon-btn tiny"
                  onClick={() => setSoundboardOpen(false)}
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="soundboard-volume-row">
              <Volume2 size={13} />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(sbVolume * 100)}
                onChange={(e) =>
                  updateAudioSettings({ soundboardVolume: Number(e.target.value) / 100 })
                }
                aria-label="Soundboard ses seviyesi"
              />
              <span className="muted-text">{Math.round(sbVolume * 100)}%</span>
            </div>

            {addingSound && (
              <div className="soundboard-upload-box">
                <input
                  ref={soundFileRef}
                  type="file"
                  accept="audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4,.mp3,.wav,.ogg,.webm,.m4a"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    setSoundUploadErr(null);
                    try {
                      const dataUrl = await readCustomAudioFile(f);
                      setNewSoundDataUrl(dataUrl);
                      setNewSoundFileName(f.name);
                      if (!newSoundLabel.trim()) {
                        setNewSoundLabel(f.name.replace(/\.[^.]+$/, '').slice(0, 28));
                      }
                    } catch (err) {
                      setSoundUploadErr(err instanceof Error ? err.message : 'Dosya okunamadı.');
                    }
                  }}
                />
                <div className="row-gap">
                  <input
                    type="text"
                    className="dark-input"
                    value={newSoundEmoji}
                    onChange={(e) => setNewSoundEmoji(e.target.value)}
                    style={{ width: 44, textAlign: 'center', padding: '5px 4px' }}
                    maxLength={4}
                    aria-label="Emoji"
                  />
                  <input
                    type="text"
                    className="dark-input"
                    value={newSoundLabel}
                    onChange={(e) => setNewSoundLabel(e.target.value)}
                    placeholder="Ses adı (örn: Bruh)"
                    maxLength={32}
                    style={{ flex: 1, padding: '5px 8px' }}
                  />
                </div>
                <div className="row-gap" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="secondary-btn small"
                    style={{ flex: 1 }}
                    onClick={() => soundFileRef.current?.click()}
                  >
                    <Upload size={13} /> {newSoundFileName ? newSoundFileName.slice(0, 18) : 'MP3 / WAV Seç (≤185 KB)'}
                  </button>
                  {newSoundDataUrl && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Önizle (sadece sana çalar)"
                      onClick={() =>
                        playSoundboard('custom', {
                          volume: sbVolume,
                          customAudioUrl: newSoundDataUrl,
                        })
                      }
                    >
                      <Play size={14} />
                    </button>
                  )}
                </div>
                {soundUploadErr && <div className="form-error" style={{ marginTop: 6 }}>{soundUploadErr}</div>}
                <div className="row-gap" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="primary-btn small"
                    style={{ flex: 1 }}
                    disabled={!newSoundDataUrl || !newSoundLabel.trim() || soundUploadBusy}
                    onClick={async () => {
                      if (!newSoundDataUrl || !newSoundLabel.trim()) return;
                      setSoundUploadBusy(true);
                      setSoundUploadErr(null);
                      try {
                        await addCustomSound({
                          label: newSoundLabel.trim(),
                          emoji: newSoundEmoji.trim() || '🔊',
                          audio_url: newSoundDataUrl,
                        });
                        setNewSoundLabel('');
                        setNewSoundDataUrl(null);
                        setNewSoundFileName('');
                        setAddingSound(false);
                        setSoundTab('custom');
                      } catch (err) {
                        setSoundUploadErr(err instanceof Error ? err.message : 'Ses eklenemedi.');
                      } finally {
                        setSoundUploadBusy(false);
                      }
                    }}
                  >
                    {soundUploadBusy ? 'Kaydediliyor...' : 'Odaya Ekle'}
                  </button>
                </div>
              </div>
            )}

            <div className="soundboard-tabs">
              {(
                [
                  { id: 'all', label: 'Tümü' },
                  { id: 'meme', label: 'Meme' },
                  { id: 'tepki', label: 'Tepki' },
                  { id: 'efekt', label: 'Efekt' },
                  { id: 'custom', label: `Özel (${customSounds.length})` },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={soundTab === t.id ? 'active' : ''}
                  onClick={() => setSoundTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="soundboard-grid">
              {filteredBuiltins.map((item) => (
                <div key={item.id} className="soundboard-item-wrap">
                  <button
                    type="button"
                    className="soundboard-btn"
                    title="Odadaki herkese çal"
                    onClick={() => {
                      playRoomSoundboard(item.id, { emoji: item.emoji, label: item.label });
                    }}
                  >
                    <span>{item.emoji}</span>
                    <span className="sb-label">{item.label}</span>
                  </button>
                  <button
                    type="button"
                    className="sb-preview-btn"
                    title="Sadece kendin dinle (önizleme)"
                    onClick={() => playSoundboard(item.id, { volume: sbVolume })}
                  >
                    <Play size={11} />
                  </button>
                </div>
              ))}

              {showCustomSounds &&
                customSounds.map((cs) => {
                  const canDel = user?.id === cs.created_by || user?.role === 'admin';
                  return (
                    <div key={cs.id} className="soundboard-item-wrap custom">
                      <button
                        type="button"
                        className="soundboard-btn"
                        title={`${cs.created_by_name} ekledi — herkese çal`}
                        onClick={() => {
                          playRoomSoundboard(cs.id, {
                            emoji: cs.emoji,
                            label: cs.label,
                            audio_url: cs.audio_url,
                          });
                        }}
                      >
                        <span>{cs.emoji}</span>
                        <span className="sb-label">{cs.label}</span>
                      </button>
                      <button
                        type="button"
                        className="sb-preview-btn"
                        title="Önizle"
                        onClick={() =>
                          playSoundboard(cs.id, {
                            volume: sbVolume,
                            customAudioUrl: cs.audio_url,
                          })
                        }
                      >
                        <Play size={11} />
                      </button>
                      {canDel && (
                        <button
                          type="button"
                          className="sb-preview-btn danger-hover"
                          title="Özel sesi sil"
                          onClick={() => deleteCustomSound(cs.id)}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>

            {soundTab === 'custom' && customSounds.length === 0 && (
              <div className="muted-text" style={{ textAlign: 'center', padding: '10px 4px' }}>
                Henüz özel ses eklenmedi. Yukarıdaki <strong>+ Ses Ekle</strong> ile kendi MP3/WAV kliplerini yükleyebilirsin!
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {firebaseMode && wsStatus !== 'connected' && (
        <div className="audio-unlock-banner" role="status">
          <span>
            İnternet bağlantısı koptu, yeniden bağlanılıyor… Odadan çıkarılmayacaksın; bağlantı
            gelince ses kendiliğinden devam eder.
          </span>
        </div>
      )}

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

      {activeStreamEntry && streamHidden && !stageCollapsed && (
        <div className="stream-mini-row">
          <Monitor size={14} className="accent-green" />
          <span className="stream-mini-label">{activeStreamEntry.label}</span>
          <span className="muted-text stream-mini-hint">gizli · ses açık</span>
          <button
            type="button"
            className="secondary-btn small"
            onClick={() => setHiddenStreamKey(null)}
          >
            <Eye size={13} /> Göster
          </button>
        </div>
      )}

      {activeStreamEntry && (
        // Hidden streams stay mounted (just invisible) so the shared game/system audio
        // keeps playing while the picture is tucked away.
        <div
          className={`stream-theater ${isFullscreen ? 'is-fullscreen' : ''} ${
            !isFullscreen && (stageCollapsed || streamHidden) ? 'tucked' : ''
          }`}
          ref={viewerRef}
          aria-hidden={!isFullscreen && (stageCollapsed || streamHidden) ? true : undefined}
        >
          <div
            className={`stream-viewport ${zoom > MIN_ZOOM ? 'zoomed' : ''} ${isDragging ? 'dragging' : ''}`}
            ref={viewportRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onDoubleClick={(e) => {
              if (!shouldRenderVideo || isOverlayTarget(e.target)) return;
              applyZoom(zoomRef.current > MIN_ZOOM ? MIN_ZOOM : DOUBLE_TAP_ZOOM);
            }}
          >
            {shouldRenderVideo ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                onLoadedMetadata={(e) => {
                  e.currentTarget.play().catch(() => {});
                }}
                className="stream-video"
                style={{
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                }}
              />
            ) : (
              <div className="self-stream-placeholder">
                <Monitor size={18} className="accent-green" />
                <span>
                  Ekranını paylaşıyorsun • Sonsuz ayna/titreşimi önlemek için yerel önizleme
                  gizlendi.
                </span>
              </div>
            )}

            <div
              className={`stream-overlay stream-overlay-top ${isFullscreen && !controlsVisible ? 'hidden' : ''}`}
              data-overlay-control="true"
            >
              <div className="stream-tabs">
                {availableStreams.length > 1 ? (
                  availableStreams.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={s.id === activeStreamEntry.id ? 'active' : ''}
                      onClick={() => setFocusedStreamUser(s.id)}
                    >
                      <Monitor size={13} />
                      <span>{s.label}</span>
                    </button>
                  ))
                ) : (
                  <span className="stream-label-pill">
                    <Monitor size={13} className="accent-green" />
                    <span>{activeStreamEntry.label}</span>
                  </span>
                )}
              </div>

              <div className="stream-controls">
                {isSelfStream ? (
                  <button
                    type="button"
                    className="stream-overlay-btn"
                    onClick={() => setShowSelfPreview((v) => !v)}
                  >
                    {showSelfPreview ? <EyeOff size={15} /> : <Eye size={15} />}
                    <span>{showSelfPreview ? 'Gizle' : 'Önizle'}</span>
                  </button>
                ) : (
                  <div className="stream-zoom-pill">
                    <button
                      type="button"
                      className="stream-overlay-btn"
                      onClick={() => setStreamMuted((v) => !v)}
                      title={streamMuted ? 'Yayın Sesini Aç' : 'Yayın Sesini Kapat'}
                    >
                      {streamMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={streamMuted ? 0 : streamVolume}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setStreamMuted(val === 0);
                        setStreamVolume(val);
                      }}
                      className="stream-vol-range"
                      title="Yayın Sesi"
                    />
                  </div>
                )}
                {!isFullscreen && (
                  <button
                    type="button"
                    className="stream-overlay-btn"
                    onClick={() => setHiddenStreamKey(streamKey)}
                    title="Yayını küçült (ses devam eder)"
                    aria-label="Yayını küçült"
                  >
                    <ChevronsUp size={15} />
                  </button>
                )}
              </div>
            </div>

            <div
              className={`stream-overlay stream-overlay-bottom ${isFullscreen && !controlsVisible ? 'hidden' : ''}`}
              data-overlay-control="true"
            >
              <div>
                {isFullscreen && (
                  <button
                    type="button"
                    className={`stream-overlay-btn ${muted || forceMuted ? 'danger' : ''}`}
                    style={{ background: 'rgba(17, 18, 20, 0.78)', border: '1px solid rgba(255,255,255,0.14)' }}
                    onClick={toggleMute}
                    title={muted || forceMuted ? 'Mikrofonu Aç' : 'Sustur'}
                  >
                    {muted || forceMuted ? <MicOff size={15} /> : <Mic size={15} />}
                    <span>{muted || forceMuted ? 'Sessiz' : 'Mikrofon'}</span>
                  </button>
                )}
              </div>

              {shouldRenderVideo && (
                <div className="stream-zoom-pill">
                  <button
                    type="button"
                    className="stream-overlay-btn"
                    disabled={zoom <= MIN_ZOOM}
                    onClick={() => applyZoom(zoomStep(zoom, -0.5))}
                    title="Uzaklaştır"
                  >
                    <ZoomOut size={15} />
                  </button>
                  <button
                    type="button"
                    className="stream-overlay-btn"
                    onClick={() => applyZoom(MIN_ZOOM)}
                    title="Yakınlaştırmayı Sıfırla"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    className="stream-overlay-btn"
                    disabled={zoom >= MAX_ZOOM}
                    onClick={() => applyZoom(zoomStep(zoom, 0.5))}
                    title="Yakınlaştır"
                  >
                    <ZoomIn size={15} />
                  </button>
                  <button
                    type="button"
                    className="stream-overlay-btn primary"
                    onClick={toggleFullscreen}
                    title={isFullscreen ? 'Tam Ekrandan Çık' : 'Tam Ekran'}
                  >
                    {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>
                </div>
              )}
            </div>
          </div>
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
          const iceFailed = stats?.iceState === 'failed';
          // 'disconnected' is usually a short blip that ICE heals (or we restart it)
          const iceReconnecting = stats?.iceState === 'disconnected';

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
              : iceReconnecting
                ? 'Yeniden bağlanıyor...'
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
                    {!isSelf &&
                      (stats ? (
                        <button
                          type="button"
                          className={`ping-badge as-button ${pingClass}`}
                          aria-expanded={expandedStatsUserId === member.user_id}
                          title="Bağlantı ayrıntıları (ping, paket kaybı, jitter)"
                          onClick={() =>
                            setExpandedStatsUserId((cur) =>
                              cur === member.user_id ? null : member.user_id,
                            )
                          }
                        >
                          {statusText}
                        </button>
                      ) : (
                        <span className={`ping-badge ${pingClass}`}>{statusText}</span>
                      ))}
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

              {!isSelf && stats && expandedStatsUserId === member.user_id && (
                <ConnectionDetails
                  stats={stats}
                  history={peerQualityHistory[member.user_id] ?? []}
                />
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
