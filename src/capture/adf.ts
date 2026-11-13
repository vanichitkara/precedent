/**
 * Pulls decisions out of Atlassian Document Format (ADF).
 *
 * Confluence's "/decision" element is stored as a `decisionList` of `decisionItem` nodes.
 * Each item has a stable `attrs.localId` (used as our upsert key) and `attrs.state`
 * ("DECIDED" or "UNDECIDED"). Undecided items become `proposed` decisions.
 */

export interface AdfNode {
  type: string;
  attrs?: Record<string, any>;
  text?: string;
  content?: AdfNode[];
}

export interface ExtractedDecision {
  localId: string;
  statement: string;
  state: 'DECIDED' | 'UNDECIDED';
  mentions: { accountId: string; displayName?: string }[];
  reviewBy: string | null; // YYYY-MM-DD from a date node inside the item
  heading: string | null; // nearest heading above the decision list
  rationale: string | null; // paragraph(s) right after the list starting "Why"/"Because"/"Rationale"
}

const RATIONALE_PREFIX = /^\s*(why|because|rationale|reason)\b[:\s-]*/i;

export function inlineText(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'mention':
      return String(node.attrs?.text ?? '').replace(/^@?/, '@');
    case 'date':
      return node.attrs?.timestamp ? toIsoDate(node.attrs.timestamp) : '';
    case 'hardBreak':
      return ' ';
    case 'emoji':
      return node.attrs?.text ?? '';
    case 'inlineCard':
      return node.attrs?.url ?? '';
    default:
      return (node.content ?? []).map(inlineText).join('');
  }
}

function toIsoDate(ts: string | number): string {
  const d = new Date(Number(ts));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function collect(node: AdfNode, type: string, out: AdfNode[] = []): AdfNode[] {
  if (node.type === type) out.push(node);
  for (const c of node.content ?? []) collect(c, type, out);
  return out;
}

export function extractDecisions(doc: AdfNode): ExtractedDecision[] {
  const results: ExtractedDecision[] = [];
  // Walk top-level blocks in order so we can track the current heading and the paragraph after a list.
  const walk = (blocks: AdfNode[], inheritedHeading: string | null) => {
    let heading = inheritedHeading;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === 'heading') {
        heading = inlineText(block).trim() || heading;
        continue;
      }
      if (block.type === 'decisionList') {
        const next = blocks[i + 1];
        const nextText = next?.type === 'paragraph' ? inlineText(next).trim() : '';
        const rationale = RATIONALE_PREFIX.test(nextText) ? nextText.replace(RATIONALE_PREFIX, '').trim() : null;
        for (const item of block.content ?? []) {
          if (item.type !== 'decisionItem') continue;
          const statement = inlineText(item).replace(/\s+/g, ' ').trim();
          if (!statement) continue;
          const dates = collect(item, 'date').map((d) => toIsoDate(d.attrs?.timestamp)).filter(Boolean);
          results.push({
            localId: String(item.attrs?.localId ?? `${results.length}`),
            statement,
            state: item.attrs?.state === 'UNDECIDED' ? 'UNDECIDED' : 'DECIDED',
            mentions: collect(item, 'mention')
              .filter((m) => m.attrs?.id)
              .map((m) => ({ accountId: String(m.attrs!.id), displayName: m.attrs?.text?.replace(/^@/, '') })),
            reviewBy: dates[0] ?? null,
            heading,
            rationale,
          });
        }
        continue;
      }
      // Decisions can sit inside panels, expands, layouts and table cells.
      if (block.content?.length) walk(block.content, heading);
    }
  };
  walk(doc.content ?? [], null);
  return results;
}

/**
 * Jira project a page's decisions belong to, from a "KEY: …" or "[KEY] …" title prefix.
 * A hyphen is not enough ("ADR-001: …" is a record number, not project ADR). No prefix means
 * the decisions apply to every project.
 */
export function projectKeyFromTitle(title: string): string | null {
  const m = /^\s*(?:\[([A-Z][A-Z0-9]{1,9})\]|([A-Z][A-Z0-9]{1,9}):)/.exec(title);
  return m ? (m[1] ?? m[2]) : null;
}

/** Short title for the ledger: the heading if it reads like a title, else the first clause of the statement. */
export function titleFor(d: ExtractedDecision, pageTitle: string): string {
  const generic = /^(decisions?|outcome|summary|decided)$/i;
  if (d.heading && !generic.test(d.heading)) return d.heading.slice(0, 255);
  const first = d.statement.split(/[.;:—–]|\s-\s/)[0].trim();
  return (first.length >= 8 ? first : `${pageTitle}: ${d.statement}`).slice(0, 255);
}

const PAGE_URL = /\/wiki\/(?:spaces\/[^/]+\/pages\/|pages\/viewpage\.action\?pageId=)(\d+)/;

/** Confluence page IDs a page links to, from link marks and smart-link cards, in order and deduplicated. */
export function linkedPageIds(doc: AdfNode, selfId?: string): string[] {
  const ids: string[] = [];
  const add = (url: unknown) => {
    const id = typeof url === 'string' ? PAGE_URL.exec(url)?.[1] : undefined;
    if (id && id !== selfId && !ids.includes(id)) ids.push(id);
  };
  const walk = (n: AdfNode & { marks?: { type: string; attrs?: Record<string, any> }[] }) => {
    if (['inlineCard', 'blockCard', 'embedCard'].includes(n.type)) add(n.attrs?.url);
    for (const m of n.marks ?? []) if (m.type === 'link') add(m.attrs?.href);
    n.content?.forEach(walk);
  };
  walk(doc);
  return ids;
}
