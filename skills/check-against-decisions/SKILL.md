---
name: check-against-decisions
description: Check a plan, proposal, work item or code change against the team's recorded decisions before acting on it. Use whenever an agent is about to recommend or start work that changes technology, architecture, process, vendors or policy.
allowed-tools: search-decisions check-against-decisions
---

# Check against decisions

Use this before you recommend, plan or start any change that could touch something the team has already decided: a technology or vendor choice, an architecture or API convention, a process, or a policy.

## Steps

1. Call `check-against-decisions` with the proposal in one or two plain sentences as `text`. If you are working on a Jira work item, pass its key as `issueKey` instead.
2. Read the result:
   - `conflicts` is empty: carry on, and mention that no conflicting decision is recorded.
   - `conflicts` is not empty: the proposal breaks an explicit rule in a decision, and `reason` quotes the clause. Stop. Tell the user which decision it contradicts (write its `cite` value exactly, then the owners) and the reason. Ask whether to change the plan or to propose superseding the decision. Do not continue the original plan without their answer.
   - `possiblyRelated`: decisions on the same topic with no explicit rule broken. **Read each `statement` and judge for yourself** whether the proposal would violate or reverse it. Being on the same topic, or implementing the decision, is not a contradiction. If you conclude one is contradicted, treat it like a conflict above and say it's your reading, not a recorded rule. Otherwise mention any that are relevant (by their `cite` value, exactly as given) and continue.
3. If the user asks *why* a decision exists, call `search-decisions` with the topic and quote the rationale.

## Rules

- Never treat a superseded decision as binding; the result marks those with `status: "superseded"`.
- Never claim a decision exists that the tools did not return.
