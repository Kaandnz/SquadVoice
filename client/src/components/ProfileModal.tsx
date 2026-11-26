import { FormEvent, useEffect, useRef, useState } from 'react';
import { Camera, Trash2, User, X } from 'lucide-react';
import { compressAvatarToDataUrl } from '../lib/imageCompress';
import { useAppStore } from '../store/useAppStore';
import type { UserStatus } from '../types/protocol';

interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
}

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

export function ProfileModal({ open, onClose }: ProfileModalProps) {
  const { user, updateOwnProfile } = useAppStore();

  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState('#5865F2');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<UserStatus>('online');
  const [customStatus, setCustomStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open || !user) return;
    setDisplayName(user.display_name);
    setAvatarColor(user.avatar_color);
    setAvatarUrl(user.avatar_url ?? null);
    setStatus(user.status ?? 'online');
    setCustomStatus(user.custom_status ?? '');
    setErr(null);
    setSavedMsg(null);
  }, [open, user]);

  if (!open || !user) return null;

  const handleAvatarUpload = async (file: File) => {
    setErr(null);
    try {
      const compressed = await compressAvatarToDataUrl(file);
      setAvatarUrl(compressed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Fotoğraf yüklenemedi.');
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSavedMsg(null);
    setBusy(true);
    try {
      await updateOwnProfile({
        display_name: displayName,
        avatar_color: avatarColor,
        avatar_url: avatarUrl,
        status,
        custom_status: customStatus.trim() || null,
      });
      setSavedMsg('Profilin güncellendi!');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Profil kaydedilemedi.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <User size={18} />
            <h3>Profil &amp; Durum</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
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
                ref={fileRef}
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
                onClick={() => fileRef.current?.click()}
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

          {err && <div className="form-error">{err}</div>}
          {savedMsg && <div className="form-success">{savedMsg}</div>}

          <div className="modal-footer">
            <button type="button" className="secondary-btn" onClick={onClose}>
              Kapat
            </button>
            <button type="submit" className="primary-btn" disabled={busy}>
              {busy ? 'Kaydediliyor...' : 'Kaydet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
