# Deploying

Field officers work outside the office, so a laptop running docker-compose is
not a deployment. Each NGO hosts its own instance; Vercel plus a managed
Postgres is the intended path, and it needs no shell at any point.

## 1. A database

Any Postgres 14+ that lets you create a role and these extensions: **`ltree`**,
**`pg_trgm`**, **`pgcrypto`**. Neon and Supabase both do; Neon's free tier is
enough to start.

**You do not create them yourself.** `sql/000-extensions.sql` does, before the
first migration, so a new database needs nothing done to it beyond existing.
All three are trusted extensions, which is what lets the owner role install them
without being superuser — nobody is, on a managed provider. If the first deploy
ends in `type "ltree" does not exist`, the role you gave as `DATABASE_URL`
lacks `CREATE` on the database.

**Use the pooled connection string.** Serverless functions each open their own
connections, and a direct connection will exhaust the database under load. On
Neon that is the host containing `-pooler`; on Supabase it is port `6543`. The
app detects both and adjusts automatically — pool size, prepared statements and
idle timeouts all change.

## 2. Import the repository into Vercel

Set **Root Directory** to `apps/web`. Vercel detects Next.js, installs from the
workspace root — so the `@sangraha/*` links and `tsx` resolve — and runs the
`vercel-build` script in `apps/web/package.json`, which applies migrations
before building.

**`vercel.json` deliberately does not set `outputDirectory`.** Vercel applies it
*relative to Root Directory*, so naming `apps/web/.next` there while Root
Directory is `apps/web` asks for `apps/web` twice and the deploy fails on a path
that reads like a missing build rather than a setting:

```
Error: The Next.js output directory "apps/web/.next" was not found at
"/vercel/path0/apps/web/apps/web/.next"
```

The framework preset already finds `.next` under Root Directory. Leave it out.

**If you move Root Directory to the repository root instead**, two things change
together: `outputDirectory` must be added back as `apps/web/.next`, because
Vercel would otherwise look for `.next` beside the root `package.json`, and the
root `vercel-build` takes over from the one in `apps/web`. Both scripts exist
and do the same two things in the same order, one per mode. Changing the setting
without changing `vercel.json` fails in one direction with the doubled path
above, and in the other with `Missing script: "vercel-build"`.

## 3. Environment variables

| Variable | |
|---|---|
| `DATABASE_URL` | **Required.** Pooled string, owner role. Runs migrations and generates analytics views. |
| `DATABASE_APP_URL` | **Required.** Same database as `mis_app`, the non-owner role migrations create. Row-Level Security only applies to this one. |
| `AUTH_SECRET` | **Required.** `openssl rand -base64 32` |
| `SIGNUP_MODE` | Optional. Defaults to `closed` in production — see below. |
| `GOOGLE_TRANSLATE_CREDENTIALS` | Optional, base64 service-account JSON. `GOOGLE_APPLICATION_CREDENTIALS` is a file path and will not work here. |

`DATABASE_APP_URL` is a chicken-and-egg: the `mis_app` role does not exist until
the first migration creates it. Set it to the password you intend to use — the
migration creates the role with that password from the URL you supply. It is the
same host and database as `DATABASE_URL`; only the role differs.

```
postgresql://mis_app:<a-password-you-choose>@<same-host>/<same-database>?sslmode=require
```

**It cannot be `DATABASE_URL`, and the build will not start without it.** Every
managed provider hands out one connection string, so reusing it is the natural
response — but that role owns the tables, and an owner bypasses its own
row-level security. The policies in `sql/020-rls.sql` *are* the tenant boundary,
so a request served on the owner connection isolates nothing and does not fail
while it doesn't. `getOwnerDb()` exists for migrations, seeding and analytics
DDL, and nothing else.

Two Vercel-specific ways this variable goes missing after you have set it: a
variable scoped only to **Production** is absent from a preview build, and a
build reads the environment once, so an already-built deployment will not pick
up a new value until you deploy again.

## 4. Deploy, then open `/start`

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

## 5. Check it worked

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

## Worth knowing

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

[← Back to the README](../README.md)
