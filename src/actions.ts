/**
 * Rovo action handlers. The same functions back the agent, the skill and the MCP server.
 * Inputs are LLM-extracted, so never trust them for authorization; the caller is in context.
 */
import { getDecision, getLinks, insertDecision, listDebt, listDecisions, supersede } from './db/decisions';
import { checkProposal, enqueueProjectRecheck, issueProposalText } from './conflicts/check';
import { rankCandidates } from './conflicts/candidates';
import { asUserAccess, linksForViewer, visibleOrNull, visibleTo } from './permissions';
import type { Decision } from './types';

interface ActionPayload {
  [input: string]: unknown;
  context?: {
    jira?: { issueKey?: string; projectKey?: string };
    confluence?: { contentId?: string; url?: string };
  };
}
interface ActionContext {
  principal?: { accountId: string };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** One line per call, so agent and MCP behaviour can be traced in `forge logs`. */
function logCall(action: string, payload: ActionPayload) {
  const { context, ...inputs } = payload;
  const where = context?.jira?.issueKey ?? context?.jira?.projectKey ?? context?.confluence?.contentId ?? 'no product context';
  // Never log credentials: MCP calls carry a signed contextToken among the inputs.
  const safe = Object.fromEntries(Object.entries(inputs).filter(([k]) => !/token|secret|auth/i.test(k)));
  console.log(`Action ${action} (${where}): ${JSON.stringify(safe).slice(0, 300)}`);
}

/** Compact shape for agents: everything needed to cite a decision, nothing more. */
/** Ready-to-paste reference; agents copy a finished string more reliably than they build one. */
export const cite = (d: Decision) => (d.sourceUrl ? `[${d.id} · ${d.title}](${d.sourceUrl})` : `${d.id} · ${d.title}`);

const brief = (d: Decision) => ({
  cite: cite(d),
  id: d.id,
  title: d.title,
  statement: d.statement,
  rationale: d.rationale,
  status: d.status,
  owners: d.owners.map((o) => o.displayName ?? o.accountId),
  decidedAt: d.decidedAt,
  reviewBy: d.reviewBy,
  supersededBy: d.supersededBy,
  projectKey: d.projectKey,
  source: d.sourceUrl,
});

export async function searchDecisionsAction(payload: ActionPayload) {
  logCall('search-decisions', payload);
  const query = str(payload.query);
  if (!query) return { error: 'query is required' };
  const projectKey = str(payload.projectKey) ?? payload.context?.jira?.projectKey;
  const pool = await visibleTo(await listDecisions({ projectKey, includeSuperseded: true, limit: 300 }));
  const ranked = rankCandidates(query, pool, { projectKey, limit: 8 });
  // rankCandidates drops superseded decisions; bring back ones that a hit superseded, so the agent can explain history.
  const hits = ranked.map((r) => r.decision);
  const replaced = pool.filter((d) => d.status === 'superseded' && hits.some((h) => h.id === d.supersededBy));
  return { results: [...hits, ...replaced].map(brief), note: hits.length ? undefined : 'No recorded decision matches this topic.' };
}

export async function getDecisionAction(payload: ActionPayload) {
  logCall('get-decision', payload);
  const id = str(payload.decisionId);
  // A decision the caller can't see is reported exactly like one that doesn't exist.
  const d = id ? await visibleOrNull(await getDecision(id)) : null;
  if (!d) return { error: `No decision ${id ?? ''} found` };
  const links = await linksForViewer(await getLinks(d.id));
  const supersededBy = d.supersededBy ? await visibleOrNull(await getDecision(d.supersededBy)) : null;
  return { decision: brief(d), supersededBy: supersededBy ? brief(supersededBy) : null, linked: links };
}

export async function checkAgainstDecisionsAction(payload: ActionPayload) {
  logCall('check-against-decisions', payload);
  const issueKey = str(payload.issueKey) ?? payload.context?.jira?.issueKey;
  let text = str(payload.text);
  let projectKey = payload.context?.jira?.projectKey ?? null;
  if (!text && issueKey) {
    // The issue is read as the app, so first confirm the caller could open it themselves.
    if (!(await asUserAccess.canSeeIssue(issueKey).catch(() => false))) return { error: `No work item ${issueKey} found` };
    const issue = await issueProposalText(issueKey);
    text = issue?.text;
    projectKey = issue?.projectKey ?? projectKey;
  }
  if (!text) return { error: 'Give either text or issueKey' };
  const result = await checkProposal(text, projectKey, visibleTo);
  const row = (r: (typeof result.conflicts)[number]) => ({ ...brief(r.decision), confidence: r.confidence, reason: r.reason });
  return {
    conflicts: result.conflicts.map(row),
    possiblyRelated: result.possiblyRelated.map(row),
    checkedDecisions: result.checked,
  };
}

export async function listDecisionDebtAction(payload: ActionPayload) {
  logCall('list-decision-debt', payload);
  const debt = await listDebt(str(payload.projectKey) ?? payload.context?.jira?.projectKey);
  const seen = new Set((await visibleTo([...debt.overdue, ...debt.questionedAssumptions.map((q) => q.decision), ...debt.superseded.map((s) => s.decision)])).map((d) => d.id));
  return {
    overdueForReview: debt.overdue.filter((d) => seen.has(d.id)).map(brief),
    questionedAssumptions: debt.questionedAssumptions.filter((q) => seen.has(q.decision.id)).map((q) => ({ ...brief(q.decision), assumption: q.assumption })),
    supersededButStillLinked: debt.superseded.filter((s) => seen.has(s.decision.id)).map((s) => ({ ...brief(s.decision), linkedWorkItems: s.linkedWorkItems })),
  };
}

/**
 * Agents (Rovo chat, or a coding agent over MCP) can propose decisions but not make them binding:
 * everything recorded here starts as `proposed`, which never flags work, until a person accepts it
 * in Precedent.
 */
export async function recordDecisionAction(payload: ActionPayload, context: ActionContext) {
  logCall('record-decision', payload);
  const title = str(payload.title);
  const statement = str(payload.statement);
  if (!title || !statement) return { error: 'title and statement are required' };
  // A work item named by the agent is an input, not proof of access: link it only if the caller can open it.
  const named = str(payload.issueKey)?.toUpperCase();
  const issueKey =
    payload.context?.jira?.issueKey ??
    (named && /^[A-Z][A-Z0-9]+-\d+$/.test(named) && (await asUserAccess.canSeeIssue(named).catch(() => false)) ? named : undefined);
  const d = await insertDecision({
    title,
    statement,
    rationale: str(payload.rationale) ?? null,
    context: 'Proposed through an AI agent',
    status: 'proposed',
    projectKey: str(payload.projectKey)?.toUpperCase() ?? payload.context?.jira?.projectKey ?? issueKey?.split('-')[0] ?? null,
    sourceType: issueKey ? 'jira' : 'manual',
    sourceId: issueKey ?? null,
    sourceUrl: str(payload.sourceUrl) ?? payload.context?.confluence?.url ?? null,
    owners: context.principal ? [{ accountId: context.principal.accountId }] : [],
  });
  return {
    recorded: brief(d),
    // Agents filled the missing link with an invented URL; say plainly there isn't one.
    message:
      `Recorded as ${d.id} with status "proposed". It won't flag any work until a teammate accepts it ` +
      `in Precedent (Apps → Precedent → Details → Accept).` +
      (d.sourceUrl ? '' : ' It has no source page, so there is no link: do not make one up.'),
  };
}

export async function supersedeDecisionAction(payload: ActionPayload) {
  logCall('supersede-decision', payload);
  const oldId = str(payload.decisionId);
  const newId = str(payload.supersededById);
  if (!oldId || !newId) return { error: 'decisionId and supersededById are required' };
  const [a, b] = await Promise.all([getDecision(oldId).then(visibleOrNull), getDecision(newId).then(visibleOrNull)]);
  if (!a || !b) return { error: 'Both decisions must exist' };
  await supersede(a.id, b.id);
  if (a.projectKey) await enqueueProjectRecheck(a.projectKey); // flags follow the current decision
  return { superseded: a.id, by: b.id };
}
