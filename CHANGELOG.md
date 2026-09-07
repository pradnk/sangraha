# Changelog

Newest first. Entries from **2026-08-30** onwards are kept in full — those are
the two whole-tree reviews and the defects they turned up. Everything before
that is condensed to a line, because the detail has been superseded by the code
and by [`issues.md`](./issues.md), which records the decisions carried forward.

### 2026-09-07 — Supabase, and four ways a working deployment is silently wrong

Moved from Neon to Supabase for a Mumbai region. It stopped at `DATABASE_URL is
not set`, with the connection details sitting in the environment under other
names. Fixing that surfaced three more, none of which announce themselves.

**Provider variable names are resolved in `load-env.mjs`.** Supabase's Vercel
integration injects `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING` and a
`POSTGRES_HOST`/`USER`/`PASSWORD`/`DATABASE` set, and no `DATABASE_URL`. They
are mapped in the one place every entry point already calls, so none of the
dozen `process.env.DATABASE_URL` reads learns that providers disagree about
naming. The pooled URL is preferred: Supabase's direct host is IPv6-only without
the IPv4 add-on and Vercel functions have no IPv6 egress, so the more
"correct"-looking choice is the one that cannot open a connection at all. The
loader logs which variable each connection came from, because a connection
resolved from a name nobody set is otherwise indistinguishable from a configured
one.

**`DATABASE_APP_URL` can now be derived from `DATABASE_APP_PASSWORD`.** Same
host, same database, same pooler; only the role and password differ. There is
deliberately no fallback to the owner's password — that would serve every
request on the connection that bypasses RLS, and it would look like everything
working.

**The role name is not always the username.** Supabase's pooler fronts every
project, so it carries the project reference in the username —
`mis_app.abcdefghijkl` — and strips it before Postgres sees it. Taken
literally, `CREATE ROLE` and every `GRANT` in `030-grants.sql` would name a role
that nothing ever authenticates as: the migration prints "database is up to
date" and every request then fails on permissions. This is the same defect as
the literal `mis_app` in the grants file, arriving from the other direction, so
it is fixed in the same place — `app-role.ts` now derives the role from the URL
*and* the host. `DATABASE_APP_ROLE` overrides it.

**`pg_trgm` is pre-installed on Supabase, in a schema called `extensions`.** So
`CREATE EXTENSION IF NOT EXISTS pg_trgm` is a no-op and the operators never
reach `public`. The owner's search path already covers that schema, so the
migration applies, the trigram index on `subjects.display_name` builds, and
nothing looks wrong — until a field worker searches for a person and gets
`operator does not exist: text % text`. `030-grants.sql` now reads the schema
out of `pg_extension` rather than assuming a name, grants `USAGE` on it and puts
it on the app role's `search_path`. Reproduced against a Supabase-shaped local
database, failing before and passing after.

**The migration lock was being taken on a transaction pooler.**
`pg_try_advisory_lock` is session-scoped, and a transaction pooler hands the
next statement to a different backend — so the lock was taken on one, the
migration ran unprotected, and the unlock returned false against a third. Two
deployments finishing together would both migrate, which is the single thing
that script exists to prevent. It now takes the lock on the session connection.

**`unpooledConnection` understands Supabase.** Previously Neon-only, so the
retry path for role DDL had nothing to fall back to. The target is session mode
— the same pooler host on port `5432` — and not the direct host, for the IPv6
reason above: a fallback that cannot be reached is worse than none, because it
fails in exactly the deployment that needed it.

Migrations also stopped preparing statements. They run once, so there is nothing
to gain and an intermittent `prepared statement does not exist` to lose.

**`vercel.json` moved to `"regions": ["bom1"]`**, following the database. The
entry below set it to `sin1` the same day, for a Neon project in Singapore —
that was the closest available, because Neon has no Indian region. A Supabase
project in `ap-south-1` makes "both in Mumbai" possible, which is the whole
reason for the move, and leaving the functions in Singapore would have kept
the latency the change was meant to remove.

### 2026-09-07 — Six to ten seconds a click, from a region nobody chose

Reported after the first working deployment: every click took 6–10 seconds,
against an app that is instant locally. Functions on Vercel, database on Neon in
Singapore.

Vercel places functions in Washington DC (`iad1`) unless told otherwise, and
`vercel.json` said nothing, so every database round trip crossed the Pacific at
roughly 240 ms. One page load spends about seventeen of them:

| | round trips |
|---|---|
| Owner pool — TCP, TLS, authentication | ~5 |
| `requireSession()` user lookup | 1 |
| App-role pool — TCP, TLS, authentication | ~5 |
| `begin` | 1 |
| `set_config` × 3, as three separate statements | 3 |
| The query | 1 |
| `commit` | 1 |

Four seconds of waiting before Next's cold start or a Neon compute resume, and
it presents as the product being slow rather than as a setting, because every
click pays it in full.

**`vercel.json` now sets `"regions": ["sin1"]`**, which is the larger half of
the fix and a single line: a round trip inside a region is about 2 ms rather
than 240 ms, so those seventeen stop mattering.

**`withContext` sets the whole RLS context in one statement instead of three.**
Six statements per query became four. Invisible against Postgres on localhost —
which is exactly why it was written that way and why it survived — and three
quarters of a second per query across an ocean. Measured against a real Postgres
with `log_statement='all'`, before and after, rather than reasoned about.

`docs/deploying.md` carried two claims that are why the default went unnoticed.
"Region choice needs a paid Vercel plan; on Hobby you get one fixed region" has
not been true for some time. And "for Indian users that means Mumbai (`bom1`)
for both" is not reachable — Neon has no Indian region — and pointed the wrong
way regardless: a request crosses from user to function once and from function
to database many times, so the function belongs next to the *database*, and the
user's single longer hop is the cheaper one to pay.

Both fixes are guarded in `connection.test.ts`, and both guards were confirmed
to fail against the code they replaced. The region one cannot check the value is
right, only that a decision was made — the default being silent is the whole
problem.

### 2026-09-07 — The example auth secret was long enough to work

Setting up the first organisation failed on:

```
Error: AUTH_SECRET must be set to at least 32 characters
```

`AUTH_SECRET` was simply not set in the deployment, which is the ordinary
version of this. Looking at the check found the unordinary one. `.env.example`
shipped

```
AUTH_SECRET=replace-me-with-a-random-32-byte-secret
```

— **39 characters, which passed the 32-character check.** An installation that
copied the example file into its environment and never replaced the value ran
perfectly well, signing every session cookie with a string published in this
repository. Anyone reading the repo could mint a session for any organisation
and any role, `org_admin` included, without a PIN. Nothing about such an
installation looked wrong, because nothing was, until someone opened the file.

The two checks that existed made it worse by being different: `session.ts`
required 32 characters, `consent.ts` required only that something was set, so
the pepper protecting consent pseudonyms could be weaker than the key signing
cookies while both read the same variable.

**`authSecret()` in `packages/db/src/auth/secret.ts` is now the only
definition**, used by both. It refuses an absent value, anything containing
`replace-me`, the handful of words people put in a field they mean to come back
to, and anything under 32 characters — reporting the length but never the value,
since these messages reach build logs. Like `migrate.ts`, it tells a build to
use its platform's environment variables and a clone to use `.env`, rather than
naming a file that does not exist where it is read.

`.env.example` now leaves `AUTH_SECRET=` empty. Rejecting the placeholder while
still shipping one would break every fresh clone, and the README already told
you to generate one on the line that copies the file. A placeholder that works
is worse than one that does not.

Verified: the demo credentials still sign in on all four roles and a wrong PIN
is still refused, so the signing path is unchanged for a correct secret.

### 2026-09-07 — The empty installation now has a landing page

The fix above made the first screen correct and left it ugly: an amber notice
box floating in the middle of an empty viewport, which still read as a fault
rather than an invitation. It was also the only thing on the page — no mark, no
indication of what had just been deployed.

**`login/welcome.tsx`** replaces it. The Sangraha mark, one sentence on what
the product is, the single action available, and four lines on what it does.
A server component, returned from `login/page.tsx` before the sign-in form is
reached, so it ships no client JavaScript and `LoginForm` can stop carrying an
empty-state branch it should never have had.

This is the one screen where the full mark belongs — inside a live organisation
the header carries *theirs* and Sangraha co-brands quietly beside it. Here there
is no organisation to lead, so nothing to be louder than.

Every claim on it is one the README already makes under **What it does** and
**Status**. The offline line says *send queue* rather than *works offline*
deliberately: the retry queue is built, the full offline PWA is not, and a
landing page that promises otherwise is a bug report waiting to be filed.

Two details that were nearly wrong. The phone capability first carried a
`WifiOff` icon — a crossed-out signal symbol, which reads as an error, on the
page whose whole purpose was to stop looking like one. And the closing line was
`slate-500` on `slate-50`: 4.55:1, compliant by a hair, one shade from the
mistake `SangrahaCoBrand` already made. It is `slate-600` (7.24:1), and
`palette.test.ts` — which already owns this question — now fails if any text on
the page drops below `slate-600`.

Rendered and checked at 390px and 1280px against an empty migrated database,
with the phone width emulated through CDP rather than a resized window: the
naive `--window-size=390` screenshot clips, and clips `/start` identically, so
it was the harness and not the page.

### 2026-09-07 — The first screen of a working deployment asked for a shell

With everything else fixed, a fresh deployment's sign-in page said:

> No organisation has been set up yet. Run `npm run db:seed` to create the demo
> organisation.

Wrong twice in the one place it is read. There is no shell on Vercel to run it
in, and `db:seed` builds the *demo* organisation with invented people and
rotating PINs — not what anyone wants on the installation they just deployed.
The actual answer, `/start`, was not mentioned. It is the one screen the
bootstrap exemption in `signup.ts` exists for, and the sign-in page did not link
to it.

**It now links to `/start`** and says what happens there: whoever sets the
organisation up becomes its administrator and signup shuts behind them. The seed
script is mentioned only under `NODE_ENV === 'development'`, where it can be run
and where the demo data is the point.

English only, and deliberately: that branch returns before the language
switcher, and it is read once by whoever just deployed, before any worker or
organisation exists. It is not field UI, so its strings do not go in
`messages.ts`.

Verified against an empty migrated database on a dev server: `/login` renders
the message with the link, `/start` returns the setup form, and after an
organisation exists `/login` shows it while `/start` — under `SIGNUP_MODE=closed`,
as production defaults to — answers "Not accepting new organisations". The door
shuts, which is what the new copy promises.

### 2026-09-07 — The doubled output path came back, from the dashboard this time

The migration succeeded and the build then failed on the error this day had
already started with:

```
Error: The Next.js output directory "apps/web/.next" was not found at
"/vercel/path0/apps/web/apps/web/.next"
```

`outputDirectory` had been removed from `vercel.json` hours earlier, and the
deployment was well past that commit. The value was coming from the Vercel
project's own **Output Directory** field, which is an independent source for the
same setting — and removing the key from `vercel.json` is what let it through.
A declared key overrides the dashboard; an absent one yields to it. Omitting it
does not assert the default, which is what "the framework preset will find
`.next` anyway" assumed.

**`vercel.json` now says `"outputDirectory": ".next"`** — correct relative to a
Root Directory of `apps/web`, and stated so the file wins over whatever the
dashboard holds. That is the point of keeping this configuration in the
repository at all: a setting nobody can read in a diff is a setting that drifts.
`docs/deploying.md` now says to check the dashboard field is empty, and
`docs/troubleshooting.md` carries the error text with the distinction between
the two sources.

### 2026-09-07 — A role from Neon's Roles UI cannot be the role that serves requests

Following the advice added earlier the same day — create the role in the console
if the build cannot — produced a role holding `BYPASSRLS`, and the migration
refused it:

```
Error: Role "mis_app" holds BYPASSRLS, and it could not be revoked.
permission denied to alter role
```

Which is the check doing its job. `BYPASSRLS` on the role that serves every
request makes every policy in `020-rls.sql` decorative, and only a superuser can
revoke it — nobody is one on Neon, so it cannot be fixed after the fact. The
advice was wrong, not the refusal: **Neon's Roles UI is the wrong way to create
this role**, and a bare `CREATE ROLE` in its SQL editor is the right one, where
the attribute defaults are all off.

Both messages now say so, and say what to do about a role that already has it:
point `DATABASE_APP_URL` at a fresh role under a new name, since the migration
grants whatever name it is given and a new name avoids having to clear the old
one's grants before dropping it. `NOBYPASSRLS` is deliberately not suggested as
a fix — writing it requires superuser too, so spelling out the safe thing is
itself rejected.

Reproduced locally against a non-superuser owner and a role created with
`BYPASSRLS`, which fails identically, and the recommended recovery verified
through: a bare `CREATE ROLE` issued *by that non-superuser owner* yields all
four attributes off, the migration then completes, and the role connects seeing
no rows without an RLS context — which is what RLS applying looks like.

### 2026-09-07 — Neon refused to create the application role, twice over

The schema migrated cleanly against Neon and then stopped on the statement that
creates the role the application connects as:

```
code: 'XX000', file: 'ddl_forwarding.c', routine: 'SendDeltasToControlPlane'
    at ensureAppRole (packages/db/src/migrate.ts:191)
```

Neon does not handle `CREATE ROLE` in Postgres alone — it forwards the change to
its own control plane so the console stays in step — and a refusal there names
neither the role nor the reason. Ordinary schema DDL crosses the same pooled
connection without complaint, which is what makes it confusing: every migration
applies, and then one statement does not.

**Role changes are now retried on a direct connection**, derived from Neon's
`-pooler` convention by `unpooledConnection`, with `DATABASE_DIRECT_URL` as the
explicit form for a provider whose pooled hostname cannot be rewritten.
Supabase's shape is deliberately not guessed at: it moves the port and sometimes
the username, so a derived URL would point confidently at nothing.

**And if the role still cannot be created, the error now says what to do**
instead of printing a driver stack: create it in the provider's console with the
password already in `DATABASE_APP_URL`, give it no attributes, deploy again. The
migration grants it what it needs and stops trying to create it once it exists.

**A second failure was waiting immediately behind the first.** `ensureAppRole`
restated `ALTER ROLE ... NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` on
every run, and only a superuser may issue that — which nobody is on a managed
provider. The statement whose entire purpose was to guarantee the tenant
boundary was itself what stopped the deployment, on a role that already held
none of those attributes. It is now verified and only altered when something
differs, so the ordinary path issues no role DDL at all; `CREATE ROLE` leaves
all four off to begin with.

Verified against a non-superuser owner role built to stand in for
`neondb_owner`, which is how both failures were reproduced locally:

| | |
|---|---|
| fresh database, role absent | created, all four attributes off |
| re-run, role already correct | no role DDL issued |
| role holds `BYPASSRLS`, owner can revoke | revoked, migration continues |
| role holds `BYPASSRLS`, owner cannot revoke | **refuses to migrate**, before the policies are applied |
| owner cannot create roles | actionable error naming the console route |
| role created by hand, owner cannot alter it | warns about the password it could not set, completes, and the role connects with RLS applying |

The refusal is the point of the rewrite rather than a side effect: `SUPERUSER`
or `BYPASSRLS` on the role that serves requests makes every policy in
`020-rls.sql` decorative, so a deployment that cannot clear them should not
proceed. `CREATEDB` and `CREATEROLE` are untidy rather than dangerous and only
warn.

### 2026-09-07 — The build's own error message pointed at a file that cannot exist

A first deploy stopped on `DATABASE_APP_URL is not set.`, and the advice
underneath it was `cp .env.example .env` — a shell command, about a file, in a
build log on a platform with neither. The message was written for a fresh clone
and was read most often somewhere it made no sense.

It now branches on `VERCEL` / `CI` and, in a build, says to set the variable in
the platform's environment and deploy again, naming the two ways it goes missing
after you think you have set it: a variable scoped only to production is absent
from a preview build, and a build reads the environment once, so retrying an
existing build will never pick it up.

`DATABASE_APP_URL` also gets a paragraph the other variables do not, because it
is the one nobody expects. Every managed provider hands out a single connection
string, so the natural response to the error is to reuse `DATABASE_URL` — and
that role owns the tables, so it bypasses its own row-level security. The
policies are the whole of the tenant boundary, which makes the failure mode
silent: requests would isolate nothing and nothing would fail while they didn't.
The message now says so, shows the shape of the URL to set, and notes the role
does not need to exist first. The role name in it comes from `appRoleName()` —
the new guard in `app-role.test.ts` refuses a literal, which is exactly the
outcome it was added for.

### 2026-09-07 — A managed Postgres could not be migrated without a SQL console

Found while setting up Neon. `ltree`, `pg_trgm` and `pgcrypto` were created only
by `infra/postgres-init/01-extensions.sql`, which Docker runs once on container
boot. Nothing mounts an init directory on Neon, Supabase or RDS, so the first
migration died on the first statement:

```
PostgresError: type "ltree" does not exist
```

Local development had always worked, which is what kept it hidden. The error
names a missing type rather than a missing step, and the fix was to find a SQL
console and paste three lines that were already in the repository — for a
project whose deployment story is explicitly that an NGO never needs a shell.

**`packages/db/sql/000-extensions.sql` now creates them**, applied by
`migrate.ts` before the schema migrations rather than after, because migration
0000 declares an `ltree` column and a trigram index and so cannot run without
them. That ordering is the whole fix: in the ordinary position the file would
apply cleanly and change nothing, the migration having already failed. All three
are trusted extensions, so the owner role installs them without being
superuser, which is what makes this work where nobody is. The Docker init hook
and its mount are gone — one definition, and the one that runs everywhere.

Verified against a database created empty: `plpgsql` only, 28 tables after,
every one of them with RLS. With the file reduced to a no-op it fails exactly as
a managed Postgres used to.

**`/api/health` also stopped inventing the role name.** It asked `pg_roles` for
a literal `'mis_app'` while `migrate.ts` creates whatever `DATABASE_APP_URL`
names, so a deployment that chose any other username was reported `degraded`
with `appRolePresent: false` — a 503 — on a database that was entirely healthy.
It now calls `appRoleName()`, which has been the single definition since the
grants file stopped hardcoding it; the health check was simply missed. The
guard in `app-role.test.ts` only ever scanned `sql/`, and now scans the
TypeScript under `apps/web/src` and `packages/db/src` too. SQL in a template
literal is still SQL.

### 2026-09-07 — Vercel deploy failed twice on the same disagreement

Reported from a deployment attempt:

```
Error: The Next.js output directory "apps/web/.next" was not found at
"/vercel/path0/apps/web/apps/web/.next"
```

`apps/web` appears twice because both halves of the configuration were applied:
Root Directory set to `apps/web` in the Vercel project, and
`outputDirectory: "apps/web/.next"` from `vercel.json`, which Vercel resolves
relative to Root Directory rather than to the repository. Nothing in the repo
was broken, and the error names a path rather than a setting, so it reads as a
missing build output.

The first fix went the wrong way — it standardised on Root Directory at the
repository root and deleted the now-unused `vercel-build` from
`apps/web/package.json`. The setting was never changed, so the next deploy
found the script gone:

```
npm error Missing script: "vercel-build"
npm error location /vercel/path0/apps/web
```

That second failure is also what settled the question. Reaching a build script
at all means the install had already succeeded from `apps/web`, so the two
objections raised against that mode — that `npm install` there could not resolve
the `@sangraha/*` workspace links, and that `tsx` would be missing because it
belongs to `packages/db` — are both wrong on Vercel, which installs from the
workspace root and hoists.

**So `apps/web` stands, as originally documented, and `vercel.json` gives up
`outputDirectory`** — the framework preset finds `.next` under Root Directory
without being told. The script in `apps/web/package.json` is restored. The two
modes each need their own `vercel.json`, which is the part that was never
written down; `docs/deploying.md` now states both and the error each one gives
when the setting and the file disagree.

### 2026-09-06 — A record sent back could not be corrected

Reported from use: open a rejected record under **What I have sent** and it is
read-only, with no way to fix anything. The supervisor's reason was shown and
nothing could act on it.

The only route open to a worker was to capture the whole visit again from the
home screen — which is worse than a dead end. It leaves the rejected record
rejected for ever and files a **second record for one encounter**: the visit
counted twice in analytics, and on a registration form, the same person entered
in the registry twice. So the one path that appeared to work was the one that
quietly corrupted the data.

**Corrections now rewrite the record in place.** *Correct and send again* on a
rejected record opens the ordinary capture UI, seeded with the answers that were
already sent, so the worker fixes the digit that was wrong instead of re-keying
forty answers — re-keying being itself how a correction introduces a fresh error
into an answer that was right. Sending puts the record back to `submitted` and
into the review queue.

The pieces this needed were mostly already there, which is the tell that it was
an omission rather than a decision: `submissions_isolation` says in its own
comment that a field worker may reach their own records because "they correct
their own mistakes", `findDuplicateAnswers` already took an
`excludeSubmissionId` described as "the submission being edited", and
`revision_change_type` already had an `updated` member that nothing wrote.

Details worth knowing:

- **The review fields are cleared.** A stale note would show the next supervisor
  a complaint about answers that are no longer there. The note is not lost — it
  is on the `status_changed` revision that recorded the rejection, which is
  where an audit reads it from.
- **`status = 'rejected'` is the whole concurrency story.** It makes a retry-queue
  replay a no-op rather than a second application, and it holds because
  `reviewSubmission` only ever acts on a `submitted` record.
- **No consent step and no duplicate check on a correction.** Permission was
  recorded when the visit happened; asking again would append a second
  attestation for one act, dated to the day of the typo. And "have you already
  registered this person?" has the obvious answer — this record registered them.
- **The correction rides the existing retry queue**, so it works offline like
  any other send. A worker fixing an answer is on exactly the connection the
  queue exists for.
- **Answered against the version the record was captured under**, not whatever
  is published now, so a form edited in between cannot silently re-key the
  answers.

`correction.test.ts` covers it: that one record stays one record, that the
rejection survives in the history, that a supervisor can review the result, that
another worker and another tenant both get `not_found`, and that a replay
changes nothing. The `rejected` guard was removed to confirm three of them fail
without it.

`verify-e2e.ts` covers the route, because that is where the interesting mistake
lives: a correction shares an endpoint with a first send and is told apart only
by `correctsSubmissionId`, so a dispatch error would send a rewrite down the
insert path and file a second record — invisible to a query-level test, which
never crosses the handler. Removing the dispatch makes six of the seven checks
fail, the first send returning `201` with a fresh id. The "did not file a second
record" check had to be rewritten to catch it: keyed on the original's
`clientUuid` it passed even against the broken build, because the fall-through
insert files its row under the *correction's* id.

### 2026-09-06 — "Sign out of this phone?" assumed the device

It is used on tablets and laptops too. Now "Sign out of this device?", in all
three UI languages. Three other strings still say phone — `gpsDenied`,
`attachmentQueued` and `consentNoticeMismatch` — and are left alone for now.

### 2026-09-06 — Form audiences, built around who approves

Every signed-in user of an organisation could use every published form.
`forms_isolation` was tenant-only and the home screen filtered on nothing but
`org_id` and `is_active`, so an NGO running two programmes put both in front of
everyone. Forms now carry an audience.

**Three options, each carrying its own approver:**

| | Who can use it | Who approves |
|---|---|---|
| Everyone in the organisation *(default)* | every signed-in user | supervisors |
| Supervisors, plus chosen field workers | every supervisor, plus those named | supervisors |
| Organisation admins, plus chosen people | admins, plus those named | admins only |

The first cut of this offered "all field workers" and "all supervisors" as flat
audiences, which was wrong in a way worth recording. `can_use_form` governs
capture *and* approval, so "all field workers" silently meant **and no supervisor
may approve** — a consequence unguessable enough that the builder screen carried
a paragraph explaining where the records would go instead, plus a publish blocker
for an audience with nobody in it, plus a publish warning about the same thing.
Three guardrails around one bad state.

Composing each option around an approval tier makes that state unrepresentable,
and **all three guardrails were deleted rather than reworded.** A setting needing
that much explanatory copy is usually a modelling error, not a documentation gap.

Two things fell out that the first model could not do:

- **The role part cannot go stale.** A supervisor or admin who joins next month
  is in the tier already. Only the individually named people are hand-kept, and
  those are the ones whose membership really is per-form.
- **A supervisors-only form** — "supervisors, nobody added" — which had no
  expression at all before.

**Enforced in the policies, not the screens.** `POST /api/submissions` takes a
`formVersionId` straight from the device, so gating the list screens would have
left the door open to anyone willing to type a uuid. The rule is
`app.can_use_form`, called from `submissions_isolation` and a RESTRICTIVE insert
policy, and the four screens that list forms call the *same* function rather than
re-deriving it. Putting it there also meant the queue, the bell and bulk approve
inherited it at once: `countAwaitingReview` takes no options, so a query-level
fix would have left the bell over-counting the list it labels.

Deliberately **not** on `forms_isolation`, which was the obvious place and the
wrong one — the queue and the timeline join that table only to resolve a form's
name, so restricting reads would have blanked the name on a worker's own past
record. Access decides what you may start and review, not what you may remember.

**`POST /api/attachments` was also minting upload URLs with no audience check.**
The submission that followed was refused, so no record appeared — and the bytes
were already in the bucket, an organisation paying to store photographs nothing
would ever account for. RLS cannot reach it, because minting a presigned PUT
inserts nothing into a policy-protected table, so the check is explicit in the
route.

What narrowing does not take away: a worker keeps their own history and can still
finish correcting a record already sent back on a form they have been moved off.
That is why the audience policy is `FOR INSERT` rather than a blanket WITH CHECK.

`form-access.test.ts` covers it in 20 cases through the real `mis_app`
connection, under the query helpers so only the policy can make them pass —
including the invariant the redesign exists for (every option has an approver),
supervisors being wholly excluded from an admins form, and the placeless-form
case locations cannot reach at all. Both halves of the predicate were
mutation-checked. So was the attachments guard, and the first version of that
check was **passing for the wrong reason**: the demo org has no attachment field,
so a made-up field key returned `unknown_field` whether the audience was checked
or not. It now asserts the specific error code and fails when the guard is
removed.

### 2026-09-06 — Whose installation is this, and where did our mark go

Two reports about the header, pulling in opposite directions.

**An organisation's logo now says whose it is on hover.** A logo is a picture of
a name, and a reader who does not recognise it had no way to ask. `alt` was
already set, which serves a screen reader and a broken image, but browsers
stopped surfacing `alt` as a tooltip long ago — so a sighted person hovering got
nothing. `OrgBrand` now sets `title` as well. It matters most where it is least
obvious: somebody supporting several NGOs, or looking at a screenshot, who
cannot tell which installation they are in.

**The Sangraha co-brand was not understated, it was unreadable.** Reported as
"not very visible", and measurement agreed: `text-slate-400` on a white header
is **2.56:1**, under the 4.5:1 WCAG AA wants for text and under even the 3:1
floor for a UI element. On a sunlit phone it was simply absent.

Fixed with colour, not size — which is the distinction that matters, because the
obvious response to "make it more visible" is to enlarge it, and that is the one
thing the co-brand must not do. The mark now carries the product accent
(`brand-600`, 6.89:1) and the word sits in `slate-600` (7.58:1), at the same
18px, in the same centred position. Nothing grew and nothing moved; the
organisation's logo still leads on the left.

`palette.test.ts` gained a contrast check pinned to those two colours. It is the
same failure this file already guarded against, one step further on: the class
was valid, the shade existed, the CSS was emitted, and the result was still
unreadable. Only a number catches that. Verified to fail against the shade it
replaced.

### 2026-09-06 — `/start` was being frozen into the build

`npm run build` failed with `ECONNREFUSED` while prerendering `/start`. The
immediate cause was a Postgres that was not running, but the reason a build
touched Postgres at all was the defect.

Every other page is dynamic by accident — it reads `cookies()` for the session,
or awaits `searchParams`. `/start` needs neither, so Next statically prerendered
it, and `signupAvailability()` ran at build time. Two consequences:

- **The build acquired a database dependency it should not have.** No database
  reachable, no build — which is also what a preview deployment with no
  `DATABASE_URL` looks like.
- **The bootstrap door appeared not to shut.** `/start` asks whether an
  organisation exists yet, and that answer changes the moment the page is used.
  Frozen into HTML, it went on serving "Set up your organisation" to everyone
  arriving after the first administrator. `createOrganisation` re-checks
  availability, so nobody actually got in — they were shown an invitation the
  system then refused.

Fixed with `export const dynamic = 'force-dynamic'` on the page. `npm run build`
now completes with no database running at all, and `/start` is listed as
dynamic rather than static.

### 2026-09-06 — The README became a README, and the project got a licence

The README had grown to 2,468 lines — half of it this changelog — and a new
reader had no way to tell what Sangraha was from what had gone wrong with it in
August. Split into a scannable front page plus `docs/`:

- **`docs/`** now holds the long guides, unchanged in substance:
  [`data.md`](./docs/data.md), [`forms.md`](./docs/forms.md),
  [`organisations.md`](./docs/organisations.md),
  [`deploying.md`](./docs/deploying.md), [`dpdp.md`](./docs/dpdp.md),
  [`architecture.md`](./docs/architecture.md) and
  [`troubleshooting.md`](./docs/troubleshooting.md).
- **This file** was extracted from the README. Entries from 2026-08-30 onwards
  are kept in full; everything earlier is condensed to a line.
- **`LICENSE`** — the project is now **GNU AGPL v3**. Every `package.json`
  carries `"license": "AGPL-3.0-only"`. Sangraha is meant to be self-hosted by
  the organisations that use it, and an improvement made by one NGO should reach
  the next one; running a modified version as a service obliges you to offer its
  source.
- **`CONTRIBUTING.md`** — setup, what to run before a PR, the invariants, the
  migration two-stage rule, and how to report a defect. Security reports and
  anything touching personal data go to email, not a public issue.

Three things were corrected rather than moved:

- **The "attachments are schema-only" disclosure was false.** It claimed photo,
  file and signature were schema-only, that there was no S3 client anywhere, and
  that `deleteOrganisation` never touched storage. All three had been untrue
  since 7 Aug, and the last since this morning. It now states the limit that
  does remain: nothing sweeps orphaned attachments.
- **Three different test counts** — 545, 551 and 382 — were quoted in three
  places. None survive; a number nobody re-runs is a number that drifts.
- **`npm run lint` and `npm run format` do not work.** There is no ESLint flat
  config in the repo and `.prettierrc.json` names an uninstalled Tailwind
  plugin. Both are now documented as known gaps instead of being listed as if
  they ran.

Also: the two identical `### Built` headings under DPDP produced colliding
anchors and are now named; the People/Places/Settings reference was orphaned
under "Your organisation's logo" with no heading of its own, and has one.

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

---

## Earlier — condensed

Each line below was a full entry before this file was split out of the README.
Where a fix has a standing consequence, it is recorded in
[`issues.md`](./issues.md) or in [`CLAUDE.md`](./CLAUDE.md) instead.

### 2026-08-11

- **The agree button existed all along and could not be seen.** An undefined
  Tailwind shade (`bg-affirm-600`) rendered a button-sized blank gap. Forty more
  undefined shades were found; the palette is now complete 50–900 with checked
  WCAG ratios, guarded by `palette.test.ts` and `verify:ui`.
- **The review screen shows the permission, not just the answers.** Every consent
  and guardian column was being written and none read back, so a supervisor
  could not tell a child was involved. `/review/[id]` gained a Permission block,
  and a supervisor can resolve a guardian gap from it.
- **The consent decision is within thumb reach.** Both answers sat ~1100px below
  the fold on a 390×844 phone. Sticky footer, equal-weight buttons, and the
  subject named in the question. `verify:ui` now checks at phone size.
- **"Write it from my forms" visibly does something.** The notice was written
  every time; a `useState` initialiser that never re-synced hid the result.

### 2026-08-10

- **The notice editor is a numbered flow, and Publish explains itself.** A
  disabled Publish button with no stated reason, purposes that did not look
  selectable, and no way to discard a draft.
- **Privacy says what is actually happening.** `/admin/privacy` now leads with
  whether anyone is being asked for consent. "Draft it for me" became "Write it
  from my forms" — `composeNotice` is offline and deterministic, not an AI call.
- **Development opens four connections, not ten.** Every Next process opens two
  pools, so ten each exhausted Postgres as soon as a second dev server started.
  Defaults are now 1 serverless, 4 development, 10 production; `DATABASE_POOL_MAX`
  overrides.
- **The stale-chunk failure is caught, and scripts are typechecked.**
  `verify:ui` signs in for real and watches for `/_next/` 404s;
  `tsconfig.scripts.json` brought `scripts/` under `npm run typecheck`, which
  immediately found a latent crash in `free-connections.ts`.

### 2026-08-08

- **A browser in the loop, and one build directory per server.** Two dev servers
  writing the same `apps/web/.next` corrupted each other's chunks — the page
  rendered and nothing responded to a click. `npm run dev:alt` gives a second
  server its own dist directory; `npm run verify:ui` was introduced because
  `npm test` contains no browser and never has.

### 2026-08-07

- **The setup guide became a standing configuration index.** Completed steps
  keep their links and show counts, so an organisation adding its second
  programme can still find where purposes live.
- **Nothing silently collects without asking.** A new organisation could work
  through the whole setup, register a child, and never be asked for consent,
  with nothing anywhere saying so. Two required setup steps and publish-time
  warnings now say it. The dev Postgres also gained `idle_session_timeout`.
- **Photo, file, signature, GPS and repeating sections** became answerable on a
  phone — `DEFERRED_FIELD_TYPES` empty for the first time. Object storage wired
  up (`objects.ts`, hand-rolled SigV4, no AWS SDK), presigned PUT, IndexedDB
  placeholders offline, and erasure reaching storage.
- **Languages before the first form.** Moved to setup step 2, because nothing is
  backfilled if it is chosen after the questions are written.
- **DPDP: consent, notices, the access log and erasure.** Purposes and lawful
  bases, generated notices frozen on publish, an append-only consent event log,
  children and guardian gaps, the access log, and erasure with pseudonymisation
  and legal holds. Migrations 0007–0012.
- **DPDP groundwork: legal identity, and an audit trail that holds.** Legal
  identity fields, `data_region`, append-only revisions enforced by grant *and*
  trigger, `deleteOrganisation` as a single transaction. Migration 0006.
- **Records reads like your data, not like a database.** Answers before
  plumbing, ids resolved to names, pagination, a full-record screen, and
  `<key>_name` columns in CSV.

### 2026-08-06

- **Bring in a spreadsheet.** CSV, Excel or a Google Sheets link becomes a form
  plus its records, including answer lists inferred from fixed-choice columns.
- **Answer formats, and what Answer lists are for.** "What kind of text?" with
  Email, Web address, PAN, Aadhaar, Pincode, IFSC or an admin-written mask —
  masks rather than regex, because a bad regex hangs and cannot be read.
  `npm run db:free` added.
- **Sangraha co-brands in the header** — centred, small, grey, not a link. The
  organisation's logo keeps the leading position.
- **Reordering and removing questions from the list**, with per-row controls
  instead of select-then-move-then-select-again.
- **The admin console navigation** split into the daily three plus a Setup menu.
- **The home screen is about forms now**; everything else moved behind the name
  menu, with the review count on a bell.
- **Unique answers, and a date-and-time field that never worked.** The datetime
  field demanded a timezone the browser never sends. Needed `db:migrate` and
  `db:views`.
- **Signup could half-create an organisation.** Provisioning was not
  transactional, so a rejected PIN left an organisation with no administrator.
- **Saying why the Translate button is missing** rather than just not rendering it.
- **Bulk approve in the review queue**, enforcing the same rules as one-by-one.
- **A name is not enough to choose a person by** — pickers now show a
  distinguishing answer.
- **The duplicate screen said what it wanted, not what it did.** Cards, an
  explicit "Yes, this is them", a confirmation, and cross-location privacy
  enforced in SQL rather than in the UI.
- **Three defects found by using it**: a one-admin NGO could not approve
  anything; a registration form with no subject type published anyway; questions
  named after creation produced `untitled_question` keys.
- **The registry, and reading your own data** — registration vs encounter forms,
  trigram duplicate detection, the Records screen and CSV export, two new views.
- **Ready to deploy on Vercel.** Pooling detection, signup closed by default with
  a first-organisation bootstrap exemption, build-time migrations under an
  advisory lock, `/api/health`, `vercel.json`.
- **Service account credentials supported** for translation, including base64
  JSON for hosts with no filesystem.
- **Translation verified end to end.** Translating into two languages had dropped
  the first; HTML escaping and a stale 401 token were also fixed.
- **Untranslated questions no longer render blank.** The builder stored `''` for
  every language an admin tabbed past and the resolver used `??`, which only
  catches `undefined`. `localise()` is now the only definition, and blanks are
  pruned on the way in.

### 2026-08-05

- **Logo upload fixed for real-world files.** Next.js rejects an oversized
  server-action body before any validation runs, so an ordinary logo produced a
  stack trace. Images are resized in the browser first; SVGs are rasterised,
  which also removes a stored-XSS path.
- **Named Sangraha, org branding.** The npm scope became `@sangraha/*` while
  infrastructure ids stayed `mis*`; `organisation_branding` and the logo route
  landed; `npm run build` moved to `.next-build`.
- **Onboarding and translation** — `/start`, `/admin/setup`, and machine
  translation writing `label_machine` / `help_machine` with English always first.
- **Admin console, answer lists, org provisioning** — `/admin/lists`,
  `/admin/users|places|settings`, `token_version` for sign-out everywhere, and
  the `org:create` / `org:delete` scripts.
- **Sign-out, and two status bugs**, including the Drizzle correlated-subquery
  identifier bug that made every form report as unpublished with zero responses.
- **Data views and form builder** — the generated analytics views and the
  split-screen builder with its publish guardrails.
- **Languages and login** — the organisation dropdown, `loadRootEnv()`, a
  re-runnable seed, `test-*` org sweeping, and per-organisation analytics schemas.

### Phase 0 — initial build

Monorepo, Postgres schema (17 tables), RLS, form engine (19 field types),
username + PIN auth, analytics view generation, field capture UI.
