-- Non-raising cast helpers used by every generated analytics view.
--
-- A plain `(data->>'age')::bigint` aborts the entire view — every column, every
-- row — the moment one submission holds an unparseable value. That happens in
-- practice: an admin widens a question's type, a bulk import lands something
-- odd, a legacy row predates a validation rule. These return NULL for that one
-- cell instead, so a bad value costs one answer rather than a whole report.
--
-- Where a regular expression fully decides the question, the function is plain
-- SQL and inlinable. PL/pgSQL is used where it cannot: the date and time types,
-- whose validity a regex cannot settle ('2026-13-45' matches the shape but is
-- not a date), and the range of `numeric` and `double precision`, which is
-- arithmetic rather than syntax. A block with an EXCEPTION clause opens a
-- subtransaction on every call, which is why those two are reached only after a
-- fast path has ruled out the ordinary case.
--
-- This file is idempotent and re-applied on every migrate.

CREATE SCHEMA IF NOT EXISTS analytics;

-- The two casts a regular expression cannot fully decide.
--
-- `1e999` matches the shape of a number and is not one a double can hold, and
-- `1e1000000` overflows even numeric — both raised, which is precisely what
-- this file exists to prevent: one such value in one row took down the whole
-- view. A regex cannot settle it, because whether a mantissa and an exponent
-- multiply out to something representable is arithmetic, not syntax.
--
-- So the shape is decided by the regex and the range by the cast, with the
-- overflow caught. The fast path in the wrapper below is what keeps the cost
-- off the ordinary case: a block with an EXCEPTION clause opens a
-- subtransaction on *every* call, so anything comfortably in range never
-- reaches these.
CREATE OR REPLACE FUNCTION analytics.try_numeric_checked(v text) RETURNS numeric
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN v::numeric;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION analytics.try_double_checked(v text) RETURNS double precision
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN v::double precision;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
  RETURN NULL;
END;
$$;

-- Up to 255 digits with no exponent is always inside numeric's range (it holds
-- 131072 before the point), so that case is decided here and stays inlinable.
-- 255 rather than something rounder because that is the largest repetition
-- count a POSIX regex accepts; anything longer simply takes the checked path.
CREATE OR REPLACE FUNCTION analytics.try_numeric(v text) RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN v ~ '^\s*-?\d{1,255}(\.\d+)?\s*$' THEN v::numeric
    WHEN v ~ '^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$' THEN analytics.try_numeric_checked(v)
  END;

-- 15 digits and no exponent is always inside double's range (it reaches ~1.8e308
-- and represents every integer up to 2^53 exactly). Every age, count, weight and
-- rupee amount this system stores takes this path.
CREATE OR REPLACE FUNCTION analytics.try_double(v text) RETURNS double precision
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN v ~ '^\s*-?\d{1,15}(\.\d+)?\s*$' THEN v::double precision
    WHEN v ~ '^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$' THEN analytics.try_double_checked(v)
  END;

-- Capped at 18 digits, which always fits in a bigint, so overflow cannot raise.
CREATE OR REPLACE FUNCTION analytics.try_bigint(v text) RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE WHEN v ~ '^\s*-?\d{1,18}\s*$' THEN v::bigint END;

CREATE OR REPLACE FUNCTION analytics.try_boolean(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN lower(trim(v)) IN ('true', 't', 'yes', 'y', 'on', '1') THEN true
    WHEN lower(trim(v)) IN ('false', 'f', 'no', 'n', 'off', '0') THEN false
  END;

CREATE OR REPLACE FUNCTION analytics.try_uuid(v text) RETURNS uuid
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v::uuid
  END;

-- STABLE rather than IMMUTABLE: text-to-date conversion consults DateStyle.
CREATE OR REPLACE FUNCTION analytics.try_date(v text) RETURNS date
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF v IS NULL OR v !~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN v::date;
EXCEPTION
  WHEN others THEN RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION analytics.try_time(v text) RETURNS time
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF v IS NULL OR v !~ '^\d{1,2}:\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN v::time;
EXCEPTION
  WHEN others THEN RETURN NULL;
END;
$$;

-- A wall-clock reading, which is what `<input type="datetime-local">` gives:
-- no timezone, so none is invented. Casting it to `timestamptz` instead would
-- silently attach whatever timezone the session happened to be in.
CREATE OR REPLACE FUNCTION analytics.try_timestamp(v text) RETURNS timestamp
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF v IS NULL OR v !~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN v::timestamp;
EXCEPTION
  WHEN others THEN RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION analytics.try_timestamptz(v text) RETURNS timestamptz
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF v IS NULL OR v !~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN v::timestamptz;
EXCEPTION
  WHEN others THEN RETURN NULL;
END;
$$;
