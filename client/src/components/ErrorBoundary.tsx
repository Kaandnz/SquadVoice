import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Name of the area shown in the fallback ("Sohbet", "Ses odası"…). Without it the
   * boundary is the app-wide one and offers a full page reload.
   */
  area?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps one crashing panel from white-screening the whole app. Panel-level boundaries
 * mean e.g. a broken chat message can't drop a running voice call.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[SquadVoice] ${this.props.area ?? 'Uygulama'} hatası:`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { area } = this.props;
    return (
      <div className={area ? 'error-fallback' : 'error-fallback full'} role="alert">
        <AlertTriangle size={area ? 18 : 28} className="error-fallback-icon" />
        <div className="error-fallback-text">
          <strong>{area ? `${area} yüklenirken bir sorun oluştu.` : 'Bir şeyler ters gitti.'}</strong>
          <span>
            {area
              ? 'Uygulamanın geri kalanı ve sesli görüşme çalışmaya devam ediyor.'
              : 'Sayfayı yenilemek genelde düzeltir.'}
          </span>
          <code className="error-fallback-detail">{error.message}</code>
        </div>
        <div className="error-fallback-actions">
          <button type="button" className="secondary-btn small" onClick={this.reset}>
            <RotateCcw size={13} /> Tekrar dene
          </button>
          <button
            type="button"
            className="primary-btn small"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={13} /> Sayfayı yenile
          </button>
        </div>
      </div>
    );
  }
}
