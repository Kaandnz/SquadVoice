import { FormEvent, useEffect, useState } from 'react';
import {
  Copy,
  Crown,
  Radio,
  RefreshCw,
  Shield,
  Trash2,
  UserMinus,
  Users,
  X,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { TurnConfig } from '../types/protocol';
import { ConfirmButton } from './ConfirmButton';

interface AdminPanelModalProps {
  open: boolean;
  onClose: () => void;
}

export function AdminPanelModal({ open, onClose }: AdminPanelModalProps) {
  const {
    user,
    serverName,
    adminInviteCode,
    turnConfig,
    allUsers,
    onlineUsers,
    channels,
    updateServerName,
    updateInviteCode,
    updateTurnConfig,
    setUserRole,
    kickMember,
    clearChannelMessages,
  } = useAppStore();

  const [tab, setTab] = useState<'general' | 'members' | 'turn'>('general');
  const [nameInput, setNameInput] = useState(serverName);
  const [inviteInput, setInviteInput] = useState(adminInviteCode || '');
  const [clearChannelId, setClearChannelId] = useState('');
  const [workerUrl, setWorkerUrl] = useState(turnConfig?.workerUrl || '');
  const [turnUrl, setTurnUrl] = useState(turnConfig?.url || '');
  const [turnUsername, setTurnUsername] = useState(turnConfig?.username || '');
  const [turnCredential, setTurnCredential] = useState(turnConfig?.credential || '');

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onlineIds = new Set(onlineUsers.map((u) => u.id));

  useEffect(() => {
    if (!open) return;
    setNameInput(serverName);
    setInviteInput(adminInviteCode || '');
    setWorkerUrl(turnConfig?.workerUrl || '');
    setTurnUrl(turnConfig?.url || '');
    setTurnUsername(turnConfig?.username || '');
    setTurnCredential(turnConfig?.credential || '');
    setClearChannelId((prev) => prev || channels[0]?.id || '');
    setStatusMsg(null);
    setErrMsg(null);
  }, [open, serverName, adminInviteCode, turnConfig]);

  if (!open || user?.role !== 'admin') return null;

  const generateCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'SQUAD-';
    for (let i = 0; i < 4; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    setInviteInput(code);
  };

  const handleSaveGeneral = async (e: FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    setErrMsg(null);
    setBusy(true);
    try {
      await updateServerName(nameInput);
      if (inviteInput.trim()) {
        await updateInviteCode(inviteInput);
      }
      setStatusMsg('Sunucu adı ve davet kodu güncellendi.');
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Kaydedilemedi.');
    } finally {
      setBusy(false);
    }
  };

  const handleClearMessages = async () => {
    if (!clearChannelId) return;
    setStatusMsg(null);
    setErrMsg(null);
    setBusy(true);
    try {
      await clearChannelMessages(clearChannelId);
      setStatusMsg('Seçilen kanalın tüm mesajları temizlendi.');
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Mesajlar silinemedi.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveTurn = async (e: FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    setErrMsg(null);
    setBusy(true);
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
      setStatusMsg(
        hasAny
          ? 'TURN ayarı kaydedildi ve ses odasındaki tüm arkadaşlara anında aktarıldı!'
          : 'TURN devre dışı bırakıldı (Sadece STUN).',
      );
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'TURN ayarlanamadı.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Crown size={18} style={{ color: '#f0b232' }} />
            <h3>Admin Yönetim Paneli</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="auth-tabs" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={tab === 'general' ? 'active' : ''}
            onClick={() => setTab('general')}
          >
            Genel &amp; Davet
          </button>
          <button
            type="button"
            className={tab === 'members' ? 'active' : ''}
            onClick={() => setTab('members')}
          >
            Üyeler ({allUsers.length}/5)
          </button>
          <button
            type="button"
            className={tab === 'turn' ? 'active' : ''}
            onClick={() => setTab('turn')}
          >
            Mobil Ses (TURN)
          </button>
        </div>

        {statusMsg && <div className="form-success">{statusMsg}</div>}
        {errMsg && <div className="form-error">{errMsg}</div>}

        {tab === 'general' && (
          <div className="modal-body">
            <form onSubmit={handleSaveGeneral} className="auth-form">
              <label>
                <span>Sunucu Adı</span>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  maxLength={32}
                  required
                />
              </label>

              <label>
                <span>Ekip Davet Kodu</span>
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
                    onClick={generateCode}
                    title="Yeni Kod Üret"
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button
                    type="button"
                    className="secondary-btn small"
                    onClick={() => {
                      navigator.clipboard?.writeText(inviteInput).catch(() => {});
                      setStatusMsg('Davet kodu panoya kopyalandı.');
                    }}
                    title="Kopyala"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </label>

              <button type="submit" className="primary-btn" disabled={busy}>
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
                    disabled={busy || !clearChannelId}
                    onConfirm={handleClearMessages}
                    armedLabel={
                      <>
                        <Trash2 size={14} /> Geri alınamaz — emin misin?
                      </>
                    }
                  >
                    <Trash2 size={14} /> Tümünü Sil
                  </ConfirmButton>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'members' && (
          <div className="modal-body">
            <div className="muted-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Users size={14} />
              <span>
                Üye atıldığında 5 kişilik slotu boşalır ve yeni arkadaş davet koduyla katılabilir.
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
                          {member.email && !member.email.endsWith('@squadvoice.app')
                            ? ` • ${member.email}`
                            : ''}
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
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            setErrMsg(null);
                            try {
                              const nextRole = member.role === 'admin' ? 'member' : 'admin';
                              await setUserRole(member.id, nextRole);
                              setStatusMsg(
                                `${member.display_name} artık ${nextRole === 'admin' ? 'Admin' : 'Üye'}.`,
                              );
                            } catch (err) {
                              setErrMsg(err instanceof Error ? err.message : 'Rol değiştirilemedi');
                            } finally {
                              setBusy(false);
                            }
                          }}
                          title="Rolü Değiştir"
                        >
                          <Shield size={13} />{' '}
                          {member.role === 'admin' ? 'Üye Yap' : 'Admin Yap'}
                        </button>
                        <ConfirmButton
                          className="action-pill danger"
                          disabled={busy}
                          onConfirm={async () => {
                            setBusy(true);
                            setErrMsg(null);
                            try {
                              await kickMember(member);
                              setStatusMsg(`${member.display_name} sunucudan çıkarıldı.`);
                            } catch (err) {
                              setErrMsg(err instanceof Error ? err.message : 'Üye atılamadı');
                            } finally {
                              setBusy(false);
                            }
                          }}
                          title="Sunucudan At"
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
          </div>
        )}

        {tab === 'turn' && (
          <div className="modal-body">
            <div className="diag-box">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Radio size={15} style={{ color: '#5865F2' }} />
                <strong>Cloudflare TURN (Ayda 1.000 GB Ücretsiz)</strong>
              </div>
              <span className="muted-text">
                4.5G/5G mobil veri ve çift CGNAT ağlarında sesin kesintisiz akması için{' '}
                <code>cloudflare-turn-worker</code> kurup aşağıya Worker URL&apos;ini yapıştır.
                Ev internetinde otomatik P2P bağlanır ve TURN kotası yemez.
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
                      placeholder="turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443"
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
                <button type="submit" className="primary-btn" style={{ flex: 1 }} disabled={busy}>
                  TURN Kaydet &amp; Bağlantıları Yenile
                </button>
                {turnConfig && (
                  <button
                    type="button"
                    className="action-pill danger"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await updateTurnConfig(null);
                        setWorkerUrl('');
                        setTurnUrl('');
                        setTurnUsername('');
                        setTurnCredential('');
                        setStatusMsg('TURN kaldırıldı.');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Kaldır
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
