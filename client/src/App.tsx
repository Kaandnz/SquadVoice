import { lazy, Suspense, useEffect, useState } from 'react';
import { Link2, Menu, Plus, X } from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { BrandLogo } from './components/BrandLogo';
import { ChatPanel } from './components/ChatPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MemberList } from './components/MemberList';
import { OtherDeviceCallBanner } from './components/OtherDeviceCallBanner';
import { RoomHubModal } from './components/RoomHubModal';
import { Sidebar } from './components/Sidebar';
import { VoiceStage } from './components/VoiceStage';
import { useAppStore } from './store/useAppStore';
import type { SettingsTabId } from './types/protocol';

const loadSettingsModal = () => import('./components/SettingsModal');
const loadScreenShareModal = () => import('./components/ScreenShareModal');

const SettingsModal = lazy(() => loadSettingsModal().then((m) => ({ default: m.SettingsModal })));
const ScreenShareModal = lazy(() =>
  loadScreenShareModal().then((m) => ({ default: m.ScreenShareModal })),
);

const PRELOAD_DIALOGS_AFTER_MS = 3000;

export function App() {
  const {
    firebaseMode,
    serverName,
    activeRoomId,
    rooms,
    user,
    authLoading,
    activeVoiceChannelId,
    toastError,
    toastInfo,
    bootstrap,
    startScreenShare,
    clearToast,
  } = useAppStore();

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId | null>(null);
  const [roomHubTab, setRoomHubTab] = useState<'join' | 'create' | null>(null);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    const timer = window.setTimeout(() => {
      for (const load of [loadSettingsModal, loadScreenShareModal]) {
        load().catch(() => {});
      }
    }, PRELOAD_DIALOGS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsTab(null);
        setRoomHubTab(null);
        setShareModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (authLoading && !user) {
    return (
      <div className="loading-screen">
        <BrandLogo size={58} />
        <div className="spinner" style={{ marginTop: 14 }} />
        <p>SquadVoice bağlanıyor...</p>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  const needsRoom = firebaseMode && !activeRoomId && rooms.length === 0;

  return (
    <div className="app-shell">
      <ErrorBoundary area="Kanal listesi">
        <Sidebar
          mobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          onOpenSettings={(tab = 'audio') => setSettingsTab(tab)}
          onOpenRoomHub={(tab) => setRoomHubTab(tab)}
        />
      </ErrorBoundary>

      <main className="main-stage">
        <div className="mobile-topbar">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="Menüyü aç"
          >
            <Menu size={20} />
          </button>
          <strong>{activeRoomId || !firebaseMode ? serverName : 'SquadVoice'}</strong>
          <span className="mobile-status">
            {activeVoiceChannelId ? 'Seste' : 'Sohbet'}
          </span>
        </div>

        {toastError && (
          <div className="toast-error" role="alert">
            <span>{toastError}</span>
            <button type="button" className="icon-btn tiny" onClick={clearToast}>
              <X size={15} />
            </button>
          </div>
        )}
        {!toastError && toastInfo && (
          <div className="toast-info" role="status">
            <span>{toastInfo}</span>
            <button type="button" className="icon-btn tiny" onClick={clearToast}>
              <X size={15} />
            </button>
          </div>
        )}

        {needsRoom ? (
          <div className="no-room-empty">
            <BrandLogo size={68} />
            <h2>Hoş geldin, {user.display_name}!</h2>
            <p className="muted-text">
              Henüz bir odada değilsin. Arkadaşından gelen davet linkiyle anında katılabilir veya
              kendi 10 kişilik sunucunu oluşturup davet linki paylaşabilirsin.
            </p>
            <div className="row-gap" style={{ marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                type="button"
                className="primary-btn"
                onClick={() => setRoomHubTab('join')}
              >
                <Link2 size={16} /> Davet Linkiyle Katıl
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setRoomHubTab('create')}
              >
                <Plus size={16} /> Yeni Oda Oluştur
              </button>
            </div>
          </div>
        ) : (
          <>
            <ErrorBoundary area="Cihaz bildirimi">
              <OtherDeviceCallBanner />
            </ErrorBoundary>
            <ErrorBoundary area="Ses odası">
              <VoiceStage onOpenShareModal={() => setShareModalOpen(true)} />
            </ErrorBoundary>

            <div className="chat-and-members">
              <ErrorBoundary area="Sohbet">
                <ChatPanel />
              </ErrorBoundary>
              <ErrorBoundary area="Üye listesi">
                <MemberList />
              </ErrorBoundary>
            </div>
          </>
        )}
      </main>

      {settingsTab && (
        <ErrorBoundary area="Ayarlar">
          <Suspense fallback={null}>
            <SettingsModal
              open
              initialTab={settingsTab}
              onClose={() => setSettingsTab(null)}
              onOpenRoomHub={(tab) => setRoomHubTab(tab)}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {roomHubTab && (
        <ErrorBoundary area="Oda ekle">
          <RoomHubModal
            open
            initialTab={roomHubTab}
            onClose={() => setRoomHubTab(null)}
          />
        </ErrorBoundary>
      )}
      {shareModalOpen && (
        <ErrorBoundary area="Ekran paylaşımı">
          <Suspense fallback={null}>
            <ScreenShareModal
              open
              onClose={() => setShareModalOpen(false)}
              onStart={startScreenShare}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

export default App;
