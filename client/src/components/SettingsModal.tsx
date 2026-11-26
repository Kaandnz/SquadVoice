import { FormEvent, useEffect, useState } from 'react';
import { Copy, KeyRound, Settings, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useMicLevelStore } from '../store/useMicLevelStore';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const {
    firebaseMode,
    adminInviteCode,
    audioSettings,
    turnEnabled,
    iceServers,
    serverUrl,
    updateAudioSettings,
    changePassword,
  } = useAppStore();
  const micLevel = useMicLevelStore((s) => s.micLevel);

  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [capturingKey, setCapturingKey] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);

  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdStatus, setPwdStatus] = useState<string | null>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);
  const [pwdBusy, setPwdBusy] = useState(false);

  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setInputs(devices.filter((d) => d.kind === 'audioinput'));
        setOutputs(devices.filter((d) => d.kind === 'audiooutput'));
      })
      .catch(() => {});
  }, [open]);

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Settings size={18} />
            <h3>Ses &amp; Bağlantı Ayarları</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

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
              <span>
                Mikrofon Hassasiyeti (Ses Kapısı:{' '}
                {audioSettings.vadThreshold === 0
                  ? 'Kapalı (Hep Açık)'
                  : audioSettings.vadThreshold}
                )
              </span>
              <span className="muted-text">Canlı Seviye: {micLevel}%</span>
            </div>
            <div className="mic-meter-track">
              <div
                className="mic-meter-fill"
                style={{
                  width: `${micLevel}%`,
                  backgroundColor:
                    audioSettings.vadThreshold === 0 || micLevel >= audioSettings.vadThreshold
                      ? '#3BA55D'
                      : '#72767D',
                }}
              />
              <div
                className="mic-meter-threshold"
                style={{ left: `${audioSettings.vadThreshold}%` }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={60}
              value={audioSettings.vadThreshold}
              onChange={(e) =>
                updateAudioSettings({ vadThreshold: Number(e.target.value) })
              }
            />
            <span className="muted-text" style={{ fontSize: '0.75rem' }}>
              Eşiğin altındaki cızırtı, fan ve klavye sesi otomatik kesilir (0 = kapı kapalı).
            </span>
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
                <strong>Gürültü Azaltma (Noise Suppression)</strong>
                <p>Cızırtı filtresi (8.5 kHz), dip gürültü ve klavye/fan sesini bastırır.</p>
              </div>
              <input
                type="checkbox"
                checked={audioSettings.noiseSuppression}
                onChange={(e) =>
                  updateAudioSettings({ noiseSuppression: e.target.checked })
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

            <label className="toggle-row">
              <div>
                <strong>Discord Ses Efektleri</strong>
                <p>Odaya giriş/çıkış, susturma ve mesaj bildirim seslerini çalar.</p>
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

          {audioSettings.pttEnabled && (
            <div className="ptt-bind-row">
              <span>Bas-Konuş Tuşu: <code>{audioSettings.pttKey}</code></span>
              <button
                type="button"
                className="secondary-btn small"
                onClick={() => setCapturingKey(true)}
              >
                {capturingKey ? 'Bir Tuşa Bas...' : 'Tuş Ata'}
              </button>
            </div>
          )}

          {firebaseMode && (
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
              <button type="submit" className="secondary-btn small" disabled={pwdBusy}>
                {pwdBusy ? 'Güncelleniyor...' : 'Şifreyi Güncelle'}
              </button>
            </form>
          )}

          <div className="diag-box">
            <div>
              <strong>Altyapı:</strong>{' '}
              {firebaseMode ? 'Firebase Serverless (7/24 Spark Plan)' : serverUrl}
            </div>
            <div>
              <strong>ICE / TURN:</strong> {iceServers.length} sunucu kayıtlı •{' '}
              {turnEnabled ? 'TURN Aktif (CGNAT uyumlu)' : 'Sadece STUN (P2P)'}
            </div>
            {adminInviteCode && (
              <div className="row-between" style={{ marginTop: 4 }}>
                <span>
                  <strong>Davet Kodu:</strong> <code>{adminInviteCode}</code>
                </span>
                <button
                  type="button"
                  className="secondary-btn small"
                  onClick={() => {
                    navigator.clipboard?.writeText(adminInviteCode).catch(() => {});
                    setCopiedInvite(true);
                    setTimeout(() => setCopiedInvite(false), 1500);
                  }}
                >
                  <Copy size={13} /> {copiedInvite ? 'Kopyalandı' : 'Kopyala'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
