# Open issues

**None.** Both whole-tree reviews are closed: the twenty defects found on
2026-08-30 and the twenty found on 2026-09-03. The Changelog in `README.md`
records what each one was; this file keeps what remains *known* about the
fixes — the places where a decision was made rather than a bug simply removed.

Anything new belongs here first, with a location, a concrete failure, and a
priority. The tiers that were used: **P1** — somebody is harmed or a boundary is
crossed, and the system reports success while it happens. **P2** — the system is
silently wrong: a rule that does not fire, a number that is not what it says.
**P3** — worth doing, hurts nobody today.

---

## What was fixed, and when

Each has a regression test that was verified to fail against the code it
replaced. Where a fix could not be reached from `npm test` — a transaction
boundary or a reference check inside a route handler — the check lives in
`scripts/verify-e2e.ts`, which needs a running server.

| Date | Scope | Tests |
|---|---|---|
| 2026-08-30 | 4 criticals, 3 offline-queue data-loss defects | `submission-queue.test.ts`, `form-builder.test.ts` |
| 2026-09-01 | 6 P1 from the first review | `erasure-holds.test.ts`, `admin-locations.test.ts`, `pin-generation.test.ts`, `signup.test.ts`, `verify-e2e.ts` |
| 2026-09-02 | 8 P2 and 4 P3 from the first review | `analytics-roundtrip.test.ts`, `uniqueness.test.ts`, `attachments.test.ts`, `objects.test.ts`, `app-role.test.ts`, `auth.test.ts`, `review.test.ts`, `reporting.test.ts`, `import.test.ts`, `rules.test.ts` |
| 2026-09-06 | the offline-queue pair from the second review | `submission-queue.test.ts` |
| 2026-09-06 | the remaining 18 from the second review | `rls.test.ts`, `subjects.test.ts`, `consent.test.ts`, `form-builder.test.ts`, `option-sets.test.ts`, `import.test.ts`, `attachments.test.ts`, `validation.test.ts`, `rules.test.ts`, `record-columns.test.ts`, `verify-e2e.ts` |

---

## Decisions carried forward

Not defects. Places where a fix chose one cost over another, written down so
they are not mistaken for oversights.

### Consent needs an answer about age before it will record one

`ConsentStep` offers three answers — under 18, 18 or over, and "Not sure" — and
neither decision button is live until one is chosen. That is a deliberate
exception to the rule stated two paragraphs below it in the same file, where a
missing guardian's name is warned about and never enforced.

The distinction is what makes it defensible: a guardian's name may genuinely not
be knowable during a visit, and a worker blocked mid-visit invents one. The age
question always has an honest answer available in one tap, because the worker is
looking at the person. "Not sure" records `subject_is_minor` as null with
`minor_basis` of `unknown` and raises `pending_override`, so it reaches a
supervisor rather than passing as an adult.

### The admin-only tables carry a second, restrictive policy

`DELETE` consults `USING` alone, so the role check those policies put in
`WITH CHECK` never reached it. The predicate could not simply move into `USING`,
because that governs `SELECT` too and every field worker has to read purposes
and notices to render the consent screen.

So there is a separate `AS RESTRICTIVE FOR DELETE` policy per table. Restrictive
because it ANDs with the policy above rather than offering a second way in — a
permissive one would widen access, which is the opposite of the point.

### An overridden import column derives its own choices

The review screen's type dropdown sets `dataType` and cannot set `choices`: the
browser only ever holds three sample values per column. `importTable` fills them
in from the table it already has, capped at 200 distinct values — past which the
choice was almost certainly a mistake rather than a two-hundred-village list.

### A 409 is dropped only when somebody is looking at it

`send` decides between `remove` and `markBlocked` on a duplicate refusal by
whether the entry is in the `watching` map — which `enqueueSubmission` populates
for the duration of its own call, and nothing else ever writes.

Both halves are load-bearing. Dropping it when a worker is on the save screen is
right: `commit` keeps the draft and sends them back to the offending question,
so the answers are still on the phone and a kept entry would become a permanent
orphan of the record they then corrected. Dropping it when the 30-second sweep
got the refusal is how a capture used to disappear with nothing shown anywhere.

Keyed by entry rather than by drain because a sweep that started a moment
earlier will pick up the new entry itself — it reads the queue after
`enqueueSubmission` has written to it — so "who performed the send" is not the
same question as "is anybody waiting". A test covers exactly that overlap.

The kept entry carries `blockedIssues`, so the "needs attention" queue this
still wants (tracked for Phase 1) can name the clashing answer rather than a
status code. Until that screen exists the worker sees it only in the count and
in the sign-out warning.

### Drains are serialised, not skipped

`drainQueue` chains onto the previous drain instead of returning early when one
is already running. The re-entrancy guard it replaced was right for the sweep,
which can simply try again, and wrong for `enqueueSubmission`, which is waiting
to learn whether the server refused the record a worker is standing in front of.

The cost is that a save can wait behind a sweep that is mid-request on a slow
connection. That is the honest ordering: the alternative was returning an empty
refusals map and calling it acceptance.

### An erasure under a legal hold defers entirely

`purgeErasures` skips the whole request when a live hold touches any of that
person's records, including the parts the hold does not reach. The `legal_holds`
schema comment is explicit that a hold should not become "we keep all of it", so
this is coarser than the design intends.

Keeping only the held answers needs per-question retention, which does not
exist. Between keeping too much for a bounded period and destroying something a
statute requires, only one of the two is recoverable.

### A CSV cell that looks like a formula gains a visible apostrophe

`csvField` prefixes `=`, `+`, `-`, `@`, tab and carriage return with `'`.
Applied as narrowly as possible — never to a number, so `-5` stays `-5` — but
the apostrophe is visible in the cell and a programmatic consumer sees it too.
Accepted because the alternative is a cell that runs something on the machine of
an administrator who double-clicked a download.

### A registration refused before anybody exists records nothing

`consent_events.subject_pseudonym` is NOT NULL and derives from a subject id, so
there is nothing to attach a pre-registration refusal to. Inventing a subject in
order to record that somebody declined to become one would be the opposite of
honouring the refusal.

### Attachment sizes cost a HEAD inside the submission transaction

One round trip per file, for the one or two a submission carries. The
alternative is a size in the database that nothing has ever verified and a
`Content-Length` on download that is a claim rather than a fact.

### `030-grants.sql` is not plain SQL

It contains `@APP_ROLE@`, substituted by `migrate.ts`. A role name cannot be a
bind parameter in DDL. `app-role.test.ts` fails if a literal name creeps back
into any file in `sql/`.

---

## Known, not a defect

One `verify:ui` check — "the notice generator is offered" — fails on seeded
data, because the demo organisation has published notices and no draft, and that
button only renders inside the draft editor. The check's own log says
"generator not exercised — no empty notice to fill". It is an assumption in the
check about seed state, not a defect in the page.
