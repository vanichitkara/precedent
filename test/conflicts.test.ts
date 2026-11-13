import { describe, expect, it } from 'vitest';
import { rankCandidates } from '../src/conflicts/candidates';
import { decisions as seed, issues } from '../scripts/seed-data';
import type { Decision } from '../src/types';

const ledger: Decision[] = seed.map((s, i) => ({
  id: `DL-${i + 1}`,
  title: s.title,
  statement: s.decision,
  rationale: s.why,
  context: s.adr,
  status: 'accepted',
  owners: [],
  decidedAt: null,
  reviewBy: s.reviewBy ?? null,
  sourceType: 'confluence',
  sourceId: String(i),
  sourceUrl: null,
  projectKey: 'ORD',
  supersededBy: null,
  updatedAt: '2026-11-10',
}));
const idOf = (adr: string) => `DL-${seed.findIndex((s) => s.adr === adr) + 1}`;

describe('rankCandidates', () => {
  it.each(issues.filter((i) => i.conflictsWith))('puts the planted decision in the top 3 for "$summary"', (issue) => {
    const ranked = rankCandidates(`${issue.summary}\n${issue.description}`, ledger, { projectKey: 'ORD' });
    expect(ranked.slice(0, 3).map((r) => r.decision.id)).toContain(idOf(issue.conflictsWith!));
  });

  it('never returns superseded decisions', () => {
    const withSuperseded = ledger.map((d, i) => (i === 0 ? { ...d, status: 'superseded' as const } : d));
    const ranked = rankCandidates('Migrate orders service to MongoDB', withSuperseded, { projectKey: 'ORD' });
    expect(ranked.map((r) => r.decision.id)).not.toContain('DL-1');
  });

  it('caps the number of related decisions returned', () => {
    expect(rankCandidates('postgres go typescript api okta flags', ledger, { limit: 2 }).length).toBeLessThanOrEqual(2);
  });
});
