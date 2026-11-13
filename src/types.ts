export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'revisit';

export interface Owner {
  accountId: string;
  displayName?: string;
}

export interface Decision {
  id: string; // "DL-12"
  title: string;
  statement: string;
  rationale: string | null;
  context: string | null;
  status: DecisionStatus;
  owners: Owner[];
  decidedAt: string | null;
  reviewBy: string | null;
  sourceType: 'confluence' | 'jira' | 'manual' | 'example';
  sourceId: string | null;
  sourceUrl: string | null;
  projectKey: string | null;
  supersededBy: string | null;
  updatedAt: string;
}

export interface DecisionInput {
  title: string;
  statement: string;
  rationale?: string | null;
  context?: string | null;
  status?: DecisionStatus;
  owners?: Owner[];
  decidedAt?: string | null;
  reviewBy?: string | null;
  sourceType: Decision['sourceType'];
  sourceId?: string | null;
  sourceLocalId?: string | null;
  sourceUrl?: string | null;
  projectKey?: string | null;
}

export interface DecisionLink {
  ari: string;
  type: 'work-item' | 'document' | 'pull-request' | 'commit' | 'user' | 'team' | 'goal' | 'other';
  label?: string | null;
  url?: string | null;
  relation: 'graph' | 'manual' | 'source';
}

export interface Conflict {
  id: number;
  decisionId: string;
  targetKey: string; // Jira issue key, or "text:<hash>" for ad-hoc checks
  confidence: number; // 0..1
  reason: string;
  status: 'open' | 'confirmed' | 'dismissed';
}
