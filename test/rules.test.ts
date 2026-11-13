import { describe, expect, it } from 'vitest';
import { extractRules, findRuleConflicts } from '../src/conflicts/rules';
import { decisions as seed, issues } from '../scripts/seed-data';
import { EXAMPLE_DECISIONS } from '../src/examples';
import type { Decision } from '../src/types';

const toDecision = (title: string, statement: string, i: number): Decision => ({
  id: `DL-${i + 1}`,
  title,
  statement,
  rationale: null,
  context: null,
  status: 'accepted',
  owners: [],
  decidedAt: null,
  reviewBy: null,
  sourceType: 'confluence',
  sourceId: String(i),
  sourceUrl: null,
  projectKey: 'ORD',
  supersededBy: null,
  updatedAt: '2026-11-12',
});

const ledger = seed.map((s, i) => toDecision(s.title, s.decision, i));
const idOf = (adr: string) => `DL-${seed.findIndex((s) => s.adr === adr) + 1}`;
const flagged = (summary: string, description: string, pool = ledger) =>
  findRuleConflicts(`${summary}\n${description}`, pool).map((h) => h.decision.id);

describe('extractRules', () => {
  it('reads prohibitions and requirements from the seed decisions', () => {
    const postgres = extractRules(ledger[0]);
    expect(postgres).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'requires', category: 'database', terms: [['postgres']] }),
        expect.objectContaining({ kind: 'prohibits', terms: [['document', 'database']] }),
      ]),
    );
    expect(extractRules(ledger[2])).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'requires', category: 'language', terms: [['go', 'typescript']] })]),
    );
  });
});

describe('findRuleConflicts on the seed data', () => {
  it.each(issues.filter((i) => i.conflictsWith))('flags exactly $conflictsWith for "$summary"', (issue) => {
    expect(flagged(issue.summary, issue.description)).toEqual([idOf(issue.conflictsWith!)]);
  });

  it.each(issues.filter((i) => !i.conflictsWith))('flags nothing for "$summary"', (issue) => {
    expect(flagged(issue.summary, issue.description)).toEqual([]);
  });

  it('catches a decision added later (Looker, never CSV) against existing work', () => {
    const withLooker = [...ledger, toDecision('Finance reporting', 'Finance reports are delivered as Looker dashboards, never as CSV exports.', ledger.length)];
    expect(flagged('Refund reconciliation report', 'Daily CSV for finance of refunds over 500 USD.', withLooker)).toEqual([`DL-${ledger.length + 1}`]);
  });

  it('quotes the clause it relied on', () => {
    const [hit] = findRuleConflicts('Migrate orders service to MongoDB', ledger);
    expect(hit.reason).toContain('MongoDB');
    expect(hit.reason).toContain('stay on PostgreSQL');
  });

  it('ignores superseded decisions', () => {
    const superseded = ledger.map((d, i) => (i === 0 ? { ...d, status: 'superseded' as const } : d));
    expect(flagged('Migrate orders service to MongoDB', '', superseded)).toEqual([]);
  });

  it('respects an exception the decision grants itself', () => {
    const scoped = [toDecision('Document store allowed for order history', 'Order history may use MongoDB; payments stay on PostgreSQL.', 0)];
    expect(flagged('Migrate orders service to MongoDB', '', scoped)).toEqual([]);
    expect(flagged('Move payments to MySQL', '', scoped)).toEqual(['DL-1']);
  });
});

describe('example decisions', () => {
  it('flag the work items the dashboard suggests trying', () => {
    const pool = EXAMPLE_DECISIONS.map((e, i) => toDecision(e.title, e.statement, i));
    expect(flagged('Migrate orders service to MongoDB', '', pool)).toEqual(['DL-1']);
    expect(flagged('New pricing service in Python', '', pool)).toEqual(['DL-3']);
    expect(flagged('Add a weekly team lunch', '', pool)).toEqual([]);
  });
});
