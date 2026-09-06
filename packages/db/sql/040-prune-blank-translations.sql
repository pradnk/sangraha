-- Removes blank translations already stored.
--
-- The form builder used to write an empty string for every language an admin
-- tabbed past, and a stored `''` is indistinguishable from a real translation
-- to anything reading it — a Kannada worker was shown a question with no words
-- in it. `localise()` now treats blank as missing, so this is not required for
-- correctness; it is here so the data says what it means, and so "is this
-- translated?" has an honest answer.
--
-- Idempotent, and re-applied on every migrate. The editors no longer create
-- these, so after the first run it is a no-op.

WITH cleaned AS (
  SELECT id,
         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
          FROM jsonb_each_text(label)
          WHERE btrim(value) <> '') AS pruned
  FROM form_fields
  WHERE EXISTS (SELECT 1 FROM jsonb_each_text(label) WHERE btrim(value) = '')
)
UPDATE form_fields f SET label = cleaned.pruned
FROM cleaned WHERE f.id = cleaned.id;

WITH cleaned AS (
  SELECT id,
         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
          FROM jsonb_each_text(help)
          WHERE btrim(value) <> '') AS pruned
  FROM form_fields
  WHERE help IS NOT NULL
    AND EXISTS (SELECT 1 FROM jsonb_each_text(help) WHERE btrim(value) = '')
)
UPDATE form_fields f SET help = nullif(cleaned.pruned, '{}'::jsonb)
FROM cleaned WHERE f.id = cleaned.id;

WITH cleaned AS (
  SELECT id,
         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
          FROM jsonb_each_text(label)
          WHERE btrim(value) <> '') AS pruned
  FROM options
  WHERE EXISTS (SELECT 1 FROM jsonb_each_text(label) WHERE btrim(value) = '')
)
UPDATE options o SET label = cleaned.pruned
FROM cleaned WHERE o.id = cleaned.id;

WITH cleaned AS (
  SELECT id,
         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
          FROM jsonb_each_text(name)
          WHERE btrim(value) <> '') AS pruned
  FROM locations
  WHERE EXISTS (SELECT 1 FROM jsonb_each_text(name) WHERE btrim(value) = '')
)
UPDATE locations l SET name = cleaned.pruned
FROM cleaned WHERE l.id = cleaned.id;
