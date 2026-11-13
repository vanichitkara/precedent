import { publishGlobal } from '@forge/realtime';
import api, { route } from '@forge/api';
import { Queue } from '@forge/events';
import { rankCandidates } from './candidates';
import { findRuleConflicts } from './rules';
import { clearStaleConflicts, listDecisions, recordConflict } from '../db/decisions';
import type { Decision } from '../types';

export interface CheckResult {
  /** Breaks an explicit rule in the decision; the reason quotes the clause. */
  conflicts: { decision: Decision; confidence: number; reason: string }[];
  /** Same topic, no explicit rule broken: for an agent (Rovo or MCP client) to judge. */
  possiblyRelated: { decision: Decision; confidence: number; reason: string }[];
  checked: number;
}

/**
 * No LLM here on purpose: Forge LLM calls are billed to the app developer with no free tier.
 * Rules catch explicit contradictions; agents calling us bring their own model for the rest.
 */
export async function checkProposal(
  proposal: string,
  projectKey?: string | null,
  // Background checks run as the app; checks on behalf of a person pass a visibility filter.
  only: (ds: Decision[]) => Promise<Decision[]> = async (ds) => ds,
): Promise<CheckResult> {
  const pool = await only(await listDecisions({ projectKey: projectKey ?? undefined, limit: 300 }));
  const hits = findRuleConflicts(proposal, pool);
  const flagged = new Set(hits.map((h) => h.decision.id));
  const related = rankCandidates(proposal, pool, { projectKey, limit: 5 })
    .filter((r) => !flagged.has(r.decision.id))
    .map((r) => ({ decision: r.decision, confidence: 0, reason: 'Same topic; no explicit rule broken. Read the statement to judge.' }));
  console.log(`Rules flagged ${[...flagged].join(', ') || 'nothing'}; ${related.length} related, ${pool.length} decisions checked`);
  return {
    conflicts: hits.map((h) => ({ decision: h.decision, confidence: 1, reason: h.reason })),
    possiblyRelated: related,
    checked: pool.length,
  };
}

interface IssueFields {
  summary?: string;
  description?: unknown;
  project?: { key: string };
}

export async function issueProposalText(issueKey: string): Promise<{ text: string; projectKey: string | null } | null> {
  const res = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description,project&expand=renderedFields`);
  if (!res.ok) return null;
  const body = (await res.json()) as { fields: IssueFields; renderedFields?: { description?: string } };
  const description = (body.renderedFields?.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    text: [body.fields.summary, description].filter(Boolean).join('\n\n'),
    projectKey: body.fields.project?.key ?? null,
  };
}

/** Runs from the queue so the issue trigger returns immediately. */
export async function checkIssue(issueKey: string): Promise<CheckResult | null> {
  const issue = await issueProposalText(issueKey);
  if (!issue?.text) return null;
  const result = await checkProposal(issue.text, issue.projectKey);
  for (const c of result.conflicts) {
    await recordConflict({ decisionId: c.decision.id, targetKey: issueKey, confidence: c.confidence, reason: c.reason });
  }
  await clearStaleConflicts(issueKey, result.conflicts.map((c) => c.decision.id));
  await announceChecked(issueKey);
  return result;
}

/**
 * Tells an open issue panel to reload, so a new flag appears without a page refresh.
 * Queue consumers have no UI context, so this has to be a global channel; the payload carries
 * nothing but "reload", and the panel then fetches through its resolver, which checks permissions.
 */
export const checkedChannel = (issueKey: string) => `precedent-checked-${issueKey}`;

async function announceChecked(issueKey: string) {
  try {
    await publishGlobal(checkedChannel(issueKey), { reload: true });
  } catch (error) {
    console.warn(`Realtime publish failed for ${issueKey}`, error); // the panel falls back to polling
  }
}

const queue = new Queue({ key: 'conflict-check-queue' });

export async function enqueueIssueCheck(issueKey: string, delayInSeconds = 0) {
  await queue.push({ body: { issueKey }, delayInSeconds });
}

const RECHECK_LIMIT = 50;

/** Re-check a project's open work after new decisions land; staggered to spread LLM calls. */
export async function enqueueProjectRecheck(projectKey: string) {
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(projectKey)) return;
  const jql = `project = ${projectKey} AND statusCategory != Done ORDER BY updated DESC`;
  const res = await api
    .asApp()
    .requestJira(route`/rest/api/3/search/jql?jql=${jql}&fields=key&maxResults=${String(RECHECK_LIMIT)}`);
  if (!res.ok) {
    console.warn(`Recheck search for ${projectKey} failed: ${res.status}`);
    return;
  }
  const body = (await res.json()) as { issues?: { key: string }[] };
  const keys = (body.issues ?? []).map((i) => i.key);
  for (const [i, key] of keys.entries()) await enqueueIssueCheck(key, Math.floor(i / 5) * 2);
  console.log(`Queued re-check of ${keys.length} open ${projectKey} work items after new decisions`);
}

export async function runConflictCheck(event: { body?: { issueKey?: string } }) {
  const key = event.body?.issueKey;
  if (!key) return;
  const result = await checkIssue(key);
  console.log(`Checked ${key}: ${result?.conflicts.length ?? 0} conflicts from ${result?.checked ?? 0} candidates`);
}
