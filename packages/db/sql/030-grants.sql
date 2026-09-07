-- Privileges for the application role.
--
-- Two connections, on purpose:
--
--   DATABASE_URL      owner. Runs migrations and generates analytics views.
--                     Bypasses RLS (a table owner is exempt), so it is never
--                     used to serve a request.
--   DATABASE_APP_URL  the application role. Serves every request. Not a
--                     superuser, not the owner, and holds no DDL privileges, so
--                     Row-Level Security genuinely constrains it.
--
-- Keeping DDL off the request path is what makes "an admin clicked Publish"
-- unable to turn into arbitrary schema change.
--
-- The role itself is created by migrate.ts, which reads its credentials from
-- DATABASE_APP_URL. This file only grants.
--
-- `@APP_ROLE@` is substituted by migrate.ts with that same username, quoted as
-- an identifier. It used to be the literal `mis_app` — so a deployment whose
-- DATABASE_APP_URL named anything else got a role with no privileges, every
-- request failing on a permission error, and a migration that had reported
-- success. The placeholder is the one thing in `sql/` that is not plain SQL;
-- run this file by hand and substitute it yourself.
--
-- Applied last: it grants EXECUTE on everything in `analytics` and `app`, so
-- those schemas and their functions must already exist.

GRANT USAGE ON SCHEMA public TO @APP_ROLE@;
GRANT USAGE ON SCHEMA analytics TO @APP_ROLE@;
GRANT USAGE ON SCHEMA app TO @APP_ROLE@;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO @APP_ROLE@;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO @APP_ROLE@;

/*
 * Append-only tables, clawed back from the blanket grant above.
 *
 * `submission_revisions` is the record of who changed what and when. It has
 * called itself append-only since it was written while the grant above let the
 * request path rewrite it freely — an audit trail the audited party can edit
 * proves nothing. This is the security boundary; the trigger in 015 is a
 * separate guard on the owner connection, which is exempt from privileges.
 *
 * Applied after the GRANT, so re-running this file always ends in the same
 * state regardless of what the blanket grant did.
 */
REVOKE UPDATE, DELETE ON submission_revisions FROM @APP_ROLE@;
REVOKE UPDATE, DELETE ON access_events FROM @APP_ROLE@;
REVOKE UPDATE, DELETE ON consent_events FROM @APP_ROLE@;

-- Analytics views are read-only to the application; they are derived data.
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO @APP_ROLE@;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA analytics TO @APP_ROLE@;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO @APP_ROLE@;

-- Cover objects created later — notably the per-form analytics views, which
-- appear whenever an admin publishes a form.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO @APP_ROLE@;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO @APP_ROLE@;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics
  GRANT SELECT ON TABLES TO @APP_ROLE@;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics
  GRANT EXECUTE ON FUNCTIONS TO @APP_ROLE@;

/*
 * Reaching the extensions, wherever the provider put them.
 *
 * `000-extensions.sql` says CREATE EXTENSION IF NOT EXISTS, and on a managed
 * provider the "if not exists" branch is the one that runs: Supabase ships
 * pg_trgm and pgcrypto pre-installed in a schema called `extensions`, so our
 * statement is a silent no-op and the operators never land in `public`.
 *
 * That is invisible during a migration and invisible to the owner, whose
 * search_path already includes that schema — the trigram index on
 * subjects.display_name builds perfectly. It surfaces later, as a field worker
 * searching for a person and getting `operator does not exist: text % text`,
 * because the role serving the request cannot see the operator.
 *
 * Discovered rather than hardcoded. `extensions` is Supabase's name for it,
 * `public` is what a plain Postgres does, and neither is worth asserting when
 * the catalogue knows.
 */
DO $$
DECLARE
  extension_schemas text[];
  target text;
  path text;
BEGIN
  SELECT coalesce(array_agg(DISTINCT n.nspname), '{}')
    INTO extension_schemas
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname IN ('ltree', 'pg_trgm', 'pgcrypto')
     AND n.nspname <> 'public';

  FOREACH target IN ARRAY extension_schemas LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO @APP_ROLE@', target);
  END LOOP;

  SELECT string_agg(quote_ident(s), ', ')
    INTO path
    FROM unnest(array_prepend('public', extension_schemas)) AS s;

  /*
   * A warning, not a failure. Altering a role's settings is control-plane DDL
   * on some providers and simply refused, and the only cost of that is
   * unqualified extension operators — which is a broken search box, not a
   * broken tenant boundary. Refusing to deploy over it would be the wrong
   * trade.
   */
  BEGIN
    EXECUTE format('ALTER ROLE @APP_ROLE@ SET search_path = %s', path);
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'could not set search_path for @APP_ROLE@ to %: %', path, SQLERRM;
  END;
END $$;
