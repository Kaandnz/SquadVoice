import { FormEvent, useState } from 'react';
import { KeyRound, Server, ShieldCheck, Sparkles } from 'lucide-react';
import { isTauriRuntime } from '../lib/platform';
import { useAppStore } from '../store/useAppStore';

export function AuthScreen() {
  const { firebaseMode, serverUrl, authError, authLoading, login, register, resetPassword } =
    useAppStore();
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState(
    import.meta.env.VITE_DEFAULT_INVITE_CODE || '',
  );
  const [customUrl, setCustomUrl] = useState(serverUrl);
  const [showServerField, setShowServerField] = useState(!firebaseMode && isTauriRuntime());
  const [localError, setLocalError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setResetSuccess(null);

    try {
      if (mode === 'login') {
        await login(username, password, showServerField ? customUrl : undefined);
      } else if (mode === 'register') {
        await register(
          username,
          displayName || username,
          email,
          password,
          inviteCode,
          showServerField ? customUrl : undefined,
        );
      } else {
        setResetBusy(true);
        await resetPassword(email);
        setResetSuccess(
          'Şifre sıfırlama bağlantısı e-posta adresine gönderildi! Spam/Gereksiz klasörünü de kontrol et.',
        );
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'İşlem başarısız');
    } finally {
      setResetBusy(false);
    }
  };

  const errText = localError || authError;

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-badge">
            <Sparkles size={24} />
          </div>
          <div>
            <h1>SquadVoice</h1>
            <p>5 kişilik özel, düşük gecikmeli ses &amp; yayın odası</p>
          </div>
        </div>

        {mode !== 'reset' ? (
          <div className="auth-tabs">
            <button
              type="button"
              className={mode === 'login' ? 'active' : ''}
              onClick={() => {
                setMode('login');
                setLocalError(null);
                setResetSuccess(null);
              }}
            >
              Giriş Yap
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'active' : ''}
              onClick={() => {
                setMode('register');
                setLocalError(null);
                setResetSuccess(null);
              }}
            >
              Kayıt Ol
            </button>
          </div>
        ) : (
          <div className="reset-header">
            <KeyRound size={18} />
            <strong>Şifre Sıfırlama</strong>
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form">
          {mode !== 'reset' && (
            <label>
              <span>{mode === 'login' ? 'E-posta veya Kullanıcı Adı' : 'Kullanıcı Adı'}</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={mode === 'login' ? 'ornek@gmail.com veya kagan' : 'ornek: kagan'}
                autoComplete="username"
                required
              />
            </label>
          )}

          {(mode === 'reset' || (mode === 'register' && firebaseMode)) && (
            <label>
              <span>
                {mode === 'reset' ? 'Kayıtlı E-posta Adresin' : 'E-posta (Şifremi Unuttum için)'}
              </span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ornek@gmail.com"
                autoComplete="email"
                required
              />
            </label>
          )}

          {mode === 'register' && (
            <label>
              <span>Görünen İsim</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Arkadaşlarının göreceği isim"
              />
            </label>
          )}

          {mode !== 'reset' && (
            <label>
              <span>Şifre</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="En az 6 karakter"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
            </label>
          )}

          {mode === 'login' && firebaseMode && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMode('reset');
                setLocalError(null);
                setResetSuccess(null);
                if (username.includes('@')) setEmail(username);
              }}
            >
              <KeyRound size={14} /> Şifremi Unuttum
            </button>
          )}

          {mode === 'register' && (
            <label>
              <span>Davet Kodu</span>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Sunucu davet kodu (örn. SQUAD-2026)"
                required
              />
            </label>
          )}

          {!firebaseMode && showServerField ? (
            <label>
              <span>Sunucu Adresi</span>
              <input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://senin-sunucun.trycloudflare.com"
                required
              />
            </label>
          ) : !firebaseMode && mode !== 'reset' ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowServerField(true)}
            >
              <Server size={14} /> Farklı sunucu adresine bağlan
            </button>
          ) : null}

          {errText && <div className="form-error">{errText}</div>}
          {resetSuccess && <div className="form-success">{resetSuccess}</div>}

          <button
            type="submit"
            className="primary-btn"
            disabled={authLoading || resetBusy}
          >
            {mode === 'reset'
              ? resetBusy
                ? 'Gönderiliyor...'
                : 'Sıfırlama Bağlantısı Gönder'
              : authLoading
                ? 'Bağlanılıyor...'
                : mode === 'login'
                  ? 'Odaya Gir'
                  : 'Hesap Oluştur'}
          </button>

          {mode === 'reset' && (
            <button
              type="button"
              className="secondary-btn"
              onClick={() => {
                setMode('login');
                setLocalError(null);
                setResetSuccess(null);
              }}
            >
              Giriş Ekranına Dön
            </button>
          )}
        </form>

        <div className="auth-footnote">
          <ShieldCheck size={14} />
          <span>
            {firebaseMode
              ? 'Firebase 7/24 Serverless • Ücretsiz Spark Plan • Max 5 Kişi'
              : 'Ücretsiz • WebRTC P2P Mesh • Maksimum 5 Kişi'}
          </span>
        </div>
      </div>
    </div>
  );
}
