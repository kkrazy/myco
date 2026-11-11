# critic.md — accumulated critic rules

This file holds project-specific critic rules + anti-patterns that
extend the base system prompt of any critic (Gemini / Codex /
Custom) running on this myco workspace. It is **read on every
critique run** and **appended to the critic's system prompt** as
authoritative project context.

Rules live ON TOP OF (do not replace) the base prompt:
"INSUFFICIENT INFORMATION:" opt-out, "✓ AGREED" verdict, citation
discipline, no-speculation clause, diff-only context.

This file is seeded from the myco-shipped default at
`server/templates/critic.md` on the first critique run for a
project. After that, **the project owns it** — myco template
updates do NOT overwrite local edits. To reset to the default,
delete `_myco_/critic.md` and trigger another critic run.

`_myco_/critic.md` is checked into git so every collaborator (and
every future agent run) shares the same critic ground truth.

## Core review principles

- **Anchor on the user's task text.** If the diff doesn't visibly
  trace to a line in the task or its sub-requirements, flag the
  unsupported change as scope-creep. Cite the diff line.
- **Distinguish severity.** Lead the verdict with data-loss,
  security, and correctness issues; only after those come
  maintainability / style suggestions. A clean "✓ AGREED" beats a
  long list of nits.
- **Cite specific diff line numbers** for every claim. A claim
  without a citation is speculative — write
  `INSUFFICIENT INFORMATION:` instead.
- **No invented context.** You only see the diff + Claude's short
  explanation. No full file contents, no chat history, no test
  runs. If you cannot tell from those alone whether something is
  correct, write `INSUFFICIENT INFORMATION: <what you would need>`
  rather than rubber-stamping or speculating.
- **Match the user's explicit ask.** If the user asked the agent to
  REMOVE feature X, don't flag the removal as a regression — that's
  what they wanted. Re-read the task before flagging "missing X".

## Anti-patterns to flag

- **Broad `try/catch` that swallows the error** without logging or
  re-raising — masked failures pile up as hard-to-debug ghosts.
- **New public API / route surfaces without callers, tests, or
  auth-tier gating** matching adjacent routes. Per CLAUDE.md §8.3,
  no speculative features.
- **Hard deletes against a shared store** without an explicit
  confirm + admin gate — `.filter(it => it.id !== id)`-style
  removals are data-loss surfaces and deserve careful scrutiny.
- **Tests altered in the same diff as the code they cover, where
  the test edit is REMOVING assertions** rather than adding new
  ones — the test is being weakened to make a regression pass.
- **Inline regex parsing of text that the SDK already provides as
  a structured event** — CLAUDE.md "Code Style §2" requires
  SDK-driven contracts only; regex on rendered text is the failure
  mode that whole section guards against.
- **New magic numbers without a named constant + 1-line
  explanation** — `setTimeout(fn, 47315)` is a future bug.
- **Cross-cutting state (carve-outs, allowlists, env-keyed
  behaviours) implemented inline in multiple places** instead of
  delegating to one helper. Per CLAUDE.md §1 (high cohesion, low
  coupling), the same responsibility should live in ONE place.
- **Comments mismatching code** (e.g. comment says "uses 8px"
  while the code uses 16px) — the divergence is itself the bug.

## Things NOT to flag (calibration — reduce false positives)

- **Missing tests for trivial CSS / copy edits.** A 1-line padding
  change doesn't need a regression test (per CLAUDE.md §6's spirit
  — write tests for *behaviour* changes, not pixel nudges that
  aren't visually-broken bugs).
- **Comments referencing prior bug numbers** (e.g. `bug-49 r1`,
  `fr-87`) — these are trail markers used by the project's
  iteration discipline, NOT technical debt.
- **`_myco_/plan.json` edits** — those are run-summary persistence
  + plan-item bookkeeping, not application code.
- **Adjacent unrelated code that wasn't modified** — only critique
  what the diff actually touches. CLAUDE.md §8.4 (surgical edits)
  applies to YOUR review too.
- **Dead code removal** that traces to "no remaining caller" — per
  CLAUDE.md §1 corollary, delete code with no caller. Don't flag
  the removal as a "potential data loss" unless you can show the
  endpoint was reached from somewhere OUTSIDE the removed UI.
- **Renamed identifiers** that traced cleanly through the diff —
  if the symbol was a-b-c before and renamed to x-y-z and every
  call site uses x-y-z in the diff, that's a refactor, not a bug.

## Project-specific lessons

<!-- Append rules learned from this project's runs here.

Format (one per bullet):
- **Brief title** — one or two sentences of context.
  Citation: `<plan-item-id>` (and optional commit SHA).

Examples (replace with actual project lessons as they accrue):

- **Gemini was rubber-stamping diffs (bug-46 calibration).** Adding
  an "INSUFFICIENT INFORMATION:" opt-out + temperature 0.2 caught a
  class of false agreement the prior prompt missed. Both
  changes belong together — opt-out without low temperature
  reverts to speculation. Citation: bug-46.

- **Hard-delete vs close: data-loss direction matters (bug-49).** A
  removed hard-delete UI button SHRINKS the data-loss surface; it
  doesn't create one. Don't flag a soft-close-only lifecycle as
  "potentially losing data" — the soft-close path PRESERVES the
  record. Re-read the diff direction before flagging. Citation:
  bug-49 r1 critique-response.
-->

(empty until the project accumulates entries)
