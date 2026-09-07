# Sangraha

**संग्रह · ಸಂಗ್ರಹ · సంగ్రహం · സംഗ്രഹം — "collection"**

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

Licensed under the [GNU AGPL v3](./LICENSE). If you run a modified Sangraha as a
service, your users are entitled to your changes.

---

## What it does

An organisation defines its own forms — questions, answer lists, validation,
skip logic — and publishes them. Field workers fill them in on a phone, one
question per screen, in their own language, offline if the link is bad.
Supervisors review what comes back. Administrators read it as a table, download
it as CSV, or point Metabase straight at the database.

Underneath, three things distinguish it from a form builder:

- **A registry, not a pile of submissions.** People are registered once and
  visits are captured against them over time, so a record has a history.
- **Flexible storage, relational output.** Answers are JSONB against an
  immutable form version; publishing generates a typed, flattened SQL view per
  form that spans every version. No UNION, no backfill, no migration when a
  question is added.
- **Isolation enforced by the database.** Row-Level Security decides what each
  role can read — a worker only their own submissions, a supervisor their
  location subtree. The UI is not the boundary.

It is built for India's DPDP Act: purposes, generated privacy notices, an
append-only consent log, an access log, and erasure. See
[docs/dpdp.md](./docs/dpdp.md).

---

## Status

**Phase 1.** An NGO can define its own forms, register the people it works with,
capture visits against them over time, review what comes back, and read its own
data without a database client. Every field type in the engine is answerable on
a phone, photographs and signatures included. What remains is mostly breadth:
the public API, rights requests, and a full offline PWA.

| | |
|---|---|
| Sign in, sign out, PIN change, switch language | ✅ built |
| Field data capture — one question per screen, 3 UI languages | ✅ built |
| Viewing collected data — "what I have sent", record detail | ✅ built |
| Supervisor review queue — approve / send back, audited | ✅ built |
| Correcting a record that was sent back, in place | ✅ built |
| Form builder — create and edit forms, live phone preview | ✅ built |
| Submission API, retry queue, idempotency | ✅ built |
| Analytics views — JSONB → typed relational tables | ✅ built |
| Tenant + location isolation (Row-Level Security) | ✅ built |
| Admin console — people, PIN reset, places, organisation settings | ✅ built |
| Answer list editing | ✅ built |
| **Form audiences** — everyone, supervisors + chosen workers, or admins + chosen people | ✅ built |
| Self-serve signup + guided setup | ✅ built |
| Machine translation of form content | ✅ built (needs an API key) |
| Organisation logo and branding | ✅ built |
| Subject registry — register people, search, longitudinal timeline | ✅ built |
| Duplicate detection at registration, with cross-location privacy | ✅ built |
| Records screen + CSV export | ✅ built |
| Consent capture and privacy notices | ✅ built |
| Access log, erasure and legal holds | ✅ built |
| Photo, file, signature, GPS and repeating sections | ✅ built |
| Object storage for attachments (MinIO locally, S3/R2 in production) | ✅ built |
| Rights requests, nomination, breach register | ❌ not built |
| Combined skip-logic conditions (and / or) in the builder | ❌ not built |
| Public REST API, webhooks | ❌ not built |
| Charts and dashboards — the Records screen is table + counts only | ❌ not built |

What is planned next is in [What's next](#whats-next), below.

---

## Getting started

Requires **Node 20+** and **Docker**.

```bash
npm install
cp .env.example .env          # then set AUTH_SECRET: openssl rand -base64 32
npm run infra:up              # Postgres + MinIO
npm run db:migrate            # schema migrations, then the idempotent sql/ layer
npm run db:seed               # build the demo organisation
npm run dev                   # http://localhost:3000
```

`npm run db:seed` is re-runnable and destroys the demo organisation's data.

### Services

| What | URL / port | Notes |
|---|---|---|
| Sangraha | http://localhost:3000 | `npm run dev` |
| Postgres | `localhost:5432` | user `mis`, password `mis_dev_password`, db `mis` |
| MinIO (object storage) | http://localhost:9000 | S3-compatible API |
| MinIO console | http://localhost:9001 | user `mis`, password `mis_dev_password` |

Containers are `mis-postgres` and `mis-minio` (`infra/docker-compose.yml`).
Configuration is one `.env` at the repo root — every variable is documented in
[`.env.example`](./.env.example).

### Demo logins

Organisation `shiksha-demo` ("Shiksha Foundation (demo)"). **You do not type the
organisation** — with a single organisation the field does not appear.

| Username | PIN | Role | Language | Sees |
|---|---|---|---|---|
| `sunita` | `639284` | Field worker | Hindi | GHPS Sampgaon, own submissions only |
| `ramesh` | `639284` | Field worker | Kannada | GHPS Kittur, own submissions only |
| `supervisor` | `571390` | Supervisor | Kannada | Both schools (the whole block) |
| `admin` | `284917` | Org admin | English | The whole organisation |

The language buttons on the login screen override the user's stored language —
on a shared phone, whoever is signing in now is the one who has to read it.
`npm run login:check` confirms all four still authenticate. PINs change only if
you edit `DEMO_PINS` in `packages/db/src/seed.ts`; `npm run db:seed` prints them.

> **Never start a second Next process against `.next`.** Every one of them writes
> `apps/web/.next`, so a second `npm run dev` corrupts the first one's chunks:
> the browser gets server HTML from one process and client JavaScript from the
> other, hydration fails, and the page renders perfectly while nothing on it
> responds to a click. Use `npm run dev:alt` (port 3100), which sets its own
> build directory. The same hazard is why `npm run build` writes `.next-build`.

---

## Documentation

| | |
|---|---|
| [Seeing the data](./docs/data.md) | The registry, the Records screen, CSV export, and querying the analytics views directly |
| [Creating and changing forms](./docs/forms.md) | The builder, answer lists, validation, uniqueness, spreadsheet import, translation, branding, and adding a field type |
| [Adding a new organisation](./docs/organisations.md) | Self-serve signup at `/start`, the guided setup, and `npm run org:create` |
| [Deploying](./docs/deploying.md) | Vercel + managed Postgres, environment variables, health checks |
| [Data protection (DPDP)](./docs/dpdp.md) | Purposes, notices, consent, children, the access log, erasure, and the known limits |
| [How it fits together](./docs/architecture.md) | The form engine, generated views, tenant isolation, and the phone-first UI |
| [When something breaks](./docs/troubleshooting.md) | Symptoms seen in practice, and what actually caused them |
| [Contributing](./CONTRIBUTING.md) | How to set up, what to run before a PR, and the invariants that matter |
| [Changelog](./CHANGELOG.md) | What changed, newest first |

---

## Repository layout

```
apps/web              Next.js — field UI, admin console, login, submission API
packages/form-engine  field types, validation, skip logic, view generation
packages/db           schema, migrations, RLS policies, auth, queries, storage
infra/                docker-compose: Postgres + MinIO
scripts/              data viewer, e2e verification, session + login helpers
docs/                 the guides linked above
```

The form engine is the centre of gravity: the builder, capture UI, API, CSV
export and view generator all read from it, so a field type is defined once.
[docs/architecture.md](./docs/architecture.md) explains why the rest is shaped
the way it is.

---

## Everyday commands

```bash
npm run dev                  # web app on :3000
npm run dev:alt              # a SECOND dev server on :3100, own build dir
npm run infra:up | infra:down | infra:reset
npm run db:migrate           # schema + the idempotent sql/ layer
npm run db:seed              # rebuild the demo organisation
npm run db:generate          # new migration after a schema change
npm run db:views             # rebuild all analytics views
npm run db:free              # release connections left by a killed dev server
npm run db:purge -- --org <slug>            # rehearse accepted erasures
npm run db:purge -- --org <slug> --confirm  # carry them out (irreversible)
npm run data [view]          # read collected data from the terminal
npm run psql                 # a shell on the database
npm run org:create -- --name "X" --admin y    # new organisation + first admin
npm run org:delete -- --slug x --confirm      # remove one, with all its data
npm run typecheck            # all packages, plus scripts/
npm test                     # vitest
npm run build                # builds into .next-build, safe while dev is running
npm run verify http://localhost:3000   # end-to-end against a running server
npm run verify:ui            # the same, in a real browser
npm run login:check          # confirm the demo credentials work
npm run session sunita       # print a session cookie for curl
```

Integration suites skip themselves when `DATABASE_URL` is unset, so `npm test`
works without Docker — but then it is not testing RLS or the views.

`npm test` has no browser in it: every check is a pure function, a database
query or an HTTP call. That leaves one class of failure invisible — the page
renders perfectly and nothing on it responds to a click, which is what a
hydration failure looks like. `npm run verify:ui` drives the Chrome already on
your machine and asserts what a request cannot see. No new dependency; skip it
if you have no Chrome.

`npm run lint` and `npm run format` do not currently work — there is no ESLint
flat config in the repo, and `.prettierrc.json` names a Tailwind plugin that is
not installed. Both are known gaps; see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Deploying

Field officers work outside the office, so a laptop running docker-compose is
not a deployment. Each NGO hosts its own instance. Vercel plus a managed
Postgres is the intended path and needs no shell at any point: the build applies
migrations under an advisory lock, and the first person to open `/start` on a
fresh deployment creates the organisation and becomes its administrator, after
which signup shuts.

You need Postgres 14+ that permits `ltree`, `pg_trgm` and `pgcrypto` — the
migration creates them, so a bare database is enough — a **pooled**
connection string, three required environment variables (`DATABASE_URL`,
`DATABASE_APP_URL`, `AUTH_SECRET`), and S3-compatible object storage if you use
photo, file or signature questions. `GET /api/health` tells you whether it
worked — treat `rlsEnabled: false` as an outage, not a warning.

Two of those three usually need no typing. Supabase's Vercel integration injects
`POSTGRES_URL` and friends, which are read as `DATABASE_URL` when it is absent;
and setting `DATABASE_APP_PASSWORD` derives `DATABASE_APP_URL` from it, keeping
the host, the pooler and — on Supabase — the project reference the pooler
requires in the username. Writing that URL by hand is where it gets left off.
Neither is ever derived from the owner's password: the whole point of the second
role is that RLS applies to it, and the owner bypasses RLS without failing.

Import the repository into Vercel and set **Root Directory** to `apps/web`.
`vercel.json` is written for that and sets `outputDirectory` to `.next`, not
`apps/web/.next` — Vercel resolves it relative to Root Directory, so the longer
path names `apps/web` twice and the deploy fails on it. It is stated rather than
omitted because the dashboard has its own field for the same setting, and the
file only wins over it if the key is there. Moving Root Directory to the repository root means changing `vercel.json`
with it; [docs/deploying.md](./docs/deploying.md) has both.

Full instructions, including the environment variable table and the reasoning
about connection pooling and regions, are in
**[docs/deploying.md](./docs/deploying.md)**.

There is no Dockerfile in this repo. `infra/docker-compose.yml` runs the
dependencies, not the app.

---

## What's next

1. **A display formatter separate from the export formatter.** Screens render
   answers with `toExportValue`, which is right for CSV and wrong for a phone: a
   Hindi worker sees `Yes` and `2026-07-15` rather than `हाँ` and a readable
   date. This means a `toDisplayValue` alongside the existing one on each field
   type — deliberately *not* a change to the export values, which analytics and
   spreadsheets depend on being stable.
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

**Usability testing with real field workers is the highest-value next step.**
"No training required" is a direction, not something a design document
establishes. The target: hand a low-end Android phone to someone who has never
seen the app, give them a one-sentence task, and time them to a successful
submission. Under three minutes, no questions asked.

---

## Contributing

Contributions are welcome — read [CONTRIBUTING.md](./CONTRIBUTING.md) first. It
covers the setup, what to run before opening a pull request, and the handful of
invariants that protect a field worker or a tenant boundary and are easy to
violate by accident. [CLAUDE.md](./CLAUDE.md) holds the same conventions in the
form agentic tools read.

## Licence

[GNU Affero General Public License v3.0](./LICENSE) — see the file for the full
text.

Copyright © 2026 Pradeep Kaushik and Sangraha contributors.

AGPL was chosen deliberately. Sangraha is intended to be self-hosted by the
organisations that use it, and the social sector is exactly where an improvement
made by one NGO should be available to the next one. Running a modified version
as a hosted service obliges you to offer your users the source of that version.
