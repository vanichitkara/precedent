import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  ButtonGroup,
  Heading,
  Inline,
  Label,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
  Textfield,
} from '@forge/react';
import type { Decision } from '../types';
import { call, DecisionSummary, StatusLozenge } from './shared';

type AssumptionStatus = 'valid' | 'questioned' | 'invalid';
interface Assumption {
  id: number;
  text: string;
  status: AssumptionStatus;
}
interface Detail {
  decision: Decision | null;
  assumptions: Assumption[];
  supersededBy: Decision | null;
  replacements: { id: string; title: string }[];
}

const ASSUMPTION_LOZENGE = { valid: 'success', questioned: 'moved', invalid: 'removed' } as const;

/**
 * Everything you can do to one decision: read it, track the assumptions it rests on,
 * and supersede it (with a new decision or an existing one). Used by the dashboard and issue panel.
 */
export const DecisionModal = ({ decisionId, onClose, onChanged }: { decisionId: string; onClose: () => void; onChanged: () => void }) => {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assumption, setAssumption] = useState('');
  const [draft, setDraft] = useState({ title: '', statement: '', rationale: '' });
  const [replacementId, setReplacementId] = useState<string | null>(null);

  const load = useCallback(() => call<Detail>('decisionDetail', { id: decisionId }).then(setDetail), [decisionId]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (key: string, payload: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ ok: boolean }>(key, payload);
      if (!res.ok) {
        setError("That didn't work. The decision may have changed, or you may not have access to it.");
        return;
      }
      after?.();
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const d = detail?.decision;
  return (
    <Modal onClose={onClose} width="large">
      <ModalHeader>
        <ModalTitle>{d ? `${d.id} · ${d.title}` : 'Decision'}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        {!detail ? (
          <Spinner label="Loading decision" />
        ) : !d ? (
          <Text>This decision doesn't exist, or you don't have access to its source page.</Text>
        ) : (
          <Stack space="space.300">
            {error ? <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage> : null}
            <DecisionSummary d={d} />

            {d.status === 'proposed' ? (
              <SectionMessage appearance="discovery" title="Proposed, not yet binding">
                <Stack space="space.100">
                  <Text>
                    {d.sourceType === 'confluence'
                      ? 'This decision is still undecided on its Confluence page. Mark it as decided there and it will start flagging conflicting work.'
                      : `${d.context ?? 'Proposed'}. It won't flag any work until someone accepts it.`}
                  </Text>
                  {d.sourceType !== 'confluence' ? (
                    <Inline>
                      <Button appearance="primary" isDisabled={busy} onClick={() => act('acceptDecision', { id: d.id })}>
                        {`Accept ${d.id}`}
                      </Button>
                    </Inline>
                  ) : null}
                </Stack>
              </SectionMessage>
            ) : null}

            {d.status === 'superseded' && detail.supersededBy ? (
              <SectionMessage appearance="information" title={`Superseded by ${detail.supersededBy.id}`}>
                <Text>{`${detail.supersededBy.title}: ${detail.supersededBy.statement}`}</Text>
              </SectionMessage>
            ) : null}

            <Stack space="space.100">
              <Heading size="small">Assumptions</Heading>
              <Text size="small">What has to stay true for this decision to hold. Mark one invalid and the decision goes to revisit.</Text>
              {detail.assumptions.length === 0 ? <Text>None recorded yet.</Text> : null}
              {detail.assumptions.map((a) => (
                <Inline key={a.id} space="space.100" alignBlock="center" spread="space-between">
                  <Inline space="space.100" alignBlock="center">
                    <Lozenge appearance={ASSUMPTION_LOZENGE[a.status]}>{a.status}</Lozenge>
                    <Text>{a.text}</Text>
                  </Inline>
                  <ButtonGroup>
                    {(['valid', 'questioned', 'invalid'] as const)
                      .filter((s) => s !== a.status)
                      .map((s) => (
                        <Button key={s} spacing="compact" appearance="subtle" isDisabled={busy} onClick={() => act('setAssumptionStatus', { assumptionId: a.id, status: s })}>
                          {s === 'valid' ? 'Still true' : s === 'questioned' ? 'Question it' : 'No longer true'}
                        </Button>
                      ))}
                  </ButtonGroup>
                </Inline>
              ))}
              <Inline space="space.100" alignBlock="end">
                <Textfield name="assumption" placeholder="e.g. Refunds always touch more than one row" value={assumption} onChange={(e) => setAssumption(e.target.value)} />
                <Button isDisabled={busy || !assumption.trim()} onClick={() => act('addAssumption', { id: d.id, text: assumption }, () => setAssumption(''))}>
                  Add assumption
                </Button>
              </Inline>
            </Stack>

            {d.status !== 'superseded' ? (
              <Stack space="space.100">
                <Heading size="small">Change this decision</Heading>
                <Text size="small">{`Superseding ${d.id} stops it flagging work, and re-checks open work against the replacement.`}</Text>
                <Tabs id="supersede-tabs">
                  <TabList>
                    <Tab>Write a new decision</Tab>
                    <Tab>Use an existing decision</Tab>
                  </TabList>
                  <TabPanel>
                    <Stack space="space.100">
                      <Label labelFor="new-title">Title</Label>
                      <Textfield id="new-title" name="title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                      <Label labelFor="new-statement">Decision</Label>
                      <TextArea id="new-statement" name="statement" value={draft.statement} onChange={(e) => setDraft({ ...draft, statement: e.target.value })} />
                      <Label labelFor="new-rationale">Why (optional)</Label>
                      <TextArea id="new-rationale" name="rationale" value={draft.rationale} onChange={(e) => setDraft({ ...draft, rationale: e.target.value })} />
                      <Inline>
                        <Button
                          appearance="warning"
                          isDisabled={busy || !draft.title.trim() || !draft.statement.trim()}
                          onClick={() => act('supersedeWithNew', { oldId: d.id, ...draft }, () => setDraft({ title: '', statement: '', rationale: '' }))}
                        >
                          {`Supersede ${d.id}`}
                        </Button>
                      </Inline>
                    </Stack>
                  </TabPanel>
                  <TabPanel>
                    <Stack space="space.100">
                      <Label labelFor="replacement">Replaced by</Label>
                      <Select
                        inputId="replacement"
                        placeholder="Choose a decision"
                        options={detail.replacements.map((r) => ({ label: `${r.id} · ${r.title}`, value: r.id }))}
                        onChange={(o: { value: string } | null) => setReplacementId(o?.value ?? null)}
                      />
                      <Inline>
                        <Button appearance="warning" isDisabled={busy || !replacementId} onClick={() => act('supersede', { oldId: d.id, newId: replacementId })}>
                          {`Supersede ${d.id}`}
                        </Button>
                      </Inline>
                    </Stack>
                  </TabPanel>
                </Tabs>
              </Stack>
            ) : null}
          </Stack>
        )}
      </ModalBody>
      <ModalFooter>
        <Inline space="space.100" alignBlock="center">
          {d ? <StatusLozenge status={d.status} /> : null}
          <Button appearance="subtle" onClick={onClose}>
            Close
          </Button>
        </Inline>
      </ModalFooter>
    </Modal>
  );
};
