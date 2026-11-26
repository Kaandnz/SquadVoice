import { Crown, MessageCircle } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { PublicUser, UserStatus } from '../types/protocol';

const STATUS_COLORS: Record<UserStatus, string> = {
  online: '#23a55a',
  idle: '#f0b232',
  dnd: '#f23f42',
  invisible: '#6d727c',
};

export function MemberList() {
  const {
    firebaseMode,
    user,
    allUsers,
    onlineUsers,
    memberListOpen,
    openDm,
  } = useAppStore();

  if (!memberListOpen) return null;

  const onlineMap = new Map(onlineUsers.map((u) => [u.id, u]));

  const onlineMembers: PublicUser[] = [];
  const offlineMembers: PublicUser[] = [];

  for (const m of allUsers) {
    const live = onlineMap.get(m.id);
    const merged = live ? { ...m, ...live } : m;
    const isVisibleOnline = Boolean(live) && merged.status !== 'invisible';
    if (isVisibleOnline) {
      onlineMembers.push(merged);
    } else {
      offlineMembers.push(merged);
    }
  }

  const renderMember = (member: PublicUser, isOnline: boolean) => {
    const isSelf = member.id === user?.id;
    const dotColor = isOnline ? STATUS_COLORS[member.status ?? 'online'] : '#6d727c';
    return (
      <div
        key={member.id}
        className={`member-list-item ${isOnline ? 'online' : 'offline'}`}
      >
        <div className="avatar-wrap">
          <span
            className="avatar-circle sm"
            style={{ backgroundColor: member.avatar_color }}
          >
            {member.avatar_url ? (
              <img src={member.avatar_url} alt={member.display_name} />
            ) : (
              member.display_name.slice(0, 1).toUpperCase()
            )}
          </span>
          <span className="avatar-status-dot" style={{ backgroundColor: dotColor }} />
        </div>

        <div className="member-item-meta">
          <div className="member-item-name">
            <span>{member.display_name}</span>
            {member.role === 'admin' && (
              <Crown size={12} style={{ color: '#f0b232', flexShrink: 0 }} />
            )}
          </div>
          {member.custom_status && (
            <div className="member-item-sub">{member.custom_status}</div>
          )}
        </div>

        {firebaseMode && !isSelf && (
          <button
            type="button"
            className="icon-btn tiny dm-trigger"
            title={`${member.display_name} ile özel sohbet`}
            onClick={() => openDm(member.id)}
          >
            <MessageCircle size={14} />
          </button>
        )}
      </div>
    );
  };

  return (
    <aside className="member-list-panel">
      <div className="member-group-title">ÇEVRİMİÇİ — {onlineMembers.length}</div>
      {onlineMembers.map((m) => renderMember(m, true))}

      <div className="member-group-title" style={{ marginTop: 14 }}>
        ÇEVRİMDIŞI — {offlineMembers.length}
      </div>
      {offlineMembers.map((m) => renderMember(m, false))}
    </aside>
  );
}
