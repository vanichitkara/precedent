import { describe, expect, it } from 'vitest';
import { extractDecisions, linkedPageIds, projectKeyFromTitle, titleFor, type AdfNode } from '../src/capture/adf';

const doc: AdfNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Stay on Postgres for transactional services' }] },
    {
      type: 'decisionList',
      attrs: { localId: 'list-1' },
      content: [
        {
          type: 'decisionItem',
          attrs: { localId: 'd-1', state: 'DECIDED' },
          content: [
            { type: 'text', text: 'Orders stay on PostgreSQL ' },
            { type: 'mention', attrs: { id: 'acc-1', text: '@Priya' } },
            { type: 'text', text: ' review by ' },
            { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 8, 30)) } },
          ],
        },
        { type: 'decisionItem', attrs: { localId: 'd-2', state: 'UNDECIDED' }, content: [{ type: 'text', text: 'Maybe shard by region' }] },
        { type: 'decisionItem', attrs: { localId: 'd-empty', state: 'DECIDED' }, content: [] },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'Why: refunds need multi-row transactions.' }] },
    {
      type: 'panel',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Decisions' }] },
        {
          type: 'decisionList',
          content: [{ type: 'decisionItem', attrs: { localId: 'd-3', state: 'DECIDED' }, content: [{ type: 'text', text: 'Use Okta for SSO; no local accounts' }] }],
        },
      ],
    },
  ],
};

describe('extractDecisions', () => {
  const found = extractDecisions(doc);

  it('finds decided, undecided and nested items and skips empty ones', () => {
    expect(found.map((d) => d.localId)).toEqual(['d-1', 'd-2', 'd-3']);
    expect(found[1].state).toBe('UNDECIDED');
  });

  it('captures mentions, review date, heading and rationale', () => {
    expect(found[0]).toMatchObject({
      mentions: [{ accountId: 'acc-1', displayName: 'Priya' }],
      reviewBy: '2026-09-30',
      heading: 'Stay on Postgres for transactional services',
      rationale: 'refunds need multi-row transactions.',
    });
    expect(found[0].statement).toBe('Orders stay on PostgreSQL @Priya review by 2026-09-30');
  });

  it('only attaches rationale to the list it follows', () => {
    expect(found[2].rationale).toBeNull();
  });

  it('falls back to the statement for generic headings', () => {
    expect(titleFor(found[0], 'Page')).toBe('Stay on Postgres for transactional services');
    expect(titleFor(found[2], 'Page')).toBe('Use Okta for SSO');
  });
});

describe('projectKeyFromTitle', () => {
  it('reads "KEY:" and "[KEY]" prefixes', () => {
    expect(projectKeyFromTitle('ORD: ADR-014 Stay on Postgres')).toBe('ORD');
    expect(projectKeyFromTitle('[PAY] Refund policy')).toBe('PAY');
  });

  it('does not mistake a record number for a project', () => {
    expect(projectKeyFromTitle('ADR-001: Use Postgres')).toBeNull();
    expect(projectKeyFromTitle('RFC-12 – API versioning')).toBeNull();
    expect(projectKeyFromTitle('Engineering decisions')).toBeNull();
  });
});

describe('linkedPageIds', () => {
  it('reads page links from link marks and smart-link cards, skipping itself and duplicates', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'see', marks: [{ type: 'link', attrs: { href: 'https://x.atlassian.net/wiki/spaces/ENG/pages/200/API' } }] }] },
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://x.atlassian.net/wiki/spaces/ENG/pages/300' } }] },
        { type: 'blockCard', attrs: { url: 'https://x.atlassian.net/wiki/pages/viewpage.action?pageId=200' } },
        { type: 'inlineCard', attrs: { url: 'https://x.atlassian.net/wiki/spaces/ENG/pages/100/Self' } },
        { type: 'inlineCard', attrs: { url: 'https://github.com/org/repo/pull/7' } },
      ],
    };
    expect(linkedPageIds(doc, '100')).toEqual(['200', '300']);
  });
});
