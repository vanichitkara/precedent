import api, { assumeTrustedRoute, route } from '@forge/api';
import { Queue } from '@forge/events';
import { extractDecisions, linkedPageIds, projectKeyFromTitle, titleFor, type AdfNode } from './adf';
import { listDecisionsForSource, listSourceLocalIds, markSynced, pruneSourceDecisions, replaceLinks, upsertDecision } from '../db/decisions';
import type { DecisionLink } from '../types';
import { enqueueProjectRecheck } from '../conflicts/check';

interface PageResponse {
  id: string;
  title: string;
  authorId?: string;
  createdAt?: string;
  version?: { number: number };
  body?: { atlas_doc_format?: { value: string } };
  _links?: { webui?: string; base?: string };
}

async function fetchPage(pageId: string): Promise<PageResponse | null> {
  const res = await api
    .asApp()
    .requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`);
  if (!res.ok) {
    console.warn(`Could not read page ${pageId}: ${res.status}`);
    return null;
  }
  return res.json();
}

async function fetchProjectLabel(pageId: string): Promise<string | null> {
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}/labels`);
  if (!res.ok) return null;
  const body = (await res.json()) as { results?: { name: string }[] };
  const label = body.results?.find((l) => /^project-[a-z0-9]+$/i.test(l.name));
  return label ? label.name.slice('project-'.length).toUpperCase() : null;
}

/** Returns the number of decisions found, or null if the page body couldn't be read yet. */
export async function syncPage(pageId: string): Promise<number | null> {
  const page = await fetchPage(pageId);
  // Right after creation the body can be briefly unavailable; null tells the caller to retry.
  if (!page?.body?.atlas_doc_format?.value) {
    console.warn(`Page ${pageId} "${page?.title ?? '?'}": body not available yet`);
    return null;
  }

  const doc = JSON.parse(page.body.atlas_doc_format.value) as AdfNode;
  const found = extractDecisions(doc);
  console.log(`Page ${pageId} "${page.title}": ${found.length} decisions`);
  const projectKey = projectKeyFromTitle(page.title) ?? (await fetchProjectLabel(pageId));
  const url = page._links?.base && page._links.webui ? page._links.base + page._links.webui : null;
  const known = new Set(await listSourceLocalIds('confluence', page.id));

  for (const d of found) {
    await upsertDecision({
      title: titleFor(d, page.title),
      statement: d.statement,
      rationale: d.rationale,
      context: page.title,
      status: d.state === 'DECIDED' ? 'accepted' : 'proposed',
      owners: d.mentions.length ? d.mentions : page.authorId ? [{ accountId: page.authorId }] : [],
      decidedAt: page.createdAt ? page.createdAt.slice(0, 19).replace('T', ' ') : null,
      reviewBy: d.reviewBy,
      sourceType: 'confluence',
      sourceId: page.id,
      sourceLocalId: d.localId,
      sourceUrl: url,
      projectKey,
    });
  }
  await pruneSourceDecisions('confluence', page.id, found.map((d) => d.localId));
  if (found.length) await storePageLinks(page, doc);
  if (page.version?.number) await markSynced(page.id, page.version.number);

  // Work created before this decision existed was never checked against it.
  const added = found.filter((d) => !known.has(d.localId)).length;
  if (added > 0 && projectKey) await enqueueProjectRecheck(projectKey);
  // Graph links are filled lazily from the UI (TWG calls need a user context).
  return found.length;
}

const MAX_LINKED_PAGES = 10;

/**
 * Pages the decision page links to, read from its own content. The Teamwork Graph returns the
 * same thing once it has indexed the page, but not on every site or plan; this works everywhere.
 * Titles are read as the app; the panel filters them to pages the viewer can open.
 */
async function storePageLinks(page: PageResponse, doc: AdfNode) {
  const ids = linkedPageIds(doc, page.id).slice(0, MAX_LINKED_PAGES);
  let links: DecisionLink[] = [];
  if (ids.length) {
    // IDs are digits only (linkedPageIds), so building the query string is safe.
    const res = await api.asApp().requestConfluence(assumeTrustedRoute(`/wiki/api/v2/pages?id=${ids.join(',')}&limit=${MAX_LINKED_PAGES}`));
    if (!res.ok) console.warn(`Linked page lookup failed: ${res.status}`);
    const body = res.ok ? ((await res.json()) as { results?: PageResponse[]; _links?: { base?: string } }) : {};
    const base = body._links?.base ?? page._links?.base ?? '';
    links = await Promise.all(
      (body.results ?? []).map(async (p) => {
        const held = (await listDecisionsForSource('confluence', p.id)).map((d) => d.id);
        return {
          ari: `confluence-page/${p.id}`,
          type: 'document' as const,
          label: held.length ? `${p.title} (${held.join(', ')})` : p.title,
          url: p._links?.webui ? base + p._links.webui : null,
          relation: 'source' as const,
        };
      }),
    );
  }
  console.log(`Page ${page.id} links to ${links.length} pages`);
  for (const d of await listDecisionsForSource('confluence', page.id)) await replaceLinks(d.id, links, 'source');
}

const MAX_SYNC_ATTEMPTS = 3;
const syncQueue = new Queue({ key: 'page-sync-queue' });

export async function syncPageOrRetry(pageId: string, attempt = 1) {
  const n = await syncPage(pageId);
  if (n !== null || attempt >= MAX_SYNC_ATTEMPTS) return;
  await syncQueue.push({ body: { pageId, attempt: attempt + 1 }, delayInSeconds: 15 * attempt });
}

export async function runPageSync(event: { body?: { pageId?: string; attempt?: number } }) {
  if (event.body?.pageId) await syncPageOrRetry(event.body.pageId, event.body.attempt ?? 1);
}
