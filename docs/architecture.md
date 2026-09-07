# How it fits together

The shape of the system: where the form engine sits, how flexible storage
produces relational output, and where tenant isolation is enforced.

---

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

Contributor conventions and invariants are in [CLAUDE.md](../CLAUDE.md).

---

[← Back to the README](../README.md)
