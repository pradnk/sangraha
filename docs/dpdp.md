# Data protection (DPDP)

What Sangraha builds for India's Digital Personal Data Protection Act, 2023 —
and what it deliberately leaves to the organisation.

---

India's Digital Personal Data Protection Act, 2023 applies to the organisations
using Sangraha directly. An NGO collecting a child's name, age and health status
is a **Data Fiduciary**; every beneficiary in the registry is a **Data
Principal**; and where Sangraha is hosted for them, its operator is a **Data
Processor**. Section 9 — children — carries the highest penalty tier, and data
about children is this product's core use case.

**What this software can and cannot do.** It builds the machinery: the records,
the evidence, the enforcement points, the reports. It does not make an
organisation compliant. Roughly half the Act is the organisation's own
governance — deciding purposes, appointing a grievance officer, signing
contracts, training workers, actually honouring requests. What Sangraha can do
is make the compliant path the easy one and hold the evidence that it was
followed. **None of this is legal advice**, and the specific timelines in the
DPDP Rules should be checked against the currently notified text before you rely
on them.

## Built — foundations

**Legal identity and privacy contact.** Under **Setup → Organisation**: the
registered name, kind of organisation, registration number and address, plus the
person who handles requests about personal data. That last one is the load-bearing
field — the Act gives people the right to complain to the organisation *before*
escalating to the Board, and a notice with nowhere to complain to removes the
first step. A phone number is enough; email is not required, because most NGOs
here will give a phone and insisting otherwise would exclude the organisations
that need this most.

The screen names what is still missing rather than counting it, and the setup
checklist carries the same step. Publishing a privacy notice will require these
fields — enforcement sits where an admin can see and fix it, not in a constraint
that locks an existing tenant out of their own data.

**Where data may live.** Each organisation records a data region, defaulting to
India. Section 16 is permissive, but the government programme agreements behind
most scheme-delivery work are not — and an organisation that never opens this
screen should not silently be exporting children's data.

**A revision log that cannot be rewritten.** `submission_revisions` has described
itself as append-only since it was written, and it was not: `030-grants.sql`
handed the request role `UPDATE` and `DELETE` on every table. An audit trail the
audited party can edit proves nothing. Two mechanisms now, doing different jobs:

- **`REVOKE UPDATE, DELETE`** (`sql/030-grants.sql`) — the security boundary.
  `mis_app` serves every request and now holds no such privilege here at all, so
  a bug in request code cannot reach these rows however hard it tries.
- **A trigger** (`sql/015-immutability.sql`) — a deliberateness guard on the
  owner connection, which is the table owner and therefore exempt from
  privileges. It cannot stop an operator who means it; it stops one who did not
  realise.

The escape hatch is `SET LOCAL app.allow_purge = 'on'`, and there is exactly one
caller: `deleteOrganisation`, which is now a single transaction because
`submission_revisions` cascades from `submissions` and a row trigger fires on a
cascade too. Erasure will be the second caller. A correction is a new row —
that is the point.

## Built — consent, notices and erasure

**Purposes.** Under **Privacy**, an organisation lists the things it does —
"run the mid-day meal programme", "deliver the state scholarship" — and each
question on each form is attributed to one. That is what makes agreement
*specific*: "do you agree to us holding your data" is agreement to nothing.

Each purpose names the basis it relies on. Consent is one; **Section 7
legitimate uses** are the others, and a government scheme is delivered under one
of them. Asking for consent you do not need is not harmless — it implies a
withdrawal the organisation could not honour, and teaches workers the question
is a formality. So where a legitimate use applies, the app does not ask.

**The notice is generated, not written.** Sangraha already knows every question
your forms ask; once each is attributed, it drafts the itemised notice the law
requires and you correct it. Grouped one sentence per purpose, never one bullet
per question — a forty-bullet notice read aloud on a doorstep is not heard,
which makes the consent that follows it worse than a short honest one. It says
in plain words what deletion cannot reach, and it never overwrites wording you
have written.

Publishing freezes it. A consent record is only worth something because it cites
the exact words somebody was read, so editing a published notice is refused by a
database trigger — editing makes a new version, and old consents keep pointing
at the old words.

**Consent capture, in the field.** A step before the first question, in the
notice's language with `dir` set correctly, working offline through the existing
retry queue. Yes and no are the same size and the same distance from the thumb;
a refusal is recorded rather than treated as an abandoned form, because "we
asked and they declined" and "we never asked" are different facts.

Stored as an **append-only event log, never a flag**. A flag says whether you
have consent; it cannot say what somebody was told, in which language, by whom,
on what date, under which version. Withdrawal is a new event — the earlier
consent stays true, because it *was* the lawful basis for what already happened.

Three things the log does that are easy to get wrong:

- **A device clock cannot reorder it.** `occurred_at` is clamped to no later
  than arrival, with the phone's raw claim kept beside it. Otherwise a
  withdrawal from a phone three days slow loses to an older "given" and the
  system goes on collecting data it was told to stop collecting, silently.
- **A replay is free; a changed replay is an error.** The retry queue re-sends,
  so the same event id must not double-count — but the same id with different
  content is a bug or tampering and is refused rather than swallowed.
- **The queue never drops an attestation.** A submission may legitimately be
  given up on; the consent it carried is rescued and re-sent on its own.

**Children.** Each subject type nominates where a date of birth lives, the same
way it already nominates the fields for matching and display — and publish now
refuses a nomination pointing at a question that does not exist, which was a
latent bug that would have made *every child resolve as an adult*. Where no age
is on file the worker is asked directly, and how we knew is recorded alongside
what we concluded.

A child with no named guardian is **not blocked**. A worker stopped mid-visit
invents a name, and an invented guardian is worse than a recorded gap — so it
goes to a supervisor, asynchronously, and is counted on the Privacy dashboard
until decided. Approving it never marks the guardian as verified: the record
stays visibly irregular, because an override that made a record look clean would
be a permission rather than an exception.

**Who looked at what.** An append-only log of every export, profile view,
records page, registry search and duplicate check. One row per act, not per row
of data. Without it, "who was affected" — which a breach report has to answer —
has no answer at all.

**Erasure.** "Forget this person" sits on the record itself. It hides them from
everyone immediately, because the Act requires processing to *cease*, not to
cease once an admin gets round to a queue; the physical purge is a separate,
rehearsable step, so a mistake is recoverable until it runs.

Six places a person physically is, five of which are not obvious:

| | |
|---|---|
| `subjects.display_name` | denormalised, so clearing attributes does not touch it |
| `submissions.review_note` | supervisor free text, reliably contains names — the column everyone forgets |
| `submission_revisions` | a full snapshot of every historical answer |
| **the duplicate cluster** | a second row holding the same human. Erasing only the row you were asked about leaves the other intact, and `ON DELETE SET NULL` quietly promotes it to canonical |
| `consent_events` | the proof you had consent, naming the person you must forget |
| object storage | not reachable, and not yet built — see below |

The consent log is **redacted, not deleted**: the identity goes, the fact stays,
so the row still shows that somebody agreed to this purpose under this notice
read in Kannada, and names nobody.

**Pseudonymise or delete.** The default keeps a de-identified row so totals
survive — and the product calls it pseudonymisation, not anonymisation, because
village plus age plus caste is near-unique at this scale and location is
retained by definition. It is still personal data and does not discharge the
duty. Two things make it defensible: an organisation declares which fields to
**keep**, not which to strip, so a field nobody thought about is removed rather
than retained; and monthly counts are written *before* anything is destroyed, so
a donor report reproduces without any row-level data at all.

**Legal holds** are purpose-scoped with a mandatory expiry. FCRA and Income Tax
retention cover financial and beneficiary-verification records, not a child's
photograph — a hold that swallowed everything would turn "we must keep some of
this" into "we keep all of it". A refusal has to name the statute; an open-ended
hold is a refusal wearing a hat.

**Languages.** `LANGUAGE_NAMES` is now the Eighth Schedule plus English, because
the Act gives a person the right to the notice in any of them. Malayalam and
Urdu were the conspicuous omissions. Urdu, Kashmiri and Sindhi are right-to-left
and `directionOf()` handles it — a mangled legal notice is worse than none,
because it still looks like consent was informed.

## Not built

- **Rights requests** — access, correction, nomination, grievance intake, and a
  public page per organisation naming its grievance officer.
- **Breach register** and the notification runbook.
- **Retro-notice for existing data.** Deliberate: writing synthetic "given" rows
  for a historical caseload would be falsifying evidence. Existing people simply
  show as having no consent on file and are picked up at their next encounter,
  because the consent step fires there anyway.

## Known limits, disclosed rather than discovered

- **A downloaded spreadsheet cannot be recalled.** The access log says who took
  one and when; the notice says so plainly.
- **Erasure does not reach database backups** until they rotate out.
- **Orphaned attachments are not swept.** Attachment capture and deletion both
  ship — erasure and `deleteOrganisation` reach object storage (fixed
  6 Sep 2026). What is still missing is the sweeper: a worker who photographs a
  form and then abandons it leaves an unclaimed row and its bytes behind.
  `findOrphanedAttachments` exists and nothing calls it yet.
- **Answers sit in plaintext in the browser's local storage** on what may be a
  shared phone, and abandoned drafts persist. Needs a TTL sweep.
- Erasure clears rows but dead tuples survive until VACUUM, so **encryption at
  rest is a deployment requirement**, not an optional extra.

---

[← Back to the README](../README.md)
