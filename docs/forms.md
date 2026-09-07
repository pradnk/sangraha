# Creating and changing forms

The form builder — questions, answer lists, validation, uniqueness,
spreadsheet import, translation, and adding a new field type.

---

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

## Who can use a form

**Manage forms → the form → Who can use this form?** Three options, each built
around who will approve what it collects:

| | Who can use it | Who approves |
|---|---|---|
| **Everyone in the organisation** | every signed-in user | supervisors, within their own locations |
| **Supervisors, plus the field workers I choose** | every supervisor, plus the workers ticked | supervisors |
| **Organisation admins, plus the people I choose** | admins, plus the people ticked | admins only |

**Organisation admins are in every option** and are not offered in the picker.
That is what guarantees every form has somebody who can check what it collects —
a form with no approver is not a state this screen can produce.

A worked example, on a real caseload:

| Form | Audience |
|---|---|
| Mid-day meal attendance, all forty workers | Everyone |
| Scholarship applications, four specialists | Supervisors, plus those four |
| Child-protection incident report | Admins, plus the two senior staff |
| Monthly block report | Supervisors, nobody added |

**Nobody added is not an unfinished job.** "Supervisors" with no one ticked is a
supervisors-only form; "Admins" with no one ticked is an admins-only form. Both
are things organisations actually want, so publish does not object.

**The role part does not go stale.** A supervisor who joins next month is in the
supervisors tier already, without anybody remembering to add them. Only the
individually named people are a hand-kept list — and those are the people whose
membership really is per-form.

**Location scoping still applies underneath.** "Supervisors" means the role, not
the map: a supervisor still sees only records from their own places. Opening a
form to supervisors does not widen anybody's patch.

**An admins form is invisible to supervisors** — not merely unfillable. Its
records never reach a supervisor's review queue or their bell. That is the point
of the option, and it is what makes it the right choice for something sensitive.

**Changing the audience takes effect immediately**, with no publish and no
sign-out. The rule is read from the database on every request rather than
carried in the session.

**What narrowing does not take away.** A worker keeps their own past records and
can still finish correcting one that was sent back, on a form they have since
been moved off. Access governs what you may start, not what you must finish — a
rejected record nobody may touch would be stuck for ever. What they cannot do is
capture anything new on it.

Enforced in the database, not the screens. The capture API takes a form version
id from the device, and the attachment API mints upload URLs from one, so a check
that lived only in the UI would be no check at all — see `app.can_use_form` in
`packages/db/sql/020-rls.sql`.

## Answers that must not repeat

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

## Moving records in from a spreadsheet

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

## Answers that must be a particular shape

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

## Adding a whole new field type

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

## Translating a form

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

### Setting up a Google credential

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

## Your organisation's logo

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

## People, places and settings

They are at `/admin/users`, `/admin/places` and `/admin/settings`:

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

[← Back to the README](../README.md)
