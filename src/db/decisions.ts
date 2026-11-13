import { sql, type UpdateQueryResponse } from '@forge/sql';
import type { Conflict, Decision, DecisionInput, DecisionLink, DecisionStatus } from '../types';

interface DecisionRow {
  id: number;
  title: string;
  statement: string;
  rationale: string | null;
  context: string | null;
  status: DecisionStatus;
  owners_json: string | null;
  decided_at: string | null;
  review_by: string | null;
  source_type: Decision['sourceType'];
  source_id: string | null;
  source_local_id: string | null;
  source_url: string | null;
  project_key: string | null;
  seq: number | null;
  superseded_by: number | null;
  updated_at: string;
}

interface ConflictRow {
  id: number;
  decision_id: number;
  target_key: string;
  confidence: string | number;
  reason: string;
  status: Conflict['status'];
  seq: number | null; // the decision's display number, joined in
}

export const formatId = (id: number) => `DL-${id}`;

export const parseId = (value: string): number | null => {
  const m = /^(?:DL-)?(\d+)$/i.exec(value.trim());
  return m ? Number(m[1]) : null;
};

const toDecision = (r: DecisionRow): Decision => ({
  id: formatId(r.seq ?? r.id),
  title: r.title,
  statement: r.statement,
  rationale: r.rationale,
  context: r.context,
  status: r.status,
  owners: r.owners_json ? JSON.parse(r.owners_json) : [],
  decidedAt: r.decided_at,
  reviewBy: r.review_by,
  sourceType: r.source_type,
  sourceId: r.source_id,
  sourceUrl: r.source_url,
  projectKey: r.project_key,
  supersededBy: r.superseded_by ? formatId(r.superseded_by) : null,
  updatedAt: r.updated_at,
});

// ── Display numbers ──────────────────────────────────────────────────────

/** Allocates the next per-installation decision number with a compare-and-set on `counters`. */
export async function nextSeq(): Promise<number> {
  await sql
    .prepare(`INSERT IGNORE INTO counters (name, n) SELECT 'decision', COALESCE(MAX(seq), 0) FROM decisions`)
    .execute();
  for (let attempt = 0; attempt < 20; attempt++) {
    const cur = await sql.prepare<{ n: number }>(`SELECT n FROM counters WHERE name = 'decision'`).execute();
    const n = Number(cur.rows[0]?.n ?? 0);
    const res = await sql
      .prepare<UpdateQueryResponse>(`UPDATE counters SET n = ? WHERE name = 'decision' AND n = ?`)
      .bindParams(n + 1, n)
      .execute();
    if (res.rows.affectedRows === 1) return n + 1;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 80)); // lost the race; retry
  }
  throw new Error('Could not allocate a decision number');
}

/** Numbers decisions created before display numbers existed, oldest first. */
export async function backfillSeq() {
  const res = await sql
    .prepare<{ id: number }>(`SELECT id FROM decisions WHERE seq IS NULL ORDER BY created_at, id LIMIT 500`)
    .execute();
  for (const r of res.rows) {
    const seq = await nextSeq();
    await sql.prepare(`UPDATE decisions SET seq = ? WHERE id = ? AND seq IS NULL`).bindParams(seq, r.id).execute();
  }
  if (res.rows.length) console.log(`Numbered ${res.rows.length} existing decisions`);
}

/** Display ID ("DL-3") → internal row id, for the tables that reference decisions. */
async function internalId(displayId: string): Promise<number | null> {
  const n = parseId(displayId);
  if (n === null) return null;
  const res = await sql.prepare<{ id: number }>(`SELECT id FROM decisions WHERE seq = ?`).bindParams(n).execute();
  return res.rows[0]?.id ?? null;
}

/** Insert or update by source, so re-publishing a page never duplicates its decisions. */
export async function upsertDecision(d: DecisionInput): Promise<void> {
  const existing = await sql
    .prepare<{ id: number; seq: number | null }>(
      `SELECT id, seq FROM decisions WHERE source_type = ? AND source_id <=> ? AND source_local_id <=> ?`,
    )
    .bindParams(d.sourceType, d.sourceId ?? null, d.sourceLocalId ?? null)
    .execute();
  // Only genuinely new decisions take a number, so re-syncs don't leave gaps.
  const seq = existing.rows[0] ? existing.rows[0].seq ?? (await nextSeq()) : await nextSeq();
  await sql
    .prepare(
      `INSERT INTO decisions
        (title, statement, rationale, context, status, owners_json, decided_at, review_by,
         source_type, source_id, source_local_id, source_url, project_key, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         seq = COALESCE(seq, VALUES(seq)),
         title = VALUES(title), statement = VALUES(statement), rationale = VALUES(rationale),
         context = VALUES(context), owners_json = VALUES(owners_json),
         review_by = VALUES(review_by), source_url = VALUES(source_url),
         project_key = COALESCE(VALUES(project_key), project_key)`,
    )
    .bindParams(
      d.title,
      d.statement,
      d.rationale ?? null,
      d.context ?? null,
      d.status ?? 'accepted',
      JSON.stringify(d.owners ?? []),
      d.decidedAt ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
      d.reviewBy ?? null,
      d.sourceType,
      d.sourceId ?? null,
      d.sourceLocalId ?? null,
      d.sourceUrl ?? null,
      d.projectKey ?? null,
      seq,
    )
    .execute();
}

export async function insertDecision(d: DecisionInput): Promise<Decision> {
  // Manual decisions have no natural source key; give them a unique one.
  const localId = d.sourceLocalId ?? `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await upsertDecision({ ...d, sourceLocalId: localId });
  const res = await sql
    .prepare<DecisionRow>(
      `SELECT * FROM decisions WHERE source_type = ? AND source_id <=> ? AND source_local_id = ?`,
    )
    .bindParams(d.sourceType, d.sourceId ?? null, localId)
    .execute();
  return toDecision(res.rows[0]);
}

/** Remove decisions that were deleted from a page since the last sync. */
export async function pruneSourceDecisions(sourceType: string, sourceId: string, keepLocalIds: string[]) {
  if (keepLocalIds.length === 0) {
    await sql
      .prepare(`DELETE FROM decisions WHERE source_type = ? AND source_id = ?`)
      .bindParams(sourceType, sourceId)
      .execute();
    return;
  }
  const placeholders = keepLocalIds.map(() => '?').join(', ');
  await sql
    .prepare(
      `DELETE FROM decisions WHERE source_type = ? AND source_id = ? AND source_local_id NOT IN (${placeholders})`,
    )
    .bindParams(sourceType, sourceId, ...keepLocalIds)
    .execute();
}

export async function listSourceLocalIds(sourceType: string, sourceId: string): Promise<string[]> {
  const res = await sql
    .prepare<{ source_local_id: string }>(
      `SELECT source_local_id FROM decisions WHERE source_type = ? AND source_id = ?`,
    )
    .bindParams(sourceType, sourceId)
    .execute();
  return res.rows.map((r) => r.source_local_id);
}

// ── Page sync bookkeeping ────────────────────────────────────────────────

// Bookkeeping is best-effort: until the page_sync migration has run (hourly), failures here
// just mean the catch-up job re-syncs a page, which is idempotent.

export async function getSyncedVersions(pageIds: string[]): Promise<Map<string, number>> {
  if (pageIds.length === 0) return new Map();
  try {
    const res = await sql
      .prepare<{ page_id: string; version: number }>(
        `SELECT page_id, version FROM page_sync WHERE page_id IN (${pageIds.map(() => '?').join(', ')})`,
      )
      .bindParams(...pageIds)
      .execute();
    return new Map(res.rows.map((r) => [r.page_id, Number(r.version)]));
  } catch (error) {
    console.warn('page_sync unavailable, treating all pages as unsynced', error);
    return new Map();
  }
}

export async function markSynced(pageId: string, version: number) {
  try {
    await sql
      .prepare(
        `INSERT INTO page_sync (page_id, version) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE version = VALUES(version)`,
      )
      .bindParams(pageId, version)
      .execute();
  } catch (error) {
    console.warn(`Could not record sync of page ${pageId}`, error);
  }
}

export async function getDecision(id: string): Promise<Decision | null> {
  const n = parseId(id);
  if (n === null) return null;
  const res = await sql.prepare<DecisionRow>(`SELECT * FROM decisions WHERE seq = ?`).bindParams(n).execute();
  return res.rows[0] ? toDecision(res.rows[0]) : null;
}

export async function listDecisions(opts: { projectKey?: string; includeSuperseded?: boolean; limit?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.projectKey) {
    // Decisions with no project apply everywhere.
    where.push('(project_key = ? OR project_key IS NULL)');
    params.push(opts.projectKey);
  }
  if (!opts.includeSuperseded) where.push(`status <> 'superseded'`);
  const res = await sql
    .prepare<DecisionRow>(
      `SELECT * FROM decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY updated_at DESC LIMIT ${Math.min(opts.limit ?? 200, 500)}`,
    )
    .bindParams(...params)
    .execute();
  return res.rows.map(toDecision);
}

export async function listDecisionsForSource(sourceType: string, sourceId: string) {
  const res = await sql
    .prepare<DecisionRow>(`SELECT * FROM decisions WHERE source_type = ? AND source_id = ? ORDER BY id`)
    .bindParams(sourceType, sourceId)
    .execute();
  return res.rows.map(toDecision);
}

export async function supersede(oldId: string, newId: string): Promise<boolean> {
  const a = parseId(oldId);
  const b = parseId(newId);
  if (a === null || b === null || a === b) return false;
  await sql
    .prepare(`UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE seq = ?`)
    .bindParams(b, a)
    .execute();
  return true;
}

export async function setStatus(id: string, status: DecisionStatus) {
  const n = parseId(id);
  if (n === null) return;
  await sql.prepare(`UPDATE decisions SET status = ? WHERE seq = ?`).bindParams(status, n).execute();
}

export async function listDebt(projectKey?: string) {
  const all = await listDecisions({ projectKey, includeSuperseded: true, limit: 500 });
  const today = new Date().toISOString().slice(0, 10);
  const overdue = all.filter((d) => d.status !== 'superseded' && d.reviewBy && d.reviewBy.slice(0, 10) < today);

  const questioned = await sql
    .prepare<{ seq: number; text: string }>(
      `SELECT d.seq AS seq, a.text AS text FROM assumptions a JOIN decisions d ON d.id = a.decision_id
       WHERE a.status IN ('questioned', 'invalid')`,
    )
    .execute();
  const byId = new Map(all.map((d) => [d.id, d]));
  const questionedAssumptions = questioned.rows
    .map((r) => ({ decision: byId.get(formatId(r.seq)), assumption: r.text }))
    .filter((x): x is { decision: Decision; assumption: string } => !!x.decision);

  const supersededStillLinked = await sql
    .prepare<{ seq: number; n: number }>(
      `SELECT d.seq AS seq, COUNT(*) AS n FROM decision_links l
       JOIN decisions d ON d.id = l.decision_id
       WHERE d.status = 'superseded' AND l.target_type = 'work-item'
       GROUP BY d.seq`,
    )
    .execute();
  const superseded = supersededStillLinked.rows
    .map((r) => ({ decision: byId.get(formatId(r.seq)), linkedWorkItems: Number(r.n) }))
    .filter((x): x is { decision: Decision; linkedWorkItems: number } => !!x.decision);

  return { overdue, questionedAssumptions, superseded };
}

/** Removes the example decisions and everything hanging off them. */
export async function removeExampleDecisions(sourceId: string) {
  const ids = `SELECT id FROM decisions WHERE source_type = 'example' AND source_id = ?`;
  for (const table of ['conflicts', 'assumptions', 'decision_links']) {
    await sql.prepare(`DELETE FROM ${table} WHERE decision_id IN (${ids})`).bindParams(sourceId).execute();
  }
  await sql.prepare(`DELETE FROM decisions WHERE source_type = 'example' AND source_id = ?`).bindParams(sourceId).execute();
}

/** Per-decision counts behind the dashboard's impact numbers; the caller filters to visible decisions. */
export async function impactCounts(): Promise<{
  conflicts: { decisionId: string; status: Conflict['status']; n: number }[];
  brokenAssumptions: { decisionId: string; n: number }[];
}> {
  const conflicts = await sql
    .prepare<{ seq: number; status: Conflict['status']; n: number }>(
      `SELECT d.seq AS seq, c.status AS status, COUNT(*) AS n FROM conflicts c
       JOIN decisions d ON d.id = c.decision_id GROUP BY d.seq, c.status`,
    )
    .execute();
  const broken = await sql
    .prepare<{ seq: number; n: number }>(
      `SELECT d.seq AS seq, COUNT(*) AS n FROM assumptions a
       JOIN decisions d ON d.id = a.decision_id WHERE a.status = 'invalid' GROUP BY d.seq`,
    )
    .execute();
  return {
    conflicts: conflicts.rows.map((r) => ({ decisionId: formatId(r.seq), status: r.status, n: Number(r.n) })),
    brokenAssumptions: broken.rows.map((r) => ({ decisionId: formatId(r.seq), n: Number(r.n) })),
  };
}

// ── Assumptions ──────────────────────────────────────────────────────────

export type AssumptionStatus = 'valid' | 'questioned' | 'invalid';

export interface Assumption {
  id: number;
  decisionId: string;
  text: string;
  status: AssumptionStatus;
}

export async function listAssumptions(decisionId: string): Promise<Assumption[]> {
  const n = await internalId(decisionId);
  if (n === null) return [];
  const res = await sql
    .prepare<{ id: number; text: string; status: AssumptionStatus }>(
      `SELECT id, text, status FROM assumptions WHERE decision_id = ? ORDER BY id`,
    )
    .bindParams(n)
    .execute();
  return res.rows.map((r) => ({ id: r.id, decisionId, text: r.text, status: r.status }));
}

export async function addAssumption(decisionId: string, text: string): Promise<boolean> {
  const n = await internalId(decisionId);
  if (n === null) return false;
  await sql.prepare(`INSERT INTO assumptions (decision_id, text) VALUES (?, ?)`).bindParams(n, text.slice(0, 1000)).execute();
  return true;
}

/** The decision an assumption belongs to, so callers can check the viewer may see it first. */
export async function assumptionDecisionId(assumptionId: number): Promise<string | null> {
  const res = await sql
    .prepare<{ seq: number }>(`SELECT d.seq AS seq FROM assumptions a JOIN decisions d ON d.id = a.decision_id WHERE a.id = ?`)
    .bindParams(assumptionId)
    .execute();
  return res.rows[0]?.seq ? formatId(res.rows[0].seq) : null;
}

export async function setAssumptionStatus(assumptionId: number, status: AssumptionStatus) {
  await sql.prepare(`UPDATE assumptions SET status = ? WHERE id = ?`).bindParams(status, assumptionId).execute();
}

// ── Links ────────────────────────────────────────────────────────────────

/** Replaces one decision's links of the given relation ('graph' from the Teamwork Graph, 'source' from its page). */
export async function replaceLinks(decisionId: string, links: DecisionLink[], relation: DecisionLink['relation'] = 'graph') {
  const n = await internalId(decisionId);
  if (n === null) return;
  await sql.prepare(`DELETE FROM decision_links WHERE decision_id = ? AND relation = ?`).bindParams(n, relation).execute();
  for (const l of links) {
    await sql
      .prepare(
        `INSERT IGNORE INTO decision_links (decision_id, target_ari, target_type, label, url, relation)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bindParams(n, l.ari, l.type, l.label ?? null, l.url ?? null, l.relation)
      .execute();
  }
}

export async function getLinks(decisionId: string): Promise<DecisionLink[]> {
  const n = await internalId(decisionId);
  if (n === null) return [];
  const res = await sql
    .prepare<{ target_ari: string; target_type: DecisionLink['type']; label: string | null; url: string | null; relation: DecisionLink['relation'] }>(
      `SELECT target_ari, target_type, label, url, relation FROM decision_links WHERE decision_id = ?`,
    )
    .bindParams(n)
    .execute();
  return res.rows.map((r) => ({ ari: r.target_ari, type: r.target_type, label: r.label, url: r.url, relation: r.relation }));
}

// ── Conflicts ────────────────────────────────────────────────────────────

const toConflict = (r: ConflictRow): Conflict => ({
  id: r.id,
  decisionId: formatId(r.seq ?? r.decision_id),
  targetKey: r.target_key,
  confidence: Number(r.confidence),
  reason: r.reason,
  status: r.status,
});

/** Records a conflict unless someone already dismissed or confirmed it for this target. */
export async function recordConflict(c: Omit<Conflict, 'id' | 'status'>) {
  const n = await internalId(c.decisionId);
  if (n === null) return;
  await sql
    .prepare(
      `INSERT INTO conflicts (decision_id, target_key, confidence, reason) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         confidence = IF(status = 'open', VALUES(confidence), confidence),
         reason = IF(status = 'open', VALUES(reason), reason)`,
    )
    .bindParams(n, c.targetKey, c.confidence.toFixed(2), c.reason)
    .execute();
}

/** Drops open conflicts the latest check no longer reports (e.g. the summary was edited). */
export async function clearStaleConflicts(targetKey: string, keepDecisionIds: string[]) {
  const keep = keepDecisionIds.map(parseId).filter((n): n is number => n !== null);
  const clause = keep.length
    ? `AND decision_id NOT IN (SELECT id FROM decisions WHERE seq IN (${keep.map(() => '?').join(', ')}))`
    : '';
  await sql
    .prepare(`DELETE FROM conflicts WHERE target_key = ? AND status = 'open' ${clause}`)
    .bindParams(targetKey, ...keep)
    .execute();
}

export async function listConflictsForTarget(targetKey: string) {
  const res = await sql
    .prepare<ConflictRow>(`SELECT c.*, d.seq AS seq FROM conflicts c JOIN decisions d ON d.id = c.decision_id
       WHERE c.target_key = ? ORDER BY c.confidence DESC`)
    .bindParams(targetKey)
    .execute();
  return res.rows.map(toConflict);
}

/** Work items currently flagged (open or confirmed) against a decision. */
export async function listConflictTargets(decisionId: string): Promise<string[]> {
  const n = await internalId(decisionId);
  if (n === null) return [];
  const res = await sql
    .prepare<{ target_key: string }>(
      `SELECT target_key FROM conflicts WHERE decision_id = ? AND status <> 'dismissed' ORDER BY created_at DESC LIMIT 25`,
    )
    .bindParams(n)
    .execute();
  return res.rows.map((r) => r.target_key);
}

export async function listOpenConflicts(limit = 50) {
  const res = await sql
    .prepare<ConflictRow>(`SELECT c.*, d.seq AS seq FROM conflicts c JOIN decisions d ON d.id = c.decision_id
       WHERE c.status = 'open' ORDER BY c.created_at DESC LIMIT ${Math.min(limit, 200)}`)
    .execute();
  return res.rows.map(toConflict);
}

export async function resolveConflict(id: number, status: 'confirmed' | 'dismissed', accountId: string) {
  await sql
    .prepare(`UPDATE conflicts SET status = ?, resolved_by = ? WHERE id = ?`)
    .bindParams(status, accountId, id)
    .execute();
}
