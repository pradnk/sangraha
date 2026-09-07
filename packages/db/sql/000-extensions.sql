-- Extensions the schema itself depends on.
--
-- The one file in this directory that runs *before* the schema migrations
-- rather than after them, because the schema cannot be created without it:
-- `0000_initial_schema.sql` declares an `ltree` column and a trigram index, so
-- a database missing these fails on its very first statement with
-- `type "ltree" does not exist`. `migrate.ts` applies this file by name ahead of
-- Drizzle for that reason; everything numbered 010 and up runs at the end.
--
-- These used to exist only in `infra/postgres-init/01-extensions.sql`, which
-- Docker runs once on container boot. That is invisible to a managed Postgres —
-- Neon, Supabase, RDS — where nothing mounts an init directory. Deploying
-- anywhere but local development meant opening a SQL console first, and the
-- error named a missing type rather than the missing step.
--
--   ltree     : location hierarchy, so "everything under Nashik district" is one indexed query
--   pg_trgm   : fuzzy search over subjects.display_name, for field-worker lookup and dedupe
--   pgcrypto  : gen_random_uuid(). In core since Postgres 13; kept for older servers.
--
-- All three are trusted extensions, so the database owner can create them
-- without being superuser. That is what makes this work on a managed provider,
-- where nobody is.
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
