# Safety: Discussion Policy

The Discussion Policy is the **server-owned safety enforcement mechanism**.
It has two independent checks, both implemented in
`src/discussion/policy.ts` as deliberately small, reviewable rule sets — and
both are **completely independent of the debate agents' instructions**:

| Check | Evaluated | Outcome |
| --- | --- | --- |
| **Input Discussion Policy** | The Topic, when a Discussion starts (`DiscussionService.start`) | Allowed Topics start; blocked Topics never create a Discussion |
| **Output Discussion Policy** | Each generated Turn, before it can be committed (`DiscussionRunner.nextTurn`) | Allowed Turns become Messages; blocked Turns are never appended to the Transcript |

The agent instructions merely *reinforce* policy (the Supporter and Opponent
are told to stay within their roles and the policy); they are **not** the
enforcement mechanism. This is proven by tests: the safety suite runs a
table of permitted and prohibited Topics and model outputs and demonstrates
that enforcement succeeds even when the (fake) model attempts to violate
policy, and the browser suite scripts an output that violates policy and
verifies the server blocks it before commit.

## What is blocked

The policy rejects advocacy in three closed categories
(`PolicyCategorySchema`):

| Category | Covers |
| --- | --- |
| `protected_class_violence_advocacy` | Advocacy of violence against protected classes or groups (explicit advocacy or prescriptive calls for violence, harm approval, or defense of direct violence against a protected class). |
| `genocide_advocacy` | Advocacy, defense, approval, or prescription of genocide or ethnic cleansing. |
| `extremist_praise` | Praise, defense, endorsement, or glorification of extremists, terrorist groups, or designated extremist organizations. |

The rules match combinations of signals — explicit advocacy verbs, harm
approval or prescriptive language, violence terms, protected-class or
genocide/extremist references — so ordinary discussion of a historical or
prevention-oriented Topic is not caught, while advocacy for the disallowed
harm is. The exact rules are the source of truth in
`src/discussion/policy.ts`; this document deliberately does not reproduce
patterns that could be used to bypass them.

## Blocked behavior

When policy blocks, the server returns a stable `422` error envelope with a
safe, actionable message and no content from the blocked text:

- **Blocked Topic** (`TOPIC_BLOCKED`): the Discussion is not created. The
  response includes the policy `category` and the action:
  > Choose a Topic that critically examines prevention, history,
  > consequences, or human rights without praising extremists or advocating
  > harm.
- **Blocked output** (`OUTPUT_BLOCKED`): the Turn is not appended to the
  Transcript and the Discussion cannot be advanced from the blocked state.
  The response includes the policy `category` and the action:
  > Start a new Discussion with a different permitted Topic; the blocked
  > Turn was not added to the Transcript.

Neither the Supporter nor the Opponent role can override the policy to
satisfy its assigned position: both roles serve **only permitted Topics**
and pass through the same output check.

The completion **synthesis** passes through the same server-owned output
policy. Its structured fields are joined and checked exactly like a Turn's
content; a blocked synthesis is persisted as a non-retryable
`output_blocked` failure and the completed debate remains fully visible.
The Synthesizer agent is neutral by instruction and by construction — it
never takes a side, never enters the Transcript, and cannot override the
policy.

## Participant recovery

- **Blocked Topic** — edit the Topic to remove the disallowed advocacy (the
  action text explains the acceptable alternative) and start again. The
  error is non-retryable; the Topic field is refocused so the correction is
  immediate.
- **Blocked output** — start a fresh Discussion with a different permitted
  Topic. The blocked Turn is non-retryable and never appears in the
  Transcript; the UI shows a terminal error state with the new-Discussion
  action.

## Persisted evidence

Policy outcomes are part of the persisted system of record, so moderation
behavior is auditable:

- `DiscussionState.policyOutcome` — the input-policy outcome for the Topic
  (`decision: "allowed" | "blocked"` + `category` + `checkedAt`).
- Each `Message.generation.outputPolicyOutcome` — the output-policy outcome
  for that committed Turn (always `allowed`, by construction: blocked Turns
  never become Messages).

Policy outcome timestamps are included in the validated schemas
(`PolicyOutcomeSchema`) and survive restarts through the durable store.
