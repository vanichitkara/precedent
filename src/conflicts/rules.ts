import type { Decision } from '../types';
import { tokenize } from './candidates';

/**
 * Rule-based contradiction detection: no LLM, so no per-call cost, and every flag quotes
 * the exact clause it's based on. It catches decisions that state an explicit rule:
 *
 *   prohibitions   "No document databases…", "never as CSV exports", "offset pagination is not allowed"
 *   requirements   "stay on PostgreSQL", "Go or TypeScript only", "must use Okta"
 *
 * Nuanced judgement (intent, exceptions) is left to the calling agent (Rovo or an MCP client),
 * which gets the related decisions alongside these flags.
 */

// Words too generic to identify what a rule is about on their own.
const GENERIC = new Set(
  'service servic system data endpoint export report account tool app application team project work item new public internal all any every one other thing way api file'.split(' '),
);

// Technologies grouped so "stay on X" can be broken by a different member of the same group.
const CATEGORIES: Record<string, string[]> = {
  database: ['postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'mongo', 'dynamodb', 'cassandra', 'sqlite', 'oracle', 'firestore', 'couchbase', 'cockroachdb'],
  language: ['python', 'go', 'golang', 'typescript', 'javascript', 'java', 'kotlin', 'ruby', 'rust', 'php', 'scala', 'elixir', 'c#'],
  identity: ['okta', 'auth0', 'onelogin', 'entra', 'keycloak'],
  analytics: ['looker', 'tableau', 'powerbi', 'metabase', 'superset'],
  cloud: ['aws', 'gcp', 'azure'],
};
const CATEGORY_OF = new Map(Object.entries(CATEGORIES).flatMap(([c, terms]) => terms.map((t) => [t, c] as const)));

// Same thing, different spellings, plus the broader kind of thing it is.
const ALIASES: Record<string, string[]> = {
  postgresql: ['postgres'],
  mongo: ['mongodb'],
  mongodb: ['document', 'database'],
  dynamodb: ['document', 'database'],
  firestore: ['document', 'database'],
  couchbase: ['document', 'database'],
  golang: ['go'],
  csv: ['csv'],
};

const canonical = (t: string) => (t === 'postgresql' ? 'postgres' : t === 'mongo' ? 'mongodb' : t === 'golang' ? 'go' : t);

/** Proposal terms with aliases expanded. "Go" only counts as the language when capitalised or written golang. */
export function proposalTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const t of tokenize(text)) {
    if (t === 'go' && !/\bGo\b/.test(text)) continue;
    terms.add(t);
    for (const a of ALIASES[t] ?? []) terms.add(a);
  }
  return terms;
}

export interface Rule {
  kind: 'prohibits' | 'requires';
  clause: string; // quoted back to the user
  terms: string[][]; // prohibits: any alternative whose terms all appear. requires: allowed set (flattened)
  category?: string;
}

// A clause that grants permission ("may use MongoDB", "MongoDB is allowed") carves an exception out of the rest.
const PERMIT = /\b(?:may|can|allowed|permitted|is fine|are fine)\b/i;
const NEGATED = /\b(?:not|never|no)\b|n't\b/i;

/** Technologies a decision explicitly permits, so its own "stay on X" doesn't flag them. */
export function permittedTerms(d: Pick<Decision, 'statement'>): Set<string> {
  const permitted = new Set<string>();
  for (const clause of d.statement.split(/(?<=[.;])\s+|;\s*/)) {
    if (!PERMIT.test(clause) || NEGATED.test(clause)) continue;
    for (const t of tokenize(clause).map(canonical)) if (CATEGORY_OF.has(t)) permitted.add(t);
  }
  return permitted;
}

const PROHIBIT_PATTERNS = [
  /\b(?:no|never)\s+(?:new\s+|more\s+)?(.+?)(?=$|\s(?:for|in|on|to|with|within|unless|except|across)\b|[,;])/gi,
  /\b(?:do not|don't|must not|should not|cannot|can't)\s+(?:use|add|build|create|introduce)\s+(.+?)(?=$|\s(?:for|in|on|to|with)\b|[,;])/gi,
  /\b(?:avoid|ban|forbid)\s+(.+?)(?=$|\s(?:for|in|on|to|with)\b|[,;])/gi,
  /([a-z0-9][\w\s"'-]{2,40}?)\s+(?:is|are)\s+(?:not allowed|forbidden|prohibited|banned)/gi,
];

const REQUIRE_PATTERNS = [
  /\b(?:stay|stays|remain|remains)\s+on\s+([\w.+#-]+)/gi,
  /\b(?:only use|must use|always use|standardi[sz]e on|through)\s+([\w.+#-]+(?:\s+(?:or|and)\s+[\w.+#-]+)*)/gi,
  /\b(?:in|use|uses|on)\s+([\w.+#-]+(?:\s+or\s+[\w.+#-]+)+)\s+only\b/gi,
  /\b([\w.+#-]+(?:\s+or\s+[\w.+#-]+)*)\s+only\b/gi,
];

const significant = (phrase: string) =>
  tokenize(phrase.replace(/^(?:as|a|an|the)\s+/i, '')).filter((t) => !GENERIC.has(t));

export function extractRules(d: Pick<Decision, 'title' | 'statement'>): Rule[] {
  const rules: Rule[] = [];
  const clauses = `${d.statement}`.split(/(?<=[.;])\s+|;\s*/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    for (const re of PROHIBIT_PATTERNS) {
      for (const m of clause.matchAll(re)) {
        const alternatives = m[1]
          .split(/\s+or\s+|,\s*/i)
          .map(significant)
          .filter((a) => a.length > 0);
        if (alternatives.length) rules.push({ kind: 'prohibits', clause, terms: alternatives });
      }
    }
    for (const re of REQUIRE_PATTERNS) {
      for (const m of clause.matchAll(re)) {
        const allowed = tokenize(m[1]).map(canonical).filter((t) => CATEGORY_OF.has(t));
        const category = allowed.length ? CATEGORY_OF.get(allowed[0]) : undefined;
        if (category && allowed.every((t) => CATEGORY_OF.get(t) === category)) {
          rules.push({ kind: 'requires', clause, terms: [allowed], category });
        }
      }
    }
  }
  return rules;
}

export interface RuleHit {
  decision: Decision;
  reason: string;
  clause: string;
}

const DISPLAY: Record<string, string> = { postgres: 'PostgreSQL', mongodb: 'MongoDB', mysql: 'MySQL', dynamodb: 'DynamoDB', typescript: 'TypeScript', javascript: 'JavaScript', csv: 'CSV', aws: 'AWS', gcp: 'GCP', php: 'PHP' };
const display = (t: string) => DISPLAY[t] ?? t.charAt(0).toUpperCase() + t.slice(1);

export function findRuleConflicts(proposal: string, decisions: Decision[]): RuleHit[] {
  const terms = proposalTerms(proposal);
  const hits: RuleHit[] = [];
  for (const decision of decisions) {
    // Only decisions the team stands behind are rules: proposals and superseded ones aren't.
    if (decision.status === 'superseded' || decision.status === 'proposed') continue;
    const permitted = permittedTerms(decision);
    for (const rule of extractRules(decision)) {
      let reason: string | null = null;
      if (rule.kind === 'prohibits') {
        const alt = rule.terms.find((a) => a.every((t) => terms.has(t)));
        if (alt) reason = `Mentions ${alt.map(display).join(' ')}, which ${decision.id} rules out: "${rule.clause}"`;
      } else {
        const allowed = new Set(rule.terms[0]);
        const other = [...terms].map(canonical).find((t) => CATEGORY_OF.get(t) === rule.category && !allowed.has(t) && !permitted.has(t));
        if (other) {
          reason = `Uses ${display(other)}, but ${decision.id} allows only ${[...allowed].map(display).join(' or ')}: "${rule.clause}"`;
        }
      }
      if (reason) {
        hits.push({ decision, reason, clause: rule.clause });
        break; // one hit per decision is enough
      }
    }
  }
  return hits;
}
