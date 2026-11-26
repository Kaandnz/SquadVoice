import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { AdminPanelModal } from './components/AdminPanelModal';
import { AuthScreen } from './components/AuthScreen';
import { ChatPanel } from './components/ChatPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MemberList } from './components/MemberList';
import { OtherDeviceCallBanner } from './components/OtherDeviceCallBanner';
import { ProfileModal } from './components/ProfileModal';
import { ScreenShareModal } from './components/ScreenShareModal';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { VoiceStage } from './components/VoiceStage';
import { useAppStore } from './store/useAppStore';

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

      <ErrorBoundary area="Ayarlar">
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </ErrorBoundary>
      <ErrorBoundary area="Admin paneli">
        <AdminPanelModal open={adminOpen} onClose={() => setAdminOpen(false)} />
      </ErrorBoundary>
      <ErrorBoundary area="Profil">
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      </ErrorBoundary>
      <ErrorBoundary area="Ekran paylaşımı">
        <ScreenShareModal
          open={shareModalOpen}
          onClose={() => setShareModalOpen(false)}
          onStart={startScreenShare}
        />
      </ErrorBoundary>
    </div>
  );
}

export default App;
