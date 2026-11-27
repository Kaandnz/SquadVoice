import { FormEvent, useEffect, useState } from 'react';
import { Link2, Plus, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { BrandLogo } from './BrandLogo';

interface RoomHubModalProps {
  open: boolean;
  initialTab?: 'join' | 'create';
  onClose: () => void;
}

const ROOM_COLORS = [
  '#5865F2',
  '#3BA55D',
  '#FAA61A',
  '#EB459E',
  '#ED4245',
  '#00AFF4',
  '#9B59B6',
  '#E67E22',
];

export function RoomHubModal({ open, initialTab = 'join', onClose }: RoomHubModalProps) {
  const { createRoom, joinRoomByInvite } = useAppStore();

  const [tab, setTab] = useState<'join' | 'create'>(initialTab);
  const [inviteInput, setInviteInput] = useState('');
  const [roomName, setRoomName] = useState('');
  const [iconColor, setIconColor] = useState(ROOM_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setInviteInput('');
    setRoomName('');
    setErr(null);
    setBusy(false);
  }, [open, initialTab]);

  if (!open) return null;

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    if (!inviteInput.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await joinRoomByInvite(inviteInput);
      onClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Odaya katılınamadı.');
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!roomName.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await createRoom(roomName, iconColor);
      onClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Oda oluşturulamadı.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <BrandLogo size={24} />
            <h3>Oda / Sunucu Ekle</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="auth-tabs" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={tab === 'join' ? 'active' : ''}
            onClick={() => {
              setTab('join');
              setErr(null);
            }}
          >
            <Link2 size={14} style={{ marginRight: 5, verticalAlign: -2 }} />
            Davet Linkiyle Katıl
          </button>
          <button
            type="button"
            className={tab === 'create' ? 'active' : ''}
            onClick={() => {
              setTab('create');
              setErr(null);
            }}
          >
            <Plus size={14} style={{ marginRight: 5, verticalAlign: -2 }} />
            Yeni Oda Oluştur
          </button>
        </div>

        {tab === 'join' ? (
          <form onSubmit={handleJoin} className="auth-form">
            <label>
              <span>Davet Linki veya Kodu</span>
              <input
                type="text"
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                placeholder="https://.../?davet=SQUAD-XXXX veya SQUAD-XXXX"
                autoFocus
                required
              />
            </label>
            <span className="muted-text">
              Arkadaşının gönderdiği davet linkini yapıştır; bu sunucu/oda sol şeridine eklenir ve
              istediğin zaman odalar arasında geçiş yapabilirsin.
            </span>
            {err && <div className="form-error">{err}</div>}
            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={onClose}>
                İptal
              </button>
              <button type="submit" className="primary-btn" disabled={busy}>
                {busy ? 'Katılınıyor...' : 'Odaya Katıl'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleCreate} className="auth-form">
            <label>
              <span>Sunucu / Oda Adı</span>
              <input
                type="text"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="Örn: Valorant Ekibi, Gece Tayfa"
                maxLength={32}
                autoFocus
                required
              />
            </label>

            <div className="stack-field">
              <span>Oda Rengi</span>
              <div className="swatch-row">
                {ROOM_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`color-swatch ${iconColor === c ? 'active' : ''}`}
                    style={{ backgroundColor: c }}
                    onClick={() => setIconColor(c)}
                  />
                ))}
              </div>
            </div>

            <span className="muted-text">
              Yeni odada otomatik <strong>Admin</strong> olursun, en fazla <strong>10 kişi</strong>{' '}
              katılabilir ve sana özel paylaşılabilir bir davet linki oluşturulur.
            </span>
            {err && <div className="form-error">{err}</div>}
            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={onClose}>
                İptal
              </button>
              <button type="submit" className="primary-btn" disabled={busy}>
                {busy ? 'Oluşturuluyor...' : 'Odayı Oluştur'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
