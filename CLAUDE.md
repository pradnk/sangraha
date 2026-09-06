# Working in Sangraha

Sangraha (संग्रह, "collection") — configurable data collection for the social
sector. Read `README.md` first — it is the operational
reference (logins, ports, commands, what is and is not built). This file covers
the conventions that are easy to violate by accident.

**Update `README.md` in the same change.** It is what everyone else reads to run
the project, so anything that alters logins, ports, commands, environment
variables, or the built/not-built status in §1 belongs there immediately, plus a
line in the Changelog. A README that has drifted is worse than none: someone
will follow it and lose an hour.

## Commands

```bash
npm run infra:up            # Postgres + MinIO (required for integration tests)
npm run db:migrate          # schema migrations, then the idempotent sql/ layer
npm run db:seed             # rebuild the demo organisation
npm run dev                 # Next.js
npm run dev:alt             # a SECOND dev server, on :3100 with its own build dir
npm run typecheck           # all packages
npm test                    # vitest
npx tsx scripts/verify-e2e.ts http://localhost:3000
npm run verify:ui                       # the same, in a real browser
npx tsx scripts/dev-session.ts sunita   # session cookie for curl
```

Integration suites skip themselves when `DATABASE_URL` is unset, so `npm test`
works without Docker — but then it is not testing RLS or the views.

**Never start a second Next process against `.next`.** Every one of them writes
that directory, so a second `next dev` — or a `next build` — while someone's dev
server is running corrupts its chunks. The `build` failure is loud
(MODULE_NOT_FOUND everywhere); the `dev` one is not. The browser gets server HTML
from one process and client JavaScript from the other, hydration fails, and the
page renders perfectly while nothing on it responds to a click. Both read as a
code bug and neither is one. Use `npm run dev:alt`, which sets `NEXT_DIST_DIR`.

## Invariants

**Field types are defined once.** A new type is one module in
`packages/form-engine/src/field-types/` plus two lines in that folder's
`index.ts`. If a change requires touching a type in a second place, the design
has drifted. The React renderer is the one exception (it lives in `apps/web`, to
keep the engine framework-free) and `coverage.test.ts` guards it.

**`form_fields.key` and `options.code` are immutable.** They name analytics
columns, API properties and CSV headers. Labels are free to change and be
translated. Never derive a stored identifier from a label.

**Never serve a request on the owner connection.** `getOwnerDb()` bypasses RLS
and is for migrations, seeding and analytics DDL only. Request code goes through
`withContext()` / `withSession()`, which set the RLS context with `SET LOCAL`.

**Analytics casts must not raise.** Use `analytics.try_*` (via `safeCast` in the
field-type helpers), never a bare `::type`. One unparseable value must not take
down a whole view.

**Published form versions are immutable.** Editing creates a new version.
Submissions point at the version they were captured under, which is what keeps
old answers interpretable.

**Never interpolate a column into a correlated subquery.** Drizzle renders
`${forms.id}` as bare `"id"`, not `"forms"."id"`. Inside a subquery over a table
that also has that column, it binds to the inner table and the correlation
silently matches nothing — no error, just wrong numbers. Use a joined aggregate
or `aliasedTable` instead. This shipped once (`listFormsForAdmin` reported every
form as unpublished with zero responses) and the regression test lives in
`form-builder.test.ts`.

## Migrations

Two stages, deliberately different:

- `packages/db/migrations/` — Drizzle-generated, incremental, run once. Generate
  with `npm run db:generate` after changing the schema.
- `packages/db/sql/` — hand-written, idempotent, **re-applied every migrate**.
  RLS policies, grants and helper functions. Whole files are easier to review
  than a chain of diffs, and re-applying means a policy cannot drift. Ordering
  matters: functions (010) → policies (020) → grants (030).

Adding a NOT NULL column to a populated table needs a default or a backfill —
the generator will not do this for you.

## Configuration

One `.env` at the repo root, for everything. Each entry point calls
`loadRootEnv()` from `load-env.mjs` — `next.config.ts`, `drizzle.config.ts`,
`migrate.ts`, `seed.ts`, `vitest.setup.ts` and the scripts. Real environment
variables always win, so Docker and CI are unaffected and there is no file to
mount.

**Any new entry point must call it too.** Next only reads a `.env` beside its own
package.json, vitest reads none, and `tsx` reads none — so a script that skips
this fails with `DATABASE_URL is not set` no matter how correct the `.env` is.
Do not reach for `--env-file` instead; it is cwd-dependent and silently makes
`npm run <script>` behave differently from running the file by hand.

**The organisation's brand leads, not ours.** Inside a live organisation every
header shows their logo or their name via `OrgBrand`, in the leading position on
the left. A worker should feel they are using their organisation's system.

Sangraha co-brands quietly beside it: `SangrahaCoBrand` sits centred in the
header, small and in grey, and is not a link. That is the only place the mark
appears inside a live organisation — the full `SangrahaLogo` still belongs only
to signup, sign-in and anywhere no organisation is resolvable. If a change would
make our mark larger, louder or earlier than the NGO's, it is the wrong change.

**Shrink uploads in the browser, do not just reject them.** Next.js rejects an
oversized server-action body before your handler runs, so the framework error is
what the user sees. `prepareLogo` in `lib/image.ts` is the pattern: decode,
resize, re-encode, then send. Server-side limits stay as the boundary — the
client is a convenience, never the check.

**Resolve translatable text with `localise()`, never with `??`.** A stored `''`
is not `undefined`, so a `??` chain returns the empty string and a worker is
shown a question with no words in it. That shipped once. `localise()` in
`packages/form-engine/src/i18n.ts` is the only definition; `pruneBlank()` keeps
blanks out of the database on the way in.

## Conventions

- Imports between workspace packages use `@sangraha/*`; relative imports have no file
  extension (bundler resolution — `.js` specifiers break drizzle-kit).
- Comments explain *why*, especially where a decision protects a field worker or
  a tenant boundary. Do not narrate what the code plainly does.
- Two design systems: default Tailwind scales for admin, `text-field-*` /
  `min-h-tap` for the field UI. Do not mix them.
- Product strings live in `apps/web/src/lib/messages.ts`, in the three shipped
  UI languages (`UI_LOCALES`: English, Hindi, Kannada). **Add a string to all
  three or `messages.test.ts` fails** — the `m()` fallback hides a missing
  translation behind English, which defeats the point. Organisation-authored
  labels are JSONB resolved with `t()` and may use any language in
  `LANGUAGE_NAMES`. Field UI copy is short and plain — the reader may be reading
  slowly, outdoors, in a hurry.
