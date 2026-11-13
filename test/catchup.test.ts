import { describe, expect, it } from 'vitest';
import { pagesNeedingSync, withinLookback } from '../src/capture/catchup';

describe('withinLookback', () => {
  const now = Date.parse('2026-11-11T18:30:00Z');
  it('keeps pages changed in the last 30 minutes and drops older or undated ones', () => {
    const pages = [
      { id: '1', version: { number: 2, createdAt: '2026-11-11T18:10:00Z' } },
      { id: '2', version: { number: 1, createdAt: '2026-11-11T17:46:00Z' } },
      { id: '3', version: { number: 1 } },
    ];
    expect(withinLookback(pages, now)).toEqual([{ id: '1', version: 2 }]);
  });
});

describe('pagesNeedingSync', () => {
  const changed = [
    { id: '491521', version: 1 }, // never synced: the dropped-event case
    { id: '163858', version: 1 }, // already synced at this version
    { id: '98551', version: 3 }, // edited since last sync
  ];
  const synced = new Map([
    ['163858', 1],
    ['98551', 2],
  ]);

  it('returns pages never synced or edited since', () => {
    expect(pagesNeedingSync(changed, synced).map((p) => p.id)).toEqual(['491521', '98551']);
  });

  it('treats everything as unsynced when bookkeeping is unavailable', () => {
    expect(pagesNeedingSync(changed, new Map())).toHaveLength(3);
  });
});
