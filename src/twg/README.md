# Teamwork Graph

Precedent reads the Teamwork Graph to show a decision's **blast radius**: who owns it, which teams they're on, and which goals and pull requests sit behind the work that conflicts with it.

It uses Atlassian's **curated queries** only. Those are typed GraphQL fields with no registration step, so there is nothing to set up:

| Curated query | Used for |
|---|---|
| `confluencePageOwners`, `confluencePageContributors` | People behind the decision's page |
| `confluencePageLinkedConfluencePages` | Pages the decision page links to, tagged with any DL numbers they hold |
| `atlassianUserInTeams` | Teams of the decision's owners |
| `jiraWorkItemGoals` | Goals linked to each conflicting work item |
| `jiraWorkItemLinkedExternalPullRequests` | Pull requests linked to each conflicting work item |

`client.ts` builds a single aliased query per decision, so one panel load costs one Teamwork Graph call. Field names come from the published schema at `https://<site>.atlassian.net/gateway/api/graphql/twg/schema`.

**Runs as the viewer.** `requestTeamworkGraph` exists only on `api.asUser()`, and every curated query is permission-filtered for that user. So enrichment runs from the issue panel and byline resolvers, never from triggers. The issue panel refreshes the radius on each view, because new conflicts change it.

**Scopes.** `manifest.yml` requests one `read:graph:<object>:<product>` scope for each object type touched: page, issue, user, team, goal and pull-request. A scope that's missing or withheld by an admin produces no error, only fewer results. The client logs partial GraphQL errors and a one-line summary ("TWG blast radius for DL-1: …") so you can see what came back in `forge logs`.

**Constraint:** an app can either call the Teamwork Graph API or provide a connector, not both. Precedent only calls the API.
