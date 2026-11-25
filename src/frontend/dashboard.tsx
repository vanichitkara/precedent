import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ModalTransition,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Link,
  SectionMessage,
  SectionMessageAction,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  xcss,
} from '@forge/react';
import type { Conflict, Decision } from '../types';
import { call, Owners, StatusLozenge } from './shared';
import { DecisionModal } from './DecisionModal';

interface Impact {
  caught: number;
  confirmed: number;
  dismissed: number;
  open: number;
  revisit: number;
  superseded: number;
  brokenAssumptions: number;
}

interface DashboardData {
  decisions: Decision[];
  impact: Impact;
  hasExamples: boolean;
  debt: {
    overdue: Decision[];
    questionedAssumptions: { decision: Decision; assumption: string }[];
    superseded: { decision: Decision; linkedWorkItems: number }[];
  };
  openConflicts: (Conflict & { decision: Decision | null })[];
}

// Equal shares of one row, same height, whatever the label length.
const stat = xcss({
  padding: 'space.150',
  borderRadius: 'radius.medium',
  backgroundColor: 'color.background.neutral',
  flexGrow: 1,
  width: '100%', // with the default shrink, every tile ends up the same width
  minWidth: '0',
  height: '112px',
});

const Stat = ({ label, value, hint }: { label: string; value: number; hint?: string }) => (
  <Box xcss={stat}>
    <Stack space="space.050">
      <Heading size="medium">{String(value)}</Heading>
      <Text size="small" weight="bold">{label}</Text>
      <Text size="small" color="color.text.subtlest">{hint ?? ' '}</Text>
    </Stack>
  </Box>
);

/** One sentence a manager can repeat: what the ledger has prevented so far. */
const impactSentence = (i: Impact) =>
  i.caught === 0
    ? 'No contradictions caught yet. Work that breaks a decision will be flagged here.'
    : `Precedent has flagged ${i.caught} ${i.caught === 1 ? 'piece of work' : 'pieces of work'} that broke a team decision. ` +
      `${i.confirmed} confirmed and blocked, ${i.dismissed} dismissed, ${i.open} awaiting review.`;

const head = {
  cells: [
    { key: 'id', content: 'ID', isSortable: true },
    { key: 'title', content: 'Decision', isSortable: true },
    { key: 'status', content: 'Status' },
    { key: 'owners', content: 'Owners' },
    { key: 'project', content: 'Project', isSortable: true },
    { key: 'decided', content: 'Decided', isSortable: true },
    { key: 'actions', content: '' },
  ],
};

const rowFor = (d: Decision, open: (id: string) => void) => ({
  key: d.id,
  cells: [
    { key: Number(d.id.slice(3)), content: d.id },
    { key: d.title, content: d.sourceUrl ? <Link href={d.sourceUrl} openNewTab>{d.title}</Link> : d.title },
    { key: d.status, content: <StatusLozenge status={d.status} /> },
    { key: 'o', content: <Owners owners={d.owners} /> },
    { key: d.projectKey ?? '', content: d.projectKey ?? 'All' },
    { key: d.decidedAt ?? '', content: d.decidedAt?.slice(0, 10) ?? '' },
    { key: 'a', content: <Button spacing="compact" onClick={() => open(d.id)}>Details</Button> },
  ],
});

const App = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call<DashboardData>('dashboard').then(setData), []);
  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = filter.toLowerCase();
    return q ? data.decisions.filter((d) => `${d.id} ${d.title} ${d.statement}`.toLowerCase().includes(q)) : data.decisions;
  }, [data, filter]);

  if (!data) return <Spinner label="Loading ledger" />;

  const debtCount = data.debt.overdue.length + data.debt.questionedAssumptions.length + data.debt.superseded.length;
  const examples = async (key: 'loadExamples' | 'removeExamples') => {
    setBusy(true);
    try {
      await call(key);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (data.decisions.length === 0) {
    return (
      <Stack space="space.300">
        <EmptyState
          header="No decisions yet"
          description='Add a "/decision" to any Confluence page and it lands here as DL-1. Or load four example decisions to see a conflict flagged in a minute.'
          primaryAction={
            <Button appearance="primary" isDisabled={busy} onClick={() => examples('loadExamples')}>
              Load example decisions
            </Button>
          }
        />
      </Stack>
    );
  }

  return (
    <Stack space="space.300">
      <ModalTransition>
        {openId ? <DecisionModal decisionId={openId} onClose={() => setOpenId(null)} onChanged={load} /> : null}
      </ModalTransition>
      {data.hasExamples ? (
        <SectionMessage
          appearance="discovery"
          title="You're using example decisions"
          actions={[<SectionMessageAction key="rm" onClick={() => !busy && examples('removeExamples')}>Remove examples</SectionMessageAction>]}
        >
          <Text>Create a Jira work item called "Migrate orders service to MongoDB" and open it: the Decisions panel flags it within a few seconds.</Text>
        </SectionMessage>
      ) : null}
      {(() => {
        const proposals = data.decisions.filter((d) => d.status === 'proposed' && d.sourceType !== 'confluence');
        return proposals.length ? (
          <SectionMessage appearance="discovery" title={`${proposals.length} ${proposals.length === 1 ? 'decision' : 'decisions'} proposed by AI agents`}>
            <Stack space="space.100">
              <Text>Proposals don't flag any work until someone on the team accepts them.</Text>
              {proposals.map((d) => (
                <Inline key={d.id} space="space.100" alignBlock="center">
                  <Button spacing="compact" onClick={() => setOpenId(d.id)}>Review</Button>
                  <Text>{`${d.id} · ${d.title}`}</Text>
                </Inline>
              ))}
            </Stack>
          </SectionMessage>
        ) : null;
      })()}
      <Text>{impactSentence(data.impact)}</Text>
      <Inline space="space.100" grow="fill">
        <Stat label="Decisions in force" value={data.decisions.filter((d) => d.status !== 'superseded').length} hint={`${data.impact.superseded} superseded`} />
        <Stat label="Contradictions caught" value={data.impact.caught} hint="work items flagged" />
        <Stat label="Blocked" value={data.impact.confirmed} hint="confirmed by the team" />
        <Stat label="Awaiting review" value={data.impact.open} hint="flagged, not yet triaged" />
        <Stat label="To revisit" value={data.impact.revisit} hint={`${data.impact.brokenAssumptions} broken assumptions`} />
        <Stat label="Decision debt" value={debtCount} hint="overdue, questioned or stale" />
      </Inline>

      <Tabs id="ledger-tabs">
        <TabList>
          <Tab>All decisions</Tab>
          <Tab>{`Conflicts (${data.openConflicts.length})`}</Tab>
          <Tab>{`Decision debt (${debtCount})`}</Tab>
        </TabList>
        <TabPanel>
          <Stack space="space.150">
            <Textfield name="filter" placeholder="Filter decisions" onChange={(e) => setFilter(e.target.value)} />
            <DynamicTable
              head={head}
              rows={visible.map((d) => rowFor(d, setOpenId))}
              rowsPerPage={20}
              emptyView={<EmptyState header="No decisions yet" description='Add a "/decision" to a Confluence page to start the ledger.' />}
            />
          </Stack>
        </TabPanel>
        <TabPanel>
          <Stack space="space.150">
            {data.openConflicts.length === 0 && <Text>No open conflicts.</Text>}
            {data.openConflicts.map((c) => (
              <Stack key={c.id} space="space.050">
                <Inline space="space.100">
                  <Text weight="bold">{c.targetKey}</Text>
                  <Text>{`conflicts with ${c.decisionId}${c.decision ? `: ${c.decision.title}` : ''}`}</Text>
                </Inline>
                <Text size="small">{c.reason}</Text>
              </Stack>
            ))}
          </Stack>
        </TabPanel>
        <TabPanel>
          <Stack space="space.200">
            <Heading size="small">Overdue for review</Heading>
            {data.debt.overdue.length ? (
              <DynamicTable head={head} rows={data.debt.overdue.map((d) => rowFor(d, setOpenId))} />
            ) : (
              <Text>Nothing overdue.</Text>
            )}
            <Heading size="small">Superseded but still linked to work</Heading>
            {data.debt.superseded.length ? (
              data.debt.superseded.map((s) => (
                <Text key={s.decision.id}>{`${s.decision.id} ${s.decision.title}: ${s.linkedWorkItems} work items still point at it`}</Text>
              ))
            ) : (
              <Text>None.</Text>
            )}
            <Heading size="small">Questioned assumptions</Heading>
            {data.debt.questionedAssumptions.length ? (
              data.debt.questionedAssumptions.map((q, i) => <Text key={i}>{`${q.decision.id}: ${q.assumption}`}</Text>)
            ) : (
              <Text>None.</Text>
            )}
          </Stack>
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
