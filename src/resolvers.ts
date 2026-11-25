import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import {
  addAssumption,
  assumptionDecisionId,
  getDecision,
  getLinks,
  impactCounts,
  insertDecision,
  listAssumptions,
  listConflictsForTarget,
  listDebt,
  listDecisions,
  listDecisionsForSource,
  listOpenConflicts,
  removeExampleDecisions,
  resolveConflict,
  setAssumptionStatus,
  setStatus,
  supersede,
  upsertDecision,
  type AssumptionStatus,
} from './db/decisions';
import { checkIssue, enqueueProjectRecheck } from './conflicts/check';
import { syncPage } from './capture/confluence';
import { ensureGraphLinks } from './twg/client';
import { asUserAccess, linksForViewer, visibleOrNull, visibleTo } from './permissions';
import { EXAMPLE_SOURCE_ID, exampleInputs } from './examples';
import type { Decision } from './types';

const resolver = new Resolver();

resolver.define('issuePanel', async ({ context }) => {
  const issueKey: string | undefined = context.extension?.issue?.key;
  const projectKey: string | undefined = context.extension?.project?.key;
  if (!issueKey) return { conflicts: [], related: [] };
  // Edited in the last minute: a check is probably still running, so the panel waits for it.
  const updated = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=updated`)
    .then((r) => (r.ok ? r.json() : null))
    .then((b: { fields?: { updated?: string } } | null) => b?.fields?.updated)
    .catch(() => undefined);
  const recentlyChanged = !!updated && Date.now() - new Date(updated).getTime() < 60_000;
  const conflicts = (await listConflictsForTarget(issueKey)).filter((c) => c.status !== 'dismissed');
  // Conflicts were found as the app; only show those whose decision this viewer may see.
  const visible = new Map(
    (await visibleTo((await Promise.all(conflicts.map((c) => getDecision(c.decisionId)))).filter((d): d is Decision => !!d))).map(
      (d) => [d.id, d],
    ),
  );
  await ensureGraphLinks([...visible.values()], context.cloudId, true); // conflicts on this item may be new
  const withDecisions = await Promise.all(
    conflicts
      // A superseded decision no longer binds, even if someone confirmed the conflict earlier.
      .filter((c) => visible.has(c.decisionId) && visible.get(c.decisionId)!.status !== 'superseded')
      .map(async (c) => ({ ...c, decision: visible.get(c.decisionId)!, links: await linksForViewer(await getLinks(c.decisionId)) })),
  );
  const related = (await visibleTo(await listDecisions({ projectKey, limit: 10 })))
    .filter((d) => !withDecisions.some((c) => c.decisionId === d.id))
    .slice(0, 5);
  return { issueKey, conflicts: withDecisions, related, recentlyChanged };
});

resolver.define('recheckIssue', async ({ context }) => {
  const issueKey: string | undefined = context.extension?.issue?.key;
  if (issueKey) await checkIssue(issueKey);
  return { ok: true };
});

resolver.define('resolveConflict', async ({ payload, context }) => {
  const { id, status } = payload as { id: number; status: 'confirmed' | 'dismissed' };
  if (status !== 'confirmed' && status !== 'dismissed') throw new Error('bad status');
  await resolveConflict(id, status, context.accountId ?? 'unknown');
  return { ok: true };
});

/** After a decision changes, re-check open work so flags follow the current decision. */
async function recheckAfterChange(projectKey: string | null, issueKey?: string) {
  if (issueKey) await checkIssue(issueKey);
  if (projectKey) await enqueueProjectRecheck(projectKey);
}

resolver.define('decisionDetail', async ({ payload }) => {
  const { id } = payload as { id: string };
  const decision = await visibleOrNull(await getDecision(id));
  if (!decision) return { decision: null };
  const [assumptions, links, supersededBy, pool] = await Promise.all([
    listAssumptions(decision.id),
    getLinks(decision.id).then((l) => linksForViewer(l)),
    decision.supersededBy ? getDecision(decision.supersededBy).then(visibleOrNull) : Promise.resolve(null),
    listDecisions({ projectKey: decision.projectKey ?? undefined, limit: 100 }),
  ]);
  // Candidates to supersede it with: other current decisions the viewer can see.
  const replacements = (await visibleTo(pool)).filter((d) => d.id !== decision.id).map((d) => ({ id: d.id, title: d.title }));
  return { decision, assumptions, links, supersededBy, replacements };
});

/** A person makes an agent's proposal binding; from then on it flags conflicting work. */
resolver.define('acceptDecision', async ({ payload, context }) => {
  const { id } = payload as { id: string };
  const decision = await visibleOrNull(await getDecision(id));
  // Confluence proposals follow their page: they're accepted by marking the item decided there.
  if (!decision || decision.status !== 'proposed' || decision.sourceType === 'confluence') return { ok: false };
  await setStatus(decision.id, 'accepted');
  console.log(`${decision.id} accepted by ${context.accountId ?? 'unknown'}`);
  await recheckAfterChange(decision.projectKey, context.extension?.issue?.key);
  return { ok: true };
});

resolver.define('addAssumption', async ({ payload }) => {
  const { id, text } = payload as { id: string; text: string };
  const decision = await visibleOrNull(await getDecision(id));
  if (!decision || !text?.trim()) return { ok: false };
  return { ok: await addAssumption(decision.id, text.trim()) };
});

resolver.define('setAssumptionStatus', async ({ payload }) => {
  const { assumptionId, status } = payload as { assumptionId: number; status: AssumptionStatus };
  if (!['valid', 'questioned', 'invalid'].includes(status)) throw new Error('bad status');
  const decisionId = await assumptionDecisionId(assumptionId);
  const decision = decisionId ? await visibleOrNull(await getDecision(decisionId)) : null;
  if (!decision) return { ok: false };
  await setAssumptionStatus(assumptionId, status);
  // A decision resting on a broken assumption needs another look.
  if (status === 'invalid' && decision.status === 'accepted') await setStatus(decision.id, 'revisit');
  return { ok: true };
});

resolver.define('supersede', async ({ payload, context }) => {
  const { oldId, newId } = payload as { oldId: string; newId: string };
  const [a, b] = await Promise.all([getDecision(oldId).then(visibleOrNull), getDecision(newId).then(visibleOrNull)]);
  if (!a || !b) return { ok: false };
  const ok = await supersede(a.id, b.id);
  if (ok) await recheckAfterChange(a.projectKey, context.extension?.issue?.key);
  return { ok };
});

resolver.define('supersedeWithNew', async ({ payload, context }) => {
  const { oldId, title, statement, rationale } = payload as { oldId: string; title: string; statement: string; rationale?: string };
  const old = await visibleOrNull(await getDecision(oldId));
  if (!old || !title?.trim() || !statement?.trim()) return { ok: false };
  const replacement = await insertDecision({
    title: title.trim().slice(0, 255),
    statement: statement.trim(),
    rationale: rationale?.trim() || null,
    projectKey: old.projectKey,
    sourceType: 'manual',
    owners: context.accountId ? [{ accountId: context.accountId }] : [],
  });
  await supersede(old.id, replacement.id);
  await recheckAfterChange(old.projectKey, context.extension?.issue?.key);
  return { ok: true, replacement };
});

resolver.define('pageDecisions', async ({ context }) => {
  const pageId = String(context.extension?.content?.id ?? '');
  if (!pageId) return { decisions: [] };
  let decisions = await listDecisionsForSource('confluence', pageId);
  // First view of a page published before install: capture on demand.
  if (decisions.length === 0 && ((await syncPage(pageId)) ?? 0) > 0) {
    decisions = await listDecisionsForSource('confluence', pageId);
  }
  // The viewer can open this page, but check anyway: the byline can render before restrictions apply.
  decisions = await visibleTo(decisions);
  await ensureGraphLinks(decisions, context.cloudId);
  return { decisions };
});

resolver.define('loadExamples', async ({ context }) => {
  for (const d of exampleInputs(context.accountId)) await upsertDecision(d);
  return { ok: true };
});

resolver.define('removeExamples', async () => {
  await removeExampleDecisions(EXAMPLE_SOURCE_ID);
  return { ok: true };
});

resolver.define('dashboard', async () => {
  const [all, debt, open, counts] = await Promise.all([
    listDecisions({ includeSuperseded: true, limit: 200 }),
    listDebt(),
    listOpenConflicts(25),
    impactCounts(),
  ]);
  const decisions = await visibleTo(all);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const seen = (d: Decision) => byId.has(d.id);
  // Conflicts name a work item too: hide those on items the viewer can't open.
  const openConflicts = (
    await Promise.all(
      open
        .filter((c) => byId.has(c.decisionId))
        .map(async (c) => ((await asUserAccess.canSeeIssue(c.targetKey).catch(() => false)) ? c : null)),
    )
  ).filter((c): c is NonNullable<typeof c> => !!c);
  // Impact numbers count only decisions this viewer can see, so they leak nothing about restricted pages.
  const sum = (rows: { decisionId: string; n: number }[]) => rows.filter((r) => byId.has(r.decisionId)).reduce((t, r) => t + r.n, 0);
  const byStatus = (status: string) => sum(counts.conflicts.filter((c) => c.status === status));
  const impact = {
    caught: sum(counts.conflicts),
    confirmed: byStatus('confirmed'),
    dismissed: byStatus('dismissed'),
    open: byStatus('open'),
    revisit: decisions.filter((d) => d.status === 'revisit').length,
    superseded: decisions.filter((d) => d.status === 'superseded').length,
    brokenAssumptions: sum(counts.brokenAssumptions),
  };
  return {
    decisions,
    impact,
    hasExamples: decisions.some((d) => d.sourceType === 'example'),
    debt: {
      overdue: debt.overdue.filter(seen),
      questionedAssumptions: debt.questionedAssumptions.filter((q) => seen(q.decision)),
      superseded: debt.superseded.filter((s) => seen(s.decision)),
    },
    openConflicts: openConflicts.map((c) => ({ ...c, decision: byId.get(c.decisionId) ?? null })),
  };
});

export const handler = resolver.getDefinitions();
