# Seeing the data

Reading what has been collected: the screens each role sees, the subject
registry, the Records screen and CSV export, and querying the analytics views
directly.

---

**In the app.** The home screen is forms and nothing else, grouped by what they
do — register someone, record a visit, one-off records. Everything else lives
behind **your name in the top right**: the actions first, then Profile, then
Sign out.

That split is deliberate. These actions never grow; the forms do. They used to
sit as cards *underneath* the form list, so every form an organisation added
pushed "Manage forms" further down until an admin could not find it.

| Menu item | Who |
|---|---|
| Find a person | everyone, once there is a registration form |
| What I have sent | everyone |
| Manage forms | admin |
| Profile | everyone |
| Sign out | everyone |

**Records waiting to be approved** are on a **bell beside your name**, not in
the menu — the count is what a supervisor opens the app to find out, so making
them open a menu to see it defeated the point. Shown to supervisors and admins
only; tapping it opens the queue.

The screens themselves:

| Screen | Who | What |
|---|---|---|
| **What I have sent** | everyone | Your own records, with status, the reason if one was sent back, and **Correct and send again** on the ones that were |
| **Approve data from field** | supervisor, admin | Everything awaiting review in your locations — approve, or send back with a note. **Check several at once** clears the routine ones without opening each. |
| **Find a person** | everyone | Search the registry by name — forgiving about spelling — then open their record. Every result shows the answers that tell namesakes apart. |
| **A person's record** | everyone | Their registration details, every visit in date order, and a button to add another |
| **Records** (admin console) | org admin | Every form's data: counts, date/place/status filters, a table, and a spreadsheet download |
| **Profile** | everyone | Your name, role and places; change language; change PIN. |

A record is always rendered against the form version it was captured under, so
editing a form never changes what an old record appears to say. Decisions are
appended to `submission_revisions`, so who approved what and when is auditable.

Two rules worth knowing. A rejection **requires** a reason — a record bounced
back with no explanation just gets re-sent unchanged. And a **supervisor cannot
approve a record they sent themselves**, because supervisors capture data too
and self-approval would hollow out the review step.

**A supervisor sees only the forms they can use.** A form set to *organisation
admins plus chosen people* never reaches a supervisor's queue or their bell at
all; admins approve it instead. Every other audience includes supervisors, so
this is the one case to know about. See
[Who can use a form](./forms.md#who-can-use-a-form).

**Correcting a record that was sent back.** *Correct and send again*, on the
record itself, reopens the ordinary capture screens with the answers already
filled in; sending puts it back in the review queue. It **rewrites the record
rather than creating a second one**, which is the point — a rejection is not a
rejection of the visit, it is a rejection of what was written down about it, and
two rows would mean one encounter counted twice. The correction is answered
against the form version the record was captured under, works offline through
the same retry queue as a first send, and does not ask for consent again: it was
recorded when the visit happened. The old note and reviewer are cleared so the
next supervisor is not shown a complaint about answers that have gone, and both
survive on the revision that recorded the rejection.

**Bulk approve.** Most of a review queue is routine — attendance a supervisor can
judge from the one-line summary — and making them open fifty screens to say yes
fifty times is how a review step stops being done at all. **Check several at
once** turns on checkboxes, with select-all and a confirmation naming the count.
The per-record screen stays, and is still the only way to send something back.

It is the same rules in one statement, not a faster path with looser checks:
each record is still filtered by Row-Level Security, still skipped if somebody
already decided it, still refused if the four-eyes rule applies, and still gets
its own audit entry. Records a supervisor sent themselves are shown greyed and
un-tickable rather than failing after the fact, and the result reports every
outcome — *"Approved 12. 3 were sent by you, so someone else has to check
them."* A partial result announced as success is how a queue comes to look
empty when it is not.

There is **no bulk send-back**: a rejection needs a reason the worker can act
on, and one reason pasted across twenty records is not a reason.

An **org admin is exempt from that second rule**, deliberately: in a two-person
NGO the admin is often the only person who can approve anything, and without the
exemption their own records were permanently stuck. It is recorded rather than
hidden — the screen says so at the time, and the analytics views carry a
`self_reviewed` column so every instance is countable:

```sql
SELECT count(*) FROM analytics_your_org.your_form WHERE self_reviewed;
```

## The registry

A **registration** form creates a person; an **encounter** form records a visit
against one. That link is what makes "how did this child progress over the
year?" answerable at all — without it every form is a standalone event.

A registration form that has not been told **who** it registers collects
answers and registers nobody. Sangraha now refuses to publish one, says so on
the forms list, and offers the fix on the form itself — including a button to
catch up records already collected, so nothing has to be typed in twice.

Set this up under **Who you register** in the admin console: name the type
(Student, Household, Self-help group), then choose which answers form the name a
worker sees in search results, and which answers must match exactly for two
records to be the same person. A phone number or ration card number works well
here; names alone produce too many false alarms in a village where half the
children share a surname.

When a worker finishes a registration form, Sangraha looks for someone who might
already be that person — a similar name (trigram similarity, so *Sunita* finds
*Sunitha*), the same ID, or the same answer in one of those match fields. If it
finds one they are asked **"Is this the same person?"**

Each match is shown with the answers that tell people apart — age, phone,
guardian — because two people really can share a name, and a card showing only
"Test1, registered 6 Aug" is not a question anybody can answer. Every card
carries the words **"Yes, this is them"**, and the choice is confirmed before
anything is saved:

- **Yes, this is them** → the answers are filed against the person who already
  exists. No second record is created.
- **No, this is someone new** → a new person is registered, as normal.

There is no "merge" at this point, deliberately: nothing has been created yet,
so the only question is which record the answers belong to. Merging two records
that *both* already exist is a separate, reversible action a supervisor takes on
a person's profile — see below.

**The check looks across the whole organisation, but does not report across it.**
A match in a place the worker does not cover comes back as a bare count —
*"someone similar is already registered somewhere else, ask your supervisor"* —
with no name and no place. Everything else on the screen is scoped to their own
locations by Row-Level Security.

Duplicates found *later* — two records that both already exist — are **linked,
never merged**. On a person's profile a supervisor or admin chooses "This is the
same person as…" and picks the other record. Before anything is written the two
are shown side by side and labelled — *the record you are on* against *the
record everyone will use* — with each one's answers, because "same person as X"
otherwise leaves it genuinely unclear which of the two survives.

Once joined, search and reporting follow the surviving record and the other
stops appearing as a separate person. Both rows stay and one tap undoes it,
because a wrongly-joined beneficiary has to be recoverable. Nothing is ever
deleted or overwritten.

## Records and CSV

**Records** in the admin console reads each form's generated analytics view, so
it is already flattened, typed, and spans every published version of the form.
Counts across the top, filters for date range / place / status, and a **Download
spreadsheet** button that applies the same filters — the file always matches the
screen.

The **index** lists every published form with how many records it holds and when
the last one arrived, most recent first, with empty forms marked as such rather
than looking identical to a form holding four hundred. Above it: the
organisation's total records, people registered, and how many are waiting for
review.

Opening a form shows **the answers, not the plumbing**. The columns are *When*,
*About*, *Sent by*, *Status*, then each question under its own label. The
thirteen machine columns every view begins with (`submission_id`, `org_id`,
`form_version`, timestamps, reviewer ids) are behind **Show technical columns** —
a link, not a checkbox, because which columns exist is decided on the server and
hiding them in CSS would ship them anyway.

Ids are resolved to names: the person a record is **About** links through to
their profile, and so does any "link to a person" question. An id that resolves
to nobody stays an id rather than borrowing somebody else's name.

**Page size is 50, 100, 250 or 500**, chosen from the pager and kept in the URL,
so a view can be bookmarked or sent to a colleague. The download ignores the page
size and always contains every matching row.

Clicking a row opens **the whole record**: who it is about, who sent it, where,
when, the review decision, then every answer under its question — including
repeating groups, which the table cannot show because they live in their own
child view. Unlike the table, this reads `submissions` through the request
connection, so Row-Level Security is the tenant boundary rather than a route
guard.

**A "link to a person" answer shows a name everywhere**, not just here — the
person's timeline, a worker's own records, and the review queue and its detail
screen all resolve it. The CSV carries a `<key>_name` column beside the uuid, so
a funder-facing file has a name in it too.

That name is read **as it is now**, unlike a choice's `_label`, which is frozen
into the view when the form is published. Rename somebody and every export
changes; retire an option and old exports keep the old wording. Both are
deliberate — a person is a living record, an answer list is not — but they do
not behave the same way.

Filtering by a district includes every village under it. The CSV is written to
RFC 4180 (so a comma, a quote or a line break inside an answer cannot shift a
row's columns) and carries a UTF-8 byte-order mark, so Excel on Windows opens
Hindi and Kannada correctly instead of as mojibake.

**Restricted to org admins.** The analytics views run with owner rights and are
not constrained by Row-Level Security, so they return the whole organisation.
Supervisors keep the location-scoped review queue.

## Straight from the database

For anything beyond a table — charts, joins across forms, a BI tool — use:

```bash
npm run data                              # list views and row counts
npm run data --silent school_attendance   # show the most recent rows
```

or point Metabase, Superset or any Postgres client at `localhost:5432`
(`mis` / `mis_dev_password`) and read the `analytics_shiksha_demo` schema:

```sql
SELECT attendance_date, present, absence_reason_label, notes
FROM analytics_shiksha_demo.school_attendance
ORDER BY submitted_at DESC;
```

Each organisation gets its own `analytics_<org_slug>` schema, and each published
form a view named after its slug. Repeating groups get a child view
(`<form>__<group>`) with one row per entry.

The registry adds two more:

| View | What |
|---|---|
| `subjects` | Every registered person: name, type, place, status, plus `canonical_id` and `is_duplicate` for handling linked duplicates |
| `subjects_<type>` | The same, with that type's registration answers flattened into typed columns |

Encounter views already carry `subject_id`, so joining them to `subjects` is what
makes longitudinal analysis possible in any BI tool:

```sql
SELECT s.display_name, count(*) AS visits
FROM analytics_shiksha_demo.school_attendance a
JOIN analytics_shiksha_demo.subjects s ON s.subject_id = a.subject_id
WHERE NOT s.is_duplicate
GROUP BY s.display_name;
```

---

[← Back to the README](../README.md)
