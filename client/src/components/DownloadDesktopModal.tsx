import { useEffect, useState } from 'react';
import {
  Cpu,
  Download,
  ExternalLink,
  Gamepad2,
  Laptop,
  Monitor,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react';
import {
  detectDesktopOs,
  fetchLatestDesktopRelease,
  formatFileSize,
  getDeferredPwaPrompt,
  getReleasesPageUrl,
  subscribePwaPrompt,
  triggerPwaInstall,
  type DesktopReleaseResult,
} from '../lib/desktopRelease';
import { BrandLogo } from './BrandLogo';

interface DownloadDesktopModalProps {
  open: boolean;
  onClose: () => void;
}

export function DownloadDesktopModal({ open, onClose }: DownloadDesktopModalProps) {
  const [os] = useState(() => detectDesktopOs());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DesktopReleaseResult | null>(null);
  const [canInstallPwa, setCanInstallPwa] = useState(() => Boolean(getDeferredPwaPrompt()));
  const [pwaNotice, setPwaNotice] = useState<string | null>(null);

  useEffect(() => {
    return subscribePwaPrompt(() => {
      setCanInstallPwa(Boolean(getDeferredPwaPrompt()));
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setPwaNotice(null);
    fetchLatestDesktopRelease(ctrl.signal)
      .then((res) => setResult(res))
      .catch(() => {})
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [open]);

  if (!open) return null;

  const releasesUrl = result?.releasesUrl ?? getReleasesPageUrl();
  const release = result?.status === 'ready' ? result.release : null;
  const winPrimary = release?.windowsExe ?? release?.windowsMsi ?? null;
  const winSecondary = release?.windowsExe && release?.windowsMsi ? release.windowsMsi : null;
  const macPrimary = release?.macosDmg ?? null;
  const macIntel = release?.macosDmgIntel ?? null;
  const androidApk = release?.androidApk ?? null;
  const releaseLabel = release
    ? release.version.toLowerCase() === 'latest'
      ? `En güncel sürüm${
          release.publishedAt
            ? ` · ${new Date(release.publishedAt).toLocaleDateString('tr-TR', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}`
            : ''
        }`
      : `Son sürüm: ${release.version}`
    : null;

  const handlePwaInstall = async () => {
    const outcome = await triggerPwaInstall();
    if (outcome === 'accepted') {
      setPwaNotice('SquadVoice masaüstü web uygulaması olarak kuruldu!');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide download-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <BrandLogo size={32} />
            <div>
              <h3>SquadVoice Uygulamasını İndir</h3>
              <div className="muted-text" style={{ fontSize: '0.76rem' }}>
                {releaseLabel
                  ? `${releaseLabel} • Windows, macOS & Android`
                  : 'Windows, macOS & Android • Ücretsiz Yerel Uygulama'}
              </div>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Kapat">
            <X size={18} />
          </button>
        </div>

        <div className="download-perks">
          <div className="download-perk">
            <Gamepad2 size={15} />
            <span>Oyun içi Global Bas-Konuş</span>
          </div>
          <div className="download-perk">
            <Cpu size={15} />
            <span>Hafif &amp; Düşük RAM (~10 MB)</span>
          </div>
          <div className="download-perk">
            <Sparkles size={15} />
            <span>Arka planda kesintisiz ses</span>
          </div>
        </div>

        <div className="download-cards">
          <div className={`download-card ${os === 'windows' ? 'recommended' : ''}`}>
            <div className="download-card-head">
              <div className="download-card-title">
                <Monitor size={18} />
                <div>
                  <strong>Windows</strong>
                  <div className="muted-text">Windows 10 / 11 (64-bit)</div>
                </div>
              </div>
              {os === 'windows' && <span className="noise-mode-badge accent">Senin Sistemin</span>}
            </div>

            {loading ? (
              <div className="muted-text">Sürüm kontrol ediliyor...</div>
            ) : winPrimary ? (
              <div className="download-card-actions">
                <a
                  href={winPrimary.url}
                  className="primary-btn small download-link-btn"
                  download
                >
                  <Download size={14} />
                  <span>
                    Windows İndir ({winPrimary.name.endsWith('.msi') ? '.msi' : '.exe'})
                    {winPrimary.size ? ` · ${formatFileSize(winPrimary.size)}` : ''}
                  </span>
                </a>
                {winSecondary && (
                  <a href={winSecondary.url} className="link-btn" download>
                    Alternatif .msi kurulum paketi ({formatFileSize(winSecondary.size)})
                  </a>
                )}
              </div>
            ) : (
              <a
                href={releasesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="secondary-btn small download-link-btn"
              >
                <ExternalLink size={14} />
                <span>GitHub Releases&apos;tan İndir (.exe / .msi)</span>
              </a>
            )}
          </div>

          <div className={`download-card ${os === 'macos' ? 'recommended' : ''}`}>
            <div className="download-card-head">
              <div className="download-card-title">
                <Laptop size={18} />
                <div>
                  <strong>macOS</strong>
                  <div className="muted-text">Apple Silicon (M1–M4) &amp; Intel</div>
                </div>
              </div>
              {os === 'macos' && <span className="noise-mode-badge accent">Senin Sistemin</span>}
            </div>

            {loading ? (
              <div className="muted-text">Sürüm kontrol ediliyor...</div>
            ) : macPrimary ? (
              <div className="download-card-actions">
                <a
                  href={macPrimary.url}
                  className="primary-btn small download-link-btn"
                  download
                >
                  <Download size={14} />
                  <span>
                    macOS İndir (.dmg)
                    {macPrimary.size ? ` · ${formatFileSize(macPrimary.size)}` : ''}
                  </span>
                </a>
                {macIntel && (
                  <a href={macIntel.url} className="link-btn" download>
                    Intel Mac sürümü (.dmg · {formatFileSize(macIntel.size)})
                  </a>
                )}
                <span className="muted-text" style={{ fontSize: '0.72rem' }}>
                  İlk açılışta uyarı çıkarsa: Sistem Ayarları → Gizlilik ve Güvenlik → &ldquo;Yine de Aç&rdquo;.
                </span>
              </div>
            ) : (
              <a
                href={releasesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="secondary-btn small download-link-btn"
              >
                <ExternalLink size={14} />
                <span>GitHub Releases&apos;tan İndir (.dmg)</span>
              </a>
            )}
          </div>

          <div
            className={`download-card ${os === 'android' ? 'recommended' : ''}`}
            style={{ gridColumn: '1 / -1' }}
          >
            <div className="download-card-head">
              <div className="download-card-title">
                <Smartphone size={18} />
                <div>
                  <strong>Android Uygulaması (.apk)</strong>
                  <div className="muted-text">
                    Ekran kilitliyken ve oyundayken kesintisiz arka plan sesi (Native Servis)
                  </div>
                </div>
              </div>
              {os === 'android' && <span className="noise-mode-badge accent">Senin Sistemin</span>}
            </div>

            {loading ? (
              <div className="muted-text">Sürüm kontrol ediliyor...</div>
            ) : androidApk ? (
              <div className="download-card-actions">
                <a
                  href={androidApk.url}
                  className="primary-btn small download-link-btn"
                  download
                >
                  <Download size={14} />
                  <span>
                    Android İndir (.apk)
                    {androidApk.size ? ` · ${formatFileSize(androidApk.size)}` : ''}
                  </span>
                </a>
                <span className="muted-text" style={{ fontSize: '0.72rem' }}>
                  Kurulumda &ldquo;Bilinmeyen uygulamalara izin ver&rdquo; çıkarsa onaylayıp tek tıkla kurabilirsin.
                </span>
              </div>
            ) : (
              <a
                href={releasesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="secondary-btn small download-link-btn"
              >
                <ExternalLink size={14} />
                <span>GitHub Releases&apos;tan İndir (.apk)</span>
              </a>
            )}
          </div>
        </div>

        {!loading && result?.status === 'no-release' && (
          <div className="diag-box">
            <span className="muted-text">
              İlk masaüstü kurulum paketi henüz derleniyor — <code>main</code> dalına güncellemeler
              gittiğinde Windows (.exe) ve macOS (.dmg) paketleri otomatik oluşup burada tek tıkla
              indirilebilir hale gelir. O zamana kadar aşağıdaki PWA seçeneğiyle tarayıcıdan hemen
              masaüstü uygulaması gibi kurabilirsin.
            </span>
          </div>
        )}

        <div className="diag-box" style={{ gap: 8 }}>
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Smartphone size={15} />
              <strong>Tarayıcıdan Hemen Uygulama Olarak Kur (PWA)</strong>
            </div>
            {canInstallPwa && (
              <button type="button" className="primary-btn small" onClick={handlePwaInstall}>
                <Download size={13} /> Hemen Yükle
              </button>
            )}
          </div>
          <span className="muted-text">
            {os === 'ios' || os === 'android'
              ? 'iPhone Safari: Paylaş → Ana Ekrana Ekle · Android için yukarıdan direkt .apk uygulamasını kurmanı öneririz.'
              : 'Kurulum dosyası beklemeden Chrome/Edge adres çubuğundaki "Uygulamayı yükle" ikonuyla masaüstüne bağımsız pencere olarak da sabitleyebilirsin.'}
          </span>
          {pwaNotice && <div className="form-success">{pwaNotice}</div>}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <a
            href={releasesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="link-btn"
          >
            <ExternalLink size={13} /> Tüm sürümler (GitHub Releases)
          </a>
          <button type="button" className="secondary-btn small" onClick={onClose}>
            Kapat
          </button>
        </div>
      </div>
    </div>
  );
}
