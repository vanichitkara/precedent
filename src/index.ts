import { syncPageOrRetry } from './capture/confluence';
import { enqueueIssueCheck } from './conflicts/check';
import { listDebt, setStatus } from './db/decisions';

export { handler as resolver } from './resolvers';
export { enqueueMigration, runMigration } from './db/migrations';
export { runConflictCheck } from './conflicts/check';
export { runPageSync } from './capture/confluence';
import { catchUpPages } from './capture/catchup';
import { enqueueMigration } from './db/migrations';

export async function maintenanceTick() {
  await enqueueMigration();
  await catchUpPages();
}
export {
  searchDecisionsAction,
  getDecisionAction,
  checkAgainstDecisionsAction,
  listDecisionDebtAction,
  recordDecisionAction,
  supersedeDecisionAction,
} from './actions';

interface PageEvent {
  content?: { id?: string | number; type?: string };
}

export async function onPage(event: PageEvent) {
  const id = event.content?.id;
  if (!id || (event.content?.type && event.content.type !== 'page')) return;
  await syncPageOrRetry(String(id));
}

interface IssueEvent {
  issue?: { key?: string };
  changelog?: { items?: { field?: string }[] };
}

export async function onIssue(event: IssueEvent) {
  const key = event.issue?.key;
  if (!key) return;
  // On updates, only re-check when the text that's judged actually changed.
  const changed = event.changelog?.items?.map((i) => i.field?.toLowerCase());
  if (changed && !changed.some((f) => f === 'summary' || f === 'description')) return;
  await enqueueIssueCheck(key);
}

/** Weekly: decisions past their review date move to "revisit" so they surface everywhere. */
export async function weeklyDebt() {
  const { overdue } = await listDebt();
  for (const d of overdue) {
    if (d.status === 'accepted') await setStatus(d.id, 'revisit');
  }
  console.log(`Decision debt: ${overdue.length} overdue`);
}
