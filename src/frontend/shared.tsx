import React from 'react';
import { Inline, Link, Lozenge, Stack, Strong, Text, User } from '@forge/react';
import { invoke } from '@forge/bridge';
import type { Decision } from '../types';

/** invoke() may wrap the body with metadata; resolvers here never request metadata, but unwrap defensively. */
export async function call<T>(key: string, payload?: Record<string, unknown>): Promise<T> {
  const res = (await invoke<T>(key, payload)) as T | { body: T; metadata?: unknown };
  return res && typeof res === 'object' && 'body' in res && 'metadata' in res ? (res as { body: T }).body : (res as T);
}

const STATUS_APPEARANCE = {
  accepted: 'success',
  proposed: 'new',
  revisit: 'moved',
  superseded: 'removed',
} as const;

export const StatusLozenge = ({ status }: { status: Decision['status'] }) => (
  <Lozenge appearance={STATUS_APPEARANCE[status]}>{status}</Lozenge>
);

export const Owners = ({ owners }: { owners: Decision['owners'] }) =>
  owners.length ? (
    <Inline space="space.050" alignBlock="center">
      {owners.slice(0, 3).map((o) => (
        <User key={o.accountId} accountId={o.accountId} />
      ))}
    </Inline>
  ) : null;

export const DecisionSummary = ({ d }: { d: Decision }) => (
  <Stack space="space.050">
    <Inline space="space.100" alignBlock="center">
      <Strong>{d.id}</Strong>
      {d.sourceUrl ? <Link href={d.sourceUrl} openNewTab>{d.title}</Link> : <Text>{d.title}</Text>}
      <StatusLozenge status={d.status} />
    </Inline>
    <Text>{d.statement}</Text>
    {d.rationale ? <Text size="small">Why: {d.rationale}</Text> : null}
    <Inline space="space.100" alignBlock="center">
      <Owners owners={d.owners} />
      {d.decidedAt ? <Text size="small">Decided {d.decidedAt.slice(0, 10)}</Text> : null}
      {d.reviewBy ? <Text size="small">· Review by {d.reviewBy.slice(0, 10)}</Text> : null}
    </Inline>
  </Stack>
);
