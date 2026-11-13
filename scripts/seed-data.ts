/**
 * Demo company: Halcyon Freight. Decisions live in Confluence ADR pages; the Jira issues
 * include three planted contradictions for the demo video (marked `conflictsWith`).
 */

export interface SeedDecision {
  adr: string;
  title: string;
  decision: string;
  why: string;
  reviewBy?: string; // YYYY-MM-DD
}

// Override when the site already uses ORD, e.g. SEED_PROJECT_KEY=PRC npm run seed
export const PROJECT_KEY = process.env.SEED_PROJECT_KEY ?? 'ORD';
export const SPACE_KEY = 'ENGDEC';
export const SPACE_NAME = 'Engineering Decisions';

export const decisions: SeedDecision[] = [
  {
    adr: 'ADR-014',
    title: 'Stay on Postgres for transactional services',
    decision: 'All transactional services, including orders and payments, stay on PostgreSQL. No document databases for transactional data.',
    why: 'Refunds and partial shipments need multi-row transactions; we lost two days of reconciliations to eventual consistency in 2025.',
  },
  {
    adr: 'ADR-021',
    title: 'Version public APIs in the URL',
    decision: 'Public REST APIs are versioned in the path (/v1/, /v2/). No unversioned or "latest" endpoints.',
    why: 'Partners pin integrations for years; header versioning caused support tickets with two carriers.',
  },
  {
    adr: 'ADR-030',
    title: 'Go or TypeScript for new services',
    decision: 'New backend services are written in Go or TypeScript only. No new Python services.',
    why: 'Two languages keeps on-call, libraries and the build pipeline manageable for a 14-person team.',
  },
  {
    adr: 'ADR-033',
    title: 'Feature flags expire after 90 days',
    decision: 'Every feature flag has an owner and is removed within 90 days of full rollout.',
    why: 'Stale flags caused the March checkout incident.',
    reviewBy: '2026-09-30',
  },
  {
    adr: 'ADR-035',
    title: 'Partner API v2 with cursor pagination',
    decision: 'Partner API v2 uses cursor pagination on all list endpoints; offset pagination is not allowed in v2.',
    why: 'Offset pagination timed out on large shipment exports.',
  },
  {
    adr: 'ADR-040',
    title: 'Single sign-on through Okta only',
    decision: 'Internal tools authenticate through Okta SSO. No local username and password accounts.',
    why: 'SOC 2 audit finding; offboarding must revoke access in one place.',
  },
];

export interface SeedIssue {
  summary: string;
  description: string;
  conflictsWith?: string; // ADR id, for the demo script only
}

export const issues: SeedIssue[] = [
  // Planted contradictions
  {
    summary: 'Migrate orders service to MongoDB',
    description: 'Order documents are deeply nested; a document store would simplify the schema and let us drop several joins.',
    conflictsWith: 'ADR-014',
  },
  {
    summary: 'New pricing service in Python',
    description: 'Build the dynamic pricing service in Python so the data science team can own it and reuse their pandas models.',
    conflictsWith: 'ADR-030',
  },
  {
    summary: 'Add /api/latest/shipments endpoint for partners',
    description: 'Partners keep asking for an endpoint that always returns the newest schema so they do not have to upgrade.',
    conflictsWith: 'ADR-021',
  },
  // Ordinary work that should NOT be flagged
  { summary: 'Add index on orders.created_at in Postgres', description: 'Order history page is slow for large accounts.' },
  { summary: 'Write v2 shipments list endpoint with cursor pagination', description: 'Implements ADR-035 for shipments.' },
  { summary: 'Remove checkout_redesign flag', description: 'Fully rolled out in August.' },
  { summary: 'Okta group sync for warehouse dashboard', description: 'Map warehouse roles to Okta groups.' },
  { summary: 'Go client library for carrier webhooks', description: 'Shared library for the three carrier integrations.' },
  { summary: 'Refund reconciliation report', description: 'Daily CSV for finance of refunds over 500 USD.' },
  { summary: 'Upgrade TypeScript to 5.7 in notifications service', description: 'Routine upgrade.' },
];
