import api, { route } from '@forge/api';
import { getLinks, listConflictTargets, listDecisionsForSource, replaceLinks } from '../db/decisions';
import type { Decision, DecisionLink } from '../types';

/**
 * Teamwork Graph "blast radius" of a decision, from Atlassian's curated queries (no
 * registration, typed results, permission-filtered for the viewer):
 *
 *   decision page ─ owners / contributors ─ their teams
 *        ├ pages it links to (marked when they hold decisions of their own)
 *        └ work items in conflict with it ─ their goals and pull requests
 *
 * Runs as the viewer (requestTeamworkGraph exists only on asUser), so call it from resolvers.
 * Every object type touched needs a read:graph:* scope in manifest.yml; a missing scope
 * just yields fewer results.
 */

const MAX_OWNERS = 3;
const MAX_WORK_ITEMS = 5;

export interface BlastRadiusInput {
  pageAri: string;
  ownerAris: string[];
  workItemAris: string[];
}

const USER = `edges { node { __typename ... on AtlassianUser { id accountId name } } }`;
const TEAM = `edges { node { __typename ... on AtlassianTeam { id displayName profileUrl } } }`;
const GOAL = `edges { node { __typename ... on AtlassianGoal { id key name url } } }`;
const PAGE = `edges { node { __typename ... on ConfluencePage { id pageId title webUrl } } }`;
const PR = `edges { node { __typename ... on ExternalPullRequest { id title displayId status url } } }`;

/** One aliased query for the whole radius, so a panel load costs a single Teamwork Graph call. */
export function buildBlastRadiusQuery(input: BlastRadiusInput): { query: string; variables: Record<string, string> } {
  const owners = input.ownerAris.slice(0, MAX_OWNERS);
  const items = input.workItemAris.slice(0, MAX_WORK_ITEMS);
  const variables: Record<string, string> = { page: input.pageAri };
  const params = ['$page: ID!'];
  const fields = [
    `owners: confluencePageOwners(id: $page, first: 5) { ${USER} }`,
    `contributors: confluencePageContributors(id: $page, first: 10) { ${USER} }`,
    `pages: confluencePageLinkedConfluencePages(id: $page, first: 10) { ${PAGE} }`,
  ];
  owners.forEach((ari, i) => {
    variables[`u${i}`] = ari;
    params.push(`$u${i}: ID!`);
    fields.push(`u${i}Teams: atlassianUserInTeams(userId: $u${i}, first: 5) { ${TEAM} }`);
  });
  items.forEach((ari, i) => {
    variables[`w${i}`] = ari;
    params.push(`$w${i}: ID!`);
    fields.push(`w${i}Goals: jiraWorkItemGoals(id: $w${i}, first: 5) { ${GOAL} }`);
    fields.push(`w${i}Prs: jiraWorkItemLinkedExternalPullRequests(id: $w${i}, first: 5) { ${PR} }`);
  });
  return { query: `query precedent_blastRadius(${params.join(', ')}) {\n  ${fields.join('\n  ')}\n}`, variables };
}

interface GraphNode {
  __typename?: string;
  id?: string;
  name?: string;
  displayName?: string;
  profileUrl?: string;
  key?: string;
  url?: string;
  title?: string;
  displayId?: string;
  status?: string;
  pageId?: string;
  webUrl?: string;
}

/** Turns the aliased response into links; tolerates fields that came back null (e.g. a missing scope). */
export function linksFromResponse(
  data: Record<string, { edges?: { node?: GraphNode }[] } | null> | undefined,
): (DecisionLink & { pageId?: string })[] {
  const links: (DecisionLink & { pageId?: string })[] = [];
  const seen = new Set<string>();
  for (const conn of Object.values(data ?? {})) {
    for (const edge of conn?.edges ?? []) {
      const n = edge?.node;
      if (!n?.id || seen.has(n.id)) continue;
      seen.add(n.id);
      switch (n.__typename) {
        case 'AtlassianUser':
          links.push({ ari: n.id, type: 'user', label: n.name ?? null, url: null, relation: 'graph' });
          break;
        case 'AtlassianTeam':
          links.push({ ari: n.id, type: 'team', label: n.displayName ?? null, url: n.profileUrl ?? null, relation: 'graph' });
          break;
        case 'AtlassianGoal':
          links.push({ ari: n.id, type: 'goal', label: [n.key, n.name].filter(Boolean).join(' ') || null, url: n.url ?? null, relation: 'graph' });
          break;
        case 'ConfluencePage':
          links.push({ ari: n.id, type: 'document', label: n.title ?? null, url: n.webUrl ?? null, relation: 'graph', pageId: n.pageId });
          break;
        case 'ExternalPullRequest':
          links.push({
            ari: n.id,
            type: 'pull-request',
            label: [n.displayId, n.title, n.status ? `(${n.status.toLowerCase()})` : null].filter(Boolean).join(' ') || null,
            url: n.url ?? null,
            relation: 'graph',
          });
          break;
      }
    }
  }
  return links;
}

interface IssueRef {
  id: string;
  key: string;
  summary: string;
  url: string;
}

/** Work items currently in conflict with the decision, as the viewer sees them. */
async function conflictingWorkItems(decisionId: string): Promise<IssueRef[]> {
  const keys = (await listConflictTargets(decisionId)).filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k)).slice(0, MAX_WORK_ITEMS);
  if (keys.length === 0) return [];
  const jql = `key in (${keys.join(',')})`;
  const res = await api.asUser().requestJira(route`/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=${String(MAX_WORK_ITEMS)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { issues?: { id: string; key: string; self: string; fields?: { summary?: string } }[] };
  return (body.issues ?? []).map((i) => ({
    id: i.id,
    key: i.key,
    summary: i.fields?.summary ?? '',
    url: `${new URL(i.self).origin}/browse/${i.key}`,
  }));
}

export async function refreshGraphLinks(decision: Decision, pageId: string, cloudId: string) {
  const items = await conflictingWorkItems(decision.id);
  const { query, variables } = buildBlastRadiusQuery({
    pageAri: `ari:cloud:confluence:${cloudId}:page/${pageId}`,
    ownerAris: decision.owners.map((o) => `ari:cloud:identity::user/${o.accountId}`),
    workItemAris: items.map((i) => `ari:cloud:jira:${cloudId}:issue/${i.id}`),
  });
  const res = await api.asUser().requestTeamworkGraph(query, variables);
  const body = (await res.json()) as { data?: Record<string, any>; errors?: unknown[] };
  // Partial errors are normal (an unconfigured product, a withheld scope): keep what came back.
  if (body.errors?.length) console.warn(`TWG partial errors for ${decision.id}:`, JSON.stringify(body.errors).slice(0, 400));
  const links: DecisionLink[] = [
    ...items.map((i) => ({
      ari: `ari:cloud:jira:${cloudId}:issue/${i.id}`,
      type: 'work-item' as const,
      label: `${i.key} ${i.summary}`.trim(),
      url: i.url,
      relation: 'graph' as const,
    })),
    ...(await withLedgerIds(linksFromResponse(body.data))),
  ];
  console.log(`TWG blast radius for ${decision.id}: ${summarise(links)}`);
  await replaceLinks(decision.id, links);
}

/** Linked pages that hold decisions of their own get their DL ids, e.g. "Payments architecture (DL-2, DL-5)". */
async function withLedgerIds(links: (DecisionLink & { pageId?: string })[]): Promise<DecisionLink[]> {
  return Promise.all(
    links.map(async ({ pageId, ...l }) => {
      if (l.type !== 'document' || !pageId) return l;
      const ids = (await listDecisionsForSource('confluence', pageId)).map((d) => d.id);
      return ids.length ? { ...l, label: `${l.label ?? 'Untitled'} (${ids.join(', ')})` } : l;
    }),
  );
}

const summarise = (links: DecisionLink[]) => {
  const counts = links.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.type]: (acc[l.type] ?? 0) + 1 }), {});
  return Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ') || 'nothing';
};

/**
 * Refreshes the radius for the given decisions (max 3 per call to keep panel loads quick).
 * `force` re-reads even when links exist, used where conflicts may have changed since.
 */
export async function ensureGraphLinks(decisions: Decision[], cloudId: string | undefined, force = false) {
  if (!cloudId) return;
  const due: Decision[] = [];
  for (const d of decisions) {
    if (d.sourceType !== 'confluence' || !d.sourceId) continue;
    if (force || !(await getLinks(d.id)).some((l) => l.relation === 'graph')) due.push(d);
  }
  const results = await Promise.allSettled(due.slice(0, 3).map((d) => refreshGraphLinks(d, d.sourceId!, cloudId)));
  for (const r of results) if (r.status === 'rejected') console.warn('TWG refresh failed', r.reason);
}
