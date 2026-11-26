import { useState } from 'react';
import { Monitor, X } from 'lucide-react';
import type { ScreenShareOptions } from '../types/protocol';

interface ScreenShareModalProps {
  open: boolean;
  onClose: () => void;
  onStart: (opts: ScreenShareOptions) => Promise<void>;
}

const PRESETS: Array<{
  id: string;
  title: string;
  desc: string;
  width: number;
  height: number;
  frameRate: number;
  maxBitrateBps: number;
}> = [
  {
    id: '720p30',
    title: '720p • 30 FPS',
    desc: 'Düşük upload dostu (~2.5 Mbps)',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrateBps: 2_500_000,
  },
  {
    id: '1080p30',
    title: '1080p • 30 FPS',
    desc: 'Dengeli kalite (~4 Mbps)',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrateBps: 4_000_000,
  },
  {
    id: '1080p60',
    title: '1080p • 60 FPS',
    desc: 'Oyun & akıcı yayın (~6 Mbps)',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrateBps: 6_000_000,
  },
];

export function ScreenShareModal({ open, onClose, onStart }: ScreenShareModalProps) {
  const [presetId, setPresetId] = useState('1080p60');
  const [contentHint, setContentHint] = useState<'motion' | 'detail'>('motion');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [starting, setStarting] = useState(false);

  if (!open) return null;

  const selected = PRESETS.find((p) => p.id === presetId) || PRESETS[2];

  const handleConfirm = async () => {
    setStarting(true);
    try {
      await onStart({
        width: selected.width,
        height: selected.height,
        frameRate: selected.frameRate,
        maxBitrateBps: selected.maxBitrateBps,
        contentHint,
        includeAudio,
      });
      onClose();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Monitor size={18} />
            <h3>Ekran &amp; Oyun Paylaşımı</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field-label">Çözünürlük &amp; Akıcılık</div>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`preset-card ${presetId === p.id ? 'active' : ''}`}
                onClick={() => setPresetId(p.id)}
              >
                <strong>{p.title}</strong>
                <span>{p.desc}</span>
              </button>
            ))}
          </div>

          <div className="field-label">İçerik Önceliği</div>
          <div className="segmented-row">
            <button
              type="button"
              className={contentHint === 'motion' ? 'active' : ''}
              onClick={() => setContentHint('motion')}
            >
              Oyun / Video (FPS Öncelikli)
            </button>
            <button
              type="button"
              className={contentHint === 'detail' ? 'active' : ''}
              onClick={() => setContentHint('detail')}
            >
              Kod / Metin (Keskinlik)
            </button>
          </div>

          <label className="toggle-row">
            <div>
              <strong>Sistem / Oyun Sesini Paylaş</strong>
              <p>
                Windows masaüstünde tüm sistem sesini alır; macOS tarayıcılarda sekme/pencereye
                göre sistem kısıtı olabilir.
              </p>
            </div>
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(e) => setIncludeAudio(e.target.checked)}
            />
          </label>
        </div>

        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>
            İptal
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={handleConfirm}
            disabled={starting}
          >
            {starting ? 'Kaynak Seçiliyor...' : 'Yayını Başlat'}
          </button>
        </div>
      </div>
    </div>
  );
}
