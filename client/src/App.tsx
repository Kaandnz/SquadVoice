import { lazy, Suspense, useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { ChatPanel } from './components/ChatPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MemberList } from './components/MemberList';
import { OtherDeviceCallBanner } from './components/OtherDeviceCallBanner';
import { Sidebar } from './components/Sidebar';
import { VoiceStage } from './components/VoiceStage';
import { useAppStore } from './store/useAppStore';

// Dialogs aren't needed for the first paint: load them on demand (and warm them up
// shortly after start so the first open is still instant).
const loadSettingsModal = () => import('./components/SettingsModal');
const loadAdminPanelModal = () => import('./components/AdminPanelModal');
const loadProfileModal = () => import('./components/ProfileModal');
const loadScreenShareModal = () => import('./components/ScreenShareModal');

const SettingsModal = lazy(() => loadSettingsModal().then((m) => ({ default: m.SettingsModal })));
const AdminPanelModal = lazy(() =>
  loadAdminPanelModal().then((m) => ({ default: m.AdminPanelModal })),
);
const ProfileModal = lazy(() => loadProfileModal().then((m) => ({ default: m.ProfileModal })));
const ScreenShareModal = lazy(() =>
  loadScreenShareModal().then((m) => ({ default: m.ScreenShareModal })),
);

const PRELOAD_DIALOGS_AFTER_MS = 3000;

export function App() {
  const {
    serverName,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    const timer = window.setTimeout(() => {
      // Failures are fine here: opening the dialog retries and the boundary reports it
      for (const load of [
        loadSettingsModal,
        loadProfileModal,
        loadScreenShareModal,
        loadAdminPanelModal,
      ]) {
        load().catch(() => {});
      }
    }, PRELOAD_DIALOGS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false);
        setAdminOpen(false);
        setProfileOpen(false);
        setShareModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (authLoading && !user) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p>SquadVoice bağlanıyor...</p>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <div className="app-shell">
      <ErrorBoundary area="Kanal listesi">
        <Sidebar
          mobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAdmin={() => setAdminOpen(true)}
          onOpenProfile={() => setProfileOpen(true)}
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
          <strong>{serverName}</strong>
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
      </main>

      {settingsOpen && (
        <ErrorBoundary area="Ayarlar">
          <Suspense fallback={null}>
            <SettingsModal open onClose={() => setSettingsOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}
      {adminOpen && (
        <ErrorBoundary area="Admin paneli">
          <Suspense fallback={null}>
            <AdminPanelModal open onClose={() => setAdminOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}
      {profileOpen && (
        <ErrorBoundary area="Profil">
          <Suspense fallback={null}>
            <ProfileModal open onClose={() => setProfileOpen(false)} />
          </Suspense>
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
