# 0007 — The T-3h reminder quotes the doors time when the agenda has one

**Date:** 2026-09-06
**Status:** Decided — **provisional, pending the product owner (Viktor)**
**Context:** The Events Bot spec's `README.md` lists this under "Open questions for
Viktor": *"the brochure says 19:30 doors / 20:00 start; the reminder currently quotes the
start only."*

**Decided by:** ORCH, on the project owner's delegation of open decisions (2026-09-06),
**after REQ-VALIDATOR ruled at the step-04 gate that ORCH was not entitled to settle the
message half inside a requirement description.** This record exists because of that
finding. See "Why this is a record and not a requirement note" below.

## The question, correctly framed

The question was originally framed — by ORCH, wrongly — as *"quote the start time only, or
invent a `doors_at` field?"*, and parked. The project owner asked why the doors time could
not simply be a parameter. It already is one, and that reframing splits the question in
two:

**The data-model half — not actually open.** PRD §5 defines the field:

```
Event · agenda[]  ← non-talk items only (doors, networking, close).
                    The talk line-up is the accepted Talks, never duplicated here.
```

`doors` is the first named example. `RE-EVALUATION.md` R7 confirms it is deliberate:
`agenda[]` was cut from v1 as an unused field that duplicated the line-up, then reinstated
with exactly this narrowed non-talk definition. So the doors time is already modelled,
already stored (REQ-011), already editable (REQ-016), already on the event card (REQ-017).
No new field is needed, and adding a `doors_at` column would contradict both PRD §5 and
R7's de-duplication. **Establishing this required only reading the spec correctly, which
is an agent's job, not a product preference.**

**The message half — genuinely open, and genuinely the owner's.** PRD FR-7 specifies the
T-3h reminder as a closed list:

```
T-3h | Route: address, both map links, start time, QR code
```

Doors is not in it. Adding a sixth element changes a message the PRD specifies exactly.

## Decision

**The T-3h reminder quotes the doors time when, and only when, the event's `agenda[]`
contains a doors item.** Otherwise it quotes the start time alone, exactly as FR-7 states.
Both times render in the chapter timezone.

## Rationale

The reminder's job is getting a person to the right place at the right time — PRD §2 makes
show-rate (70% → ≥80%) the product's headline metric, and PRD §11a puts the reminder chain
on the critical path. Telling someone "20:00" when the room opens at 19:30 sends them to
arrive half an hour after they could have, which works against the one metric the feature
exists to move. Where the spec already stores the better answer, quoting it costs nothing.

The conditional matters: an event with no doors item behaves exactly as FR-7 literally
specifies, so this is strictly additive and never contradicts the spec for any event the
organizer hasn't given a doors time.

## Why this is a record and not a requirement note

ORCH first resolved this inside REQ-026's description. REQ-VALIDATOR's step-04 gate ruled
that split correctly:

- The **data-model** half ORCH was entitled to settle — it is a reading of the spec.
- The **message** half it was not. `core-directives.md`'s Zero Manual Work clause 1
  prescribes a `decisions/000x` record with the options named for exactly this case: a
  genuine preference question with a named human owner. **Clause 1 does not say "leave it
  parked"** — stalling is explicitly not the remedy. It says decide visibly and let the
  owner overturn it.

ORCH's commit message for the original amendment claimed *"PRD's no-invented-rules closing
rule was never engaged."* That is true of the data model and **false of the message**. The
overstatement is recorded here rather than quietly corrected.

Buried in a requirement description, this decision would have been invisible to the person
entitled to reverse it. Here it is one file, and reversing it is a one-line change to this
record plus REQ-026's criteria.

## For Viktor — what to say if this is wrong

This is the only decision in the registry that overrides a literal PRD instruction. Three
ways to overturn it, in descending order of likelihood:

1. **"Start time only, as FR-7 says."** → Revert to quoting `starts_at` alone; drop
   REQ-026's doors criteria. Smallest change.
2. **"Doors time always, even without an agenda item."** → Needs a rule for events with no
   doors item (default offset? require one at publish?), which is a new question.
3. **"Doors on the T-24h reminder too."** → Additive; a small new requirement.

Until then the decision stands and implementation proceeds on it, per Zero Manual Work.

## Consequences

- **REQ-026** implements the conditional, with separate criteria for the with-doors and
  without-doors cases. The without-doors case must be tested with a **non-empty** agenda
  holding only non-doors items — an empty agenda cannot catch a loose match.
- **REQ-011** must make a doors item identifiable by a single query, not by loading the
  agenda and scanning it in application code.
- **REQ-016** must validate agenda items now that one carries behavioural meaning: a doors
  time later than `starts_at` is refused, any item later than `ends_at` is refused, and at
  most one doors item may exist — REQ-026 resolves exactly one doors time and has no rule
  for choosing among several. **No lower bound** on how early an item may be: the spec
  states none, and REQ-VALIDATOR's step-05 gate correctly caught an earlier draft of this
  requirement inventing a `starts_at − 12h` cutoff, which would have refused a legitimate
  all-day workshop's setup item. Both surviving bounds derive from PRD §5's own fields.
- **REQ-017** renders every agenda item with its time and label in the chapter timezone.
  The card-vs-reminder consistency check lives in **REQ-026**, not here: REQ-017 is a
  transitive ancestor of REQ-026 and is built first, so only REQ-026 can compare itself
  against an already-built card renderer. An earlier draft had this backwards.

## What this does not decide

Nothing about the T-24h "Still coming?" message, which FR-7 defines separately and which
this record leaves untouched. Nothing about the agenda item's shape — that is
DATA-DESIGNER's at REQ-011.
