import type { Decision } from '../types';

/**
 * Cheap pre-filter before the LLM: rank decisions by term overlap with the proposal,
 * with a boost for shared "decision-bearing" terms (technologies, languages, vendors)
 * and for decisions in the same project. Keeps LLM calls to a handful per check.
 */

const STOPWORDS = new Set(
  'a an and are as at be by for from has have in into is it its of on or our should that the their this to use used using we will with all new add'.split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    // Naive plural folding so "services" matches "service".
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Terms that usually carry the substance of an engineering or business decision.
const STRONG_HINT = /^(postgres|postgresql|mysql|mongodb|mongo|dynamodb|redis|kafka|sqs|python|go|golang|typescript|java|kotlin|rust|node|react|vue|graphql|rest|grpc|aws|gcp|azure|kubernetes|k8s|terraform|v\d+|versioning|monorepo|microservice|serverless|vendor|sso|saml|gdpr|sla)$/;

export interface ScoredDecision {
  decision: Decision;
  score: number;
}

export function rankCandidates(
  proposal: string,
  decisions: Decision[],
  opts: { projectKey?: string | null; limit?: number } = {},
): ScoredDecision[] {
  const p = new Set(tokenize(proposal));
  if (p.size === 0) return [];
  const scored = decisions
    .filter((d) => d.status !== 'superseded')
    .map((decision) => {
      const terms = new Set(tokenize(`${decision.title} ${decision.statement} ${decision.rationale ?? ''}`));
      let score = 0;
      for (const t of terms) {
        if (!p.has(t)) continue;
        score += STRONG_HINT.test(t) ? 3 : 1;
      }
      // Technology swaps rarely share the new term, so reward shared "domain" nouns too:
      // "migrate orders to MongoDB" vs "Stay on Postgres for transactional services" share "orders"/"service".
      if (opts.projectKey && decision.projectKey === opts.projectKey) score += 1;
      const hasStrong = [...p].some((t) => STRONG_HINT.test(t)) && [...terms].some((t) => STRONG_HINT.test(t));
      if (hasStrong) score += 1;
      return { decision, score };
    })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 8);
}
