/**
 * Seeds a dev site with the Halcyon Freight demo data.
 *
 *   ATLASSIAN_SITE=your-site.atlassian.net ATLASSIAN_EMAIL=you@example.com \
 *   ATLASSIAN_API_TOKEN=... npm run seed
 *
 * Use your dev site only. Create a Jira project with key ORD first (any template).
 * Install the app before seeding so the page and issue triggers fire.
 */
import { randomUUID } from 'node:crypto';
import { decisions, issues, PROJECT_KEY, SPACE_KEY, SPACE_NAME, type SeedDecision } from './seed-data';

const site = process.env.ATLASSIAN_SITE;
const email = process.env.ATLASSIAN_EMAIL;
const token = process.env.ATLASSIAN_API_TOKEN;
if (!site || !email || !token) {
  console.error('Set ATLASSIAN_SITE, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN');
  process.exit(1);
}

const base = `https://${site.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const text = (t: string) => ({ type: 'text', text: t });
const paragraph = (...content: object[]) => ({ type: 'paragraph', content });

function adrBody(d: SeedDecision, me: { accountId: string; displayName: string }) {
  const decisionContent: object[] = [
    text(d.decision + ' '),
    { type: 'mention', attrs: { id: me.accountId, text: `@${me.displayName}` } },
  ];
  if (d.reviewBy) {
    decisionContent.push(text(' Review by '), { type: 'date', attrs: { timestamp: String(Date.parse(d.reviewBy)) } });
  }
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(text(`Status: accepted. Project: ${PROJECT_KEY}.`)),
      { type: 'heading', attrs: { level: 2 }, content: [text(d.title)] },
      {
        type: 'decisionList',
        attrs: { localId: randomUUID() },
        content: [{ type: 'decisionItem', attrs: { localId: randomUUID(), state: 'DECIDED' }, content: decisionContent }],
      },
      paragraph(text(`Why: ${d.why}`)),
    ],
  };
}

async function ensureSpace(): Promise<string> {
  const existing = await call<{ results: { id: string }[] }>('GET', `/wiki/api/v2/spaces?keys=${SPACE_KEY}`);
  if (existing.results[0]) return existing.results[0].id;
  await call('POST', '/wiki/rest/api/space', { key: SPACE_KEY, name: SPACE_NAME });
  const created = await call<{ results: { id: string }[] }>('GET', `/wiki/api/v2/spaces?keys=${SPACE_KEY}`);
  return created.results[0].id;
}

async function main() {
  const me = await call<{ accountId: string; displayName: string }>('GET', '/rest/api/3/myself');

  // Fail before creating anything if the target project isn't there.
  const project = await fetch(`${base}/rest/api/3/project/${PROJECT_KEY}`, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!project.ok) {
    console.error(`Jira project ${PROJECT_KEY} not found on ${site}. Create it first, or set SEED_PROJECT_KEY to an existing key.`);
    process.exit(1);
  }
  const existing = await call<{ total?: number; issues?: unknown[] }>(
    'GET',
    `/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${PROJECT_KEY}`)}&maxResults=1&fields=key`,
  );
  if (existing.issues?.length) {
    console.warn(`Note: ${PROJECT_KEY} already has work items; the demo issues will be added alongside them.`);
  }

  const spaceId = await ensureSpace();
  console.log(`Space ${SPACE_KEY} (${spaceId})`);

  for (const d of decisions) {
    const page = await call<{ id: string }>('POST', '/wiki/api/v2/pages', {
      spaceId,
      status: 'current',
      title: `${PROJECT_KEY}: ${d.adr} ${d.title}`,
      body: { representation: 'atlas_doc_format', value: JSON.stringify(adrBody(d, me)) },
    });
    console.log(`  page ${page.id}  ${d.adr} ${d.title}`);
  }

  for (const i of issues) {
    const created = await call<{ key: string }>('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: PROJECT_KEY },
        issuetype: { name: 'Task' },
        summary: i.summary,
        description: { type: 'doc', version: 1, content: [paragraph(text(i.description))] },
      },
    });
    console.log(`  ${created.key}  ${i.summary}${i.conflictsWith ? `   ← should flag ${i.conflictsWith}` : ''}`);
  }
  console.log('\nDone. Conflict checks run asynchronously; open the flagged issues after ~30 s.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
