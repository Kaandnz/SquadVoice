import { ClipboardEvent, FormEvent, useEffect, useRef, useState } from 'react';
import {
  AtSign,
  Check,
  CornerUpLeft,
  Hash,
  ImagePlus,
  Pencil,
  Pin,
  Search,
  Send,
  Smile,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { compressImageToDataUrl } from '../lib/imageCompress';
import { parseMarkdown } from '../lib/markdown';
import { resolveAssetUrl } from '../lib/platform';
import { useAppStore } from '../store/useAppStore';
import type { Message, MessageReplyRef } from '../types/protocol';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🔥', '🎮', '👀', '🏆', '😮'];

function MarkdownMessage({ content }: { content: string }) {
  const tokens = parseMarkdown(content);
  return (
    <div className="message-text">
      {tokens.map((tok, i) => {
        switch (tok.type) {
          case 'bold':
            return <strong key={i}>{tok.text}</strong>;
          case 'italic':
            return <em key={i}>{tok.text}</em>;
          case 'code':
            return (
              <code key={i} className="inline-code">
                {tok.text}
              </code>
            );
          case 'codeblock':
            return (
              <pre key={i} className="code-block">
                <code>{tok.text}</code>
              </pre>
            );
          case 'mention':
            return (
              <span key={i} className="mention-pill">
                {tok.text}
              </span>
            );
          case 'link':
            return (
              <a
                key={i}
                href={tok.url}
                target="_blank"
                rel="noopener noreferrer"
                className="msg-link"
              >
                {tok.url}
              </a>
            );
          default:
            return <span key={i}>{tok.text}</span>;
        }
      })}
    </div>
  );
}

export function ChatPanel() {
  const {
    firebaseMode,
    user,
    serverUrl,
    token,
    channels,
    allUsers,
    activeTextChannelId,
    activeDmUserId,
    messagesByChannel,
    dmMessagesByPeer,
    typingUsers,
    memberListOpen,
    sendMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    togglePinMessage,
    setTyping,
    toggleMemberList,
  } = useAppStore();

  const [text, setText] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<{
    url: string;
    name: string;
  } | null>(null);
  const [replyTo, setReplyTo] = useState<MessageReplyRef | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [reactionPickerMsgId, setReactionPickerMsgId] = useState<string | null>(null);
  const [composerEmojiOpen, setComposerEmojiOpen] = useState(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pinsOpen, setPinsOpen] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [zoomedImg, setZoomedImg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<number | null>(null);

  const activeChannel = channels.find((c) => c.id === activeTextChannelId);
  const dmPeer = activeDmUserId ? allUsers.find((u) => u.id === activeDmUserId) : null;

  const rawMessages: Message[] = activeDmUserId
    ? dmMessagesByPeer[activeDmUserId] || []
    : activeTextChannelId
      ? messagesByChannel[activeTextChannelId] || []
      : [];

  const filteredMessages = searchQuery.trim()
    ? rawMessages.filter((m) =>
        m.content.toLowerCase().includes(searchQuery.trim().toLowerCase()) ||
        m.display_name.toLowerCase().includes(searchQuery.trim().toLowerCase()),
      )
    : rawMessages;

  const pinnedMessages = rawMessages.filter((m) => Boolean(m.pinned));

  useEffect(() => {
    if (!searchQuery.trim()) {
      listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [rawMessages.length, activeTextChannelId, activeDmUserId, searchQuery]);

  useEffect(() => {
    setReplyTo(null);
    setEditingMsgId(null);
    setReactionPickerMsgId(null);
    setPinsOpen(false);
  }, [activeTextChannelId, activeDmUserId]);

  const handleUploadFile = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    try {
      if (firebaseMode) {
        const compressed = await compressImageToDataUrl(file);
        setPendingAttachment(compressed);
      } else {
        if (!token) return;
        const uploaded = await api.uploadImage(serverUrl, token, file);
        setPendingAttachment(uploaded);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Görsel yüklenemedi');
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleUploadFile(file);
          return;
        }
      }
    }
  };

  const handleTextChange = (val: string) => {
    setText(val);
    if (!firebaseMode) return;
    if (val.trim()) {
      setTyping(true);
      if (typingTimerRef.current !== null) {
        window.clearTimeout(typingTimerRef.current);
      }
      typingTimerRef.current = window.setTimeout(() => {
        setTyping(false);
      }, 3000);
    } else {
      setTyping(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() && !pendingAttachment) return;
    sendMessage(text.trim(), pendingAttachment, replyTo);
    setText('');
    setPendingAttachment(null);
    setReplyTo(null);
    setComposerEmojiOpen(false);
  };

  const handleSaveEdit = async (e: FormEvent, msgId: string) => {
    e.preventDefault();
    if (!editingContent.trim()) return;
    await editMessage(msgId, editingContent.trim());
    setEditingMsgId(null);
  };

  const headerTitle = dmPeer ? dmPeer.display_name : activeChannel?.name || 'genel';

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-left">
          {dmPeer ? <AtSign size={18} /> : <Hash size={18} />}
          <span>{headerTitle}</span>
          {dmPeer && <span className="badge-subtle">Özel Mesaj</span>}
        </div>

        <div className="chat-header-actions">
          {searchOpen ? (
            <div className="chat-search-box">
              <Search size={14} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Mesaj ara..."
                autoFocus
              />
              <button
                type="button"
                className="icon-btn tiny"
                onClick={() => {
                  setSearchQuery('');
                  setSearchOpen(false);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="icon-btn"
              title="Mesajlarda Ara"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={17} />
            </button>
          )}

          {firebaseMode && !dmPeer && (
            <button
              type="button"
              className={`icon-btn ${pinsOpen ? 'active-icon' : ''}`}
              title="Sabitlenmiş Mesajlar"
              onClick={() => setPinsOpen((v) => !v)}
            >
              <Pin size={17} />
            </button>
          )}

          <button
            type="button"
            className={`icon-btn ${memberListOpen ? 'active-icon' : ''}`}
            title="Üye Listesi"
            onClick={toggleMemberList}
          >
            <Users size={17} />
          </button>
        </div>
      </div>

      {pinsOpen && !dmPeer && (
        <div className="pinned-drawer">
          <div className="row-between" style={{ marginBottom: 8 }}>
            <strong>Sabitlenmiş Mesajlar ({pinnedMessages.length})</strong>
            <button type="button" className="icon-btn tiny" onClick={() => setPinsOpen(false)}>
              <X size={14} />
            </button>
          </div>
          {pinnedMessages.length === 0 ? (
            <div className="muted-text">Bu kanalda henüz sabitlenmiş mesaj yok.</div>
          ) : (
            <div className="pinned-list">
              {pinnedMessages.map((pm) => (
                <div key={pm.id} className="pinned-item">
                  <div>
                    <strong>{pm.display_name}:</strong> {pm.content || '(Görsel)'}
                  </div>
                  <button
                    type="button"
                    className="icon-btn tiny danger-hover"
                    onClick={() => togglePinMessage(pm.id, false)}
                    title="Sabitlemeyi kaldır"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="chat-messages">
        {filteredMessages.length === 0 ? (
          <div className="chat-empty">
            {dmPeer ? <AtSign size={36} /> : <Hash size={36} />}
            <h3>
              {searchQuery
                ? 'Aramana uygun mesaj bulunamadı'
                : dmPeer
                  ? `${dmPeer.display_name} ile özel sohbet`
                  : `#${activeChannel?.name || 'genel'} kanalına hoş geldin`}
            </h3>
            {!searchQuery && (
              <p>
                Markdown (**kalın**, `kod`), emoji tepkisi, yanıtlama veya Ctrl+V görsel
                destekli.
              </p>
            )}
          </div>
        ) : (
          filteredMessages.map((msg, idx) => {
            const prev = idx > 0 ? filteredMessages[idx - 1] : null;
            const grouped =
              !msg.reply_to &&
              prev &&
              prev.user_id === msg.user_id &&
              new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() <
                5 * 60 * 1000;

            const timeStr = new Date(msg.created_at).toLocaleTimeString('tr-TR', {
              hour: '2-digit',
              minute: '2-digit',
            });

            const isAuthor = user?.id === msg.user_id;
            const canDelete = firebaseMode && (user?.role === 'admin' || isAuthor);
            const isMentioningMe =
              Boolean(user) &&
              msg.content.toLowerCase().includes(`@${user!.username.toLowerCase()}`);

            const authorInfo = allUsers.find((u) => u.id === msg.user_id);
            const avatarSrc = authorInfo?.avatar_url ?? msg.avatar_url;

            const reactionEntries = Object.entries(msg.reactions || {}).filter(
              ([, usersMap]) => Object.keys(usersMap || {}).length > 0,
            );

            return (
              <div
                key={msg.id}
                className={`message-row ${grouped ? 'grouped' : ''} ${isMentioningMe ? 'mentioned' : ''}`}
              >
                {!grouped ? (
                  <span
                    className="avatar-circle"
                    style={{ backgroundColor: authorInfo?.avatar_color || msg.avatar_color }}
                  >
                    {avatarSrc ? (
                      <img src={avatarSrc} alt={msg.display_name} />
                    ) : (
                      msg.display_name.slice(0, 1).toUpperCase()
                    )}
                  </span>
                ) : (
                  <span className="message-gutter-time">{timeStr}</span>
                )}

                <div className="message-body">
                  {msg.reply_to && (
                    <div className="reply-snippet">
                      <CornerUpLeft size={12} />
                      <strong>@{msg.reply_to.display_name}</strong>
                      <span>{msg.reply_to.content || 'Görsel'}</span>
                    </div>
                  )}

                  {!grouped && (
                    <div className="message-meta">
                      <strong>{authorInfo?.display_name || msg.display_name}</strong>
                      <span>{timeStr}</span>
                      {msg.pinned && (
                        <span className="pin-tag">
                          <Pin size={10} /> Sabitli
                        </span>
                      )}
                    </div>
                  )}

                  {editingMsgId === msg.id ? (
                    <form
                      onSubmit={(e) => handleSaveEdit(e, msg.id)}
                      className="inline-edit-form"
                    >
                      <input
                        type="text"
                        value={editingContent}
                        onChange={(e) => setEditingContent(e.target.value)}
                        className="dark-input"
                        autoFocus
                      />
                      <button type="submit" className="icon-btn tiny">
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn tiny"
                        onClick={() => setEditingMsgId(null)}
                      >
                        <X size={14} />
                      </button>
                    </form>
                  ) : (
                    msg.content && (
                      <div className="message-content-line">
                        <MarkdownMessage content={msg.content} />
                        {msg.edited_at && <span className="edited-tag">(düzenlendi)</span>}
                      </div>
                    )
                  )}

                  {msg.attachment_url && (
                    <img
                      src={resolveAssetUrl(serverUrl, msg.attachment_url)}
                      alt={msg.attachment_name || 'Ek'}
                      className="message-image"
                      onClick={() =>
                        setZoomedImg(resolveAssetUrl(serverUrl, msg.attachment_url!))
                      }
                    />
                  )}

                  {reactionEntries.length > 0 && (
                    <div className="reaction-bar">
                      {reactionEntries.map(([emoji, map]) => {
                        const count = Object.keys(map).length;
                        const mine = Boolean(user && map[user.id]);
                        return (
                          <button
                            key={emoji}
                            type="button"
                            className={`reaction-chip ${mine ? 'active' : ''}`}
                            onClick={() => toggleReaction(msg.id, emoji, !mine)}
                          >
                            <span>{emoji}</span>
                            <span>{count}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {firebaseMode && (
                  <div className="message-hover-actions">
                    <button
                      type="button"
                      className="icon-btn tiny"
                      title="Tepki Ekle"
                      onClick={() =>
                        setReactionPickerMsgId(
                          reactionPickerMsgId === msg.id ? null : msg.id,
                        )
                      }
                    >
                      <Smile size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn tiny"
                      title="Yanıtla"
                      onClick={() =>
                        setReplyTo({
                          id: msg.id,
                          display_name: msg.display_name,
                          content: msg.content.slice(0, 80),
                        })
                      }
                    >
                      <CornerUpLeft size={13} />
                    </button>
                    {!dmPeer && (
                      <button
                        type="button"
                        className="icon-btn tiny"
                        title={msg.pinned ? 'Sabitlemeyi Kaldır' : 'Sabitle'}
                        onClick={() => togglePinMessage(msg.id, !msg.pinned)}
                      >
                        <Pin size={13} />
                      </button>
                    )}
                    {isAuthor && msg.content && (
                      <button
                        type="button"
                        className="icon-btn tiny"
                        title="Düzenle"
                        onClick={() => {
                          setEditingMsgId(msg.id);
                          setEditingContent(msg.content);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {canDelete && (activeTextChannelId || dmPeer) && (
                      <button
                        type="button"
                        className="icon-btn tiny danger-hover"
                        title="Sil"
                        onClick={() =>
                          deleteMessage(activeTextChannelId || 'dm', msg.id)
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    )}

                    {reactionPickerMsgId === msg.id && (
                      <div className="reaction-popover">
                        {QUICK_EMOJIS.map((em) => {
                          const mine = Boolean(user && msg.reactions?.[em]?.[user.id]);
                          return (
                            <button
                              key={em}
                              type="button"
                              onClick={() => {
                                toggleReaction(msg.id, em, !mine);
                                setReactionPickerMsgId(null);
                              }}
                            >
                              {em}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={listEndRef} />
      </div>

      {typingUsers.length > 0 && (
        <div className="typing-indicator">
          <span className="typing-dots" />
          <span>
            {typingUsers.map((u) => u.display_name).join(', ')} yazıyor...
          </span>
        </div>
      )}

      {(replyTo || pendingAttachment || uploadError) && (
        <div className="attachment-preview-bar">
          {replyTo && (
            <div className="reply-compose-chip">
              <CornerUpLeft size={13} />
              <span>
                <strong>@{replyTo.display_name}</strong> yanıtlanıyor
              </span>
              <button
                type="button"
                className="icon-btn tiny"
                onClick={() => setReplyTo(null)}
              >
                <X size={13} />
              </button>
            </div>
          )}
          {pendingAttachment && (
            <div className="attachment-chip">
              <img
                src={resolveAssetUrl(serverUrl, pendingAttachment.url)}
                alt={pendingAttachment.name}
              />
              <span>{pendingAttachment.name}</span>
              <button
                type="button"
                className="icon-btn tiny"
                onClick={() => setPendingAttachment(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {uploadError && <span className="form-error">{uploadError}</span>}
        </div>
      )}

      <form onSubmit={handleSubmit} className="chat-composer" style={{ position: 'relative' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUploadFile(file);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="icon-btn"
          title="Görsel Yükle"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus size={19} />
        </button>
        <input
          type="text"
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onPaste={handlePaste}
          placeholder={
            dmPeer
              ? `@${dmPeer.display_name} kullanıcısına mesaj yaz...`
              : `#${activeChannel?.name || 'genel'} kanalına mesaj yaz...`
          }
          maxLength={4000}
        />
        <button
          type="button"
          className="icon-btn"
          title="Emoji Ekle"
          onClick={() => setComposerEmojiOpen((v) => !v)}
        >
          <Smile size={18} />
        </button>
        <button
          type="submit"
          className="primary-btn small"
          disabled={!text.trim() && !pendingAttachment}
        >
          <Send size={16} />
        </button>

        {composerEmojiOpen && (
          <div className="composer-emoji-popover">
            {QUICK_EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => {
                  setText((prev) => prev + em);
                  setComposerEmojiOpen(false);
                }}
              >
                {em}
              </button>
            ))}
          </div>
        )}
      </form>

      {zoomedImg && (
        <div className="modal-backdrop" onClick={() => setZoomedImg(null)}>
          <img src={zoomedImg} alt="Büyütülmüş görsel" className="zoomed-image" />
        </div>
      )}
    </div>
  );
}
