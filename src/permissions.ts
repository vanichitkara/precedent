import api, { assumeTrustedRoute, route } from '@forge/api';
import type { Decision, DecisionLink } from './types';

/**
 * Decisions are captured as the app, which can read restricted pages. Everything shown to a
 * person (panels, Rovo agent, MCP tools) goes through `visibleTo` so they only see decisions
 * whose source page or work item they can open themselves. It fails closed: if the check
 * can't run, sourced decisions are hidden. Decisions recorded in chat have no source and are
 * visible to everyone on the site.
 */

export interface SourceAccess {
  /** Of the given Confluence page IDs, the ones the current user can view. */
  visiblePages(ids: string[]): Promise<Set<string>>;
  /** Whether the current user can view this Jira work item. */
  canSeeIssue(key: string): Promise<boolean>;
}

const PAGE_BATCH = 250; // v2 pages endpoint limit

export const asUserAccess: SourceAccess = {
  async visiblePages(ids) {
    const visible = new Set<string>();
    for (let i = 0; i < ids.length; i += PAGE_BATCH) {
      const batch = ids.slice(i, i + PAGE_BATCH);
      // IDs are digits only (checked below), so building the query string is safe.
      const res = await api
        .asUser()
        .requestConfluence(assumeTrustedRoute(`/wiki/api/v2/pages?id=${batch.join(',')}&limit=${PAGE_BATCH}`));
      if (!res.ok) {
        console.warn(`Page visibility check failed: ${res.status}; hiding ${batch.length} pages`);
        continue;
      }
      const body = (await res.json()) as { results?: { id: string | number }[] };
      for (const p of body.results ?? []) visible.add(String(p.id));
    }
    return visible;
  },
  async canSeeIssue(key) {
    const res = await api.asUser().requestJira(route`/rest/api/3/issue/${key}?fields=id`);
    return res.ok;
  },
};

export async function visibleTo<T extends Pick<Decision, 'sourceType' | 'sourceId'>>(
  decisions: T[],
  access: SourceAccess = asUserAccess,
): Promise<T[]> {
  if (decisions.length === 0) return [];
  const pageIds = [
    ...new Set(decisions.filter((d) => d.sourceType === 'confluence' && d.sourceId && /^\d+$/.test(d.sourceId)).map((d) => d.sourceId!)),
  ];
  const issueKeys = [...new Set(decisions.filter((d) => d.sourceType === 'jira' && d.sourceId).map((d) => d.sourceId!))];

  let pages = new Set<string>();
  const issues = new Set<string>();
  try {
    if (pageIds.length) pages = await access.visiblePages(pageIds);
    const checks = await Promise.all(issueKeys.map(async (k) => [k, await access.canSeeIssue(k)] as const));
    for (const [k, ok] of checks) if (ok) issues.add(k);
  } catch (error) {
    // No user context (e.g. an automation-run agent) or the check itself failed: fail closed.
    console.warn('Visibility check unavailable; showing only unsourced decisions', error);
  }

  const kept = decisions.filter((d) => {
    if (d.sourceType === 'confluence') return !!d.sourceId && pages.has(d.sourceId);
    if (d.sourceType === 'jira') return !!d.sourceId && issues.has(d.sourceId);
    return true; // recorded in chat: no source to restrict it
  });
  console.log(`Visibility: kept ${kept.length} of ${decisions.length} decisions`);
  return kept;
}

/** Single-decision form: null when the viewer may not see it, as if it didn't exist. */
export async function visibleOrNull<T extends Pick<Decision, 'sourceType' | 'sourceId'>>(
  decision: T | null,
  access: SourceAccess = asUserAccess,
): Promise<T | null> {
  if (!decision) return null;
  const [d] = await visibleTo([decision], access);
  return d ?? null;
}

const linkedPageId = (l: DecisionLink) => /(?:page\/|pages\/)(\d+)/.exec(`${l.ari} ${l.url ?? ''}`)?.[1];

/**
 * Related pages come from two places (the Teamwork Graph and the decision page itself) and were
 * stored for whoever viewed first. Keep one per page, and only pages this viewer can open.
 */
export async function linksForViewer(links: DecisionLink[], access: SourceAccess = asUserAccess): Promise<DecisionLink[]> {
  const pageIds = [...new Set(links.filter((l) => l.type === 'document').map(linkedPageId).filter((id): id is string => !!id))];
  const visible = pageIds.length ? await access.visiblePages(pageIds).catch(() => new Set<string>()) : new Set<string>();
  const seen = new Set<string>();
  return links.filter((l) => {
    if (l.type !== 'document') return true;
    const id = linkedPageId(l);
    if (!id || !visible.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
