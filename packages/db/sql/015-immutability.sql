-- Append-only tables, enforced rather than asserted.
--
-- `submission_revisions` has described itself as append-only since it was
-- written, and it was not: 030-grants.sql hands `mis_app` UPDATE and DELETE on
-- every table in `public`. An audit trail the audited party can rewrite is not
-- an audit trail, and it is the one table whose whole purpose is to be
-- believed years later.
--
-- Two mechanisms, doing different jobs:
--
--   REVOKE (030)  the security boundary. `mis_app` serves every request and now
--                 holds no UPDATE or DELETE privilege here at all, so a bug in
--                 request code cannot reach these rows however hard it tries.
--   this trigger  a deliberateness guard on the owner connection, which is the
--                 table owner and therefore exempt from both privileges and
--                 RLS. It cannot stop an operator who means it — nothing can —
--                 but it stops an operator who did not realise.
--
-- The escape hatch is a transaction-local setting rather than a role, because
-- the legitimate cases are rare, whole-transaction, and always run on the owner
-- connection: deleting an organisation, and (later) redacting a consent record
-- for an erasure request. `SET LOCAL` means it can never outlive its
-- transaction on a pooled connection.
--
-- Slot 015: after 010 creates the analytics schema, before 020 defines the
-- policies that assume `app` exists. Idempotent and re-applied every migrate.

CREATE SCHEMA IF NOT EXISTS app;

/*
 * True when the current transaction has declared itself a purge.
 *
 * Read with the two-argument form of `current_setting` so an unset value is
 * NULL rather than an error — the same fail-quiet convention as
 * `app.current_org_id()` in 020-rls.sql.
 */
CREATE OR REPLACE FUNCTION app.purge_allowed() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN coalesce(current_setting('app.allow_purge', true), '') = 'on';

/*
 * Rejects any UPDATE or DELETE on the table it is attached to.
 *
 * Generic so it can guard every append-only table from one definition. Note
 * that a row trigger fires on a foreign-key cascade too, which is why
 * `deleteOrganisation` has to opt in explicitly: `submission_revisions`
 * cascades from `submissions`, so deleting an organisation legitimately
 * destroys these rows.
 */
CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF app.purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING
      ERRCODE = 'restrict_violation',
      HINT = 'Correct the record by appending a new row. A purge must set app.allow_purge.';
END;
$$;

-- DROP-then-CREATE rather than CREATE OR REPLACE: Postgres has no
-- `CREATE OR REPLACE TRIGGER` before 14, and dropping first keeps the file
-- re-appliable without accumulating duplicates.
DROP TRIGGER IF EXISTS submission_revisions_append_only ON submission_revisions;
CREATE TRIGGER submission_revisions_append_only
  BEFORE UPDATE OR DELETE ON submission_revisions
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- The access log. Same reasoning as the revision log, more sharply: this is the
-- record of who looked at whose data, so anyone able to edit it can erase the
-- evidence of their own access. Nothing legitimate ever amends a row here.
DROP TRIGGER IF EXISTS access_events_append_only ON access_events;
CREATE TRIGGER access_events_append_only
  BEFORE UPDATE OR DELETE ON access_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

/*
 * A published notice never changes again.
 *
 * The whole evidentiary value of a consent record is that it cites the exact
 * words shown, so editing a published version silently rewrites what every
 * past consent was given to. Editing creates a new version instead — the same
 * rule as `form_versions`, enforced here because this one is load-bearing in
 * law rather than merely in analytics.
 *
 * Drafts stay editable, and `retracted_at` stays settable: retracting is how an
 * organisation says a notice was inadequate without pretending it never
 * existed.
 */
CREATE OR REPLACE FUNCTION app.forbid_published_notice_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF app.purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'A published privacy notice cannot be deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.body IS DISTINCT FROM OLD.body
       OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
       OR NEW.version_number IS DISTINCT FROM OLD.version_number
       OR NEW.notice_id IS DISTINCT FROM OLD.notice_id
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'A published privacy notice cannot be edited; publish a new version'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS consent_notice_versions_immutable ON consent_notice_versions;
CREATE TRIGGER consent_notice_versions_immutable
  BEFORE UPDATE OR DELETE ON consent_notice_versions
  FOR EACH ROW EXECUTE FUNCTION app.forbid_published_notice_edit();

/*
 * The consent log, with one permitted mutation.
 *
 * Append-only like the others, except that erasure has to be able to strip a
 * person's identity out of it: the log is the proof you had consent, and it
 * names the person you have been asked to forget. So an UPDATE that only nulls
 * `subject_id` and stamps `redacted_at` is allowed, and everything else raises.
 *
 * Enforced in SQL rather than in TypeScript because a redaction rule the
 * application can talk itself out of is not an invariant.
 */
CREATE OR REPLACE FUNCTION app.consent_events_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF app.purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_events is append-only; a consent is withdrawn by appending, not deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  /*
   * A redaction, and nothing else. Every column is compared rather than
   * allow-listing a few, so a column added later is refused by default instead
   * of quietly becoming editable.
   */
  IF NEW.subject_id IS NULL
     AND OLD.subject_id IS NOT NULL
     AND NEW.redacted_at IS NOT NULL
     AND OLD.redacted_at IS NULL
     AND to_jsonb(NEW) - 'subject_id' - 'redacted_at' - 'guardian_name' - 'guardian_contact'
         = to_jsonb(OLD) - 'subject_id' - 'redacted_at' - 'guardian_name' - 'guardian_contact'
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'consent_events may only be amended by redacting a subject for an erasure'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS consent_events_append_only ON consent_events;
CREATE TRIGGER consent_events_append_only
  BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION app.consent_events_guard();
