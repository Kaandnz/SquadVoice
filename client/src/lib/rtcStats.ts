export interface StatEntry {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface StatsReportLike {
  forEach(callback: (stat: StatEntry) => void): void;
}

/**
 * Returns the candidate pair ICE actually uses for media. A connection can have
 * several "succeeded" pairs at once (e.g. a direct host/srflx pair *and* a TURN
 * relay pair), so picking any succeeded pair misreports relay usage and RTT.
 */
export function findSelectedCandidatePair(report: StatsReportLike): StatEntry | null {
  let selectedId: string | null = null;
  const pairs: StatEntry[] = [];

  report.forEach((stat) => {
    if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
      selectedId ??= stat.selectedCandidatePairId;
    } else if (stat.type === 'candidate-pair') {
      pairs.push(stat);
    }
  });

  if (selectedId) {
    const byTransport = pairs.find((p) => p.id === selectedId);
    if (byTransport) return byTransport;
  }

  return (
    pairs.find((p) => p.selected === true) ??
    pairs.find((p) => p.nominated === true && p.state === 'succeeded') ??
    pairs.find((p) => p.state === 'succeeded') ??
    null
  );
}
