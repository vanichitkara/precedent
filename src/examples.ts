import type { DecisionInput } from './types';

/**
 * Example decisions a new site can load from the empty dashboard, so you can see a conflict
 * flagged without writing a Confluence page first. They apply to every project and are
 * stored as source "example", so they can be removed in one go.
 */
export const EXAMPLE_SOURCE_ID = 'examples';

export const EXAMPLE_DECISIONS: (Pick<DecisionInput, 'title' | 'statement' | 'rationale'> & { localId: string })[] = [
  {
    localId: 'postgres',
    title: 'Stay on Postgres for transactional services',
    statement: 'All transactional services, including orders and payments, stay on PostgreSQL. No document databases for transactional data.',
    rationale: 'Refunds and partial shipments need multi-row transactions.',
  },
  {
    localId: 'api-versions',
    title: 'Version public APIs in the URL',
    statement: 'Public REST APIs are versioned in the path (/v1/, /v2/). No unversioned or "latest" endpoints.',
    rationale: 'Partners pin integrations for years.',
  },
  {
    localId: 'languages',
    title: 'Go or TypeScript for new services',
    statement: 'New backend services are written in Go or TypeScript only. No new Python services.',
    rationale: 'Two languages keep on-call, libraries and the build pipeline manageable.',
  },
  {
    localId: 'sso',
    title: 'Single sign-on through Okta only',
    statement: 'Internal tools authenticate through Okta SSO. No local username and password accounts.',
    rationale: 'Offboarding must revoke access in one place.',
  },
];

export const exampleInputs = (accountId?: string): (DecisionInput & { sourceLocalId: string })[] =>
  EXAMPLE_DECISIONS.map((e) => ({
    title: e.title,
    statement: e.statement,
    rationale: e.rationale,
    context: 'Example decision',
    sourceType: 'example',
    sourceId: EXAMPLE_SOURCE_ID,
    sourceLocalId: e.localId,
    projectKey: null,
    owners: accountId ? [{ accountId }] : [],
  }));
