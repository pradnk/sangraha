# Contributing to Sangraha

Thank you for considering it. Sangraha is used by organisations working with
children and other vulnerable people, so a bug here is rarely just a bug — it
can be a record that vanishes, a name that leaks across a tenant boundary, or a
question a worker is shown with no words in it. That shapes most of what
follows.

By contributing you agree that your contribution is licensed under the
[GNU AGPL v3](./LICENSE), the same licence as the project.

---

## Getting set up

You need **Node 20+** and **Docker**.

```bash
git clone https://github.com/pradnk/sangraha.git
cd sangraha
npm install
cp .env.example .env          # then set AUTH_SECRET: openssl rand -base64 32
npm run infra:up              # Postgres + MinIO
npm run db:migrate
npm run db:seed
npm run dev                   # http://localhost:3000
```

Demo logins are in the [README](./README.md#demo-logins). If anything misbehaves,
[docs/troubleshooting.md](./docs/troubleshooting.md) lists the symptoms we have
actually hit and what caused them — it will usually save you an hour.

**Never start a second Next process against `apps/web/.next`.** Every one of
them writes that directory. A second `next dev` — or a `next build` while
someone's dev server is running — corrupts its chunks. The `build` failure is
loud; the `dev` one is not: the browser gets server HTML from one process and
client JavaScript from the other, hydration fails, and the page renders
perfectly while nothing on it responds to a click. Both read as a code bug and
neither is one. Use `npm run dev:alt`, which sets `NEXT_DIST_DIR`.

---

## Before you open a pull request

```bash
npm run typecheck    # all packages, plus scripts/
npm test             # vitest
npm run verify http://localhost:3000    # end-to-end, needs a running server
npm run verify:ui                       # the same, in a real browser
```

Integration suites skip themselves when `DATABASE_URL` is unset, so `npm test`
passes without Docker — but then it has not tested RLS or the analytics views.
Run it with `npm run infra:up` before claiming a change is green.

`npm test` contains no browser. `npm run verify:ui` drives the Chrome already on
your machine over the DevTools Protocol — no extra dependency, no browser
download — and asserts the things an HTTP request cannot see: the account menu
opens, the capture flow advances, the console is clean. Skip it if you have no
Chrome, and say so in the PR.

**`npm run lint` and `npm run format` are currently broken** and fixing them is
a welcome first contribution. `lint` fails because there is no ESLint flat
config (`eslint.config.js`) anywhere in the repo; `format` fails because
`.prettierrc.json` declares `prettier-plugin-tailwindcss`, which is not in any
`package.json`. Until then, match the surrounding code: 2-space indent, single
quotes, semicolons, trailing commas, 100-column lines.

### What a good pull request looks like

- **One concern per PR.** A defect fix and a refactor in the same diff are hard
  to review and harder to revert.
- **A regression test that fails against the code you replaced.** For a defect
  fix this is not optional. Verify that it actually fails before your change —
  a test that passes both ways proves nothing. Where a fix cannot be reached
  from `npm test` (a transaction boundary, a check inside a route handler), the
  test belongs in `scripts/verify-e2e.ts`.
- **A README or docs update in the same commit**, if you changed anything about
  logins, ports, commands, environment variables, or what is and is not built.
  A README that has drifted is worse than none: someone will follow it and lose
  an hour.
- **A [CHANGELOG](./CHANGELOG.md) entry** for anything that changes how the
  system is run, logged into, or configured. Newest first. Say what was wrong,
  not only what you did.
- **Comments that explain *why*.** Especially where a decision protects a field
  worker or a tenant boundary. Do not narrate what the code plainly does.

---

## Invariants

These are the things that are easy to violate by accident and expensive to
discover later. Most of them shipped as a bug once.

**Field types are defined once.** A new type is one module in
`packages/form-engine/src/field-types/` plus two lines in that folder's
`index.ts`. If your change requires touching a type in a second place, the
design has drifted. The React renderer is the one exception — it lives in
`apps/web` to keep the engine framework-free — and `coverage.test.ts` guards it.

**`form_fields.key` and `options.code` are immutable.** They name analytics
columns, API properties and CSV headers. Labels are free to change and be
translated. Never derive a stored identifier from a label.

**Never serve a request on the owner connection.** `getOwnerDb()` bypasses RLS
and is for migrations, seeding and analytics DDL only. Request code goes through
`withContext()` / `withSession()`, which set the RLS context with `SET LOCAL`, so
a pooled connection cannot leak one tenant into the next request.

**Analytics casts must not raise.** Use `analytics.try_*` (via `safeCast` in the
field-type helpers), never a bare `::type`. One unparseable value must not take
down a whole view.

**Published form versions are immutable.** Editing creates a new version.
Submissions point at the version they were captured under, which is what keeps
old answers interpretable.

**Never interpolate a column into a correlated subquery.** Drizzle renders
`${forms.id}` as bare `"id"`, not `"forms"."id"`. Inside a subquery over a table
that also has that column it binds to the inner table and the correlation
silently matches nothing — no error, just wrong numbers. Use a joined aggregate
or `aliasedTable`. This shipped once, and the regression test lives in
`form-builder.test.ts`.

**Resolve translatable text with `localise()`, never with `??`.** A stored `''`
is not `undefined`, so a `??` chain returns the empty string and a worker is
shown a question with no words in it. That shipped once. `localise()` in
`packages/form-engine/src/i18n.ts` is the only definition; `pruneBlank()` keeps
blanks out of the database on the way in.

**Shrink uploads in the browser, do not just reject them.** Next.js rejects an
oversized server-action body before your handler runs, so the framework error is
what the user sees. `prepareLogo` in `apps/web/src/lib/image.ts` is the pattern:
decode, resize, re-encode, then send. Server-side limits stay as the boundary —
the client is a convenience, never the check.

**The organisation's brand leads, not ours.** Inside a live organisation every
header shows their logo or their name via `OrgBrand`, in the leading position on
the left. `SangrahaCoBrand` sits centred at 18px and is not a link — the only
place our mark appears inside a live organisation. The full `SangrahaLogo`
belongs only to signup, sign-in and anywhere no organisation is resolvable. If a
change would make our mark larger, louder or earlier than the NGO's, it is the
wrong change.

**Quiet is size and position, never contrast.** That co-brand shipped as
`slate-400` on white — 2.56:1, below even the 3:1 floor for a UI element — and
was reported as invisible rather than subtle. Colour fixed it where size would
have broken the rule above. Anything a user must read meets 4.5:1, and
`palette.test.ts` holds the two co-brand colours to it.

---

## Migrations

Two stages, deliberately different:

- `packages/db/migrations/` — Drizzle-generated, incremental, run once. Generate
  with `npm run db:generate` after changing the schema.
- `packages/db/sql/` — hand-written, idempotent, **re-applied on every migrate**.
  RLS policies, grants and helper functions. Whole files are easier to review
  than a chain of diffs, and re-applying means a policy cannot drift. Ordering
  matters: functions (010) → immutability (015) → policies (020) → grants (030).

Adding a NOT NULL column to a populated table needs a default or a backfill —
the generator will not do this for you.

If you change the analytics view generator, run `npm run db:views` to rebuild
every view, and say so in the changelog entry — deployers need to run it too.

---

## Configuration

One `.env` at the repo root, for everything. Each entry point calls
`loadRootEnv()` from `load-env.mjs` — `next.config.ts`, `drizzle.config.ts`,
`migrate.ts`, `seed.ts`, `vitest.setup.ts` and the scripts. Real environment
variables always win, so Docker and CI are unaffected and there is no file to
mount.

**Any new entry point must call it too.** Next only reads a `.env` beside its own
`package.json`, vitest reads none, and `tsx` reads none — so a script that skips
this fails with `DATABASE_URL is not set` no matter how correct the `.env` is.
Do not reach for `--env-file` instead; it is cwd-dependent and silently makes
`npm run <script>` behave differently from running the file by hand.

Document any new variable in `.env.example`, with a comment saying what happens
if it is absent.

---

## Conventions

- Imports between workspace packages use `@sangraha/*`. Relative imports have no
  file extension — bundler resolution; `.js` specifiers break drizzle-kit.
- Two design systems: default Tailwind scales for admin, `text-field-*` and
  `min-h-tap` for the field UI. Do not mix them.
- Product strings live in `apps/web/src/lib/messages.ts`, in the three shipped
  UI languages (`UI_LOCALES`: English, Hindi, Kannada). **Add a string to all
  three or `messages.test.ts` fails** — the `m()` fallback hides a missing
  translation behind English, which defeats the point.
- Organisation-authored labels are JSONB, resolved with `t()`, and may use any
  language in `LANGUAGE_NAMES`.
- Field UI copy is short and plain. The reader may be reading slowly, outdoors,
  in a hurry.

---

## Reporting a defect

Open an issue with a location, a concrete failure, and a priority. The tiers in
use, from [`issues.md`](./issues.md):

- **P1** — somebody is harmed or a boundary is crossed, *and the system reports
  success while it happens*.
- **P2** — the system is silently wrong: a rule that does not fire, a number
  that is not what it says.
- **P3** — worth doing, hurts nobody today.

The failure mode worth naming loudest is the silent one. Most of the worst
defects found so far looked fine from the outside: the screen said saved, the
counter said nothing was waiting, the button said done.

### Security and personal data

Please do **not** open a public issue for a vulnerability that could expose
personal data or cross a tenant boundary. Email
[pradnk@gmail.com](mailto:pradnk@gmail.com) instead, with enough detail to
reproduce it, and allow time for a fix before disclosing.

Never attach real beneficiary data to an issue, a pull request, or a test
fixture. Use the demo organisation (`npm run db:seed`), which is entirely
synthetic.
