import { PointerEvent as ReactPointerEvent, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import {
  rateConnection,
  sparkGeometry,
  summarize,
  type ConnectionRating,
  type QualitySample,
} from '../lib/connectionQuality';
import type { PeerStats } from '../types/protocol';

const SPARK_W = 120;
const SPARK_H = 28;

const RATING: Record<ConnectionRating, { label: string; Icon: typeof CheckCircle2 }> = {
  good: { label: 'İyi bağlantı', Icon: CheckCircle2 },
  fair: { label: 'Orta — hafif takılma olabilir', Icon: AlertTriangle },
  poor: { label: 'Zayıf — ses kopabilir', Icon: XCircle },
  unknown: { label: 'Ölçülüyor…', Icon: Loader2 },
};

function formatValue(v: number | null, decimals: number): string {
  return v === null ? '—' : v.toFixed(decimals);
}

interface TileProps {
  label: string;
  unit: string;
  values: Array<number | null>;
  times: number[];
  /** Minimum top of the y-scale, so tiny values don't look like spikes. */
  floor: number;
  decimals?: number;
}

/** One metric: name, value (current or hovered) and a one-minute trend line. */
function QualityTile({ label, unit, values, times, floor, decimals = 0 }: TileProps) {
  const [hover, setHover] = useState<number | null>(null);
  const geo = sparkGeometry(values, SPARK_W, SPARK_H, floor);

  let lastKnown: number | null = null;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null) {
      lastKnown = i;
      break;
    }
  }
  const shownIdx = hover ?? lastKnown;
  const shownValue = shownIdx === null ? null : values[shownIdx];
  const shownPoint = shownIdx === null ? null : geo.points[shownIdx];
  const secondsAgo =
    hover !== null && times[hover] ? Math.max(0, Math.round((Date.now() - times[hover]) / 1000)) : null;

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (values.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (values.length - 1)));
  };

  return (
    <div className="conn-tile">
      <div className="conn-tile-text">
        <span className="conn-tile-label">
          {label}
          {secondsAgo !== null && <span className="conn-tile-ago"> · {secondsAgo} sn önce</span>}
        </span>
        <span className="conn-tile-value">
          {formatValue(shownValue, decimals)}
          <span className="conn-tile-unit">{unit}</span>
        </span>
      </div>
      <div
        className="conn-spark"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        aria-hidden="true"
      >
        <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none">
          <line className="conn-spark-base" x1={0} x2={SPARK_W} y1={SPARK_H - 3} y2={SPARK_H - 3} />
          {hover !== null && shownPoint && (
            <line className="conn-spark-cross" x1={shownPoint.x} x2={shownPoint.x} y1={0} y2={SPARK_H} />
          )}
          {geo.segments.map((points, i) => (
            <polyline key={i} className="conn-spark-line" points={points} />
          ))}
        </svg>
        {shownPoint && (
          <span
            className="conn-spark-dot"
            style={{
              left: `${(shownPoint.x / SPARK_W) * 100}%`,
              top: `${(shownPoint.y / SPARK_H) * 100}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Expanded connection view for one participant: rating, path and 1-minute trends. */
export function ConnectionDetails({
  history,
  stats,
}: {
  history: QualitySample[];
  stats: PeerStats;
}) {
  const latest = history[history.length - 1];
  const rating = latest ? rateConnection(latest) : 'unknown';
  const { label, Icon } = RATING[rating];
  const times = history.map((h) => h.t);
  const rtt = history.map((h) => h.rttMs);
  const loss = history.map((h) => h.lossPct);
  const jitter = history.map((h) => h.jitterMs);
  const rttSummary = summarize(rtt);

  return (
    <div className="conn-details">
      <div className={`conn-details-head ${rating}`}>
        <Icon size={14} className={rating === 'unknown' ? 'spin' : undefined} />
        <span className="conn-details-rating">{label}</span>
        <span className="conn-details-meta">
          {stats.usingRelay ? 'TURN relay' : 'Doğrudan P2P'} · Ses {stats.audioKbps} kbps
        </span>
      </div>
      <QualityTile label="Ping" unit=" ms" values={rtt} times={times} floor={100} />
      <QualityTile label="Paket kaybı" unit=" %" values={loss} times={times} floor={5} decimals={1} />
      <QualityTile label="Jitter" unit=" ms" values={jitter} times={times} floor={30} />

      {/* Same data as text for screen readers (the charts are aria-hidden) */}
      <table className="sr-only">
        <caption>
          Son 1 dakikanın bağlantı ölçümleri
          {rttSummary
            ? `, ping ortalama ${Math.round(rttSummary.avg)} ms, en yüksek ${rttSummary.max} ms`
            : ''}
        </caption>
        <thead>
          <tr>
            <th>Zaman</th>
            <th>Ping (ms)</th>
            <th>Paket kaybı (%)</th>
            <th>Jitter (ms)</th>
          </tr>
        </thead>
        <tbody>
          {history.slice(-10).map((h, i) => (
            <tr key={`${h.t}-${i}`}>
              <td>{new Date(h.t).toLocaleTimeString('tr-TR')}</td>
              <td>{formatValue(h.rttMs, 0)}</td>
              <td>{formatValue(h.lossPct, 1)}</td>
              <td>{formatValue(h.jitterMs, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
