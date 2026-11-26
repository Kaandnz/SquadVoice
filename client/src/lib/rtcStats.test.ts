import { describe, expect, it } from 'vitest';
import { findSelectedCandidatePair, type StatEntry } from './rtcStats';

function report(entries: StatEntry[]) {
  return new Map(entries.map((e) => [e.id, e]));
}

describe('findSelectedCandidatePair', () => {
  it('uses the transport selectedCandidatePairId even when a relay pair also succeeded', () => {
    const r = report([
      { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP-direct' },
      { id: 'CP-relay', type: 'candidate-pair', state: 'succeeded', nominated: false },
      { id: 'CP-direct', type: 'candidate-pair', state: 'succeeded', nominated: true },
    ]);
    expect(findSelectedCandidatePair(r)?.id).toBe('CP-direct');
  });

  it('falls back to the Firefox selected flag', () => {
    const r = report([
      { id: 'CP-a', type: 'candidate-pair', state: 'succeeded' },
      { id: 'CP-b', type: 'candidate-pair', state: 'succeeded', selected: true },
    ]);
    expect(findSelectedCandidatePair(r)?.id).toBe('CP-b');
  });

  it('prefers a nominated succeeded pair over a merely succeeded one', () => {
    const r = report([
      { id: 'CP-a', type: 'candidate-pair', state: 'succeeded', nominated: false },
      { id: 'CP-b', type: 'candidate-pair', state: 'succeeded', nominated: true },
    ]);
    expect(findSelectedCandidatePair(r)?.id).toBe('CP-b');
  });

  it('returns null when no pair has connected yet', () => {
    const r = report([{ id: 'CP-a', type: 'candidate-pair', state: 'in-progress' }]);
    expect(findSelectedCandidatePair(r)).toBeNull();
  });
});
