import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Bell,
  Camera,
  Copy,
  Crown,
  KeyRound,
  Link2,
  LogOut,
  Mic,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Shield,
  Sparkles,
  Square,
  Trash2,
  User,
  UserMinus,
  Users,
  Volume2,
  Wifi,
  X,
} from 'lucide-react';
import { dbFromMeterPercent, meterPercent } from '../lib/audioGate';
import { MAX_ROOM_MEMBERS } from '../lib/firebaseBackend';
import { compressAvatarToDataUrl } from '../lib/imageCompress';
import { currentInviteLink, generateInviteCode } from '../lib/invite';
import {
  NOISE_SUPPRESSION_OPTIONS,
  getNoiseSuppressionLabel,
  resolveNoiseSuppressionMode,
} from '../lib/noiseSuppression';
import { playSoundboard, playUiSound } from '../lib/sounds';
import { useAppStore } from '../store/useAppStore';
import { useMicLevelStore } from '../store/useMicLevelStore';
import type {
  InputSensitivityMode,
  SettingsTabId,
  TurnConfig,
  UserStatus,
} from '../types/protocol';
import { ConfirmButton } from './ConfirmButton';

const MANUAL_MIN_DB = -80;
const MANUAL_MAX_DB = -10;

const SENSITIVITY_MODES: Array<{ id: InputSensitivityMode; label: string; hint: string }> = [
  {
    id: 'auto',
    label: 'Otomatik',
    hint: 'Eşik ortam gürültüne göre kendini ayarlar. Klavye, fan gibi eşiğin altındaki sesler gönderilmez.',
  },
  {
    id: 'manual',
    label: 'Elle',
    hint: 'Konuşurken çubuk yeşile, susunca griye dönecek şekilde eşiği ayarla. Gri kısım gönderilmez.',
  },
  {
    id: 'off',
    label: 'Kapalı',
    hint: 'Mikrofon her zaman açık: arka plan sesleri de dahil her şey gönderilir.',
  },
];

const COLOR_SWATCHES = [
  '#5865F2',
  '#3BA55D',
  '#FAA61A',
  '#EB459E',
  '#ED4245',
  '#00AFF4',
  '#9B59B6',
  '#E67E22',
];

const STATUS_OPTIONS: Array<{ value: UserStatus; label: string; color: string }> = [
  { value: 'online', label: 'Çevrimiçi', color: '#23a55a' },
  { value: 'idle', label: 'Boşta', color: '#f0b232' },
  { value: 'dnd', label: 'Rahatsız Etme', color: '#f23f42' },
  { value: 'invisible', label: 'Görünmez', color: '#80848e' },
];

interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsTabId;
  onClose: () => void;
  onOpenRoomHub?: (tab: 'join' | 'create') => void;
}

export function SettingsModal({
  open,
  initialTab = 'audio',
  onClose,
  onOpenRoomHub,
}: SettingsModalProps) {
  const {
    firebaseMode,
    user,
    serverName,
    activeRoomId,
    rooms,
    allUsers,
    onlineUsers,
    channels,
    adminInviteCode,
    turnConfig,
    audioSettings,
    noiseSuppressionStatus,
    turnEnabled,
    iceServers,
    serverUrl,
    micTestActive,
    activeVoiceChannelId,
    muted,
    forceMuted,
    deafened,
    updateAudioSettings,
    updateOwnProfile,
    changePassword,
    startMicTest,
    stopMicTest,
    updateServerName,
    updateInviteCode,
    updateTurnConfig,
    setUserRole,
    kickMember,
    clearChannelMessages,
    leaveCurrentRoom,
  } = useAppStore();

  const micLevel = useMicLevelStore((s) => s.micLevel);
  const liveThresholdPct = useMicLevelStore((s) => s.gateThreshold);
  const selectedNoiseMode = resolveNoiseSuppressionMode(audioSettings);
  const sensitivity = audioSettings.inputSensitivity;
  const metering = micTestActive || Boolean(activeVoiceChannelId);
  const gateOff = sensitivity === 'off' || audioSettings.pttEnabled;
  const thresholdPct =
    sensitivity === 'manual' ? meterPercent(audioSettings.gateThresholdDb) : liveThresholdPct;
  const thresholdDb = Math.round(
    sensitivity === 'manual' ? audioSettings.gateThresholdDb : dbFromMeterPercent(liveThresholdPct),
  );
  const isAdmin = Boolean(firebaseMode && user?.role === 'admin' && activeRoomId);

  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [capturingKey, setCapturingKey] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);

  // Profile state
  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState('#5865F2');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<UserStatus>('online');
  const [customStatus, setCustomStatus] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState<string | null>(null);
  const avatarFileRef = useRef<HTMLInputElement | null>(null);

  // Password state
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdStatus, setPwdStatus] = useState<string | null>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);
  const [pwdBusy, setPwdBusy] = useState(false);

  // Admin sub-tab state
  const [adminSubTab, setAdminSubTab] = useState<'general' | 'members' | 'turn'>('general');
  const [nameInput, setNameInput] = useState(serverName);
  const [inviteInput, setInviteInput] = useState(adminInviteCode || '');
  const [clearChannelId, setClearChannelId] = useState('');
  const [workerUrl, setWorkerUrl] = useState(turnConfig?.workerUrl || '');
  const [turnUrl, setTurnUrl] = useState(turnConfig?.url || '');
  const [turnUsername, setTurnUsername] = useState(turnConfig?.username || '');
  const [turnCredential, setTurnCredential] = useState(turnConfig?.credential || '');
  const [adminStatus, setAdminStatus] = useState<string | null>(null);
  const [adminErr, setAdminErr] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setActiveTab(initialTab === 'admin' && !isAdmin ? 'audio' : initialTab);
  }, [open, initialTab, isAdmin]);

  useEffect(() => {
    if (!open || !user) return;
    setDisplayName(user.display_name);
    setAvatarColor(user.avatar_color);
    setAvatarUrl(user.avatar_url ?? null);
    setStatus(user.status ?? 'online');
    setCustomStatus(user.custom_status ?? '');
    setProfileErr(null);
    setProfileSaved(null);
  }, [open, user]);

  useEffect(() => {
    if (!open) return;
    setNameInput(serverName);
    setInviteInput(adminInviteCode || '');
    setWorkerUrl(turnConfig?.workerUrl || '');
    setTurnUrl(turnConfig?.url || '');
    setTurnUsername(turnConfig?.username || '');
    setTurnCredential(turnConfig?.credential || '');
    setClearChannelId((prev) => prev || channels[0]?.id || '');
    setAdminStatus(null);
    setAdminErr(null);
  }, [open, serverName, adminInviteCode, turnConfig, channels]);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!open || !media?.enumerateDevices) return;
    const refresh = () => {
      media
        .enumerateDevices()
        .then((devices) => {
          setInputs(devices.filter((d) => d.kind === 'audioinput'));
          setOutputs(devices.filter((d) => d.kind === 'audiooutput'));
        })
        .catch(() => {});
    };
    refresh();
    media.addEventListener?.('devicechange', refresh);
    return () => media.removeEventListener?.('devicechange', refresh);
  }, [open, micTestActive]);

  useEffect(() => {
    if (!open) stopMicTest();
    return () => stopMicTest();
  }, [open, stopMicTest]);

  useEffect(() => {
    if (!capturingKey) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      updateAudioSettings({ pttKey: e.code });
      setCapturingKey(false);
    };
    window.addEventListener('keydown', onKeyDown, { once: true });
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [capturingKey, updateAudioSettings]);

  if (!open) return null;

  const onlineIds = new Set(onlineUsers.map((u) => u.id));
  const inviteLink = currentInviteLink(adminInviteCode);
  const inviteDirty = inviteInput.trim() !== (adminInviteCode ?? '').trim();
  const sbVolume = audioSettings.soundboardVolume ?? 0.85;

  const tabs: Array<{ id: SettingsTabId; label: string; icon: typeof Mic; visible: boolean }> = [
    { id: 'audio', label: 'Ses & Mikrofon', icon: Mic, visible: true },
    { id: 'notifications', label: 'Sesler & Bildirim', icon: Bell, visible: true },
    { id: 'profile', label: 'Profil & Hesap', icon: User, visible: firebaseMode },
    { id: 'connection', label: 'Bağlantı & Odalar', icon: Wifi, visible: true },
    { id: 'admin', label: 'Admin Paneli', icon: Crown, visible: isAdmin },
  ];

  const handleAvatarUpload = async (file: File) => {
    setProfileErr(null);
    try {
      const compressed = await compressAvatarToDataUrl(file);
      setAvatarUrl(compressed);
    } catch (e) {
      setProfileErr(e instanceof Error ? e.message : 'Fotoğraf yüklenemedi.');
    }
  };

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setProfileErr(null);
    setProfileSaved(null);
    setProfileBusy(true);
    try {
      await updateOwnProfile({
        display_name: displayName,
        avatar_color: avatarColor,
        avatar_url: avatarUrl,
        status,
        custom_status: customStatus.trim() || null,
      });
      setProfileSaved('Profilin güncellendi!');
    } catch (err) {
      setProfileErr(err instanceof Error ? err.message : 'Profil kaydedilemedi.');
    } finally {
      setProfileBusy(false);
    }
  };

  const handlePasswordChange = async (e: FormEvent) => {
    e.preventDefault();
    setPwdErr(null);
    setPwdStatus(null);
    setPwdBusy(true);
    try {
      await changePassword(curPwd, newPwd);
      setCurPwd('');
      setNewPwd('');
      setPwdStatus('Şifren başarıyla güncellendi.');
    } catch (err) {
      setPwdErr(err instanceof Error ? err.message : 'Şifre değiştirilemedi.');
    } finally {
      setPwdBusy(false);
    }
  };

  const handleSaveAdminGeneral = async (e: FormEvent) => {
    e.preventDefault();
    setAdminStatus(null);
    setAdminErr(null);
    setAdminBusy(true);
    try {
      await updateServerName(nameInput);
      if (inviteInput.trim()) {
        await updateInviteCode(inviteInput);
      }
      setAdminStatus('Oda adı ve davet kodu güncellendi.');
    } catch (err) {
      setAdminErr(err instanceof Error ? err.message : 'Kaydedilemedi.');
    } finally {
      setAdminBusy(false);
    }
  };

  const handleClearMessages = async () => {
    if (!clearChannelId) return;
    setAdminStatus(null);
    setAdminErr(null);
    setAdminBusy(true);
    try {
      await clearChannelMessages(clearChannelId);
      setAdminStatus('Seçilen kanalın tüm mesajları temizlendi.');
    } catch (err) {
      setAdminErr(err instanceof Error ? err.message : 'Mesajlar silinemedi.');
    } finally {
      setAdminBusy(false);
    }
  };

  const handleSaveTurn = async (e: FormEvent) => {
    e.preventDefault();
    setAdminStatus(null);
    setAdminErr(null);
    setAdminBusy(true);
    try {
      const payload: TurnConfig = {};
      if (workerUrl.trim()) payload.workerUrl = workerUrl.trim();
      if (turnUrl.trim()) {
        payload.url = turnUrl.trim();
        payload.username = turnUsername.trim();
        payload.credential = turnCredential.trim();
      }
      const hasAny = Boolean(payload.workerUrl || payload.url);
      await updateTurnConfig(hasAny ? payload : null);
      setAdminStatus(
        hasAny
          ? 'TURN ayarı kaydedildi ve ses odasındaki tüm arkadaşlara anında aktarıldı!'
          : 'TURN devre dışı bırakıldı (Sadece STUN).',
      );
    } catch (err) {
      setAdminErr(err instanceof Error ? err.message : 'TURN ayarlanamadı.');
    } finally {
      setAdminBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card settings-shell" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Settings size={18} />
            <h3>Ayarlar</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Ayar sekmeleri">
            {tabs
              .filter((t) => t.visible)
              .map((t) => {
                const Icon = t.icon;
                const isActive = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`settings-nav-btn ${isActive ? 'active' : ''} ${t.id === 'admin' ? 'admin-tab' : ''}`}
                    onClick={() => setActiveTab(t.id)}
                  >
                    <Icon size={15} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
          </nav>

          <div className="settings-pane">
            {activeTab === 'audio' && (
              <div className="modal-body">
                <div className="settings-grid">
                  <label className="stack-field">
                    <span>Mikrofon</span>
                    <select
                      value={audioSettings.inputDeviceId}
                      onChange={(e) => updateAudioSettings({ inputDeviceId: e.target.value })}
                    >
                      <option value="default">Varsayılan Mikrofon</option>
                      {inputs.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `Mikrofon ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="stack-field">
                    <span>Çıkış (Kulaklık / Hoparlör)</span>
                    <select
                      value={audioSettings.outputDeviceId}
                      onChange={(e) => updateAudioSettings({ outputDeviceId: e.target.value })}
                    >
                      <option value="default">Varsayılan Çıkış</option>
                      {outputs.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `Çıkış ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="stack-field">
                  <div className="row-between">
                    <span>Mikrofon Hassasiyeti</span>
                    <span className="muted-text">
                      {metering
                        ? `Seviye ${Math.round(dbFromMeterPercent(micLevel))} dB · eşik ${thresholdDb} dB`
                        : 'Seviyeyi görmek için mikrofonu test et'}
                    </span>
                  </div>
                  <div className="segmented-row" role="radiogroup" aria-label="Mikrofon hassasiyeti">
                    {SENSITIVITY_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="radio"
                        aria-checked={sensitivity === m.id}
                        className={sensitivity === m.id ? 'active' : ''}
                        disabled={audioSettings.pttEnabled}
                        onClick={() => updateAudioSettings({ inputSensitivity: m.id })}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <div className="mic-meter-track" aria-hidden="true">
                    <div
                      className="mic-meter-fill"
                      style={{
                        width: `${micLevel}%`,
                        backgroundColor: gateOff || micLevel >= thresholdPct ? '#3BA55D' : '#72767D',
                      }}
                    />
                    {!gateOff && (
                      <div className="mic-meter-threshold" style={{ left: `${thresholdPct}%` }} />
                    )}
                  </div>
                  {sensitivity === 'manual' && !audioSettings.pttEnabled && (
                    <input
                      type="range"
                      min={MANUAL_MIN_DB}
                      max={MANUAL_MAX_DB}
                      step={1}
                      value={audioSettings.gateThresholdDb}
                      aria-label="Gürültü kapısı eşiği (dB)"
                      onChange={(e) =>
                        updateAudioSettings({ gateThresholdDb: Number(e.target.value) })
                      }
                    />
                  )}
                  <span className="muted-text" style={{ fontSize: '0.75rem' }}>
                    {audioSettings.pttEnabled
                      ? 'Bas-Konuş açıkken tuşa bastığın sürece her şey gönderilir; hassasiyet devre dışı.'
                      : SENSITIVITY_MODES.find((m) => m.id === sensitivity)?.hint}
                  </span>
                  <div className="mic-test-row">
                    <button
                      type="button"
                      className={micTestActive ? 'action-pill danger' : 'secondary-btn small'}
                      onClick={() => (micTestActive ? stopMicTest() : startMicTest())}
                    >
                      {micTestActive ? <Square size={13} /> : <Mic size={14} />}
                      {micTestActive ? 'Testi Durdur' : 'Mikrofonu Test Et'}
                    </button>
                    <span className="muted-text" style={{ fontSize: '0.75rem' }}>
                      {micTestActive && activeVoiceChannelId && (muted || forceMuted || deafened)
                        ? 'Mikrofonun şu an kapalı — açınca sesini duyacaksın.'
                        : micTestActive
                          ? 'Kendi sesini duyuyorsun — AI gürültü filtresi de dahil!'
                          : 'Kulaklık tak: sesin sana geri çalınır, filtre farkını anında duyarsın.'}
                    </span>
                  </div>
                </div>

                <div className="noise-mode-section">
                  <div className="row-between">
                    <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Sparkles size={13} />
                      <span>Gürültü Azaltma Modu</span>
                    </div>
                    {metering && (
                      <span
                        className={`noise-mode-status ${noiseSuppressionStatus.loading ? 'loading' : ''}`}
                      >
                        {noiseSuppressionStatus.loading
                          ? 'Model yükleniyor...'
                          : `Aktif: ${getNoiseSuppressionLabel(noiseSuppressionStatus.activeMode)}`}
                      </span>
                    )}
                  </div>
                  <div className="noise-mode-grid" role="radiogroup" aria-label="Gürültü Azaltma Modu">
                    {NOISE_SUPPRESSION_OPTIONS.map((opt) => {
                      const isSelected = selectedNoiseMode === opt.id;
                      const isFeatured = opt.id === 'deepfilternet';
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          className={`preset-card noise-mode-card ${isFeatured ? 'featured' : ''} ${isSelected ? 'active' : ''}`}
                          onClick={() =>
                            updateAudioSettings({
                              noiseSuppressionMode: opt.id,
                              noiseSuppression: opt.id !== 'off',
                            })
                          }
                        >
                          <div className="noise-mode-header">
                            <strong>{opt.label}</strong>
                            {opt.badge && (
                              <span
                                className={`noise-mode-badge ${opt.id === 'deepfilternet' || opt.id === 'gtcrn' ? 'accent' : ''}`}
                              >
                                {opt.badge}
                              </span>
                            )}
                          </div>
                          <span>{opt.description}</span>
                        </button>
                      );
                    })}
                  </div>
                  {noiseSuppressionStatus.fallbackMessage && (
                    <div className="noise-mode-warning">{noiseSuppressionStatus.fallbackMessage}</div>
                  )}
                </div>

                <div className="field-label">Opus Ses Kalitesi</div>
                <div className="segmented-row">
                  {([64, 96, 128] as const).map((kbps) => (
                    <button
                      key={kbps}
                      type="button"
                      className={audioSettings.opusBitrateKbps === kbps ? 'active' : ''}
                      onClick={() => updateAudioSettings({ opusBitrateKbps: kbps })}
                    >
                      {kbps} kbps {kbps === 96 ? '(Önerilen)' : kbps === 128 ? '(Stüdyo)' : ''}
                    </button>
                  ))}
                </div>

                <div className="toggle-list">
                  <label className="toggle-row">
                    <div>
                      <strong>Yankı Engelleme (Echo Cancellation)</strong>
                      <p>Hoparlör kullanırken karşı sesin geri dönmesini engeller.</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={audioSettings.echoCancellation}
                      onChange={(e) =>
                        updateAudioSettings({ echoCancellation: e.target.checked })
                      }
                    />
                  </label>

                  <label className="toggle-row">
                    <div>
                      <strong>Otomatik Kazanç (AGC)</strong>
                      <p>Ses seviyesini otomatik dengeler.</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={audioSettings.autoGainControl}
                      onChange={(e) =>
                        updateAudioSettings({ autoGainControl: e.target.checked })
                      }
                    />
                  </label>

                  <label className="toggle-row">
                    <div>
                      <strong>Stereo Modu</strong>
                      <p>Müzik/mikser girişi için çift kanal ses iletimi.</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={audioSettings.stereo}
                      onChange={(e) => updateAudioSettings({ stereo: e.target.checked })}
                    />
                  </label>

                  <label className="toggle-row">
                    <div>
                      <strong>Bas-Konuş (Push-to-Talk)</strong>
                      <p>Masaüstü Tauri uygulamasında oyun içindeyken bile global çalışır.</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={audioSettings.pttEnabled}
                      onChange={(e) => updateAudioSettings({ pttEnabled: e.target.checked })}
                    />
                  </label>
                </div>

                {audioSettings.pttEnabled && (
                  <div className="ptt-bind-row">
                    <span>
                      Bas-Konuş Tuşu: <code>{audioSettings.pttKey}</code>
                    </span>
                    <button
                      type="button"
                      className="secondary-btn small"
                      onClick={() => setCapturingKey(true)}
                    >
                      {capturingKey ? 'Bir Tuşa Bas...' : 'Tuş Ata'}
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  className="secondary-btn small"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() =>
                    updateAudioSettings({
                      echoCancellation: true,
                      noiseSuppression: true,
                      noiseSuppressionMode: 'standard',
                      autoGainControl: true,
                      opusBitrateKbps: 96,
                      stereo: false,
                      inputSensitivity: 'auto',
                    })
                  }
                >
                  Önerilen Temiz Ses Ayarlarını Uygula
                </button>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="modal-body">
                <div className="toggle-list">
                  <label className="toggle-row">
                    <div>
                      <strong>Uygulama &amp; Soundboard Sesleri</strong>
                      <p>Odaya giriş/çıkış, susturma, mesaj ve ses tahtası efektlerini çalar.</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={audioSettings.soundsEnabled}
                      onChange={(e) => updateAudioSettings({ soundsEnabled: e.target.checked })}
                    />
                  </label>

                  <label className="toggle-row">
                    <div>
                      <strong>Masaüstü Bildirimleri (@bahsetme &amp; DM)</strong>
                      <p>Sekme arka plandayken sana @bahsedildiğinde veya DM gelince uyarır.</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={audioSettings.desktopNotifications}
                      onChange={async (e) => {
                        const want = e.target.checked;
                        if (
                          want &&
                          typeof Notification !== 'undefined' &&
                          Notification.permission === 'default'
                        ) {
                          await Notification.requestPermission().catch(() => {});
                        }
                        updateAudioSettings({ desktopNotifications: want });
                      }}
                    />
                  </label>
                </div>

                <div className="diag-box" style={{ gap: 10 }}>
                  <div className="row-between">
                    <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Volume2 size={15} /> Soundboard Ses Seviyesi
                    </strong>
                    <span className="muted-text">{Math.round(sbVolume * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(sbVolume * 100)}
                    onChange={(e) =>
                      updateAudioSettings({ soundboardVolume: Number(e.target.value) / 100 })
                    }
                  />
                  <div className="row-gap" style={{ flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="secondary-btn small"
                      onClick={() => playSoundboard('vineboom', { volume: sbVolume })}
                    >
                      <Play size={12} /> 💥 Vine Boom
                    </button>
                    <button
                      type="button"
                      className="secondary-btn small"
                      onClick={() => playSoundboard('applause', { volume: sbVolume })}
                    >
                      <Play size={12} /> 👏 Alkış
                    </button>
                    <button
                      type="button"
                      className="secondary-btn small"
                      onClick={() => playSoundboard('airhorn', { volume: sbVolume })}
                    >
                      <Play size={12} /> 📯 Havalı Korna
                    </button>
                    <button
                      type="button"
                      className="secondary-btn small"
                      onClick={() => playUiSound('join')}
                    >
                      <Play size={12} /> 🔔 Giriş Sesi
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'profile' && firebaseMode && user && (
              <div className="modal-body">
                <form onSubmit={handleSaveProfile} className="modal-body" style={{ gap: 12 }}>
                  <div className="profile-avatar-row">
                    <div className="profile-avatar-preview" style={{ backgroundColor: avatarColor }}>
                      {avatarUrl ? (
                        <img src={avatarUrl} alt={displayName} />
                      ) : (
                        <span>{(displayName || user.username).slice(0, 1).toUpperCase()}</span>
                      )}
                    </div>
                    <div className="row-gap">
                      <input
                        ref={avatarFileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleAvatarUpload(f);
                          e.target.value = '';
                        }}
                      />
                      <button
                        type="button"
                        className="secondary-btn small"
                        onClick={() => avatarFileRef.current?.click()}
                      >
                        <Camera size={14} /> Fotoğraf Yükle
                      </button>
                      {avatarUrl && (
                        <button
                          type="button"
                          className="action-pill danger"
                          onClick={() => setAvatarUrl(null)}
                        >
                          <Trash2 size={14} /> Kaldır
                        </button>
                      )}
                    </div>
                  </div>

                  <label className="stack-field">
                    <span>Görünen İsim</span>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="dark-input"
                      maxLength={32}
                      required
                    />
                  </label>

                  <div className="stack-field">
                    <span>Avatar Rengi</span>
                    <div className="swatch-row">
                      {COLOR_SWATCHES.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`color-swatch ${avatarColor === c ? 'active' : ''}`}
                          style={{ backgroundColor: c }}
                          onClick={() => setAvatarColor(c)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="stack-field">
                    <span>Çevrimiçi Durumu</span>
                    <div className="status-grid">
                      {STATUS_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          className={`status-pill-btn ${status === opt.value ? 'active' : ''}`}
                          onClick={() => setStatus(opt.value)}
                        >
                          <span className="status-dot-sm" style={{ backgroundColor: opt.color }} />
                          <span>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="stack-field">
                    <span>Özel Durum Mesajı (Opsiyonel)</span>
                    <input
                      type="text"
                      value={customStatus}
                      onChange={(e) => setCustomStatus(e.target.value)}
                      className="dark-input"
                      placeholder="Örn: Valorant oynuyor / Afk 5 dk"
                      maxLength={60}
                    />
                  </label>

                  {profileErr && <div className="form-error">{profileErr}</div>}
                  {profileSaved && <div className="form-success">{profileSaved}</div>}
                  <button
                    type="submit"
                    className="primary-btn small"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={profileBusy}
                  >
                    {profileBusy ? 'Kaydediliyor...' : 'Profili Kaydet'}
                  </button>
                </form>

                <form onSubmit={handlePasswordChange} className="diag-box" style={{ gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <KeyRound size={14} />
                    <strong>Şifre Değiştir</strong>
                  </div>
                  <div className="settings-grid">
                    <input
                      type="password"
                      value={curPwd}
                      onChange={(e) => setCurPwd(e.target.value)}
                      placeholder="Mevcut şifre"
                      className="dark-input"
                      required
                    />
                    <input
                      type="password"
                      value={newPwd}
                      onChange={(e) => setNewPwd(e.target.value)}
                      placeholder="Yeni şifre (min 6)"
                      className="dark-input"
                      minLength={6}
                      required
                    />
                  </div>
                  {pwdErr && <div className="form-error">{pwdErr}</div>}
                  {pwdStatus && <div className="form-success">{pwdStatus}</div>}
                  <button
                    type="submit"
                    className="secondary-btn small"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={pwdBusy}
                  >
                    {pwdBusy ? 'Güncelleniyor...' : 'Şifreyi Güncelle'}
                  </button>
                </form>
              </div>
            )}

            {activeTab === 'connection' && (
              <div className="modal-body">
                <div className="diag-box" style={{ gap: 8 }}>
                  <div>
                    <strong>Aktif Oda / Sunucu:</strong>{' '}
                    {activeRoomId ? `${serverName} (${allUsers.length}/${MAX_ROOM_MEMBERS} üye)` : 'Oda seçili değil'}
                  </div>
                  <div>
                    <strong>Altyapı:</strong>{' '}
                    {firebaseMode ? 'Firebase Serverless (7/24 Spark Plan)' : serverUrl}
                  </div>
                  <div>
                    <strong>ICE / TURN:</strong> {iceServers.length} sunucu kayıtlı •{' '}
                    {turnEnabled ? 'TURN Aktif (CGNAT uyumlu)' : 'Sadece STUN (P2P)'}
                  </div>
                  {adminInviteCode && (
                    <div className="row-between" style={{ marginTop: 4, flexWrap: 'wrap', gap: 8 }}>
                      <span>
                        <strong>Davet Kodu:</strong> <code>{adminInviteCode}</code>
                      </span>
                      <button
                        type="button"
                        className="secondary-btn small"
                        onClick={() => {
                          const text = currentInviteLink(adminInviteCode) ?? adminInviteCode;
                          navigator.clipboard?.writeText(text).catch(() => {});
                          setCopiedInvite(true);
                          setTimeout(() => setCopiedInvite(false), 1500);
                        }}
                      >
                        <Copy size={13} /> {copiedInvite ? 'Kopyalandı' : 'Davet Linkini Kopyala'}
                      </button>
                    </div>
                  )}
                </div>

                {firebaseMode && (
                  <div className="diag-box" style={{ gap: 10 }}>
                    <strong>Odalarım ({rooms.length})</strong>
                    <span className="muted-text">
                      Birden fazla odaya/sunucuya davet linkiyle katılabilir veya kendi 10 kişilik
                      odanı oluşturup arkadaşlarına link gönderebilirsin.
                    </span>
                    <div className="row-gap" style={{ flexWrap: 'wrap' }}>
                      {onOpenRoomHub && (
                        <>
                          <button
                            type="button"
                            className="primary-btn small"
                            onClick={() => {
                              onClose();
                              onOpenRoomHub('join');
                            }}
                          >
                            <Link2 size={14} /> Davet Linkiyle Katıl
                          </button>
                          <button
                            type="button"
                            className="secondary-btn small"
                            onClick={() => {
                              onClose();
                              onOpenRoomHub('create');
                            }}
                          >
                            <Plus size={14} /> Yeni Oda Oluştur
                          </button>
                        </>
                      )}
                      {activeRoomId && (
                        <ConfirmButton
                          className="action-pill danger"
                          onConfirm={async () => {
                            await leaveCurrentRoom();
                            onClose();
                          }}
                          armedLabel={
                            <>
                              <LogOut size={13} /> Odadan ayrıl?
                            </>
                          }
                        >
                          <LogOut size={13} /> Aktif Odadan Ayrıl
                        </ConfirmButton>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'admin' && isAdmin && user && (
              <div className="modal-body">
                <div className="auth-tabs" style={{ marginBottom: 0 }}>
                  <button
                    type="button"
                    className={adminSubTab === 'general' ? 'active' : ''}
                    onClick={() => setAdminSubTab('general')}
                  >
                    Genel &amp; Davet
                  </button>
                  <button
                    type="button"
                    className={adminSubTab === 'members' ? 'active' : ''}
                    onClick={() => setAdminSubTab('members')}
                  >
                    Üyeler ({allUsers.length}/{MAX_ROOM_MEMBERS})
                  </button>
                  <button
                    type="button"
                    className={adminSubTab === 'turn' ? 'active' : ''}
                    onClick={() => setAdminSubTab('turn')}
                  >
                    Mobil Ses (TURN)
                  </button>
                </div>

                {adminStatus && <div className="form-success">{adminStatus}</div>}
                {adminErr && <div className="form-error">{adminErr}</div>}

                {adminSubTab === 'general' && (
                  <>
                    <form onSubmit={handleSaveAdminGeneral} className="auth-form">
                      <label>
                        <span>Oda / Sunucu Adı</span>
                        <input
                          type="text"
                          value={nameInput}
                          onChange={(e) => setNameInput(e.target.value)}
                          maxLength={32}
                          required
                        />
                      </label>

                      <label>
                        <span>Davet Kodu</span>
                        <div className="row-gap">
                          <input
                            type="text"
                            value={inviteInput}
                            onChange={(e) => setInviteInput(e.target.value)}
                            minLength={3}
                            maxLength={40}
                            style={{ flex: 1 }}
                            required
                          />
                          <button
                            type="button"
                            className="secondary-btn small"
                            onClick={() => setInviteInput(generateInviteCode())}
                            title="Yeni Kod Üret"
                          >
                            <RefreshCw size={14} />
                          </button>
                          <button
                            type="button"
                            className="secondary-btn small"
                            onClick={() => {
                              navigator.clipboard?.writeText(inviteInput).catch(() => {});
                              setAdminStatus('Davet kodu panoya kopyalandı.');
                            }}
                            title="Kodu Kopyala"
                          >
                            <Copy size={14} />
                          </button>
                        </div>
                      </label>

                      {inviteLink && (
                        <div className="invite-link-row">
                          <button
                            type="button"
                            className="secondary-btn small"
                            disabled={inviteDirty}
                            onClick={() => {
                              navigator.clipboard?.writeText(inviteLink).catch(() => {});
                              setAdminStatus(
                                'Davet linki kopyalandı — arkadaşın linke tıklayıp hemen katılabilir.',
                              );
                            }}
                          >
                            <Link2 size={14} /> Davet Linkini Kopyala
                          </button>
                          <span className="muted-text">
                            {inviteDirty ? 'Önce yeni kodu kaydet.' : inviteLink}
                          </span>
                        </div>
                      )}

                      <button type="submit" className="primary-btn" disabled={adminBusy}>
                        Ayarları Kaydet
                      </button>
                    </form>

                    {channels.length > 0 && (
                      <div className="diag-box">
                        <strong>Kanal Geçmişini Temizle</strong>
                        <div className="row-gap" style={{ marginTop: 6 }}>
                          <select
                            value={clearChannelId}
                            onChange={(e) => setClearChannelId(e.target.value)}
                            className="dark-select"
                            style={{ flex: 1 }}
                          >
                            {channels.map((ch) => (
                              <option key={ch.id} value={ch.id}>
                                {ch.kind === 'voice' ? `🔊 ${ch.name} (Oda Sohbeti)` : `#${ch.name}`}
                              </option>
                            ))}
                          </select>
                          <ConfirmButton
                            className="action-pill danger"
                            disabled={adminBusy || !clearChannelId}
                            onConfirm={handleClearMessages}
                            armedLabel={
                              <>
                                <Trash2 size={14} /> Emin misin?
                              </>
                            }
                          >
                            <Trash2 size={14} /> Tümünü Sil
                          </ConfirmButton>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {adminSubTab === 'members' && (
                  <>
                    <div className="muted-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Users size={14} />
                      <span>
                        Üye atıldığında {MAX_ROOM_MEMBERS} kişilik slotu boşalır ve yeni arkadaş
                        davet linkiyle katılabilir.
                      </span>
                    </div>
                    <div className="admin-member-list">
                      {allUsers.map((member) => {
                        const isSelf = member.id === user.id;
                        const isOnline = onlineIds.has(member.id);
                        return (
                          <div key={member.id} className="admin-member-row">
                            <div className="admin-member-info">
                              <span
                                className="mini-avatar"
                                style={{ backgroundColor: member.avatar_color }}
                              >
                                {member.display_name.slice(0, 1).toUpperCase()}
                              </span>
                              <div>
                                <div className="participant-name">
                                  {member.display_name}
                                  {member.role === 'admin' && (
                                    <span className="role-badge admin">ADMIN</span>
                                  )}
                                  {isSelf && <span className="you-tag">(Sen)</span>}
                                </div>
                                <div className="muted-text">
                                  @{member.username}
                                  {member.slot ? ` • Slot ${member.slot}` : ''}
                                  {' • '}
                                  {isOnline ? 'Çevrimiçi' : 'Çevrimdışı'}
                                </div>
                              </div>
                            </div>

                            {!isSelf && (
                              <div className="row-gap">
                                <button
                                  type="button"
                                  className="secondary-btn small"
                                  disabled={adminBusy}
                                  onClick={async () => {
                                    setAdminBusy(true);
                                    setAdminErr(null);
                                    try {
                                      const nextRole =
                                        member.role === 'admin' ? 'member' : 'admin';
                                      await setUserRole(member.id, nextRole);
                                      setAdminStatus(
                                        `${member.display_name} artık ${nextRole === 'admin' ? 'Admin' : 'Üye'}.`,
                                      );
                                    } catch (err) {
                                      setAdminErr(
                                        err instanceof Error ? err.message : 'Rol değiştirilemedi',
                                      );
                                    } finally {
                                      setAdminBusy(false);
                                    }
                                  }}
                                >
                                  <Shield size={13} />{' '}
                                  {member.role === 'admin' ? 'Üye Yap' : 'Admin Yap'}
                                </button>
                                <ConfirmButton
                                  className="action-pill danger"
                                  disabled={adminBusy}
                                  onConfirm={async () => {
                                    setAdminBusy(true);
                                    setAdminErr(null);
                                    try {
                                      await kickMember(member);
                                      setAdminStatus(`${member.display_name} odadan çıkarıldı.`);
                                    } catch (err) {
                                      setAdminErr(
                                        err instanceof Error ? err.message : 'Üye atılamadı',
                                      );
                                    } finally {
                                      setAdminBusy(false);
                                    }
                                  }}
                                  armedLabel={
                                    <>
                                      <UserMinus size={13} /> Atılsın mı?
                                    </>
                                  }
                                >
                                  <UserMinus size={13} /> At
                                </ConfirmButton>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {adminSubTab === 'turn' && (
                  <>
                    <div className="diag-box">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <Radio size={15} style={{ color: '#5865F2' }} />
                        <strong>Cloudflare TURN (Ayda 1.000 GB Ücretsiz)</strong>
                      </div>
                      <span className="muted-text">
                        4.5G/5G mobil veri ve çift CGNAT ağlarında sesin kesintisiz akması için{' '}
                        <code>cloudflare-turn-worker</code> URL&apos;ini yapıştır.
                      </span>
                    </div>

                    <form onSubmit={handleSaveTurn} className="auth-form">
                      <label>
                        <span>Cloudflare TURN Worker URL (Önerilen)</span>
                        <input
                          type="url"
                          value={workerUrl}
                          onChange={(e) => setWorkerUrl(e.target.value)}
                          placeholder="https://squadvoice-turn.hesabin.workers.dev/turn"
                        />
                      </label>

                      <details>
                        <summary className="muted-text" style={{ cursor: 'pointer' }}>
                          Alternatif: Manuel Statik TURN Sunucusu (Opsiyonel)
                        </summary>
                        <div className="auth-form" style={{ marginTop: 10 }}>
                          <label>
                            <span>TURN URL</span>
                            <input
                              type="text"
                              value={turnUrl}
                              onChange={(e) => setTurnUrl(e.target.value)}
                              placeholder="turn:global.relay.metered.ca:80"
                            />
                          </label>
                          <label>
                            <span>TURN Username</span>
                            <input
                              type="text"
                              value={turnUsername}
                              onChange={(e) => setTurnUsername(e.target.value)}
                              placeholder="Opsiyonel kullanıcı adı"
                            />
                          </label>
                          <label>
                            <span>TURN Credential</span>
                            <input
                              type="text"
                              value={turnCredential}
                              onChange={(e) => setTurnCredential(e.target.value)}
                              placeholder="Opsiyonel şifre"
                            />
                          </label>
                        </div>
                      </details>

                      <div className="row-gap">
                        <button
                          type="submit"
                          className="primary-btn"
                          style={{ flex: 1 }}
                          disabled={adminBusy}
                        >
                          TURN Kaydet &amp; Bağlantıları Yenile
                        </button>
                        {turnConfig && (
                          <button
                            type="button"
                            className="action-pill danger"
                            disabled={adminBusy}
                            onClick={async () => {
                              setAdminBusy(true);
                              try {
                                await updateTurnConfig(null);
                                setWorkerUrl('');
                                setTurnUrl('');
                                setTurnUsername('');
                                setTurnCredential('');
                                setAdminStatus('TURN kaldırıldı.');
                              } finally {
                                setAdminBusy(false);
                              }
                            }}
                          >
                            Kaldır
                          </button>
                        )}
                      </div>
                    </form>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
