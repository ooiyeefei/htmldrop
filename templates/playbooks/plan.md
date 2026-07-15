use_when: proposing a change/roadmap/approach
# Plan playbook

Use this when proposing a change, roadmap, rollout, remediation, migration, or implementation approach.

## Required structure

1. Goal — the outcome the viewer should be able to approve.
2. Current — what exists now, shown concretely.
3. Proposed — the target state and steps to get there.
4. Risks — what could fail, what it costs, and how you reduce the risk.
5. Open questions — the decisions still needed.

## UI rule

Mock the UI; don't describe it. If the proposal changes a dashboard, show the proposed dashboard frame. If it changes a workflow, show the workflow. If it changes a component, render the component in the target states. The viewer should react to the thing, not to paragraphs about the thing.

## Pattern

- Lead with a short approval banner: "Approve this direction if the goal and risk profile match."
- Use a timeline or stepper only for actual sequence.
- Put open questions next to the affected step, then summarize them at the end.
