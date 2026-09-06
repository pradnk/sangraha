-- Extensions the schema depends on. Runs once, on first container boot.
--   ltree      : location hierarchy ("everything under Nashik district" as one indexed query)
--   pg_trgm    : fuzzy search over subjects.display_name for field-worker lookup and dedupe
--   pgcrypto   : gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Analytics schema. Every published form gets a flattened view in here, and this
-- is the only schema the per-org read-only BI role is granted access to.
CREATE SCHEMA IF NOT EXISTS analytics;
