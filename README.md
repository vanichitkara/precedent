# Precedent

**"Has this already been decided?"** Precedent is a Forge app for Jira and Confluence. It collects decisions where teams already write them (Confluence `/decision` items), flags Jira work that breaks them, and shows what's at stake through the Teamwork Graph. It also gives the same answers to Rovo and to coding agents such as Claude Code over MCP.

Built for **Codegeist 2026** · Category: **Apps for Software Teams** · Bonus prizes: **Best Agents**, **Best app with Atlassian MCP**, **Best Teamwork Graph integration**, **Best Marketplace app**.

---

## For judges: setup and a 5-minute tour

### Install

**Installation link:** _TODO: add the production sharing link before submission._

| You need | Why | Without it |
|---|---|---|
| **Jira Cloud** | Required. Precedent installs into Jira first. | — |
| **Confluence Cloud**, connected to the same install | Decisions are captured from Confluence pages | Decisions can only be recorded through the agent |
| **Rovo** on the site | The Precedent agent and the **Ask Precedent** button | Conflict flagging, the dashboard and MCP still work |
| The installer is an **organization admin** | Atlassian requires org-admin rights to install apps that use Teamwork Graph scopes | Everything works except the **Blast radius** block |

Install from the link into **Jira**, then connect **Confluence** when prompted. A free Forge demo site (`forge site provision`) includes Rovo.

**In a hurry?** Open **Apps → Precedent** in Jira and click **Load example decisions**. Then skip to step 2: four decisions that apply to every project are loaded, and **Remove examples** takes them out again.

### 1. Capture a decision (1 min)
1. In any Confluence space, create a page, e.g. **"Database choice"**.
2. Type `/decision` and enter: **All transactional services stay on PostgreSQL. No document databases.**
3. On the next line, write **Why: refunds need multi-row transactions.**
4. Publish. Click **Decisions** in the page byline to see it in the ledger as **DL-1**.

A title prefix like `PAY:` or `[PAY]` scopes the page's decisions to Jira project PAY. With no prefix, they apply to every project.

### 2. See a conflict flagged (1 min)
1. In any Jira project, create a work item: **"Migrate the orders service to MongoDB"**.
2. Open it and look at the **Decisions** panel. Within about 10 seconds it warns: *Conflicts with DL-1*, quoting the clause that's broken.
3. Click **Yes, it conflicts** or **Not a conflict**. A dismissal is remembered.

Adding a decision later also re-checks existing open work in that project automatically.

### 3. Ask the agent (1 min)
Click **Ask Precedent** in the panel, or open Rovo chat and **select the Precedent agent**. New chats start on the default Rovo agent, which doesn't use the ledger. Try:
- *Has the team decided which database to use?* → cites DL-1 with a link
- *Did we decide which CI provider to use?* → says nothing is recorded; it doesn't invent one
- *Record a decision: we use Sentry for error tracking.* → shows the wording and asks before saving

### 4. Use it from a coding agent over MCP (2 min)
1. In **Atlassian Administration** → Apps → Sites → *your site* → **Connected apps** → **Precedent**, turn on its tools. External MCP access is off by default.
2. Add the server to Claude Code:
   ```bash
   claude mcp add --scope user --transport http precedent https://mcp.atlassian.com/forge/a53572ac-c92b-46a7-b125-e78dcfa1a1be
   ```
3. Start `claude`, run `/mcp`, choose **precedent** → **Authenticate**, and approve your site.
4. Ask: *"I want to add a new orders service on MongoDB. Check with precedent first."* It calls `check-against-decisions` and pushes back, citing DL-1.

Any MCP-compatible client works. The `skills/check-against-decisions/SKILL.md` file can be dropped into another agent as its instructions.

### 5. Teamwork Graph blast radius (org admin only)
Create a team (app switcher → **Teams**) and add yourself, then reopen the work item. Under the warning, **Blast radius (Teamwork Graph)** lists:
- the work in conflict
- the owning teams
- goals and pull requests linked to that work, if your site has Goals or a connected Git provider
- related Confluence pages the decision page links to, with their own DL numbers if they hold decisions
- how many people worked on the decision page

### 6. See the impact (30 s)
Open **Apps → Precedent**. The dashboard leads with how many work items broke a decision, how many the team confirmed and blocked or dismissed, and which decisions need revisiting because an assumption broke. Click **Details** on any decision to track its assumptions or supersede it.

### Want a full dataset instead?
`npm run seed` creates 6 decision pages and 10 Jira work items, 3 of which break a decision. See [Developer setup](#developer-setup).

### Troubleshooting
| Symptom | Fix |
|---|---|
| No warning on a work item | Wait up to 5 minutes: a catch-up job re-syncs any page whose event was missed. Or click **Re-check against decisions**. |
| The agent answers without DL numbers | You're on the default Rovo agent. Select **Precedent**. |
| No Blast radius block | The installer isn't an org admin, or a Teamwork Graph scope was withheld in admin settings |
| `precedent` missing from `/mcp` | Add it with `--scope user`, then start a new `claude` session |

### Data, cost and permissions
- **Runs on Atlassian:** no external egress. All data stays in Forge SQL on your site.
- **No Forge LLM.** Conflict checks are rule-based, so a check costs nothing. Deeper judgement comes from the agent you're already using (Rovo or your MCP client).
- **Respects permissions.** Decisions are captured as the app, but every surface (panels, dashboard, agent, MCP) shows only decisions whose source page or work item the viewer can open. Teamwork Graph results are filtered for the viewer too.

---

## How it works

| Piece | Where |
|---|---|
| **Capture:** Confluence `/decision` items are parsed from the page's ADF on publish or update and upserted by `localId`. A 5-minute catch-up job re-syncs pages whose events were dropped, using page versions. | `src/capture/` |
| **Ledger:** decisions, links, assumptions and conflicts in Forge SQL. People-facing IDs (`DL-n`) come from a per-site counter, because TiDB auto-increment isn't sequential. | `src/db/` |
| **Conflict check:** issue events queue an async check. Rules read each decision's explicit *no / never / not allowed / only / stay on* clauses, with technology categories and aliases (MongoDB is a document database). They flag work that breaks one and quote the clause. Same-topic decisions are returned to agents to judge. | `src/conflicts/` |
| **Permissions:** `visibleTo()` keeps only decisions the viewer can open, with one batched Confluence check made as the user. It fails closed. | `src/permissions.ts` |
| **Rovo agent, skill and actions:** search, get, check, debt, record, supersede. Every result carries a ready-to-paste `cite`. | `manifest.yml`, `src/actions.ts`, `prompts/`, `skills/` |
| **MCP server (`rovo:mcp`):** exposes the four read actions to Rovo Studio and to external MCP clients | `manifest.yml` |
| **Teamwork Graph:** one aliased curated-query call per decision (owners, contributors, teams, goals, PRs), as the viewer | `src/twg/` (read its README) |
| **UI:** issue panel, Confluence byline, global dashboard (UI Kit) | `src/frontend/` |
| **Background:** a 5-minute maintenance tick (pending migrations, page catch-up) and a weekly decision-debt job | `src/index.ts` |

Why conflicts are checked in a trigger rather than by the agent: Rovo agents run from Jira Automation **can't call CREATE or UPDATE actions**, so they can't save a conflict.

## Developer setup

```bash
npm install -g @forge/cli
forge login
npm install
forge register            # writes your app id into manifest.yml
forge deploy
forge install --site your-site.atlassian.net --product jira
forge install --site your-site.atlassian.net --product confluence
```

To seed demo data, create a Jira project `ORD` (or set `SEED_PROJECT_KEY`). Then, in your own terminal:

```bash
export ATLASSIAN_SITE=your-site.atlassian.net ATLASSIAN_EMAIL=you@example.com
read -s ATLASSIAN_API_TOKEN && export ATLASSIAN_API_TOKEN   # type the literal name, then paste the token
npm run seed
```

Use `forge logs` while testing. Every agent and MCP action, visibility check and blast-radius query writes one log line. Credentials are never logged.

## License

[MIT](LICENSE). The agent skill in [`skills/check-against-decisions/SKILL.md`](skills/check-against-decisions/SKILL.md) is free to reuse in any agent.

## Scripts
- `npm test`: unit tests covering ADF parsing, title prefixes, conflict rules on the seed data, candidate ranking, catch-up selection, the concurrent ID counter, permission filtering, and the Teamwork Graph query and parser
- `npm run typecheck`
- `npm run lint`: runs `forge lint`

## Known limitations
- Rules only catch contradictions a decision states explicitly. "We prefer managed services" vs "self-host Kafka" isn't flagged automatically; the agent catches it when asked.
- The Teamwork Graph needs an org-admin installer. On sites without Goals or a connected Git provider, those rows stay empty.
- "Contradictions caught" counts flags still on record: a flag that a later re-check clears (because the work item changed) isn't counted.
- Assumptions are managed in the UI only; the agent can read decision debt but not edit assumptions.
