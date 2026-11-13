import api, { route } from '@forge/api';
import { getSyncedVersions } from '../db/decisions';
import { syncPageOrRetry } from './confluence';

/**
 * Safety net for dropped page events. Every few minutes, find pages changed recently and
 * sync any whose version we haven't seen. The lookback window is wider than the schedule
 * interval so a slow or skipped run doesn't leave gaps.
 */

const LOOKBACK_MS = 30 * 60 * 1000;
const PAGE_LIMIT = 50;

export interface ChangedPage {
  id: string;
  version: number;
}

/** Pages whose current version is newer than the last one we synced (or never synced). */
export function pagesNeedingSync(changed: ChangedPage[], synced: Map<string, number>): ChangedPage[] {
  return changed.filter((p) => (synced.get(p.id) ?? 0) < p.version);
}

interface PageListItem {
  id: string;
  version?: { number: number; createdAt?: string };
}

/** Keeps pages whose latest version was created inside the lookback window. */
export function withinLookback(pages: PageListItem[], now: number, lookbackMs = LOOKBACK_MS): ChangedPage[] {
  return pages
    .filter((p) => p.version?.createdAt && now - Date.parse(p.version.createdAt) <= lookbackMs)
    .map((p) => ({ id: String(p.id), version: p.version!.number }));
}

// v2 page list sorted by last change. (CQL search would need the extra search:confluence scope.)
async function recentlyChangedPages(): Promise<ChangedPage[]> {
  const res = await api
    .asApp()
    .requestConfluence(route`/wiki/api/v2/pages?sort=-modified-date&limit=${String(PAGE_LIMIT)}`);
  // 403 here means Confluence isn't connected to this installation (Jira-only): nothing to catch up.
  if (res.status === 403) return [];
  if (!res.ok) {
    console.warn(`Catch-up page list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return [];
  }
  const body = (await res.json()) as { results?: PageListItem[] };
  return withinLookback(body.results ?? [], Date.now());
}

export async function catchUpPages() {
  const changed = await recentlyChangedPages();
  if (changed.length === 0) return;
  const stale = pagesNeedingSync(changed, await getSyncedVersions(changed.map((p) => p.id)));
  for (const p of stale) await syncPageOrRetry(p.id);
  console.log(`Catch-up: ${changed.length} recently changed pages, ${stale.length} synced`);
}
