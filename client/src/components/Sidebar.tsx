import { FormEvent, useState } from 'react';
import {
  Check,
  Crown,
  Hash,
  HeadphoneOff,
  Headphones,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  Pencil,
  PhoneOff,
  Plus,
  Settings,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { UserStatus } from '../types/protocol';

interface SidebarProps {
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpenSettings: () => void;
  onOpenAdmin: () => void;
  onOpenProfile: () => void;
}

const STATUS_DOT: Record<UserStatus, string> = {
  online: '#23a55a',
  idle: '#f0b232',
  dnd: '#f23f42',
  invisible: '#6d727c',
};

export function Sidebar({
  mobileOpen,
  onCloseMobile,
  onOpenSettings,
  onOpenAdmin,
  onOpenProfile,
}: SidebarProps) {
  const {
    firebaseMode,
    serverName,
    user,
    wsStatus,
    channels,
    activeTextChannelId,
    activeDmUserId,
    unreadByChannel,
    activeVoiceChannelId,
    onlineUsers,
    allUsers,
    voiceMembers,
    muted,
    forceMuted,
    deafened,
    speaking,
    audioSettings,
    pttActive,
    selectTextChannel,
    openDm,
    joinVoice,
    leaveVoice,
    createChannel,
    renameChannel,
    deleteChannel,
    toggleMute,
    toggleDeafen,
    logout,
  } = useAppStore();

  const [creatingKind, setCreatingKind] = useState<'text' | 'voice' | null>(null);
  const [newChannelName, setNewChannelName] = useState('');
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editingChannelName, setEditingChannelName] = useState('');

  const textChannels = channels.filter((c) => c.kind === 'text');
  const voiceChannels = channels.filter((c) => c.kind === 'voice');
  const onlineMap = new Map(onlineUsers.map((u) => [u.id, u]));

  const handleCreateChannel = async (e: FormEvent) => {
    e.preventDefault();
    if (!creatingKind || !newChannelName.trim()) return;
    await createChannel(newChannelName.trim(), creatingKind);
    setNewChannelName('');
    setCreatingKind(null);
  };

  const handleRenameSubmit = async (e: FormEvent, channelId: string) => {
    e.preventDefault();
    if (editingChannelName.trim()) {
      await renameChannel(channelId, editingChannelName.trim());
    }
    setEditingChannelId(null);
  };

  const dmPeers = allUsers.filter((m) => m.id !== user?.id);

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} />}
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div>
            <h2>{serverName}</h2>
            <div className="connection-pill">
              <span className={`dot ${wsStatus}`} />
              <span>
                {wsStatus === 'connected'
                  ? `${onlineUsers.length}/5 Çevrimiçi`
                  : wsStatus === 'connecting'
                    ? 'Bağlanıyor...'
                    : 'Bağlantı Koptu'}
              </span>
            </div>
          </div>
          <div className="row-gap">
            {firebaseMode && user?.role === 'admin' && (
              <button
                type="button"
                className="icon-btn"
                title="Admin Yönetim Paneli"
                onClick={() => {
                  onOpenAdmin();
                  onCloseMobile();
                }}
              >
                <Crown size={18} style={{ color: '#f0b232' }} />
              </button>
            )}
            <button type="button" className="icon-btn mobile-only" onClick={onCloseMobile}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="sidebar-scroll">
          <div className="channel-section">
            <div className="section-title">
              <span>METİN KANALLARI</span>
              <button
                type="button"
                className="icon-btn tiny"
                title="Metin kanalı ekle"
                onClick={() => setCreatingKind(creatingKind === 'text' ? null : 'text')}
              >
                <Plus size={14} />
              </button>
            </div>
            {textChannels.map((ch) => {
              const unread = unreadByChannel[ch.id] || 0;
              const isActive = !activeDmUserId && activeTextChannelId === ch.id;
              return (
                <div key={ch.id} className={`channel-row ${isActive ? 'active' : ''}`}>
                  {editingChannelId === ch.id ? (
                    <form
                      onSubmit={(e) => handleRenameSubmit(e, ch.id)}
                      className="inline-rename-form"
                    >
                      <input
                        type="text"
                        value={editingChannelName}
                        onChange={(e) => setEditingChannelName(e.target.value)}
                        maxLength={32}
                        autoFocus
                      />
                      <button type="submit" className="icon-btn tiny">
                        <Check size={13} />
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="channel-btn"
                        onClick={() => {
                          selectTextChannel(ch.id);
                          onCloseMobile();
                        }}
                      >
                        <Hash size={16} />
                        <span>{ch.name}</span>
                      </button>
                      {unread > 0 && <span className="unread-badge">{unread}</span>}
                      {firebaseMode && user?.role === 'admin' && (
                        <button
                          type="button"
                          className="icon-btn tiny"
                          title="Kanal adını değiştir"
                          onClick={() => {
                            setEditingChannelId(ch.id);
                            setEditingChannelName(ch.name);
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                      {user?.role === 'admin' && textChannels.length > 1 && (
                        <button
                          type="button"
                          className="icon-btn tiny danger-hover"
                          title="Kanalı sil"
                          onClick={() => deleteChannel(ch.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="channel-section">
            <div className="section-title">
              <span>SES &amp; YAYIN KANALLARI</span>
              <button
                type="button"
                className="icon-btn tiny"
                title="Ses kanalı ekle"
                onClick={() => setCreatingKind(creatingKind === 'voice' ? null : 'voice')}
              >
                <Plus size={14} />
              </button>
            </div>
            {voiceChannels.map((ch) => {
              const members = voiceMembers.filter((m) => m.channel_id === ch.id);
              const isJoined = activeVoiceChannelId === ch.id;
              const unread = unreadByChannel[ch.id] || 0;
              const isVoiceChatOpen = !activeDmUserId && activeTextChannelId === ch.id;
              return (
                <div key={ch.id} className="voice-group">
                  <div className={`channel-row ${isJoined ? 'active-voice' : ''}`}>
                    {editingChannelId === ch.id ? (
                      <form
                        onSubmit={(e) => handleRenameSubmit(e, ch.id)}
                        className="inline-rename-form"
                      >
                        <input
                          type="text"
                          value={editingChannelName}
                          onChange={(e) => setEditingChannelName(e.target.value)}
                          maxLength={32}
                          autoFocus
                        />
                        <button type="submit" className="icon-btn tiny">
                          <Check size={13} />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="channel-btn"
                          onClick={() => {
                            if (isJoined) {
                              selectTextChannel(ch.id);
                            } else {
                              joinVoice(ch.id);
                            }
                            onCloseMobile();
                          }}
                        >
                          <Volume2 size={16} />
                          <span>{ch.name}</span>
                        </button>
                        {unread > 0 && <span className="unread-badge">{unread}</span>}
                        <button
                          type="button"
                          className={`icon-btn tiny ${isVoiceChatOpen ? 'active-icon' : ''}`}
                          title="Oda sohbetini aç"
                          onClick={() => {
                            selectTextChannel(ch.id);
                            onCloseMobile();
                          }}
                        >
                          <MessageSquare size={13} />
                        </button>
                        {firebaseMode && user?.role === 'admin' && (
                          <button
                            type="button"
                            className="icon-btn tiny"
                            title="Kanal adını değiştir"
                            onClick={() => {
                              setEditingChannelId(ch.id);
                              setEditingChannelName(ch.name);
                            }}
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                        {isJoined ? (
                          <button
                            type="button"
                            className="icon-btn tiny danger"
                            title="Sesten çık"
                            onClick={leaveVoice}
                          >
                            <PhoneOff size={13} />
                          </button>
                        ) : (
                          user?.role === 'admin' &&
                          voiceChannels.length > 1 && (
                            <button
                              type="button"
                              className="icon-btn tiny danger-hover"
                              title="Kanalı sil"
                              onClick={() => deleteChannel(ch.id)}
                            >
                              <Trash2 size={13} />
                            </button>
                          )
                        )}
                      </>
                    )}
                  </div>

                  {members.length > 0 && (
                    <div className="voice-member-list">
                      {members.map((m) => (
                        <div key={m.user_id} className="voice-mini-member">
                          <span
                            className={`mini-avatar ${m.speaking ? 'speaking' : ''}`}
                            style={{ backgroundColor: m.avatar_color }}
                          >
                            {m.avatar_url ? (
                              <img src={m.avatar_url} alt={m.display_name} />
                            ) : (
                              m.display_name.slice(0, 1).toUpperCase()
                            )}
                          </span>
                          <span className="mini-name">{m.display_name}</span>
                          <span className="mini-badges">
                            {m.screen_sharing && (
                              <span className="live-pill">
                                <Monitor size={10} /> YAYIN
                              </span>
                            )}
                            {(m.muted || m.force_muted) && (
                              <MicOff size={12} className="muted-icon" />
                            )}
                            {m.deafened && <HeadphoneOff size={12} className="muted-icon" />}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {creatingKind && (
            <form onSubmit={handleCreateChannel} className="inline-channel-form">
              <input
                type="text"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                placeholder={
                  creatingKind === 'text' ? 'Yeni metin kanalı' : 'Yeni ses kanalı'
                }
                autoFocus
                maxLength={32}
              />
              <button type="submit" className="primary-btn small">
                Ekle
              </button>
            </form>
          )}

          {firebaseMode && dmPeers.length > 0 && (
            <div className="channel-section">
              <div className="section-title">
                <span>ÖZEL MESAJLAR (DM)</span>
              </div>
              {dmPeers.map((member) => {
                const live = onlineMap.get(member.id);
                const merged = live ? { ...member, ...live } : member;
                const isVisOnline = Boolean(live) && merged.status !== 'invisible';
                const dotColor = isVisOnline
                  ? STATUS_DOT[merged.status ?? 'online']
                  : '#6d727c';
                return (
                  <div
                    key={member.id}
                    className={`channel-row ${activeDmUserId === member.id ? 'active' : ''}`}
                  >
                    <button
                      type="button"
                      className="channel-btn"
                      onClick={() => {
                        openDm(member.id);
                        onCloseMobile();
                      }}
                    >
                      <span
                        className="mini-avatar"
                        style={{ backgroundColor: merged.avatar_color }}
                      >
                        {merged.avatar_url ? (
                          <img src={merged.avatar_url} alt={merged.display_name} />
                        ) : (
                          merged.display_name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span>{merged.display_name}</span>
                      <span
                        className="presence-dot"
                        style={{ backgroundColor: dotColor, marginLeft: 'auto' }}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="user-bar">
          <button
            type="button"
            className="user-info-btn"
            onClick={() => {
              if (firebaseMode) {
                onOpenProfile();
                onCloseMobile();
              }
            }}
            title={firebaseMode ? 'Profil & Durum Düzenle' : undefined}
          >
            <div className="avatar-wrap">
              <span
                className={`avatar-circle ${speaking && !muted && !deafened && !forceMuted ? 'speaking' : ''}`}
                style={{ backgroundColor: user?.avatar_color || '#5865F2' }}
              >
                {user?.avatar_url ? (
                  <img src={user.avatar_url} alt={user.display_name} />
                ) : (
                  (user?.display_name || '?').slice(0, 1).toUpperCase()
                )}
              </span>
              <span
                className="avatar-status-dot"
                style={{ backgroundColor: STATUS_DOT[user?.status ?? 'online'] }}
              />
            </div>
            <div className="user-meta">
              <div className="user-display">{user?.display_name}</div>
              <div className="user-sub">
                {forceMuted
                  ? 'Yönetici Susturdu'
                  : user?.custom_status
                    ? user.custom_status
                    : audioSettings.pttEnabled
                      ? pttActive
                        ? 'Bas-Konuş Aktif'
                        : `Bas-Konuş (${audioSettings.pttKey})`
                      : activeVoiceChannelId
                        ? 'Ses Bağlı'
                        : `@${user?.username}`}
              </div>
            </div>
          </button>

          <div className="user-controls">
            <button
              type="button"
              className={`icon-btn ${muted || forceMuted ? 'danger-active' : ''}`}
              title={
                forceMuted
                  ? 'Yönetici tarafından susturuldun'
                  : muted
                    ? 'Mikrofonu Aç'
                    : 'Mikrofonu Kapat'
              }
              onClick={toggleMute}
            >
              {muted || forceMuted ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
            <button
              type="button"
              className={`icon-btn ${deafened ? 'danger-active' : ''}`}
              title={deafened ? 'Sesi Aç' : 'Sağırlaştır'}
              onClick={toggleDeafen}
            >
              {deafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Ses & Bağlantı Ayarları"
              onClick={onOpenSettings}
            >
              <Settings size={17} />
            </button>
            <button
              type="button"
              className="icon-btn danger-hover"
              title="Çıkış Yap"
              onClick={logout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
