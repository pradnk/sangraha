# When something breaks

Symptoms seen in practice, and what actually caused them.

---

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
| `Role "…" holds BYPASSRLS, and it could not be revoked` | The role was created through Neon's Roles UI, which sets `BYPASSRLS`; only a superuser can revoke it, so it cannot be fixed in place. That attribute would make every RLS policy decorative, so the migration refuses. Create a fresh role in Neon's **SQL Editor** with a bare `CREATE ROLE name LOGIN PASSWORD '…'` — no attribute clauses — point `DATABASE_APP_URL` at it, and deploy again. |
| `XX000` / `SendDeltasToControlPlane` during `db:migrate` | Neon refused a role change; it handles those in its control plane, not in Postgres. The migration retries on a direct connection on its own. If it still fails, create the role under **Branches → Roles** with the password from `DATABASE_APP_URL`, give it no attributes, and deploy again. |
| `permission denied to alter role`, on a role that is already correct | Fixed 7 Sep 2026. The migration used to restate `NOSUPERUSER NOBYPASSRLS` unconditionally, which only a superuser may do — so a managed provider rejected the statement whose only purpose was to check something that was already true. It now verifies and only alters what differs. |
| `DATABASE_APP_URL is not set` in a deploy build | The app connects as a second, non-owner role and that variable names it; there is no default because it carries a password. [Deploying](./deploying.md) has the value to set. It cannot be `DATABASE_URL` — an owner bypasses RLS. On Vercel, check the variable is scoped to the environment being built, and redeploy rather than retrying the old build. |
| `type "ltree" does not exist` during `db:migrate` | The `DATABASE_URL` role cannot create extensions. `sql/000-extensions.sql` creates all three before the first migration, so this now means a privilege problem rather than a missing step — grant that role `CREATE` on the database. |

---

[← Back to the README](../README.md)
