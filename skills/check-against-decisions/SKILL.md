---
name: check-against-decisions
description: Check a plan, proposal, work item or code change against the team's recorded decisions before acting on it, and propose new decisions made along the way. Use whenever an agent is about to recommend or start work that changes technology, architecture, process, vendors or policy, or has just made such a choice with the user.
allowed-tools: search-decisions check-against-decisions record-decision
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

## Proposing a decision you made with the user

When you and the user settle a choice that others on the team should follow (a library, a data store, an API convention, a process), offer to record it:

1. Call `check-against-decisions` with the choice first. If it conflicts with a recorded decision, say so instead of recording; the team would have to supersede the old one.
2. Show the user the exact title, one- or two-sentence statement and the reason, and ask whether to record it. Don't record without a yes.
3. Call `record-decision`. Pass `issueKey` if you're working on a Jira work item.
4. Tell the user it was saved as **proposed** (its `cite` value, exactly) and that a teammate must accept it in Precedent before it applies to anyone's work.

Record decisions, not task notes: "Session data lives in Redis" is a decision; "Fixed the login bug" is not.

## Rules

- Never treat a superseded decision as binding; the result marks those with `status: "superseded"`.
- Never claim a decision exists that the tools did not return.
- A `proposed` decision is a suggestion, not a rule. Mention it if relevant, but don't block work on it.
