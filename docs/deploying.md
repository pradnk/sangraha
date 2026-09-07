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

### On Supabase

Three things differ enough to be worth stating, and all three are silent when
they go wrong.

**The pooler carries the project reference in the username.** One pooler fronts
every project, so it connects as `postgres.abcdefghijkl`, not `postgres`, and
strips the suffix before Postgres sees it. The application role is
`mis_app.abcdefghijkl` for the same reason. The app knows the rule and derives
the role name back out — but a URL written by hand without the suffix is
refused, and one where the suffix is mistaken for part of the role name grants
every privilege to a role that does not exist.

**Do not use the direct host on Vercel.** `db.<ref>.supabase.co` resolves to
IPv6 only unless the IPv4 add-on is enabled, and Vercel functions have no IPv6
egress. This is why `POSTGRES_URL` is preferred over `POSTGRES_URL_NON_POOLING`
when both are present. Where an unpooled connection is genuinely needed — the
migration lock, role DDL — the app uses **session mode**, which is the same
pooler host on port `5432`: reachable over IPv4, and one backend held for the
connection's lifetime, which is the property that was actually wanted.

**Put the functions in the database's region.** A Supabase project in Mumbai
(`ap-south-1`) wants `"regions": ["bom1"]` in `vercel.json`. Vercel defaults to
Washington DC, and the default is silent: every query pays four round trips, so
a 240ms distance becomes a second of latency on a page that works perfectly.

**The Vercel integration sets its own variable names** — `POSTGRES_URL`,
`POSTGRES_URL_NON_POOLING`, `POSTGRES_HOST` and so on, and no `DATABASE_URL`.
Those are read automatically; there is nothing to copy across. The build log
says which variable each connection came from.

## 2. Import the repository into Vercel

Set **Root Directory** to `apps/web`. Vercel detects Next.js, installs from the
workspace root — so the `@sangraha/*` links and `tsx` resolve — and runs the
`vercel-build` script in `apps/web/package.json`, which applies migrations
before building.

**`vercel.json` sets `outputDirectory` to `.next`, not `apps/web/.next`.**
Vercel resolves it *relative to Root Directory*, so naming `apps/web/.next`
while Root Directory is `apps/web` asks for `apps/web` twice, and the deploy
fails on a path that reads like a missing build rather than a setting:

```
Error: The Next.js output directory "apps/web/.next" was not found at
"/vercel/path0/apps/web/apps/web/.next"
```

**Check the dashboard's own Output Directory field is empty**, under Settings →
Build and Deployment. It is a second, independent source for the same value, and
it is where that error usually comes from once `vercel.json` is right — the
message says "check your project settings" and means the dashboard, not the
file. `vercel.json` is declared rather than left blank precisely so the file
overrides whatever is in that field: omitting the key does not assert a default,
it just yields to the dashboard.

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
| `DATABASE_URL` | **Required**, unless the provider set `POSTGRES_URL` or `POSTGRES_URL_NON_POOLING`, which are read in that order. Pooled string, owner role. Runs migrations and generates analytics views. |
| `DATABASE_APP_URL` | **Required**, unless `DATABASE_APP_PASSWORD` is set. Same database as `mis_app`, the non-owner role migrations create. Row-Level Security only applies to this one. |
| `DATABASE_APP_PASSWORD` | The password for that role, and nothing else. The rest of the URL is taken from `DATABASE_URL`, tenant suffix included. Simpler and harder to get wrong than writing the URL out. |
| `DATABASE_APP_ROLE` | Optional. The role's name, if `mis_app` is unwanted. Names the role Postgres sees, not the string used to connect. |
| `AUTH_SECRET` | **Required.** `openssl rand -base64 32`. At least 32 characters, and not a placeholder — it is rejected by name. See below. |
| `SIGNUP_MODE` | Optional. Defaults to `closed` in production — see below. |
| `GOOGLE_TRANSLATE_CREDENTIALS` | Optional, base64 service-account JSON. `GOOGLE_APPLICATION_CREDENTIALS` is a file path and will not work here. |
| `DATABASE_DIRECT_URL` | Optional. A session-scoped connection, used for the migration lock and for role changes a transaction pooler will not carry. Derived without being set on Neon (the `-pooler` host, minus the `-pooler`) and on Supabase (the same pooler host on port `5432`). |
| `DATABASE_ENV_QUIET` | Optional. `1` stops the loader logging which variable each connection was resolved from. |

**`AUTH_SECRET` is not optional and has no default.** It signs every session
cookie and peppers the consent pseudonyms, so a guessable value lets anyone mint
a session for any organisation and any role without a PIN — and nothing about
the installation would look wrong. It must be at least 32 characters, and the
placeholders people reach for are refused by name, including the one this
repository used to ship in `.env.example`. That value was 39 characters and
passed the length check, so an installation that never replaced it worked
perfectly while signing sessions with a public string.

`DATABASE_APP_URL` is a chicken-and-egg: the `mis_app` role does not exist until
the first migration creates it. Give it the password you intend to use — the
migration creates the role with that password. It is the same host and database
as `DATABASE_URL`; only the role differs.

The short way, and the one to prefer, is to set only the password and let the
rest be derived from `DATABASE_URL`:

```
DATABASE_APP_PASSWORD=<a-password-you-choose>
```

That is the whole of it on any provider. It keeps the host, the port, the
database and — on Supabase — the project reference in the username, which is
the piece a hand-written URL loses.

Written out in full instead, it is:

```
postgresql://mis_app:<a-password-you-choose>@<same-host>/<same-database>?sslmode=require
```

and on Supabase's pooler, with the project reference the pooler requires:

```
postgresql://mis_app.<project-ref>:<a-password-you-choose>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
```

**Copy the host from the dashboard rather than from here.** The region is part
of it, and newer projects are `aws-1-` rather than `aws-0-`.

**Strip any `?supa=`, `?pgbouncer=` or `?connection_limit=` from a string you
paste in.** They are markers for other tools, and the driver forwards every
query parameter it does not recognise to the server as a startup parameter, so
Postgres answers with `unrecognized configuration parameter` and the error names
the parameter rather than the tool that added it. The loader removes these
automatically; the note is here for anyone connecting with `psql` and wondering.

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

**If the build cannot create the role**, create it yourself and deploy again —
in the provider's **SQL Editor** (Neon and Supabase both have one), with the
password you chose:

```sql
CREATE ROLE mis_app LOGIN PASSWORD '<the password you chose>';
```

Name the role `mis_app`, not `mis_app.<project-ref>`. The suffix is how the
pooler routes a connection and is stripped before Postgres sees it; a role
literally called `mis_app.abcdefghijkl` is a different role that nothing will
ever authenticate as.

Exactly that, with no attribute clauses. The defaults are all off, which is what
is wanted, and `NOBYPASSRLS` may only be written by a superuser — so spelling
out the safe thing is itself rejected. The migration grants the role everything
it needs and stops trying to create it once it exists.

**Not Neon's Roles UI.** A role created there arrives holding `BYPASSRLS`, and
only a superuser can revoke that — which nobody is on Neon, so it cannot be
fixed afterwards. `BYPASSRLS` on the role that serves requests makes every
policy in `020-rls.sql` decorative, so the migration refuses to proceed against
such a role rather than deploying something that isolates nothing. If you have
already made one, point `DATABASE_APP_URL` at a fresh role under a new name
created as above — the migration grants whatever name it is given, and a new
name avoids having to clear the old one's grants before dropping it.

Neon handles role changes in its own control plane rather than in Postgres, and
a refusal there arrives as an error that names neither the role nor the reason:

```
XX000  ddl_forwarding.c  SendDeltasToControlPlane
```

Ordinary schema DDL goes through the pooled connection perfectly well, which is
what makes this one confusing to meet — every migration applies, and then the
single statement that creates a role does not. The migration retries role
changes on a direct connection by itself, deriving it from Neon's `-pooler`
convention. `DATABASE_DIRECT_URL` sets one explicitly, for a provider whose
pooled hostname cannot be rewritten that way.

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

**Put the functions in the same region as the database.** Not near your field
staff — near the database. `vercel.json` sets it:

```json
"regions": ["bom1"]
```

`bom1` is Mumbai, which matches a Supabase project in `ap-south-1`. Change it if
your database is elsewhere: `sin1` is Singapore, for `ap-southeast-1`. Both in
Mumbai is the reason to be on a provider that offers an Indian region at all —
Neon does not, so the closest it allows is functions and database both in
Singapore.

**Vercel defaults to Washington DC (`iad1`) and says nothing about it.** With a
database in India or Singapore that is about 240 ms per round trip, and a
request makes several: `begin`, the RLS context, the query, `commit`, plus a
user lookup on its own pool, plus TCP, TLS and authentication on a cold
instance. Around seventeen round trips for one page — four seconds of pure
waiting, before Next's cold start or a compute resume. It presents as the whole
application being slow rather than as a setting, because every click pays it.

The asymmetry is what makes the direction obvious. A request crosses from the
user to the function *once*, and from the function to the database many times.
Functions far from the database pay the long hop repeatedly; functions beside it
pay it once, on the user's connection, where it costs a single hop instead of
seventeen. Which is why the answer is the database's region and not the field
staff's — and why, if the field staff are in India, moving the database to
Mumbai and the functions with it beats either one alone.

Region selection is available on every plan, Hobby included — that was not true
when this project started, and the old advice to leave it alone is why the
default went unnoticed.

**An idle compute may be suspended.** Neon's free tier does this after five
minutes, and the next request waits for the resume. A first click that is
seconds slower than the rest is this, not the region.

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
