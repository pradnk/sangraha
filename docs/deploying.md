# Deploying

Field officers work outside the office, so a laptop running docker-compose is
not a deployment. Each NGO hosts its own instance; Vercel plus a managed
Postgres is the intended path, and it needs no shell at any point.

## 1. A database

Any Postgres 14+ that lets you create a role and these extensions: **`ltree`**,
**`pg_trgm`**, **`pgcrypto`**. Neon and Supabase both do; Neon's free tier is
enough to start.

**Use the pooled connection string.** Serverless functions each open their own
connections, and a direct connection will exhaust the database under load. On
Neon that is the host containing `-pooler`; on Supabase it is port `6543`. The
app detects both and adjusts automatically — pool size, prepared statements and
idle timeouts all change.

## 2. Import the repository into Vercel

Set **Root Directory** to `apps/web`. Vercel detects Next.js and picks up the
`vercel-build` script, which applies migrations before building. Leaving Root
Directory at the repo root also works — there is a `vercel.json` for it.

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
migration creates the role with that password from the URL you supply.

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
