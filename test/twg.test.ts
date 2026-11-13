import { describe, expect, it } from 'vitest';
import { buildBlastRadiusQuery, linksFromResponse } from '../src/twg/client';

describe('buildBlastRadiusQuery', () => {
  it('aliases one field per owner and two per work item, with matching variables', () => {
    const { query, variables } = buildBlastRadiusQuery({
      pageAri: 'ari:cloud:confluence:c1:page/100',
      ownerAris: ['ari:cloud:identity::user/a'],
      workItemAris: ['ari:cloud:jira:c1:issue/10001', 'ari:cloud:jira:c1:issue/10002'],
    });
    expect(query).toContain('query precedent_blastRadius($page: ID!, $u0: ID!, $w0: ID!, $w1: ID!)');
    expect(query).toContain('owners: confluencePageOwners(id: $page');
    expect(query).toContain('pages: confluencePageLinkedConfluencePages(id: $page');
    expect(query).toContain('u0Teams: atlassianUserInTeams(userId: $u0');
    expect(query).toContain('w1Goals: jiraWorkItemGoals(id: $w1');
    expect(query).toContain('w1Prs: jiraWorkItemLinkedExternalPullRequests(id: $w1');
    expect(variables).toEqual({
      page: 'ari:cloud:confluence:c1:page/100',
      u0: 'ari:cloud:identity::user/a',
      w0: 'ari:cloud:jira:c1:issue/10001',
      w1: 'ari:cloud:jira:c1:issue/10002',
    });
  });

  it('caps owners and work items so the query stays small', () => {
    const { variables } = buildBlastRadiusQuery({
      pageAri: 'p',
      ownerAris: ['1', '2', '3', '4', '5'],
      workItemAris: ['1', '2', '3', '4', '5', '6', '7'],
    });
    expect(Object.keys(variables).filter((k) => k.startsWith('u'))).toHaveLength(3);
    expect(Object.keys(variables).filter((k) => k.startsWith('w'))).toHaveLength(5);
  });
});

describe('linksFromResponse', () => {
  it('maps users, teams, goals and pull requests and skips null fields and duplicates', () => {
    const links = linksFromResponse({
      owners: { edges: [{ node: { __typename: 'AtlassianUser', id: 'u1', name: 'Priya' } }] },
      contributors: { edges: [{ node: { __typename: 'AtlassianUser', id: 'u1', name: 'Priya' } }] },
      u0Teams: { edges: [{ node: { __typename: 'AtlassianTeam', id: 't1', displayName: 'Payments', profileUrl: 'https://x/t1' } }] },
      w0Goals: { edges: [{ node: { __typename: 'AtlassianGoal', id: 'g1', key: 'SHIP-3', name: 'Faster checkout', url: 'https://x/g1' } }] },
      w0Prs: { edges: [{ node: { __typename: 'ExternalPullRequest', id: 'pr1', displayId: '#42', title: 'Mongo spike', status: 'OPEN', url: 'https://x/pr' } }] },
      pages: { edges: [{ node: { __typename: 'ConfluencePage', id: 'c1', pageId: '200', title: 'Orders overview', webUrl: 'https://x/p' } }] },
      w1Goals: null, // e.g. goal scope withheld
    });
    expect(links.map((l) => [l.type, l.label])).toEqual([
      ['user', 'Priya'],
      ['team', 'Payments'],
      ['goal', 'SHIP-3 Faster checkout'],
      ['pull-request', '#42 Mongo spike (open)'],
      ['document', 'Orders overview'],
    ]);
    expect(links.at(-1)?.pageId).toBe('200');
  });

  it('returns nothing for an empty or missing response', () => {
    expect(linksFromResponse(undefined)).toEqual([]);
  });
});
