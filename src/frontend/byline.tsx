import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Spinner, Stack, Text } from '@forge/react';
import type { Decision } from '../types';
import { call, DecisionSummary } from './shared';

const App = () => {
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  useEffect(() => {
    call<{ decisions: Decision[] }>('pageDecisions').then((r) => setDecisions(r.decisions));
  }, []);

  if (!decisions) return <Spinner label="Loading decisions" />;
  if (decisions.length === 0) {
    return <Text>No decisions on this page yet. Type "/decision" in the editor to add one.</Text>;
  }
  return (
    <Stack space="space.200">
      <Text>{`${decisions.length} decision${decisions.length > 1 ? 's' : ''} in the ledger from this page`}</Text>
      {decisions.map((d) => (
        <DecisionSummary key={d.id} d={d} />
      ))}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
