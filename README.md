# Sangraha

**संग्रह · ಸಂಗ್ರಹ · సంగ్రహ · സംഗ്രഹം — "collection"**

Configurable data collection for the social sector. NGO staff define what they
collect, field workers capture it on ordinary Android phones, and the data lands
in clean, typed relational tables that BI tools and data pipelines can read
directly.

The name is a Sanskrit-derived word present in every major North and South
Indian language, so it needs no translation anywhere in the country — and it
means precisely what the product does.

**Sangraha stays in the background.** Inside a live organisation, every header
carries *their* logo and *their* name. The only screens that lead with our own
mark are signup and an installation with no organisation yet. The point is that
it should feel like their system, not like software they were handed.

> **Keep this file current.** It is the operational reference for everyone using
> the project. Any change to logins, ports, commands, or what is and is not
> built belongs here, in the same commit. See [Changelog](#changelog).

---

## 1. Status — read this first

**Phase 1.** An NGO can now define its own forms, register the people it works
with, capture visits against them over time, review what comes back, and read
its own data without a database client — verified end to end by 545 tests. Every
field type in the engine is now answerable on a phone, photographs and
signatures included. What remains is mostly breadth: the public API, rights
requests, and a full offline PWA.

| | Status |
|---|---|
| Sign in, sign out, PIN change, switch language | ✅ built |
| Field data capture (one question per screen, 3 languages) | ✅ built |
| **Viewing collected data** — "what I have sent", record detail | ✅ built |
| **Supervisor review queue** — approve / send back, audited | ✅ built |
| **Form builder** — create and edit forms, live phone preview | ✅ built |
| Submission API, retry queue, idempotency | ✅ built |
| Analytics views (JSONB → typed relational tables) | ✅ built |
| Tenant + location isolation (Row-Level Security) | ✅ built |
| **Admin console** — people, PIN reset, places, organisation settings | ✅ built |
| **Answer list editing** | ✅ built |
| **Self-serve signup + guided setup** ([§7](#7-adding-a-new-organisation)) | ✅ built |
| **Machine translation of form content** ([§6](#6-creating-and-changing-forms)) | ✅ built (needs an API key) |
| **Organisation logo and branding** ([§7](#7-adding-a-new-organisation)) | ✅ built |
| **Subject registry** — register people, search, longitudinal timeline ([§5](#5-seeing-the-data)) | ✅ built |
| **Duplicate detection** at registration, with cross-location privacy | ✅ built |
| **Records screen + CSV export** ([§5](#5-seeing-the-data)) | ✅ built |
| **Consent capture and privacy notices** ([§12](#12-data-protection-dpdp)) | ✅ built |
| **Access log, erasure and legal holds** ([§12](#12-data-protection-dpdp)) | ✅ built |
| **Photo, file, signature, GPS and repeating sections in capture** ([§6](#6-creating-and-changing-forms)) | ✅ built |
| **Object storage for attachments** (MinIO locally, S3/R2 in production) | ✅ built |
| Rights requests, nomination, breach register ([§12](#12-data-protection-dpdp)) | ❌ not built |
| Combined skip-logic conditions (and / or) in the builder | ❌ not built |
| Public REST API, webhooks | ❌ not built |
| Charts and dashboards (the Records screen is table + counts only) | ❌ not built |

**Roles now differ visibly.** A field worker sees their forms and what they
have sent. A supervisor also gets a review queue, badged with how many records
are waiting. An org admin also gets **Manage forms**. Underneath, Row-Level
Security decides what each can actually read — a worker only their own
submissions, a supervisor their location subtree — and that is enforced in the
database, not the UI.

---

## 2. Servers and services

| What | URL / port | Notes |
|---|---|---|
| Sangraha | http://localhost:3000 | `npm run dev`. Use `-- --port 3100` if 3000 is taken. |
| Postgres | `localhost:5432` | user `mis`, password `mis_dev_password`, db `mis` |
| MinIO (file storage) | http://localhost:9000 | S3-compatible API |
| MinIO console | http://localhost:9001 | user `mis`, password `mis_dev_password` |

Containers are `mis-postgres` and `mis-minio` (`infra/docker-compose.yml`).
Configuration is one `.env` at the repo root — see `.env.example`.

**That is the development setup.** Field officers work outside the office, so
production has to be hosted — see [§10, Deploying](#10-deploying-to-vercel).

---

## 3. Logins

Organisation `shiksha-demo` ("Shiksha Foundation (demo)"). **You do not type the
organisation** — with a single organisation the field does not appear at all.

| Username | PIN | Role | Language | Sees |
|---|---|---|---|---|
| `sunita` | `639284` | Field worker | Hindi | GHPS Sampgaon, own submissions only |
| `ramesh` | `639284` | Field worker | Kannada | GHPS Kittur, own submissions only |
| `supervisor` | `571390` | Supervisor | Kannada | Both schools (the whole block) |
| `admin` | `284917` | Org admin | English | The whole organisation |

The language buttons on the login screen override the user's stored language —
on a shared phone, whoever is signing in now is the one who has to read it.

```bash
npm run login:check     # confirms all four still authenticate
```

PINs change only if you edit `DEMO_PINS` in `packages/db/src/seed.ts`;
`npm run db:seed` prints them.

---

## 4. Getting started

Requires Node 20+ and Docker.

```bash
npm install
cp .env.example .env          # then set AUTH_SECRET: openssl rand -base64 32
npm run infra:up              # Postgres + MinIO
npm run db:migrate
npm run db:seed
npm run dev
```

`npm run db:seed` is re-runnable, and destroys the demo organisation's data.

**`npm run typecheck` now covers `scripts/` too** (`tsconfig.scripts.json`).
They run under `tsx`, which strips types rather than checking them, so nothing
checked them at all — and one of them irreversibly destroys data. Adding it
found a latent crash in `free-connections.ts`.

**Checking the UI actually works.** `npm test` has no browser in it — every one
of its 551 checks is a pure function, a database query or an HTTP call. That
leaves one class of failure invisible: the page renders perfectly and nothing on
it responds to a click, which is what a hydration failure looks like. `npm run
verify:ui` drives the Chrome already on your machine and asserts the things a
request cannot see — the account menu opens, the capture flow advances, every
row of the setup index links somewhere, and the console is clean. No new
dependency; skip it if you have no Chrome.

**Running a second dev server?** Use `npm run dev:alt` (port 3100). Every Next
process writes `apps/web/.next`, so a plain second `npm run dev` corrupts the
first one's chunks — the browser then gets server HTML from one process and
client JavaScript from the other, hydration fails, and the page renders while
nothing on it responds to a click. `dev:alt` gives it its own build directory.
The same hazard is why `npm run build` writes to `.next-build`.

---

## 5. Seeing the data

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
| **What I have sent** | everyone | Your own records, with status and the reason if one was sent back |
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

### The registry

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

### Records and CSV

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

### Straight from the database

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

## 6. Creating and changing forms

Sign in as `admin` and open **Manage forms**, or go to `/admin/forms`.

**Creating one** asks two questions — a name, and whether it registers a person,
records a visit, or stands alone. The slug is derived from the name and is
permanent; the name itself can be changed and translated freely afterwards.

**The builder** is a split screen: questions on the left, an editor in the
middle, and a live phone preview on the right. The preview is the *real* capture
component in preview mode, not a mock, so skip logic behaves there exactly as it
will in the field. Nothing typed into it is saved.

Per question you can set the wording in all three languages, a hint, whether an
answer is required, the list of answers for a choice question, and when to ask
it. **Skip logic reads as a sentence** — *Show this question only if [Was the
student present?] is [Absent]* — composed entirely from dropdowns. There is no
formula box, which is also why a form author cannot inject anything executable.

**Editing is versioned, invisibly.** Your first change opens a draft copied from
what is published; field workers keep seeing the published version until you
press **Publish to field workers**, which freezes the draft as a new version and
regenerates the analytics views. **Discard changes** throws the draft away.

**Guardrails.** The builder refuses edits that would destroy meaning, and says
why in plain language:

- Renaming or retranslating a question is always safe — the analytics column is
  named after an immutable key, not the label.
- A question holding answers **cannot be deleted**. You are offered *Stop asking
  this question* instead: it disappears for field workers, and the answers stay
  in your reports.
- Changing a question's type is allowed only where every stored answer survives
  (whole number → number, single choice → multiple choice). Narrowing is
  refused, with the count of answers at stake.
- A choice question cannot be published without a list of answers, and an empty
  form cannot be published at all.

**Field types.** All 19 in the engine are offered in the builder and answerable
on a phone — short text, long text, number, whole number, date, time, date and
time, yes/no, choose one, choose several, phone, rating, calculated, link to a
person, photo, file, signature, GPS and repeating section.

`DEFERRED_FIELD_TYPES` in `question-input.tsx` is the mechanism for a type that
lands in the engine before its renderer: anything listed there is hidden from
the palette rather than shown broken, and `coverage.test.ts` fails if a type is
neither rendered nor deferred. The list is currently empty.

**Photo, file and signature** are stored in S3-compatible object storage; the
answer is the uuid of a row in `attachments`. Three things are worth knowing:

- **Photos are shrunk in the browser** before they are sent, to the question's
  own `maxWidthPx`. The canvas round trip also strips EXIF — which on most
  phones carries the GPS position the photo was taken at, and a photograph of a
  beneficiary should not carry their home address to wherever it is shared next.
- **Uploads go from the browser straight to storage** with a presigned PUT.
  `POST /api/attachments` decides whether the upload is allowed and hands back a
  URL; the bytes never pass through the app, because a serverless platform caps
  the request body at 4.5 MB and a form may legitimately ask for a 10 MB scan.
  Downloads are the opposite — proxied through `/api/attachments/[id]` so that
  whether you may see a photograph is decided by our own code on every request.
- **Captured offline, they wait on the phone.** The bytes go to IndexedDB under
  a placeholder uuid and the send queue swaps it for the real attachment id when
  it drains. Set `S3_*` in `.env`; without them the capture UI says so rather
  than offering a camera button that does nothing.

**GPS** watches for a better fix rather than taking the first one — a phone's
first answer is the cell-tower estimate, accurate to a kilometre. A reading
worse than the question's `requiredAccuracyM` is shown as a problem, and can
only be kept if the form allows the override.

**Repeating sections** get a list-plus-editor screen. The entry editor stacks
its questions instead of showing one per screen, which is deliberate: an entry
is a tight cluster of facts about one person, and "add six family members" would
otherwise be thirty screens.

**Answer lists** live at `/admin/lists`, not inside a single question — a list
is shared between questions and forms, so editing it there would hide that a
change ripples outward. Codes are derived from the label once and then frozen;
relabelling never touches them. An answer that records already use cannot be
deleted, only hidden.

### Answers that must not repeat

Next to **An answer is required** in the question editor is **No two records may
have the same answer** — for a phone number, an email, a ration card or a
government ID. A second record with that answer is refused when it is saved, and
the worker is sent back to the offending question with the reason.

Worth knowing:

- **One question, one form.** The same number on a different form is a
  different question; a survey does not block a registration.
- Capitals and surrounding spaces are ignored, so `ABC123 ` and `abc123` count
  as the same. Spaces *inside* a value are not folded — `1234 5678` and
  `12345678` stay different, because collapsing them would also silently merge
  two genuinely different free-text answers.
- A blank answer is not a value, so any number of records may leave it empty.
- Drafts and deleted records do not count.
- Not offered on yes/no (the form would accept two records ever), on
  multiple-choice (the stored value is a list and compares by order), or on
  photos, files and repeating sections.
- **The rule binds from now on.** Turning it on cannot reach backwards over data
  already collected, so publishing succeeds and tells you how many existing
  records share a value.
- It needs the server, so it cannot be checked offline. A submission queued
  without a signal is accepted and checked when it sends.

### Moving records in from a spreadsheet

**Setup → Bring in a spreadsheet.** Upload an Excel file or CSV, or paste a
Google Sheets link, and Sangraha builds a form out of the column headings and
brings the records in under it. The point is the migration: until an
organisation's existing years of records are here too, this is a second place
to look rather than *the* place to look — and a form made of their own column
headings is one their team already knows how to read.

**Two steps, always.** Nothing is created until you have seen what it worked
out. The review screen shows, per column: the guessed question type, three real
values as evidence, how many cells are blank, how many will not fit, and whether
anything repeats. Every guess is a dropdown.

What it works out on its own:

| Evidence in the column | Becomes |
|---|---|
| ISO dates, or `02/01/2026` | Date — read day-first |
| whole numbers / decimals | Whole number · Number |
| yes/no/true/false/1/0 | Yes or no (also `हाँ`, `ಹೌದು`) |
| all look like emails | Short text, checked as an email |
| 10-digit or `+91` | Phone number |
| ≤15 values that keep repeating | Choose one answer — **and it builds the answer list** |
| anything mixed | Short text |

It leans towards text whenever the evidence is thin, because a question can be
widened later but not narrowed. A long run of digits stays text rather than
becoming a number: that is how phone numbers and ration card numbers get
silently corrupted by spreadsheet imports.

**What it will not do**

- Import anything if a heading is blank or repeated — fix that in the
  spreadsheet first, or two columns become one question
- Read more than 5,000 rows or 5 MB at a time. It says so and brings in what it
  read; import the rest as a second file
- Refuse everything over a few bad cells. A cell that will not convert is left
  blank on its row and listed afterwards, with a downloadable list of exactly
  which rows and columns

**Where it lands.** Imported records are **approved** — this is history being
migrated, not field capture awaiting a check — and each carries where it came
from (`deviceMeta.import`), so an auditor can tell an imported record from a
collected one. If you say the rows are people, subjects are created too and
everyone is findable under *Find a person* immediately.

Google Sheets needs either the service-account credential (share the sheet with
its address) or the API key for a sheet shared with anyone who has the link —
the same credential the translation feature uses.

### Answers that must be a particular shape

Any short-text question has a **What kind of text?** setting: Email address,
Web address, PAN, Aadhaar, Pincode, IFSC, or a pattern you write yourself.
A badly formatted answer is refused when the worker saves, in their language,
naming the question.

**Email address** and **Aadhaar number** also appear as their own tiles when
adding a question — they make an ordinary text question with the format already
set, so there is one mechanism underneath and the setting stays changeable.

For anything else, choose **A pattern I set** and write a mask:

| | |
|---|---|
| `A` | any letter |
| `9` | any digit |
| anything else | must appear exactly |

So `AAAAA9999A` is a PAN, `AA99/9999` accepts `KA01/2345`. Deliberately not
regular expressions: a mistyped regex silently rejects real beneficiary data
with no clue why, and a badly formed one can hang the server on every
submission. A mask cannot do either, and an admin can read it back and see
whether it is right.

Formats apply to new answers only — turning one on cannot reach backwards over
data already collected, and the editor says so when the question already holds
answers.

### Adding a whole new field type

The settings above cover text. A genuinely new *kind* of question — a slider, a
barcode scan — is a code change, and a deliberately small one:

1. One module in `packages/form-engine/src/field-types/`, exporting a
   `FieldTypeDefinition`: how it validates, what column it becomes in analytics,
   and how it renders in a CSV.
2. Two lines in that folder's `index.ts` to register it.
3. A renderer in `apps/web/src/components/field/question-input.tsx`, plus its
   name in `field-palette.tsx`.

`coverage.test.ts` fails if a registered type has no renderer and is not listed
as deliberately deferred, so the two halves cannot drift apart. Everything else
— the builder, the analytics view, the CSV export, the API — picks it up with
no further change.

### Translating a form

**No Translate button?** It appears only when both are true: your organisation
has more than one language turned on (**Organisation** in the admin console),
and a translation credential is configured. If either is missing the form
builder now says which one, rather than simply not showing the button — a new
organisation starts with English alone, so this is the usual reason.


Build in **English first**, then translate — it is much easier to check a
translation when you can see the original beside it.

1. Turn a language on under **Organisation**.
2. Open the form and press **Translate**.

It fills in only what is missing, in one API call per language, and **never
overwrites anything a person has typed**. Everything it produces is highlighted
in amber as an unchecked draft; editing one clears the flag and marks it yours.

A mistranslated health question is worse than an untranslated one, because a
worker cannot tell it is wrong — so treat the output as a first draft, not a
result. Untranslated text falls back to English rather than showing blank — a
worker must never be asked a question they cannot see, so `localise()` treats an
empty or whitespace-only translation as no translation at all.

#### Setting up a Google credential

The **Translate** button only appears once one is configured. Without it the
translation fields are still there — you type them in yourself.

First, in the [Google Cloud console](https://console.cloud.google.com/): pick or
create a project and enable **Cloud Translation API**. Then choose one of two
credentials.

**An API key — simplest.** A plain string, nothing to download.

> APIs & Services → Credentials → **Create credentials → API key**.
> Restrict it: **API restrictions → Cloud Translation API**. Worth doing — an
> unrestricted key that leaks works against every Google service you have enabled.

```bash
GOOGLE_TRANSLATE_API_KEY=AIza...
```

**A service account — if you were handed a JSON file.** Asking the console for a
credential often gives you this, and some organisations disable API keys by
policy.

> APIs & Services → Credentials → **Create credentials → Service account** →
> then **Keys → Add key → JSON**. Grant it the **Cloud Translation API User**
> role.

**Do not paste the JSON into `.env`.** It contains a private key, it spans
multiple lines, and it is a different authentication mechanism entirely. Point
at the file instead:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json
```

On a host with no filesystem (Vercel, Fly), pass the same JSON base64-encoded:

```bash
base64 -i key.json          # then paste the result
GOOGLE_TRANSLATE_CREDENTIALS=eyJ0eXBlIjoic2Vydmlj...
```

Keep the file out of the repository — `.gitignore` covers the usual names, but a
leaked service account key is worse than a leaked API key.

**Then restart the app.** `.env` is read at startup, so a running server will not
pick it up. If both credentials are set, the service account is used.

Billing is per character; a twenty-question form is a few thousand characters,
so ordinary use costs very little. `GOOGLE_TRANSLATE_ENDPOINT` optionally points
the adapter at a proxy or an API-compatible service.

**Does it work once added?** Both adapters are covered by 23 tests against stubs
reproducing Google's documented request and response shapes — the service
account path signs a JWT with a real generated RSA key and the stub verifies it.
Three faults were found that way and fixed: Google HTML-escapes its output even
in text mode, translating into two languages dropped the first, and a stale
access token was not being discarded on a 401. The only unexercised step is
Google's own response to a real credential.

### Your organisation's logo

**Organisation → Your logo.** Upload any image — PNG, JPG, WebP or SVG, at any
size. It appears at the top of every screen your team sees and on the sign-in
page. Without one, your organisation's name is shown in clear type instead —
plenty of small NGOs have no usable logo file, and a name set properly looks
deliberate where a gap looks broken.

**Large files are resized in the browser** before they are sent, down to at most
1024×512 and about 200 KB, and you are told when that happens. Print-resolution
logos are what people actually have to hand; asking them to go and shrink one
first is not a real answer.

An SVG is **rasterised** in the browser and only the pixels are stored. That is
what makes accepting it safe: an SVG is a document that can carry script, and
storing one to be served from our own origin would be a stored-XSS vector the
moment anything rendered it inline. Nothing but raster bytes ever reaches the
database, which refuses SVG outright as a second line of defence.

Stored in Postgres rather than object storage, deliberately: it is one small file
per organisation that has to be readable *before* anyone signs in, which with S3
would mean either a public bucket or a presigning round trip on every page load.
Served from `/api/orgs/<slug>/logo` with a cache-busting stamp.

**People, places and settings** are at `/admin/users`, `/admin/places` and
`/admin/settings`:

- **People** — add someone, set their role, assign places, reset a PIN, unlock a
  locked account, switch someone off. An issued PIN is shown **once**: it is
  stored only as a hash, and the person is forced to choose their own on first
  sign-in. Resetting a PIN or changing a role signs that person out of every
  device immediately.
- **Places** — your hierarchy, indented. Assigning someone a place gives them
  everything inside it, so a block coordinator needs one assignment rather than
  one per village. A place that records came from cannot be deleted, only
  switched off.
- **Organisation** — name, which languages staff can choose, and what you call
  each level of your geography (District → Block → School, or whatever fits).

---

## 7. Adding a new organisation

### Self-serve

Go to **`/start`**. Four questions — organisation name, your name, a sign-in
name, a PIN — and you are its administrator, signed in, looking at a setup
guide.

The guide at `/admin/setup` walks through what comes next, and each step marks
itself done by looking at your actual data rather than at a checkbox:

1. Add your places
2. Choose your languages — optional
3. Say why you collect data
4. Build your first form (in English)
5. Publish it
6. Publish your privacy notice
7. Say who handles privacy questions
8. Add your team — each person gets a one-time PIN to pass on
9. Add your logo — optional
10. Try it on your own phone

Each step links to the specific card it names — `/admin/settings#languages`,
`/admin/privacy#notices` — rather than to the top of a page holding four
unrelated things.

**It is not only a checklist.** Setting up does not finish: a new programme is a
new purpose and a re-published notice, a new district is places and people, a
new team is a language. So every row always links, done or not, and every row
shows what is actually there — "4 purposes", "2 of 3 published", the name of
whoever handles privacy requests. Once the required rows are done the heading
becomes **What you have set up**, and it is the first entry in the **Setup**
menu: the index of the seven screens under it, for an admin who knows they need
to change something and not which screen holds it.

**The Privacy screen says outright whether anyone is being asked.** Consent is
only collected when a live purpose rests on the person's permission *and* a
notice covering it has been published — miss either and the capture screen
silently skips the step. That was inferable from two grey subtitles and nothing
else, so the top of `/admin/privacy` now states which of the two states you are
in, and lists the missing half with a link to it.

**"Write it from my forms" is not an AI call.** It reads your legal details, your
purposes, and which questions are attributed to each, and assembles a notice from
a template (`composeNotice`) — offline, no key, and the same words for the same
inputs, which is what makes the published hash worth anything. It used to be
labelled "Draft it for me" beside a sparkle icon, which read as a language model
and made people distrust a notice the system had honestly derived from their own
forms. `npm run verify:ui` fails if that implication comes back.

**Purposes and the notice are steps, not paperwork.** Nothing asks anyone for
permission until a purpose exists whose lawful basis is consent *and* a
published notice covers it — `consentRequirementFor` returns null otherwise and
the capture screen shows no consent step at all. Both are legitimate states, so
they are not enforced; what is not acceptable is finding out by accident, which
is why a form that will ask nobody says so when it is published.

Languages come *before* the first form on purpose. The **Translate** button in
the form builder only appears once a second language is switched on, so an
organisation that picks its languages first gets a machine-made first draft
offered as it writes each question. Switch a language on afterwards and nothing
is backfilled: every existing form has to be reopened, translated and published
again.

A banner across the admin console shows how many steps remain until you dismiss
it.

**Who is allowed to sign up** is `SIGNUP_MODE` in `.env`:

| | |
|---|---|
| `open` | Anyone with the URL. The default, so a fresh clone works. |
| `code` | A shared `SIGNUP_CODE` is required. Good for onboarding known partners. |
| `closed` | No signup; use the command below. |

> **Change this on a public deployment.** Left open, anyone who finds the URL can
> create an organisation in your database.

### From the command line

For self-hosting, scripting, or when signup is closed:

```bash
npm run org:create -- --name "Pratham Education" --admin meera \
  --locales en,hi,kn --levels District,Block,School
```

It prints a sign-in address and a one-time PIN. Unlike self-serve, the PIN is
*issued*, so that administrator is made to choose their own on first sign-in.

| Option | |
|---|---|
| `--name` | Required. Display name, shown on the sign-in screen. |
| `--admin` | Required. Sign-in name for the first administrator. |
| `--slug` | Optional. Defaults to a slug from the name. **Permanent** — it names the analytics schema. |
| `--locales` | Optional. `en`, `hi`, `kn`. English is always included. |
| `--levels` | Optional. Place level names, outermost first. |

To remove one, with everything in it:

```bash
npm run org:delete -- --slug pratham-education --confirm
```

**The login screen adapts.** With one organisation there is no organisation field
at all. With several it becomes a dropdown of names — so use
`/login?org=<slug>` in links to staff to preselect theirs.

> For real multi-tenant SaaS, replace the dropdown with subdomain resolution
> (`pratham.example.org`). A public list of every customer is fine for a
> self-hosted install and wrong for SaaS.

---

## 8. Everyday commands

```bash
npm run dev                  # web app
npm run infra:up | infra:down | infra:reset
npm run db:migrate           # schema + the idempotent sql/ layer
npm run db:seed              # rebuild the demo organisation
npm run db:generate          # new migration after a schema change
npm run db:views             # rebuild all analytics views (after a generator change)
npm run db:purge -- --org <slug>            # rehearse accepted erasures
npm run db:purge -- --org <slug> --confirm  # carry them out (irreversible)
npm run db:free              # release connections left by a killed dev server
npm run data [view]          # read collected data
npm run org:create -- --name "X" --admin y    # new organisation + first admin
npm run org:delete -- --slug x --confirm      # remove one, with all its data
npm run psql                 # a shell on the database
npm run typecheck            # all three packages
npm test                     # 382 tests
npm run build                # builds into .next-build, safe while dev is running
npm run verify http://localhost:3000   # end-to-end against a running server
npm run login:check          # confirm the demo credentials work
npm run session sunita       # print a session cookie for curl
```

### When something breaks

| Symptom | Cause |
|---|---|
| `DATABASE_URL is not set` | No `.env` — `cp .env.example .env` |
| `EADDRINUSE :3000` | Something else on 3000 — `npm run dev -- --port 3100` |
| "That name or PIN is not right" | Run `npm run login:check`. If it passes, the seed was re-run with different PINs. |
| Login page lists odd organisations | An interrupted test run left `test-*` orgs. `npm test` sweeps them. |
| Analytics view missing a column | `npm run db:views` rebuilds every view from the current generator. |
| Two identical-looking people in the duplicate check | They differ in some answer the card is not showing. Add that question to **How to spot a duplicate** under Who you register, and it will be shown first. |
| Nobody appears under **Find a person** | The form probably does not say who it registers. Open it under **Forms** — if it warns "No one chosen", pick a type and use the catch-up button. |
| Signup says the organisation name already exists, but you never created it | Fixed 6 Aug 2026. Before that, a rejected PIN left an organisation behind with no administrator. Remove it with `npm run org:delete -- --slug <slug> --confirm`. |
| `Loading chunk … failed`, or buttons do nothing, with a `_next/static/chunks/…` 404 in the console | The dev server's `.next` cache went stale, so the HTML references a chunk that is not on disk and the page never hydrates. `rm -rf apps/web/.next` and restart `npm run dev`; hard-reload the browser afterwards. `npm run verify:ui` reproduces it in one command. |
| **Every page loads but has no styling at all** — serif fonts, no colour, no layout | Two `next dev` processes are writing to the same `apps/web/.next` and clobbering each other, leaving `.next/static/css/app/` empty while the HTML still links to it. `pgrep -fl "next dev"` will show more than one. Kill them all, `rm -rf apps/web/.next`, start one. Hard-reload the browser, or the 404 stays cached. |
| `npm test` fails with "too many clients" or "remaining connection slots are reserved" | A dev server or test run that was killed rather than stopped left its pool open. `npm run db:free` releases connections idle for more than 30 seconds; a running dev server is left alone. |
| A date-and-time question rejects every answer | Fixed 6 Aug 2026. It demanded a timezone the browser never sends. Run `npm run db:migrate && npm run db:views` after updating. |
| No **Translate** button on a form | The organisation has only one language, or no translation credential. The builder says which; turn on a second language under **Organisation**. |
| A CSV column is called `untitled_question` | The question was named after it was created, on a form published before Aug 2026. New forms take the key from the label. Existing keys cannot move without breaking the data already stored under them. |
| Connection refused on 5432 | `npm run infra:up` |

---

## 9. How it fits together

```
apps/web              Next.js — field UI, login, submission API
packages/form-engine  field types, validation, skip logic, view generation
packages/db           schema, migrations, RLS policies, auth, queries
infra/                docker-compose: Postgres + MinIO
scripts/              data viewer, e2e verification, session + login helpers
```

**The form engine is the centre of gravity.** `packages/form-engine` defines what
a form is; the builder, capture UI, API, CSV export and view generator all read
from it, so a field type is defined once. Adding one is a single module in
`src/field-types/` plus two lines in that folder's `index.ts`.

**Flexible storage, relational output.** Submissions are one JSONB row against an
immutable form version. On publish, a flattened view is generated per form:

- Columns are named after the immutable field `key`, never the label.
- The view spans every published version — a question added in v3 is NULL for
  older rows; one removed in v3 keeps its history. No UNION, no backfill.
- Casts go through `analytics.try_*` and cannot raise, so one bad value costs
  one cell rather than the whole report.

**Isolation is enforced by the database.** Two connections: `DATABASE_URL`
(owner — migrations and analytics DDL, bypasses RLS) and `DATABASE_APP_URL`
(`mis_app` — every request, no DDL, RLS applies). Context is set per transaction
with `SET LOCAL`, so a pooled connection cannot leak one tenant into the next
request; an unset context matches no rows. All 17 tables have policies, asserted
in `packages/db/src/__tests__/rls.test.ts`.

**Built for the phone it will run on.** 56px tap targets, 18px base font, icon
*and* text on every action, one question per screen. Voice input on text
questions. Autosave every keystroke. A retry queue rather than a direct POST,
with device-generated `clientUuid` idempotency, so a replay over a flaky link
cannot create a duplicate visit. Skip logic drops orphaned answers, so
correcting "absent" to "present" leaves no phantom absence reason in the data.

**Three UI languages** — English, Hindi, Kannada (`UI_LOCALES` in
`apps/web/src/lib/i18n.ts`). `messages.test.ts` fails if a string is added to one
catalogue and not the others. Organisation-authored content is JSONB and can
carry any language in `LANGUAGE_NAMES` without a code change.

Contributor conventions and invariants are in [CLAUDE.md](./CLAUDE.md).

---

## 10. Deploying to Vercel

Field officers work outside the office, so a laptop running docker-compose is
not a deployment. Each NGO hosts its own instance; Vercel plus a managed
Postgres is the intended path, and it needs no shell at any point.

### 1. A database

Any Postgres 14+ that lets you create a role and these extensions: **`ltree`**,
**`pg_trgm`**, **`pgcrypto`**. Neon and Supabase both do; Neon's free tier is
enough to start.

**Use the pooled connection string.** Serverless functions each open their own
connections, and a direct connection will exhaust the database under load. On
Neon that is the host containing `-pooler`; on Supabase it is port `6543`. The
app detects both and adjusts automatically — pool size, prepared statements and
idle timeouts all change.

### 2. Import the repository into Vercel

Set **Root Directory** to `apps/web`. Vercel detects Next.js and picks up the
`vercel-build` script, which applies migrations before building. Leaving Root
Directory at the repo root also works — there is a `vercel.json` for it.

### 3. Environment variables

| Variable | |
|---|---|
| `DATABASE_URL` | **Required.** Pooled string, owner role. Runs migrations and generates analytics views. |
| `DATABASE_APP_URL` | **Required.** Same database as `mis_app`, the non-owner role migrations create. Row-Level Security only applies to this one. |
| `AUTH_SECRET` | **Required.** `openssl rand -base64 32` |
| `SIGNUP_MODE` | Optional. Defaults to `closed` in production — see below. |
| `GOOGLE_TRANSLATE_CREDENTIALS` | Optional, base64 service-account JSON. `GOOGLE_APPLICATION_CREDENTIALS` is a file path and will not work here. |

`DATABASE_APP_URL` is a chicken-and-egg: the `mis_app` role does not exist until
the first migration creates it. Set it to the password you intend to use — the
migration creates the role with that password from the URL you supply.

### 4. Deploy, then open `/start`

The build runs migrations, guarded by a Postgres advisory lock so two
deployments finishing together cannot race.

**Signup is closed by default in production — with one exception: it is always
open while the database has no organisation.** So the first person to visit
`/start` on a fresh deployment creates the organisation and becomes its
administrator, and the door shuts behind them. Everyone else is added from
**People**, each getting a one-time PIN.

That exists because there is no shell on Vercel to run `npm run org:create` in.
To run more than one organisation on an instance, set `SIGNUP_CODE` to a shared
secret, or `SIGNUP_MODE=open`.

### 5. Check it worked

```
GET /api/health
```

```json
{ "status": "ok",
  "checks": { "databaseReachable": true, "schemaPresent": true,
              "rlsEnabled": true, "appRolePresent": true },
  "pooling": { "serverless": true, "pooledConnection": true } }
```

`rlsEnabled: false` means tenant isolation is not in force — treat that as an
outage, not a warning. `pooledConnection: false` on Vercel means you used the
direct connection string and will hit connection limits under load.

### Worth knowing

**Put the functions near the database, and near your field staff.** A cold
start, ~100 ms of PIN hashing and a cross-region database round trip add up on a
2G phone. For Indian users that means Mumbai (`bom1`) for both. Region choice
needs a paid Vercel plan; on Hobby you get one fixed region.

**Publishing a form runs DDL** — `CREATE SCHEMA`, `CREATE VIEW` — so the
`DATABASE_URL` role needs those rights at runtime, not only at deploy. That is
deliberate: it is what makes an admin pressing Publish produce real analytics
tables. It also means that credential is live in your functions.

**Migrations can be taken out of the build** with `SKIP_MIGRATIONS=1`, if you
would rather gate schema changes behind your own process.

**Attachments need object storage.** Set the `S3_*` variables — `npm run
infra:up` gives you MinIO with the bucket already created, and production is S3
or R2 with the same settings. Without them, photo, file and signature questions
tell the worker so rather than failing silently. Logos are the exception and
still live in Postgres: one small file per organisation, shown on the sign-in
screen before anyone has authenticated, so object storage would mean either a
public bucket or a presign on every page load.

---

## 11. What's next

1. **A display formatter separate from the export formatter.** Screens currently
   render answers with `toExportValue`, which is right for CSV and wrong for a
   phone: a Hindi worker sees `Yes` and `2026-07-15` rather than `हाँ` and a
   readable date. Fixing it means a `toDisplayValue` alongside the existing one
   on each field type — deliberately *not* a change to the export values, which
   analytics and spreadsheets depend on being stable.
2. **API** — scoped keys, per-form typed endpoints, per-org OpenAPI, webhooks.
3. **A sweeper for orphaned attachments.** A worker who photographs a form and
   then abandons it leaves an unclaimed row and its bytes behind.
   `findOrphanedAttachments` exists and nothing calls it yet; it wants the same
   treatment as the purge — a command an operator runs, not a silent cron.
4. **Charts on the Records screen.** Deliberately left out of the first cut;
   counts, filters and CSV cover the questions people actually asked for.
5. **Combined skip-logic conditions** (and / or) in the builder. The engine and
   capture UI already evaluate them; only the editor is single-condition.
6. **Supervisor-scoped records** via `security_invoker` views, so the Records
   screen is not admin-only.
7. **Full offline PWA.**

**Usability testing with real field workers is now the highest-value next step.**
"No training required" is a direction, not something a design document
establishes. The target: hand a low-end Android phone to someone who has never
seen the app, give them a one-sentence task, and time them to a successful
submission. Under three minutes, no questions asked.

---

## 12. Data protection (DPDP)

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

### Built

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

### Built

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

### Not built

- **Rights requests** — access, correction, nomination, grievance intake, and a
  public page per organisation naming its grievance officer.
- **Breach register** and the notification runbook.
- **Retro-notice for existing data.** Deliberate: writing synthetic "given" rows
  for a historical caseload would be falsifying evidence. Existing people simply
  show as having no consent on file and are picked up at their next encounter,
  because the consent step fires there anyway.

### Known limits, disclosed rather than discovered

- **A downloaded spreadsheet cannot be recalled.** The access log says who took
  one and when; the notice says so plainly.
- **Erasure does not reach database backups** until they rotate out.
- **Attachment capture must not ship before object deletion exists.** Photo,
  file and signature are schema-only, there is no S3 client anywhere, and
  `deleteOrganisation` never touches storage. An erasure that leaves
  photographs of children in a bucket is a lie.
- **Answers sit in plaintext in the browser's local storage** on what may be a
  shared phone, and abandoned drafts persist. Needs a TTL sweep.
- Erasure clears rows but dead tuples survive until VACUUM, so **encryption at
  rest is a deployment requirement**, not an optional extra.

## Changelog

Newest first. Add an entry for anything that changes how the system is run,
logged into, or configured.

### 2026-09-06 — The rest of the second review, and both backlogs are empty

Eighteen, after the queue pair below. Two of them together were the worst thing
in the list, and neither is visible from the other.

**Every child resolved as an adult, from two directions at once.** On the admin
side, the three question nominations on a subject type — date of birth, age,
contact — used a zod transform that runs on an *absent* key and returns null. So
every partial update from that screen, including renaming the type on blur or
flipping the active toggle, silently cleared them. On the worker's side, when
nothing on file settled a person's age the consent screen asked — and did not
require an answer, because both decision buttons were live from the start.
Tapping straight through recorded no guardian, no supervisor flag, and
`subject_is_minor` as null, which the compliance dashboard filters on. A child
captured as an adult, invisible in the data and on the screen meant to catch it.

The schema now distinguishes set, cleared and not-mentioned. And the consent
screen offers a third answer — "Not sure" — and records no decision until one of
the three is given. That is a deliberate exception to the rule stated in the
same file, where a missing guardian's name is warned about and never enforced: a
name may genuinely not be knowable during a visit, but the worker is looking at
the person, and "Not sure" is always available in one tap. It records
`minor_basis` as `unknown` and raises `pending_override`, so it reaches a
supervisor instead of passing as an adult.

**A field worker could delete an organisation's purposes.** Six policies put
the administrator check in `WITH CHECK`, which governs INSERT and UPDATE —
`DELETE` consults `USING` alone. Verified on the application connection before
the fix: `UPDATE purposes` was refused while `DELETE FROM purposes` returned
`DELETE 1`. The predicate could not simply move into `USING`, because that
governs SELECT too and every field worker has to read purposes and notices to
render the consent screen, so each table gained a separate restrictive DELETE
policy.

**A submission could name any place and any person.** `subjectId` and
`locationId` were written onto the row behind nothing but a uuid check. A record
filed at a location outside the worker's own subtree then failed
`can_see_location` and disappeared from the review queue of every supervisor who
should have seen it. Both are now resolved through the request connection, so
RLS answers the question instead of a comparison somebody has to remember.

**Deleting an organisation left every photograph in the bucket.** The rows went
and the objects stayed, with `storage_key` — the only record of where they were
— destroyed along with them. `purgeErasures` had always got this right, which
made the whole-tenant path the weaker of the two.

**An overridden import column was discarded entirely.** The review screen's type
dropdown sets the type and cannot set the choices, so a column overridden to
"Choose one answer" arrived with none: no option set was created and every cell
failed to match a code. On a 5,000-row file that silently lost 4,800 values
while the skipped-cell list, capped at 200, made it look small. The choices are
now derived server-side from the table, which is the only place the whole column
exists.

**A broken config took the defaults with it.** `resolveFieldConfig` fell back to
`{}` on a failed parse — and `{}` is *no* config, not the defaults, because zod
only materialises a `.default()` from a parse that succeeded. One unrecognised
key on a phone question built `^\d{undefined}$`, which rejects every real phone
number and accepts the literal `9{undefined}`. It now drops only the settings
the schema objected to and keeps the rest.

**And nine quieter ones.** The duplicate search applied its limit before
deciding what the worker could see, so ten matches from other villages could
crowd out the one next door and the count was capped at ten either way.
Duplicate chains could still be built from one direction. `notice_mismatch` was
declared, rendered and counted, and never written by anything — the device sent
back the server's own hash, so the comparison was a tautology; the device now
hashes what it actually rendered, with the shared `hashNoticeText` so formatting
cannot cause a false alarm. Tabbing through the hint box saved English as the
Hindi translation and marked it human-reviewed. Renaming a provisional key left
every rule that depended on it pointing at a name that no longer existed, which
hid the dependent question from every worker permanently. An oversized file was
accepted offline and deleted hours later with nothing shown. Answer counts
missed repeat groups, so an option still in use could be hard-deleted. Two
compliance figures multiplied by the number of purposes. Array columns were
never detected, so multi-choice answers rendered as raw JSON. And two more
private copies of `localise()` are gone.

### 2026-09-06 — The send queue could still lose a morning, twice over

Both from a second review, and they compound: one made "Saved" mean a record had
been checked when nothing had been sent, and the other then deleted that record
when the check eventually failed with nobody watching.

**A background 409 deleted the capture.** The duplicate branch dropped the entry
from the queue, on the reasoning that "the worker is standing right there and
can correct it". That holds only when the drain came from the save screen —
`startQueueDraining` also sweeps every 30 seconds, on mount and on `online`, and
throws away what the drain returns. So a worker registered somebody offline, saw
Saved, walked into signal, and a colleague's earlier use of the same phone
number deleted the record: refused before insert on the server, gone from
localStorage on the phone, draft already cleared, counter back to zero, no error
anywhere.

It is now dropped only when somebody is actually being shown the clash, and kept
as blocked otherwise, with the clashing answers attached so a screen can name
them. Both halves matter — keeping it on the save screen too would leave a
permanent orphan of the record the worker then corrected, because saving again
queues a fresh one.

**And "Saved" could mean nothing was sent.** `enqueueSubmission` read an empty
refusals map as acceptance, but the drain returned one without touching the new
entry in two ordinary cases: a sweep already running tripped the re-entrancy
guard, and an earlier entry failing on 2G broke the loop before reaching it.
Either way the uniqueness check that waiting for the send exists to perform was
skipped, and the draft was deleted on the strength of it.

Drains are now serialised rather than skipped — a save waits behind a sweep
instead of being told nothing was refused — and the entry being saved is
attempted first, so the break that stops the queue hammering a dead connection
cannot leave the one request somebody is waiting on unmade.

The subtle part is that "is anybody waiting" is now a property of the entry
rather than of the drain. A sweep that started a moment earlier picks up the new
entry itself, because it reads the queue after the save has written to it — so
the drain that performs the send is not necessarily the one that was asked to.

### 2026-09-02 — Twelve quieter ones, and the backlog is empty

The rest of `issues.md`. Nothing here loses a record outright; most of it is a
rule that was not firing, or a number that was not what it said.

**Configuration that only worked on one machine.** `030-grants.sql` granted to a
literal `mis_app` while `migrate.ts` created whatever `DATABASE_APP_URL` named,
so any deployment that chose another username migrated cleanly, printed
"database is up to date", and then failed every request on a permission error
that said nothing about the cause. The role name is now derived from the URL the
application actually connects with, in one place, and substituted into the SQL —
which makes `030-grants.sql` the one file in `sql/` you cannot run directly
through `psql`. A test fails if a literal name creeps back into any of them.

**The uniqueness rule never fired across workers.** `findDuplicateAnswers` ran
on the request transaction, where `submissions_isolation` restricts a field
worker to their own rows — so the clash check could only ever see the caller's
own submissions, and the two-worker case the rule exists for was silently
unenforced. It now goes through a SECURITY DEFINER function that re-imposes
`org_id` explicitly and stops there: uniqueness is a statement about the
organisation, not about one worker's patch. The tests moved onto the request
path at the same time — every one of them passed throughout, because they ran on
the owner connection, which bypasses the policies.

**Attachments were org-scoped while the download route claimed otherwise.** The
policy was `org_id = app.current_org_id()` and nothing else, so a worker
restricted to their own submissions could still read any attachment row in the
organisation given its uuid. It now inherits the submission's visibility, the
same way the revision log does. An unclaimed upload — the ordinary state while a
form is being filled — belongs to whoever reserved it.

**Uploads were unbounded in practice.** The size limit checked a number the
*client* declared, and the presigned PUT signs only `host`, so nothing obliged
it to send that many bytes. The real size is now read from storage at the moment
the file is attached to a record; an object over the platform ceiling rolls the
submission back. That also makes the `Content-Length` on download a fact rather
than a repetition of the claim.

**Two analytics casts could still take down a whole view.** `1e999` is
syntactically a number and not one a double can hold; `1e1000000` overflows even
numeric. Both raised — the exact failure the `try_*` helpers exist to prevent,
reachable from any free-text column somebody typed into. The common case still
takes an inlinable fast path; only exotic values pay for the check.

**A US-formatted date became an impossible one.** Day-first is right for India
and is not in question. What was missing was checking the reading is *possible*:
`12/25/2020` matched the regex and was written as `2020-25-12`, which stores
perfectly well and is then silently dropped by the cast — so the cell vanished
from the report without ever appearing among the bad cells the import screen
promises to list. A column that cannot be read day-first now falls through to
text rather than being guessed at.

**Smaller, same shape.** `/my-submissions` showed a supervisor everybody's
records, because the policy only narrows for a field worker and the page never
asked. `uniqueSlug` took an `orgId` and ignored it, so form slugs were unique
across every tenant and probeable. `/change-pin` had no attempt counter, unlike
the sign-in screen — being signed in is not a reason to allow unlimited guesses
at the PIN on a shared phone. `Number('')` is `0`, so a rule reading "show when
*Number of children* is 0" fired on every unanswered form. A CSV cell beginning
`=`, `+`, `-` or `@` was executed as a formula when the export was opened, and
the content is free text typed by field workers. And a consent refusal was never
recorded at all: the screen filtered on a `subjectId` the events never carried,
so `/api/consent` was called for no form ever — "we asked and they declined" and
"we never asked" were indistinguishable in the data.

### 2026-09-01 — Six things the system promised and did not do

The high-severity tier from the same review, in `issues.md`. Where the previous
batch lost records, these mostly kept things that should have gone, or opened
doors that were meant to be shut.

**A legal hold was a label, not a lock.** `holdsBlocking` was consulted when an
erasure request was filed, shown to the admin once, and then the purge iterated
every accepted request and destroyed everything regardless. An organisation that
had recorded an Income-tax s.44AA retention hold had exactly the records the
statute obliges them to keep erased anyway. The hold is now re-checked inside
the purge, before the photographs are deleted from object storage — that step is
outside the transaction and nothing can roll it back. A held request is deferred
rather than refused, so nothing needs re-filing: a hold has a mandatory expiry
and the next run after that date completes it on its own. The person stays
soft-deleted throughout, so processing has ceased even while the bytes are
retained. Deliberately conservative — it defers the whole request, including the
parts a hold does not reach, because keeping only the held answers needs
per-question retention that does not exist yet.

**An erasure reported as complete left the name on the screen.** The purge
nulled the subject link but not `subject_name_at_request` — which the schema
itself documents as kept "until completion" — nor the requester's name and
relationship, nor `identity_checked_note`, which is free text and reliably
contains names for the same reason `review_note` does. All four were still being
rendered on the organisation's own privacy screen. What survives now is the
proof without the person: the pseudonym, who received it, when, and what was
touched.

**Deleting a village published everyone in it.** `deleteLocation` refused on
child locations and on submissions but never on `subjects.location_id`, which is
`ON DELETE SET NULL` — and `app.can_see_location` treats a null location as
visible org-wide, correctly, so that an office-entered record is not invisible
to everybody. Two right decisions meeting badly: every beneficiary registered
there became searchable by every field worker in the organisation, and their
recorded place of registration was destroyed. The test for this demonstrates the
exposure rather than asserting the guard.

**A 409 committed the record it was refusing.** Returning a `NextResponse` from
inside the `withSession` callback resolves it, and Drizzle commits a resolved
transaction. So a consent replay conflict left the submission row and possibly a
new subject written, with no `created` revision and its attachments unclaimed,
while the client was told the send had failed — and the retry then met the
idempotency short-circuit and cheerfully reported success. The conflict now
throws out of the transaction and the response is built outside it.

**Temporary PINs came from `Math.random()`.** Not a CSPRNG, and its state is
recoverable from a short run of output — so PINs issued in one sitting would
predict the next, which is how an administrator actually uses this. Now
`crypto.randomInt`, one call per digit so `042917` is still a PIN.

**A code-gated signup that accepted any code.** `SIGNUP_MODE=code` with
`SIGNUP_CODE` left blank reported mode `code`, put a code box on `/start`, and
then matched anything typed into it, including nothing. That is worse than an
open door, because it looks shut. Both halves now fail closed: the mode refuses
to report `code` with no code set — closing signup and logging why — and
`signupCodeMatches` returns false rather than true when there is nothing to
compare against. The bootstrap exemption is untouched, so a misconfiguration
cannot lock an operator out of an empty installation.

### 2026-08-30 — Seven ways a record could vanish, or land in the wrong place

A review of the whole codebase. Seven defects, and what they have in common is
that none of them looked like a failure from the outside: the screen said saved,
the counter said nothing was waiting, the button said done.

**A worker's morning could be deleted by five minutes of bad signal.** The send
queue gave up on an entry after ten attempts, with no delay between them — and
the sweep runs every 30 seconds behind `navigator.onLine`, which stays true on a
captive portal or a mobile connection that is associated but carrying nothing.
Ten sweeps is five minutes, and then the records were gone from the phone
without having reached the server. The queue indicator simply stopped showing a
count, which reads as *everything sent*. Nothing is ever deleted for failing now.
A transient failure waits longer each time, doubling from 30 seconds up to 15
minutes, and keeps waiting; a payload the server refuses outright stops being
retried but is kept, and the drain steps over it rather than being blocked
behind it.

**The same queue deleted records when a session expired.** `requireSession()`
answers with a redirect to `/login`, not a 401 — so `fetch` followed it, the
login page returned 200, and the queue read that as accepted and removed the
submission. The 401 branch written to prevent exactly this could never run. The
send now asks for `redirect: 'manual'` and treats a redirect as "not signed in,
try later".

**A photo that uploaded could be stranded by one that did not.** Blobs are
deleted from the phone as they upload, and the resolver returned a bare null if
a *later* file in the same submission failed — throwing away the real id of the
one that had already gone. The next attempt found nothing pending, passed the
placeholder through untouched, and the record was stored pointing at a
photograph that would never exist. Partial progress is now written back to the
queue entry before anything stops.

**"Add another" registered the next person under the previous person's
consent.** Everything else was cleared between people; the consent events were
not, and the screen went straight to the first question without showing the
notice. Because the server is idempotent on `clientEventUuid`, the second person
then ended up with no consent record at all. The notice is read again from the
top, which is also simply the truth: it is a different person.

**Renaming a question after publishing rewrote the published version.** The
builder shows the published version when there is no draft, so the browser holds
published field ids; the first edit creates the draft, copying every field under
new ids, and the edit was still applied to the stale one. A question people had
already answered silently changed its wording, while the draft kept the old text.
Field edits are now scoped to a version, and an id from the version the browser
rendered is resolved to its counterpart in the draft by key.

**Google Sheets import could never finish.** The mapping plan was only attached
to the file upload; the sheet branch sent the link with the plan dropped, and
the last button returned a bare 400 every time. The whole review screen worked
right up to it.

**A supervisor could write to another organisation's consent log.** Approving a
child recorded without a guardian has to run on the owner connection, so RLS is
not scoping it — and the admin Privacy screen's version, unlike the identical
decision on the review screen, never re-read the event under the caller's own
context first. Anyone who knew a uuid could reach across the tenant boundary.

### 2026-08-11 — The agree button existed all along and could not be seen

Reported as "where is the positive button?" — and there was a button-sized blank
gap above "They said no" in the screenshot, which is the whole answer.

`bg-affirm-600` named a shade the palette did not define. The `affirm` scale held
50, 500 and 700, and **Tailwind is silent about a shade that was never
defined**: the class emits no CSS at all, so the element kept a transparent
background while `text-white` still applied. White text on nothing. In the DOM,
the right size, focusable, clickable, invisible.

It had been that way for a long time. Nobody noticed because the decision also
sat 1100px below the fold; pinning it to the bottom yesterday is what finally
brought it on screen to be seen as missing.

A sweep found **forty-odd more** across the admin console, including
`bg-deny-600` on two destructive buttons. So the three scales are now complete
from 50 to 900 rather than defining only the steps that happened to be in use.
The original anchors are unchanged; the rest are interpolated between them, and
every shade carrying white text or sitting on its own 50 tint clears WCAG AA —
`affirm-600` at 5.50:1 is in fact better than the `affirm-500` it sat beside
(4.43:1, large text only).

Two checks, because this is invisible to every other kind of review — the class
name is valid, it typechecks, the component renders, the button is in the DOM:

- `palette.test.ts` fails on any class naming a shade that does not exist, and
  names the file and line. Verified by deleting `affirm-600` again and watching
  it point at `consent-step.tsx:225`.
- `verify:ui` asserts the agree button is painted at all — a fill or a border —
  and not merely present.

### 2026-08-11 — The review screen shows the permission, not just the answers

Asked directly: "in approval view I am not seeing anything related to consent and
guardian details. Is that ui not designed?" It was not. Every column was being
written and nothing read them back, so a supervisor approving the registration of
a child could not tell a child was involved, let alone whether anyone agreed on
their behalf.

`/review/[id]` now opens with **Permission**, above the answers, because whether
this person agreed decides whether the answers may be kept at all:

- who agreed and when, per purpose, and a withdrawal if there was one;
- **recorded as a child**, and *how we know* — a date of birth and "the worker
  said so" are different answers to the same question;
- the guardian's name and relationship, or **no guardian was named** in red;
- which notice version was shown and for how long, whether the worker confirmed
  reading it out, and whether the phone's wording matched what was published.

An absent record is reported two ways, because the difference is the whole point:
"nobody was asked, and nobody needed to be" on a legitimate-use form, versus
"nobody was asked, and somebody should have been" — `formNeedsConsent` decides
which. A warning shown on every form is a warning nobody reads.

**A supervisor can resolve a guardian gap here**, which is where `pendingOverrides`
always said the decision would land — "in the same queue as everything else they
review". Until now it existed only on the admin Privacy screen, which a
supervisor cannot reach; the action had permitted `supervisor` and revalidated
`/review` all along. It still never sets `guardian_verified`: accepting a gap is
not a guardian appearing, and the accepted reason stays visible on the record
afterwards.

`decideOverride` writes on the owner connection, because `consent_events` is
append-only and only the immutability trigger's declared exception may touch it —
so RLS is not scoping that statement. `isOverrideVisible` stands in for it, and
reaches the event *through* `subjects` deliberately: `consent_events_read` is
org-scoped only, while `subjects_isolation` adds `app.can_see_location`. A test
moves a child between villages and asserts a worker loses sight of the override
with them.

### 2026-08-11 — The consent decision is within thumb reach

Reported as: after typing the guardian's details, "they only see 'They said No'
and no action for they agreed". Measured on a 390x844 phone, the cause was not
subtle — the page is 1935px tall and both answers sat about **1100px below the
fold**, moving *further* down when the guardian panel opened. `mt-auto` never
engaged, because a screen carrying a full privacy notice always overflows.

- **The decision is pinned to the bottom of the screen** with the same
  `sticky bottom-0` treatment the capture screen uses for Next and Save. Sticky
  rather than fixed, so at full scroll it settles below the last guardian field
  instead of covering it — verified.
- **Both answers stay the same size and the same distance from the thumb.** A
  refusal that is harder to give than a yes is a nudge, and nudged consent is not
  freely given, so the footer stacks them rather than shrinking one.
- **It names who is agreeing.** "They agreed" is ambiguous on the one screen
  where it matters — the child is in front of you and the permission that counts
  is their mother's. The prompt above the buttons now reads "Does Kamala Devi
  agree?" once a guardian has been typed, and the affirmative button says "The
  parent or guardian agreed".
- The read-aloud reminder appears beside the decision when the box is unticked —
  a reminder, never a block, for the reason already given about fake guardians.

`npm run verify:ui` now runs at a real phone size and asserts both answers are on
screen without scrolling. That mattered: at desktop width the whole page fits and
the bug is invisible, so a check in a default window would have passed while the
screen was unusable. Confirmed by putting the old layout back and watching both
assertions fail.

### 2026-08-11 — "Write it from my forms" visibly does something

Reported as "nothing happens when I click on it". It always worked — the notice
was written to the database every time — but two things conspired to hide it.

- **The textarea never re-synced with the server.** It holds the words in
  `useState`, whose initialiser runs only on mount, so `revalidatePath` plus
  `router.refresh()` handed the card fresh props while the box went on showing
  its old value. The card is now keyed on the server's copy of the words, the
  same idiom `admin/settings/identity-form.tsx` already uses. Typing is
  unaffected: the key is built from the server value, which does not change
  while somebody types.
- **A published notice showed an empty box.** Publishing turns the draft into
  the published version, leaving `draft` null — so a live notice 966 characters
  long rendered as blank, and pressing the generator appeared to do nothing
  because the box was empty before *and* after. `NoticeDetail` now carries
  `publishedBody`, and the editor falls back to it.

`npm run verify:ui` guards both: that a published notice shows the words it is
publishing, and that pressing the generator on an empty notice puts words in the
box. It only presses on an empty one, so nothing hand-written is overwritten, and
says so out loud when there is nothing safe to press.

The notice cards also carry `data-notice` now. Matching them by their text meant
matching every ancestor that contained them, and the first version of the check
read one card's status against another card's textarea — reporting a bug that was
not there.

### 2026-08-10 — The notice editor is a numbered flow, and Publish explains itself

Reported as "I am not sure how I publish. it is not getting enabled." Three
traps in one card, none of them the administrator's fault:

- **Publish was disabled with no reason.** It needs a purpose ticked, and said
  so nowhere. It is now always pressable and refuses out loud, naming exactly
  what is outstanding — plus the same list sits beside the button before you
  press it. A disabled control that will not say what it wants is a dead end.
- **The purposes read as a label, not a choice.** "This notice explains ·
  student scholarship" is a sentence, and the pill differed from its selected
  state only by border tint, so nobody clicked it. They are visible checkboxes
  now, with the tick drawn, under a question — and default to every purpose on a
  notice that has never been published, which is what the generated wording
  already describes.
- **The "add another notice" box looked like the notice's own name field**,
  sitting bare underneath the card with a prose placeholder. It is boxed,
  titled, and asks for a short label.

The three stages are numbered, because an administrator doing this once a year
should not have to infer a sequence.

**A notice nobody has been read can now be thrown away.** `slug` is derived from
the name and immutable, so a first attempt with the wrong name — or a second one
created by accident — was permanent clutter with no way back. A *published*
notice still cannot be removed: it is the record of what people were told before
they agreed, cited by `consent_events`. `discardNotice` enforces the difference.

### 2026-08-10 — Privacy says what is actually happening

Two changes to the same confusion, both reported from real use.

- **`/admin/privacy` now leads with whether consent is being collected at all.**
  It needs a consent-based purpose *and* a published notice; with either missing
  the capture screen skips the consent step and says nothing. The page opens with
  "Nobody is being asked for permission", what that means for children, and the
  missing half linked. Once both are in place it is one quiet affirmative line —
  a permanent green banner is furniture, and furniture is not read.
- **"Draft it for me" became "Write it from my forms", and lost its sparkle.**
  It was read as a language-model call. It is not one, and never was: it
  assembles the notice from the organisation's legal details, its purposes, and
  the questions attributed to them, offline and deterministically. The label was
  promising something the code does not do — and worse, casting doubt on a notice
  honestly derived from the NGO's own forms. `verify:ui` now fails if any AI
  implication returns.

### 2026-08-10 — Development opens four connections, not ten

Follow-through on the connection exhaustion reported earlier, which the
`idle_session_timeout` on the dev Postgres treated as a symptom. The cause was
the pool size: every Next process opens *two* pools — the app role and the owner
role — and ten each is twenty per dev server against Postgres's default hundred.
Two dev servers, a test run and a couple of scripts exhausted it, and the symptom
was either "remaining connection slots are reserved…" or an unexplained 500 with
nothing pointing at the cause.

Development now defaults to four. Serverless stays at one per instance and
long-lived production at ten; `DATABASE_POOL_MAX` still overrides everything.

### 2026-08-10 — The stale-chunk failure is now caught, and scripts are typechecked

`Loading chunk app/(field)/page failed` on login. The dev server's `.next` had
the HTML referencing a chunk that was not on disk — residue from the two-server
incident, which does not heal on its own. Cured by `rm -rf apps/web/.next` and a
restart, which §8 already prescribed.

- **`npm run verify:ui` now signs in for real**, from a browser with no cookies,
  instead of injecting a session and skipping the one journey every user takes.
- **It watches the network**, so a 404 on anything under `/_next/` is a failure
  rather than something to be inferred from a console message. Verified by
  deleting the chunk and confirming all three assertions fire.
- **`npm run typecheck` now includes `scripts/`** via `tsconfig.scripts.json`.
  Nothing checked them before — `tsx` strips types rather than checking them —
  and a duplicate declaration in `verify-ui.ts` reached runtime because of it.
  Adding the project found a latent crash in `free-connections.ts`, where an
  empty result set would have thrown instead of reporting zero.

### 2026-08-08 — A browser in the loop, and one build directory per server

Two dev servers were run against the same `apps/web/.next`. Every Next process
writes that directory, so the browser got server HTML from one and client
JavaScript from the other: the field header rendered correctly and the account
menu could not be opened. It reads as a code bug and is not one.

- **`npm run dev:alt`** runs a second dev server on port 3100 with its own build
  directory. `next.config.ts` already warned about this for `next build`; the
  `next dev` case is subtler, because it fails silently rather than loudly.
- **`npm run verify:ui`** is the check that would have caught it — a real
  browser, driven over the DevTools Protocol, asserting that pages hydrate and
  respond. No new dependency. It was tested by breaking the account menu's click
  handler on purpose and confirming it fails.

Worth saying plainly: `npm test` contains no browser and never has, so nothing
in it could see this. That gap is now covered by a separate command rather than
by pretending the unit suite reaches further than it does.

### 2026-08-07 — The setup guide became a standing configuration index

A completed step used to hide its own link, so a finished setup was a wall of
green ticks leading nowhere — exactly when an organisation adding its second
programme comes looking for where purposes live. Setting up is not an event that
finishes, and the page no longer pretends it is.

- **Every row always links**, done or not.
- **Every row shows what is there** — "4 purposes", "2 of 3 published", the name
  of whoever handles privacy requests — not just a tick. `SetupProgress` gained
  a `counts` object for it.
- **The heading changes** to "What you have set up" once the required rows are
  done, and rows that get revisited say when to ("Add one whenever you start a
  new programme").
- **It leads the Setup menu**, renamed from "Getting started", as the index of
  the seven screens beneath it.

### 2026-08-07 — Nothing silently collects without asking

A new organisation could work through the whole setup guide, register a child,
and never once be asked for consent — because no purpose and no published
notice existed, so `consentRequirementFor` returned null and the capture screen
skipped the step. Nothing anywhere said so. Now three things do:

- **Two new setup steps** — "Say why you collect data" and "Publish your privacy
  notice" — both required, so the guide will not report itself complete.
- **Publishing a form warns** when its questions belong to no purpose, when
  nobody will be asked for permission, or — loudest — when it needs consent and
  no notice covers it.
- **Each setup step links to its own card** (`#languages`, `#purposes`,
  `#notices`, `#legal`, `#logo`) instead of dropping you at the top of a page
  holding four unrelated things.

**Postgres reaps stranded connections.** `idle_session_timeout=600000` on the
dev container. A killed dev server leaves its pool open and the server cannot
tell, so a few restarts exhausted the 100 slots and the next run failed with
"remaining connection slots are reserved for roles with the SUPERUSER
attribute". `npm run db:free` still clears them on demand.

### 2026-08-07 — Photo, file, signature, GPS and repeating sections

The last five field types are answerable on a phone, so everything the builder
offers can now be filled in. `DEFERRED_FIELD_TYPES` is empty for the first time.

- **Object storage is wired up.** `S3_*` in `.env` — MinIO locally, S3 or R2 in
  production. Requests are signed in `packages/db/src/storage/objects.ts`
  without the AWS SDK; a round trip against real MinIO is part of the suite.
- **Uploads go browser → storage** with a presigned PUT, because a serverless
  request body caps at 4.5 MB. Downloads are proxied through
  `/api/attachments/[id]` so authorisation is decided on every request.
- **Captured offline, they wait in IndexedDB** and the send queue exchanges the
  placeholder for a real attachment id when it drains.
- **Erasure now reaches object storage**, which it previously could not. Both
  `npm run db:purge` and the Privacy screen destroy the objects first and report
  any that survived, loudly.

### 2026-08-07 — Languages before the first form

The setup guide now asks for languages at step 2, before the first form is
built, and links straight to the Languages section of Organisation. It stays
optional — plenty of organisations work in English — but it can no longer be
reached after the questions are written, which was the only order in which the
**Translate** button was of any use. See [§7](#7-adding-a-new-organisation).

Also: the PIN inputs on `/start`, `/login` and `/change-pin` no longer report a
React hydration mismatch when a password manager rewrites their attributes.

### 2026-08-07 — DPDP: consent, notices, the access log and erasure

The rest of [§12](#12-data-protection-dpdp). Everything from purposes through
erasure, in five steps that each shipped on their own.

- **Purposes and generated notices.** An organisation lists what it does, each
  question is attributed to one, and Sangraha drafts the itemised privacy notice
  from the forms that already exist. Published notices are frozen by a database
  trigger — a consent is only worth something because it cites exact words.
- **Consent capture** as an append-only event log, offline-capable, with the
  device clock clamped so a slow phone cannot resurrect a withdrawn consent, and
  a queue that will not drop an attestation even when it gives up on the record
  carrying it.
- **Children.** Date of birth nominated per subject type; a child with no
  guardian goes to a supervisor rather than blocking the worker, and stays
  visibly irregular after approval.
- **An access log** of every export, profile view and search. One row per act.
- **Erasure** that reaches the duplicate cluster, `review_note` and the revision
  snapshots, redacts the consent log rather than deleting it, and writes monthly
  counts before destroying the rows behind them. `npm run db:purge` rehearses by
  default.

Also fixed, found while building this: **`validateDraft` never checked that a
subject type's nominated field keys exist.** A renamed question left the pointer
dangling — and with a dangling date-of-birth nomination, every child would have
resolved as an adult with nothing saying so.

Migrations `0007`–`0012` are additive. `LANGUAGE_NAMES` grew from 10 languages
to the Eighth Schedule plus English, with right-to-left handling.

### 2026-08-07 — DPDP groundwork: legal identity, and an audit trail that holds

First step of [§12](#12-data-protection-dpdp). Two foundations that everything
else rests on, both of which are what a claim of compliance gets checked
against later.

- **Organisations can say who they are.** Registered name, kind of organisation,
  registration number, address, and — the one that matters — the person who
  handles requests about personal data, with a phone or an email. On
  **Setup → Organisation**, and a step on the setup checklist. A new
  `data_region` column defaults to `IN`.
- **`submission_revisions` is genuinely append-only now.** It always said it
  was, while `030-grants.sql` let the request role rewrite it. `REVOKE UPDATE,
  DELETE` is the boundary for the request path; a new idempotent
  `sql/015-immutability.sql` adds a trigger so the owner connection has to
  declare a purge deliberately.

**`deleteOrganisation` is now one transaction**, because it is the sole
legitimate destroyer of revision rows and has to set `app.allow_purge` to get
past the trigger. That is also a fix on its own: a half-deleted organisation —
submissions gone, people still listed — was a worse state than either end of the
operation.

Migration `0006` is additive; both NOT NULL columns carry defaults, so there is
no backfill. Nothing needs `db:views`.

### 2026-08-07 — Records reads like your data, not like a database

The Records screen was a database dump bolted on beside the product: a grid of
cards carrying a form name and a slug, and a table that opened with thirteen
machine columns before the first answer, six of them bare UUIDs.

- **The index is a list** with a record count and when the last record arrived,
  ordered by recency, empty forms marked as empty. Above it, the organisation's
  totals: records, people registered, waiting for review.
- **The table shows the answers.** *When / About / Sent by / Status*, then each
  question by its label. The machine columns are behind **Show technical
  columns**, which is a URL parameter (`?tech=1`) and so re-renders on the
  server rather than hiding columns already sent to the browser.
- **Ids are names, and names are links.** The person a record is about, and any
  "link to a person" answer, resolve to a display name linking to their profile.
  Resolution is bulk — three queries for a page, never one per row — and every
  query is filtered by organisation, because these run on the owner connection
  where RLS does not apply.
- **Pagination: 50 / 100 / 250 / 500**, numbered pages with first/prev/next/last,
  the size held in the URL and clamped server-side. The CSV download is
  unaffected and still contains every matching row.

- **A record opens in full.** New screen at
  `/admin/records/<form>/<id>`: the facts across the top, then every answer,
  repeating groups included. A junk or unknown id is a 404, and an id belonging
  to a different form is a 404 rather than that record shown under the wrong
  form's heading.
- **"Link to a person" answers read as names.** They were bare uuids on every
  screen that showed them — a person's timeline, a worker's own records, the
  review queue and its detail screen. All now resolve, and the analytics views
  gained a `<key>_name` column so the CSV does too.

  **This one needs `npm run db:views` on deploy**, or the screen and the file
  disagree about which columns exist. Header names are stable, so anything
  reading the CSV by name is unaffected; anything reading it *positionally*
  shifts by one column per "link to a person" question.

Also fixed: a form whose slug is `subjects` — or longer than 63 characters —
would never have appeared in Records and would have 404ed on its own URL, because
both queries matched the view by `view_name = forms.slug` while the generator
names those views differently. Nobody has one; now nobody will find out the hard
way.

### 2026-08-06 — bring in a spreadsheet

The migration path off Excel. **Setup → Bring in a spreadsheet** takes a CSV, an
Excel file or a Google Sheets link, builds a form from the column headings, and
imports the records under it — including creating the answer lists for columns
that turn out to be a fixed set of choices.

Always two steps. The review screen shows every guess with the evidence behind
it — three real values, how many cells are blank, how many will not fit, whether
anything repeats — and every guess is a dropdown. Nothing is written until it is
confirmed, and the whole import is one transaction, so a failure part way
through leaves no form and no half-set of records.

Deliberate choices worth knowing:

- **Cautious by default.** Thin evidence becomes text, because a question can be
  widened later and not narrowed. A long run of digits stays text rather than a
  number — that is how phone and ration card numbers get silently corrupted.
- **Imports what fits.** A cell reading "not known" in a date column is left
  blank on its row and listed afterwards, rather than the whole file being
  refused over it.
- **Approved, and marked as imported.** History being migrated is not field
  capture awaiting a check, and 500 rows in the review queue is a queue nobody
  clears. Every row carries its source, batch and row number.
- **Re-running a batch cannot double it** — each row gets a deterministic id.
- CSV is parsed by hand rather than by a dependency, as with the export. Excel
  adds `exceljs`, loaded only inside the import route so it does not slow every
  cold start.

The Google token cache is now keyed by scope. It was a single slot, which was
correct while translation was the only caller and would have handed Sheets a
translation-scoped token the moment there were two.

### 2026-08-06 — answer formats, and what Answer lists are for

**"What kind of text?"** on any short-text question: Email, Web address, PAN,
Aadhaar, Pincode, IFSC, or a pattern the admin writes. Email and Aadhaar also
appear as tiles in the question palette, creating a text question with the
format preset — one mechanism underneath, not a second kind of field.

A custom format is a mask (`A` a letter, `9` a digit) rather than a regular
expression. An admin can read it back and check it, a mistake can only make the
rule the wrong shape rather than catastrophic, and it cannot backtrack — there
is a test asserting 20,000 worst-case matches finish in under a second. It also
describes Indian ID numbers exactly.

**A validation failure now says words.** Field types report a message key so the
engine stays language-free, and nothing was translating them — a worker who
mistyped a date was shown the literal string `invalidDate`. Fixed for every
field type, not just the new formats.

**Answer lists explains itself.** The page said "the choices a question offers",
which is accurate and tells a programme manager nothing. It now leads with a
worked example — one "Class" list feeding both the registration and the
attendance form — and says what reuse buys: add a choice once, rename or
translate without re-keying, and count across forms.

**`npm run db:free`** releases Postgres connections stranded by a killed dev
server or test run. That failure looks exactly like a code regression and is
not one.

### 2026-08-06 — Sangraha co-brands in the header

Every signed-in screen now carries the Sangraha mark, centred in the header,
small and in grey. The organisation's own logo keeps the leading position on the
left, which is the point: the product is identifiable without a field worker
feeling they were handed somebody else's software.

- Not a link. Tapping a logo in a header conventionally means "go home", and the
  organisation's mark on the left already does that.
- On a narrow phone the word drops away and only the mark remains, and the
  person's name in the menu is shortened to make room — the organisation's name
  is not the thing to sacrifice.
- In the admin console it appears above 1280px only; below that the navigation
  and the right-hand links already meet in the middle.
- Sign-in and signup are unchanged: they carry the full logo in the page itself,
  since no organisation is resolved yet.

`CLAUDE.md` records the balance so it does not drift: if a change would make our
mark larger, louder or earlier than the NGO's, it is the wrong change.

### 2026-08-06 — reordering and removing questions from the list

Putting a form in order meant selecting a question, moving it in the editor
panel, selecting the next one, and so on — with the list shifting under the
cursor each time. Each question row now carries its own controls:

- **Move up / move down**, without selecting the question first. Disabled at
  the ends rather than silently doing nothing.
- **Delete** when the question holds no answers, **Stop asking** when it does —
  the same rule the editor applies, not a looser one, because deleting a
  question with answers would hide them from every report. Deleting is
  confirmed once, naming the question.
- An archived question shows the same "ask it again" control, so undoing is
  where doing was.

The question-type palette no longer truncates its descriptions. "Worked out
from oth…" was cut off exactly where it started to explain, and that line is
the only thing telling a programme manager what "Calculated" or "Link to a
person" means.

Questions marked unique now show a fingerprint in the list, alongside the
existing markers for required and no-longer-asked.

### 2026-08-06 — the admin console navigation

Eight links sat in one flat row, all the same weight, with nothing showing which
one you were on. Split by how often an administrator needs them:

- **Forms**, **Records** and **People** are the daily work and stay in the bar.
- **Who you register**, **Answer lists**, **Places**, **Organisation** and
  **Getting started** are set up once and then left alone, so they moved behind
  a **Setup** menu — one click away, with a line of explanation each that the
  bar had no room for.
- The current section is now underlined, including when you are inside one of
  the Setup pages. The old bar never showed it at all.

Nothing was removed, and every URL is unchanged.

### 2026-08-06 — the home screen is about forms now

The four things that are not filling in a form — Find a person, What I have
sent, Approve data from field, Manage forms — moved from cards at the bottom of
the home screen into a menu behind the person's name in the header. Every form
an organisation added used to push "Manage forms" further down, and eventually
off the screen. Navigation does not grow; the work does.

- The home screen is now forms only, grouped by what they do: register someone,
  record a visit, one-off records. The headings appear only when there is more
  than one kind.
- **Records to check** is now **Approve data from field**, in all three
  languages, and lives on a bell beside your name with the number waiting on
  it rather than inside the menu.
- **Profile** in the menu opens the account screen. **Sign out** moved into the
  menu — with its confirmation and its warning about anything still queued on
  the device. Changing a PIN stays on the account screen: it is deliberate,
  nobody does it by accident, and it is easier to talk somebody through over
  the phone when it is not behind a menu.
- The bell is the one place in the field UI where an icon stands without a word
  beside it. The rule elsewhere — icon *and* text, never icon alone — exists
  because an untrained worker cannot decode a glyph; this is shown only to
  supervisors and admins, a bell with a number is about as widely understood as
  an interface convention gets, and it carries a full label for screen readers.

### 2026-08-06 — unique answers, and a date-and-time field that never worked

**Questions can now be marked unique.** A checkbox beside "An answer is
required": no two records on that form may hold the same answer. Meant for
phone numbers, emails and ID numbers. Refused when saved, with the worker sent
back to the question that clashed.

Enforced in the same transaction as the insert, behind an advisory lock on the
value — not by a database unique index, which could not be added to a form
whose existing data already repeats. The lock is what makes it hold when two
workers submit the same number at the same moment; there is a test that fails
without it. Publishing reports duplicates already in the data rather than
pretending the rule reaches backwards.

**Date-and-time questions rejected every answer.** The field required a full
offset-bearing instant (`2026-08-06T14:30:00Z`), but the only thing that writes
it is `<input type="datetime-local">`, which yields `2026-08-06T14:30`. Every
entry failed as an invalid date and time — the field type was unusable from the
day it shipped. It now stores a wall-clock reading like its `date` and `time`
siblings, and its analytics column is `timestamp` rather than `timestamptz`, so
no timezone is invented for a reading that never had one.

Run `npm run db:migrate` then `npm run db:views` after updating: the migration
adds `form_fields.is_unique`, and the datetime column type changes.

### 2026-08-06 — signup could half-create an organisation

Reported from use, and two bugs in one flow.

**The organisation was created even when signup failed.** `provisionOrganisation`
inserted the organisation and *then* hashed the administrator's PIN, with no
transaction — and hashing is what rejects a weak PIN. So choosing 111111 gave an
error message *and* a committed organisation with no administrator, which
nobody could sign into. The second attempt was then refused for a name that
"already existed": the person's own wreckage from the first.

Now the PIN is checked before anything is written, and the organisation and its
administrator are created in one transaction — so it is both or neither. The
message also says which rule the PIN broke rather than guessing between four.

**A rejected signup wiped the form.** React clears an uncontrolled form once its
action returns, so one bad PIN also erased the organisation name, the person's
name and their sign-in name. What they typed now comes back with the error. The
PINs deliberately do not: they never travel back to the browser, and retyping
one after a rejection is right anyway.

If an earlier attempt left an empty organisation behind, remove it with
`npm run org:delete -- --slug <slug> --confirm`.

### 2026-08-06 — saying why the Translate button is missing

Reported from use. The button needs two things — a second language turned on
for the organisation, and a translation credential — and when either was
missing it simply was not rendered. A new organisation starts with English
alone, so the common case was an admin concluding the product could not
translate at all.

The builder now says which of the two is missing, and links to the setting that
fixes it. Nothing about the translation itself changed.

### 2026-08-06 — bulk approve in the review queue

Requested: opening every record to approve it does not scale past a handful.
**Check several at once** on **Records to check** turns on checkboxes, with
select-all, a confirmation naming the count, and a warning that approving cannot
be undone. Tapping a record still opens it, which remains the only way to send
one back.

The bulk path enforces exactly the same rules as the single one — RLS scope,
already-decided records left alone, the four-eyes rule per record, one audit
entry each. A supervisor's own submissions appear greyed and un-tickable, and
select-all skips them. Every outcome is reported, including the ones that did
not happen.

No bulk send-back, deliberately: a rejection needs a reason the worker can act
on, and one reason across twenty records is not a reason.

### 2026-08-06 — a name is not enough to choose a person by

Reported from use, and the same fault in a second place: "This is the same
person as…" listed people by name alone, so four rows reading "Test1 ·
Respondent" gave nothing to choose between.

Fixed in the shared picker rather than one screen at a time, so **Find a
person**, choosing who a visit is for, the `subject_ref` question and the
duplicate-linking screen all improve together. Each result now carries the
answers that distinguish people — age, phone, guardian — plus where they are and
who registered them. The answers that already make up the displayed name are
skipped: "Name: Test1" under a heading reading "Test1" is a wasted line on a
phone.

Joining two records also now confirms first, showing both side by side and
saying plainly which one survives.

### 2026-08-06 — the duplicate screen said what it wanted, not what it did

Reported from use: the screen asked "Is this the same person?", listed two
cards, and gave no clue what tapping one would do — nor any way to tell the two
apart, since both read "Test1 · Registered 6 Aug 2026". Tapping saved
immediately.

- Each card now shows the answers that distinguish people (age, phone,
  guardian), drawn from the type's **How to spot a duplicate** fields first,
  plus who registered them and where.
- Each card carries the words **"Yes, this is them"** instead of a chevron.
- Choosing one now asks to confirm — *"Save to Test1? The answers you just
  filled in will be added to their record. No new person will be created."* —
  before anything is written.
- The README now spells out that there is no merge at this point (nothing has
  been created yet) and that joining two existing records is the separate,
  reversible action on a person's profile.

The privacy promise is unchanged and now harder to break: the extra answers are
withheld by the SQL itself for matches outside the worker's locations, and the
test asserts a phone number from another village never reaches the payload.

### 2026-08-06 — three defects found by using it

All three were silent, which is what made them worth fixing properly.

**A one-admin NGO could not approve anything.** The four-eyes rule refused to
let anyone approve a record they submitted, so in an organisation whose only
reviewer is the admin, everything they captured was permanently stuck — and the
screen said "This record has already been checked by someone else", which was
untrue. Three different failures shared one message. Now: org admins may
approve their own records (recorded as `self_reviewed`, and said out loud on
screen), supervisors still may not, and each failure says what actually
happened, in all three languages.

**A registration form with no subject type registered nobody, silently.** The
form said "Registers a person", a worker filled it in, and nothing appeared
under Find a person. Forms built before the registry existed are all in that
state. Now such a form cannot be published, is flagged on the forms list, and
can be pointed at a subject type from the form itself — with a button to
register the records already collected, crediting the worker who captured them.

**Every question built through the UI got a meaningless key.** Questions are
created with the placeholder label "Untitled question", the key was derived from
that and frozen, so a question later named "Age" shipped an analytics column and
a CSV header called `untitled_question_2`. Keys are now re-derived the first time
a real label is typed — only while the key is still the placeholder and no
answer has ever been recorded against it, so a real rename still never moves a
column. Apostrophes are dropped rather than split on, so "Guardian's phone"
gives `guardians_phone`, not `guardian_s_phone`.

Existing keys are left alone: data is already stored under them. Run
`npm run db:views` after deploying to pick up the new `self_reviewed`,
`reviewed_by` and `reviewed_at` columns.

288 tests, up from 265.

### 2026-08-06 — the registry, and reading your own data

The two pieces that make this an MIS rather than a form collector.

**The registry works.** `subjects` had been in the schema since Phase 0 and had
never held a row: `/admin/forms/new` never asked what a registration form
registered, so every form built through the UI had no subject type and the
registry could not function. Now:

- **Who you register** (admin console) — define Student, Household, Self-help
  group; choose which answers name them and which identify them
- Registration forms create a person, in the same transaction as the submission
- **Find a person** (field app) — fuzzy search, forgiving about spelling
- **A person's record** — registration details plus every visit in date order
- Encounter forms ask who the visit is for, from either direction: form-first
  from the home screen, person-first from a profile
- `subject_ref` questions ("which mother?") now render, using the same picker

**Duplicate detection at registration.** Similar name, same ID, or same match
field. A match outside the worker's locations is reported as a count only — no
name, no place. Duplicates found later are linked reversibly, never merged.

**Records + CSV.** Every form's data with counts, date/place/status filters and
a download that applies the same filters. RFC 4180 quoting and a UTF-8 BOM, so
a comma inside a note cannot shift a row and Excel opens Kannada correctly.
Org admins only — the analytics views bypass Row-Level Security.

Two new analytics views per organisation: `subjects` and `subjects_<type>`.

On an existing deployment, run `npm run db:migrate` and then **`npm run
db:views`** — migration `0004` is additive, but the new `subjects` views are
built by the view generator, which otherwise only runs when a form is
published. `db:views` is new, idempotent, and safe to run at any time.

265 tests, up from 226.

### 2026-08-06 — ready to deploy on Vercel

Hosting is the product: field officers are not in the office, so docker-compose
is the development loop and Vercel is production. Each NGO runs its own instance.

- **Connection settings are now detected, not assumed.** On serverless the pool
  drops to one connection per instance and idle connections are released
  quickly; behind a transaction pooler (Neon `-pooler`, Supabase `:6543`,
  `pgbouncer=true`) prepared statements are disabled. Ten connections across
  thirty warm instances would have exhausted the database, and prepared
  statements would have failed intermittently under load. Local behaviour is
  unchanged.
- **Signup is closed by default in production**, and always open while the
  database has no organisation. Whoever deploys visits `/start`, becomes the
  administrator, and it closes behind them — there is no shell on Vercel to run
  `org:create` in. The previous default was open everywhere, which made a public
  deployment insecure unless its operator had read the right paragraph.
- **Migrations run during the build**, guarded by an advisory lock so concurrent
  deployments cannot race. `SKIP_MIGRATIONS=1` opts out.
- **`/api/health`** reports whether the database is reachable, migrated, has
  RLS in force and has the `mis_app` role — the things that actually go wrong on
  a first deploy, and which "the page loads" says nothing about.
- `vercel.json` plus a `vercel-build` script in both packages, so either Vercel
  monorepo layout works. See §10.

### 2026-08-06 — service account credentials supported

- **A Google service-account JSON now works.** The Cloud console hands you one
  when you ask for a credential, and many organisations disable API keys by
  policy, so "wrong kind of key, go make another" was a poor answer. Point
  `GOOGLE_APPLICATION_CREDENTIALS` at the file, or pass the JSON base64-encoded
  in `GOOGLE_TRANSLATE_CREDENTIALS` for hosts with no filesystem. **Never paste
  the JSON into `.env`** — it is a private key and spans lines.
- Signs a short-lived JWT, exchanges it for an access token, caches it for the
  hour Google allows, and discards it on a 401. The credential travels as a
  bearer header, so unlike an API key it never appears in a URL or an access log.
- 12 tests, signing with a real generated RSA key that the stub verifies.

### 2026-08-06 — translation verified end to end

- **Fixed: translating into two languages dropped the first.** The fields were
  read once and each language applied to that original copy, so an organisation
  with Hindi and Kannada ended up with only Kannada. Results now accumulate
  across languages and each question is written once.
- **Fixed: Google HTML-escapes its output even with `format: text`**, so
  "Student's name" would have reached a field worker as `Student&#39;s name`.
  Decoded now.
- **`GOOGLE_TRANSLATE_ENDPOINT`** added, for a proxy or an API-compatible
  service — and it is what let the whole path be tested without a real key.
- 11 adapter tests against a stub of Google's documented shape. See §6 for how
  to add a key.

### 2026-08-06 — untranslated questions no longer render blank

- **Fixed: a field worker could be shown a question with no words in it.** The
  form builder wrote an empty string for every language an admin tabbed past, so
  a label was stored as `{ en: 'Name', hi: '', kn: '' }` — and the resolver used
  `??`, which only catches `undefined`. A Kannada worker saw a blank line and a
  required asterisk.
- **One resolver now, in `packages/form-engine/src/i18n.ts`.** `localise()`
  treats blank and whitespace as untranslated and falls back requested language
  → English → any language with text → the caller's fallback. Nine sites that
  each had their own `??` chain now call it, including choice-option labels and
  the analytics `_label` columns.
- **Blanks are no longer stored.** Every per-language editor prunes them, so
  "is this translated?" has an honest answer.
- **`040-prune-blank-translations.sql`** cleans what was already stored. Runs on
  every migrate and is a no-op after the first.

### 2026-08-05 — logo upload fixed for real-world files

- **Fixed: uploading an ordinary logo crashed with "Body exceeded 1 MB limit".**
  Next.js rejects an oversized server-action request before any of our own
  validation runs, so the user saw a stack trace instead of a message. Images
  are now decoded and resized in the browser first (max 1024×512, ~200 KB), and
  the person is told it happened.
- **SVG is now accepted**, rasterised client-side. Only pixels are stored, so
  the stored-XSS concern that made us refuse it does not apply — and the database
  still refuses SVG as a second line of defence.
- The upload no longer goes through `useActionState`, so a framework-level
  failure (body limit, dropped connection) is caught and reported rather than
  thrown. `serverActions.bodySizeLimit` is now stated explicitly at 2 MB —
  headroom, not a target.

### 2026-08-05 — named Sangraha, org branding

- `npm run build` now writes to `.next-build`, not `.next`. Building while a dev
  server was running corrupted its chunks and made every route throw
  MODULE_NOT_FOUND — a failure that looks like a code bug and is not one.

- **The product is called Sangraha** — संग्रह · ಸಂಗ್ರಹ · సంగ్రహ, "collection".
  Chosen for a root shared across Indo-Aryan and Dravidian languages, so it
  reads the same from Kerala to Punjab, and because it states what the product
  does. Mark, favicon and iOS icon added: scattered points gathering into one.
- **Organisations can upload a logo**, shown in the field header, the admin
  header and on the sign-in page, falling back to the organisation's name. New
  `organisation_branding` table and a public `/api/orgs/<slug>/logo` route.
  Raster only — SVG is refused as a stored-XSS vector.
- **Sangraha recedes inside an organisation.** Our own mark appears only on
  signup and where no organisation is resolvable.
- The npm scope is now `@sangraha/*` (was `@mis/*`). Infrastructure identifiers
  — the `mis-postgres` container, the `mis` database and the `mis_app` role —
  are deliberately unchanged, since renaming them would force a data reset for
  no functional gain.

### 2026-08-05 — onboarding and translation

- **Self-serve signup at `/start`.** Four questions, then you are the
  administrator of a new organisation, signed in, on a setup guide. Gated by
  `SIGNUP_MODE` (`open` / `code` / `closed`) — **change it on a public
  deployment**.
- **Guided setup at `/admin/setup`**, with a banner across the admin console
  until it is done. Every step derives its own completion from real data, so it
  cannot claim something is finished that has been undone.
- **Machine translation of form content.** A Translate button fills in missing
  translations of an organisation's own questions, never overwriting human text,
  marking everything it writes as an unchecked draft. Needs
  `GOOGLE_TRANSLATE_API_KEY`; the button is hidden without one. New
  `label_machine` / `help_machine` columns carry the review state.
- **English is always enabled**, and always first — it is the fallback when an
  organisation's own content is untranslated.
- Organisation provisioning is now one shared function used by both the CLI and
  signup, so slug derivation cannot drift between them.

### 2026-08-05 — admin console, answer lists, org provisioning

- **Answer lists are editable** at `/admin/lists`. Codes are derived once and
  frozen, so relabelling never moves an answer in your reports; an answer that
  records already use can be hidden but not deleted.
- **Admin console built** — `/admin/users`, `/admin/places`, `/admin/settings`.
  Add people, set roles, assign places, reset PINs (shown once, forced change on
  first sign-in), unlock accounts, edit the place hierarchy, and set the
  organisation's name, languages and place level names.
- **Resetting a PIN or changing a role signs that person out everywhere**, via
  `token_version`. An administrator cannot remove their own admin rights or
  switch off their own account.
- **`npm run org:create` / `org:delete`** — provisioning a tenant is a
  platform-operator action, so it is a command rather than a screen. See §7.
- **Fixed: the language setting did not survive signing out.** The account
  screen wrote it only to the session cookie, never to `users.locale`, so it
  looked like it had silently failed. A saved preference now wins over the
  login-screen choice, which remains the fallback for someone who has never set
  one.
- Widened the auth helpers to accept a transaction, so PIN resets run inside the
  caller's RLS context.

### 2026-08-05 — sign-out, and two status bugs

- **Sign out now exists**, on a new **Your account** screen reached by tapping
  your name in the header. It also hosts the language switcher and the link to
  change your PIN — previously language could only be set at login, so anyone
  who picked one they could not read had no visible way back.
- **The "Everything is sent" chip is gone.** It reported on a send queue field
  workers do not know exists, and being always present it carried no
  information. Only the exception is shown now: "2 waiting to send", and
  nothing at all when nothing is waiting.
- **Fixed: a never-published form claimed to be "Published · version 1"** in the
  builder while the forms list correctly said "Not published". The builder had a
  two-valued `isDraft` boolean where the state is genuinely three-valued
  (never published / unpublished changes / published).
- **Fixed: the forms list reported "Not published" and 0 responses for every
  form.** Drizzle renders an interpolated `${table.column}` as a bare
  identifier, so inside a correlated subquery over a table with the same column
  name it bound to the wrong table and matched nothing — wrong answers, no
  error. All four such subqueries are now joined aggregates, with a regression
  test asserting the values.

### 2026-08-05 — data views and form builder

- **You can now see collected data in the app.** "What I have sent" for every
  user, with a record detail screen; a supervisor review queue with approve and
  send-back. Decisions are written to `submission_revisions`, a rejection
  requires a reason, and nobody can approve their own submission.
- **The form builder is live** at `/admin/forms`. Create and edit forms, all 13
  usable question types, skip logic composed from dropdowns, live phone preview
  using the real capture component. Publishing versions the form and
  regenerates the analytics views.
- **Destructive-edit guardrails.** Deleting a question that holds answers is
  refused and archiving is offered instead; type narrowing is refused; widening
  warns. Messages are written for the admin, not the developer.
- **Admin shell** at `/admin`, gated to org admins, using a dense desktop theme
  distinct from the field UI.
- Added `analytics`-facing helpers: `formatAnswers`, `summariseSubmission`,
  `ruleNodeSchema` (validates rules posted from the browser).
- Fixed a 174 kB namespace icon import that had bloated the builder bundle.

### 2026-08-05 — languages and login

- **UI languages are English, Hindi and Kannada.** Marathi replaced by Kannada
  throughout, including all demo content. `UI_LOCALES` is the single source of
  truth; `messages.test.ts` guards catalogue completeness. Demo geography moved
  to Belagavi, Karnataka for coherence.
- **The organisation is no longer typed at login.** One organisation and the
  field disappears; several and it is a dropdown of names. It was previously a
  free-text slug, and a wrong value reported "That name or PIN is not right" —
  an error about the wrong field entirely.
- **`npm run db:migrate` / `db:seed` work standalone.** They did not load the
  root `.env`. Every entry point now calls `loadRootEnv()`; do the same for any
  new one.
- **`npm run db:seed` is re-runnable with data present.** Deletion order now
  lives in `deleteOrganisation()`, shared with the test harness.
- **The test harness sweeps abandoned `test-*` organisations** left by
  interrupted runs, scoped to before the current process started.
- **`npm run typecheck` fixed** — it pointed at a root `tsconfig.json` that does
  not exist.
- **Added** `npm run data`, `login:check`, `verify`, `session`.
- Analytics views moved to a per-organisation schema (`analytics_<slug>`), so two
  NGOs with the same form slug cannot collide.

### Phase 0 — initial build

Monorepo, Postgres schema (17 tables), RLS, form engine (19 field types),
username + PIN auth, analytics view generation, field capture UI.
