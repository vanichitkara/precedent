import { describe, expect, it } from 'vitest';
import { visibleOrNull, visibleTo, type SourceAccess } from '../src/permissions';
import type { Decision } from '../src/types';

type D = Pick<Decision, 'id' | 'sourceType' | 'sourceId'>;
const page = (id: string, pageId: string): D => ({ id, sourceType: 'confluence', sourceId: pageId });
const issue = (id: string, key: string): D => ({ id, sourceType: 'jira', sourceId: key });
const manual = (id: string): D => ({ id, sourceType: 'manual', sourceId: null });

const access = (pages: string[], issues: string[] = []): SourceAccess & { pageCalls: string[][] } => {
  const pageCalls: string[][] = [];
  return {
    pageCalls,
    visiblePages: async (ids) => (pageCalls.push(ids), new Set(ids.filter((i) => pages.includes(i)))),
    canSeeIssue: async (key) => issues.includes(key),
  };
};

describe('visibleTo', () => {
  const all = [page('DL-1', '100'), page('DL-2', '200'), page('DL-3', '100'), issue('DL-4', 'ORD-7'), manual('DL-5')];

  it('keeps decisions from pages and work items the viewer can open, plus unsourced ones', async () => {
    const seen = await visibleTo(all, access(['100'], ['ORD-7']));
    expect(seen.map((d) => d.id)).toEqual(['DL-1', 'DL-3', 'DL-4', 'DL-5']);
  });

  it('hides decisions from restricted pages and work items', async () => {
    const seen = await visibleTo(all, access([], []));
    expect(seen.map((d) => d.id)).toEqual(['DL-5']);
  });

  it('checks each page once, in one batch', async () => {
    const a = access(['100', '200']);
    await visibleTo(all, a);
    expect(a.pageCalls).toEqual([['100', '200']]);
  });

  it('fails closed when the check throws (no user context)', async () => {
    const broken: SourceAccess = {
      visiblePages: async () => {
        throw new Error('asUser unavailable');
      },
      canSeeIssue: async () => true,
    };
    expect((await visibleTo(all, broken)).map((d) => d.id)).toEqual(['DL-5']);
  });

  it('ignores malformed page ids rather than putting them in a URL', async () => {
    const a = access(['100']);
    const seen = await visibleTo([page('DL-9', '100&id=1'), page('DL-1', '100')], a);
    expect(a.pageCalls).toEqual([['100']]);
    expect(seen.map((d) => d.id)).toEqual(['DL-1']);
  });
});

describe('visibleOrNull', () => {
  it('returns null for a hidden decision, as if it did not exist', async () => {
    expect(await visibleOrNull(page('DL-2', '200'), access(['100']))).toBeNull();
    expect(await visibleOrNull(page('DL-1', '100'), access(['100']))).toMatchObject({ id: 'DL-1' });
  });
});
