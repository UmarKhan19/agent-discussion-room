# Triage Labels

The engineering skills use these canonical triage roles and local status strings.

| Canonical role | Local tracker status | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |
| — | `done` | Verified implementation was integrated by the ticket harness |

`in-progress`, `verifying`, `reviewing`, `fixing`, `failed`, and `conflict` are transient Sandcastle run states recorded under `.sandcastle/state/`; ticket Markdown remains `ready-for-agent` until its verified branch is integrated.

When a skill mentions a canonical role, use the corresponding local status string.
