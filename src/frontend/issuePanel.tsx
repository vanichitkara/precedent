import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  EmptyState,
  Heading,
  Inline,
  Link,
  Lozenge,
  ModalTransition,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  xcss,
} from '@forge/react';
import { realtime, rovo } from '@forge/bridge';
import type { Conflict, Decision, DecisionLink } from '../types';
import { call, DecisionSummary } from './shared';
import { DecisionModal } from './DecisionModal';

type ConflictView = Conflict & { decision: Decision; links: DecisionLink[] };
interface PanelData {
  issueKey?: string;
  conflicts: ConflictView[];
  related: Decision[];
  recentlyChanged?: boolean;
}

const WAIT_MS = 30_000;
const POLL_MS = 5_000;

const card = xcss({ padding: 'space.150', borderRadius: 'radius.medium', backgroundColor: 'elevation.surface.raised', boxShadow: 'elevation.shadow.raised' });

const RADIUS_ROWS: { type: DecisionLink['type']; label: string }[] = [
  { type: 'goal', label: 'Goals at stake' },
  { type: 'pull-request', label: 'Pull requests' },
  { type: 'work-item', label: 'Work in conflict' },
  { type: 'team', label: 'Owning teams' },
  { type: 'document', label: 'Related pages' },
];

const LinkOrText = ({ l }: { l: DecisionLink }) =>
  l.url ? <Link href={l.url} openNewTab>{l.label ?? l.ari}</Link> : <Text size="small">{l.label ?? l.ari}</Text>;

/** Teamwork Graph context for the decision: what else moves if it changes. */
const BlastRadius = ({ links }: { links: DecisionLink[] }) => {
  const rows = RADIUS_ROWS.map((r) => ({ ...r, items: links.filter((l) => l.type === r.type) })).filter((r) => r.items.length);
  const people = links.filter((l) => l.type === 'user').length;
  if (!rows.length && !people) return null;
  return (
    <Stack space="space.050">
      <Text size="small" weight="bold">Blast radius (Teamwork Graph)</Text>
      {rows.some((r) => r.items.some((l) => l.relation === 'source')) ? (
        <Text size="small" color="color.text.subtlest">Related pages also include links read from the decision page.</Text>
      ) : null}
      {rows.map((r) => (
        <Inline key={r.type} space="space.075" alignBlock="center" shouldWrap>
          <Text size="small">{`${r.label}:`}</Text>
          {r.items.slice(0, 4).map((l) => (
            <LinkOrText key={l.ari} l={l} />
          ))}
          {r.items.length > 4 ? <Lozenge>{`+${r.items.length - 4}`}</Lozenge> : null}
        </Inline>
      ))}
      {people ? <Text size="small">{`${people} ${people === 1 ? 'person has' : 'people have'} worked on the decision page`}</Text> : null}
    </Stack>
  );
};

const App = () => {
  const [data, setData] = useState<PanelData | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const load = useCallback(() => call<PanelData>('issuePanel').then(setData), []);
  useEffect(() => {
    load();
  }, [load]);

  // The check runs in the background after an edit: reload when it announces it's done.
  useEffect(() => {
    if (!data?.issueKey) return;
    const sub = realtime.subscribeGlobal(`precedent-checked-${data.issueKey}`, () => {
      setWaitingSince(null);
      load();
    });
    return () => {
      sub.then((s) => s.unsubscribe()).catch(() => undefined);
    };
  }, [data?.issueKey, load]);

  // Fallback if no realtime event arrives: poll briefly after a recent edit.
  const waiting = !!data?.recentlyChanged && data.conflicts.length === 0;
  useEffect(() => {
    if (!waiting) return setWaitingSince(null);
    const since = waitingSince ?? Date.now();
    if (waitingSince === null) setWaitingSince(since);
    if (Date.now() - since > WAIT_MS) return;
    const t = setTimeout(load, POLL_MS);
    return () => clearTimeout(t);
  }, [waiting, data, waitingSince, load]);
  const checking = waiting && waitingSince !== null && Date.now() - waitingSince <= WAIT_MS;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Spinner label="Loading decisions" />;

  const open = data.conflicts.filter((c) => c.status === 'open');
  const confirmed = data.conflicts.filter((c) => c.status === 'confirmed');

  return (
    <Stack space="space.200">
      <ModalTransition>
        {openId ? <DecisionModal decisionId={openId} onClose={() => setOpenId(null)} onChanged={load} /> : null}
      </ModalTransition>
      {checking ? (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" label="Checking" />
          <Text>Checking this work item against team decisions…</Text>
        </Inline>
      ) : null}
      {open.map((c) => (
        <SectionMessage key={c.id} appearance="warning" title={`Conflicts with ${c.decision.id}: ${c.decision.title}`}>
          <Stack space="space.100">
            <Text>{c.reason}</Text>
            <DecisionSummary d={c.decision} />
            <BlastRadius links={c.links} />
            <ButtonGroup>
              <Button isDisabled={busy} onClick={() => act(() => call('resolveConflict', { id: c.id, status: 'confirmed' }))}>
                Yes, it conflicts
              </Button>
              <Button appearance="subtle" isDisabled={busy} onClick={() => act(() => call('resolveConflict', { id: c.id, status: 'dismissed' }))}>
                Not a conflict
              </Button>
              <Button appearance="subtle" onClick={() => setOpenId(c.decision.id)}>
                Details
              </Button>
            </ButtonGroup>
          </Stack>
        </SectionMessage>
      ))}

      {confirmed.map((c) => (
        <SectionMessage key={c.id} appearance="error" title={`Blocked by ${c.decision.id}: ${c.decision.title}`}>
          <Stack space="space.100">
            <Text>{`${c.reason} Talk to the decision owners, or supersede ${c.decision.id} if it should change.`}</Text>
            <BlastRadius links={c.links} />
            <Inline>
              <Button onClick={() => setOpenId(c.decision.id)}>{`Supersede ${c.decision.id}…`}</Button>
            </Inline>
          </Stack>
        </SectionMessage>
      ))}

      {open.length === 0 && confirmed.length === 0 && (
        <SectionMessage appearance="success" title="No decision rules broken">
          <Text>This work item doesn't break any explicit rule in a recorded decision. Ask Precedent for a closer read.</Text>
        </SectionMessage>
      )}

      {data.related.length > 0 && (
        <Stack space="space.100">
          <Heading size="xsmall">Recent decisions in this project</Heading>
          {data.related.map((d) => (
            <Box key={d.id} xcss={card}>
              <Stack space="space.100">
                <DecisionSummary d={d} />
                <Inline>
                  <Button spacing="compact" appearance="subtle" onClick={() => setOpenId(d.id)}>
                    Details
                  </Button>
                </Inline>
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
      {!checking && data.related.length === 0 && data.conflicts.length === 0 && (
        <EmptyState
          header="No decisions recorded yet"
          description='Add a "/decision" to any Confluence page and it shows up here.'
        />
      )}

      <Inline space="space.100">
        <Button
          appearance="primary"
          onClick={() =>
            rovo.open({
              type: 'forge',
              agentKey: 'precedent-agent',
              agentName: 'Precedent',
              prompt: `Does ${data.issueKey ?? 'this work item'} contradict any recorded decisions? Check it and explain.`,
            })
          }
        >
          Ask Precedent
        </Button>
        <Button appearance="subtle" isDisabled={busy} onClick={() => act(() => call('recheckIssue'))}>
          {busy ? 'Checking…' : 'Re-check against decisions'}
        </Button>
      </Inline>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
