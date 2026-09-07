-- Row-Level Security: tenant and location isolation, enforced by the database.
--
-- Application code can forget a WHERE clause. A policy cannot. Because these
-- also constrain the read-only BI connections, an analyst pointing Metabase at
-- the database sees exactly what the app would have shown them.
--
-- Request context is set per transaction by the app:
--   SET LOCAL app.org_id  = '<uuid>';
--   SET LOCAL app.user_id = '<uuid>';
--   SET LOCAL app.role    = 'field_worker';
-- SET LOCAL is deliberate — the setting dies with the transaction, so a pooled
-- connection can never carry one tenant's context into the next request.
--
-- Idempotent and re-applied on every migrate.

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- Request context accessors
-- ---------------------------------------------------------------------------

-- The `true` argument makes current_setting return NULL instead of raising when
-- the setting is absent. An unset context therefore matches no rows, which is
-- the right failure direction: a bug that forgets to set the org yields an
-- empty screen, never another tenant's data.
CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN nullif(current_setting('app.org_id', true), '')::uuid;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN nullif(current_setting('app.user_id', true), '')::uuid;

CREATE OR REPLACE FUNCTION app.actor_role() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN coalesce(nullif(current_setting('app.role', true), ''), 'field_worker');

-- Admins see their whole organisation; field workers and supervisors are
-- confined to the places they are assigned.
CREATE OR REPLACE FUNCTION app.is_location_scoped() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN app.actor_role() IN ('field_worker', 'supervisor');

/*
 * True when the current actor may see something at `loc`.
 *
 * Assigning a user to a node implies its entire subtree, so a block coordinator
 * needs one assignment rather than one per village. The ltree containment
 * (`<@`) is what makes that a single indexed lookup.
 *
 * SECURITY DEFINER because it reads user_locations and locations, which are
 * themselves under RLS; without it the policies that call this would recurse.
 * search_path is pinned so the definer's privileges cannot be redirected to an
 * attacker-controlled schema.
 */
CREATE OR REPLACE FUNCTION app.can_see_location(loc uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  RETURN
    NOT app.is_location_scoped()
    -- A submission with no place (a standalone survey, an office-entered form)
    -- is visible org-wide rather than invisible to everyone.
    OR loc IS NULL
    OR EXISTS (
      SELECT 1
      FROM user_locations ul
      JOIN locations assigned ON assigned.id = ul.location_id
      JOIN locations target ON target.id = loc
      WHERE ul.user_id = app.current_user_id()
        AND target.path <@ assigned.path
    );

/*
 * True when the current actor may use `form`.
 *
 * Three audiences, each named after the lowest role it includes automatically,
 * and each carrying an approver by construction:
 *
 *   everyone     every signed-in user; supervisors approve
 *   supervisors  every supervisor, plus the field workers named on the form
 *   admins       admins only, plus the people named
 *
 * Org admins first and unconditionally. They have to be able to edit and approve
 * a form they are not themselves an audience of, and their presence in every
 * option is what guarantees a record can always be reviewed by somebody.
 *
 * SECURITY DEFINER for the same reason `can_see_location` is: it reads `forms`
 * and `form_access`, both of which are under RLS, and `submissions_isolation`
 * calls it — without the definer's rights the policy would recurse. The
 * search_path is pinned so those rights cannot be redirected to an
 * attacker-controlled schema.
 *
 * The org check inside the EXISTS is not redundant with the caller's policy.
 * This runs as the definer, so no policy is filtering the read — the tenant
 * boundary has to be re-imposed here explicitly, exactly as
 * `duplicate_answer_exists` does below.
 *
 * `app.actor_role()` defaults to 'field_worker' when the context is unset, so
 * an unscoped connection fails closed rather than open.
 */
CREATE OR REPLACE FUNCTION app.can_use_form(form uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  RETURN
    app.actor_role() IN ('org_admin', 'super_admin')
    OR EXISTS (
      SELECT 1
      FROM forms f
      WHERE f.id = form
        AND f.org_id = app.current_org_id()
        AND (
          f.audience = 'everyone'
          -- Every supervisor is in the `supervisors` tier automatically, which
          -- is what makes that option's approval loop immune to staffing
          -- changes: a supervisor who joins next month is already in it.
          OR (f.audience = 'supervisors' AND app.actor_role() = 'supervisor')
          -- Named additions, for both restricted tiers. `admins` has no role
          -- clause of its own because the admin short-circuit above already
          -- covers it — the only other way in is by name.
          OR EXISTS (
            SELECT 1 FROM form_access fa
            WHERE fa.form_id = f.id AND fa.user_id = app.current_user_id()
          )
        )
    );

/*
 * Whether this organisation already holds this answer on this form.
 *
 * SECURITY DEFINER for the same reason `can_see_location` is, but the problem
 * it solves is the opposite one. `submissions_isolation` narrows a field worker
 * to `submitted_by = app.current_user_id()`, so a uniqueness check running
 * under their own policy could only ever see *their own* records — and the
 * whole point of the rule is the second worker, in the next village, enrolling
 * the same person under the same phone number. The rule was silently doing
 * nothing in exactly the case it exists for.
 *
 * So the policy is stepped around and the tenant boundary is re-imposed here
 * explicitly. Organisation-wide and no further: `can_see_location` is
 * deliberately *not* consulted, because "no two records may share this answer"
 * is a statement about the organisation, not about one worker's patch.
 *
 * What a caller learns is only that the value they just typed is already in
 * use — never whose record holds it, or where. That is the minimum the feature
 * can convey and still be a feature.
 */
CREATE OR REPLACE FUNCTION app.duplicate_answer_exists(
  p_form_id uuid,
  p_field_key text,
  p_normalised text,
  p_exclude uuid
) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  RETURN EXISTS (
    SELECT 1
    FROM submissions s
    WHERE s.form_id = p_form_id
      -- An unset context yields NULL and therefore no rows, which is the right
      -- failure direction: a missing org means "found nothing", never "found
      -- somebody else's".
      AND s.org_id = app.current_org_id()
      AND s.deleted_at IS NULL
      AND s.status <> 'draft'
      AND (p_exclude IS NULL OR s.id <> p_exclude)
      AND lower(trim(s.data->>p_field_key)) = p_normalised
  );

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON organisations;
CREATE POLICY org_isolation ON organisations
  USING (id = app.current_org_id())
  WITH CHECK (id = app.current_org_id());

-- Every user in the organisation is readable: submission lists and review
-- queues have to show who captured a record. Who may *modify* a user is
-- enforced in the application's admin routes.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_isolation ON users;
CREATE POLICY users_isolation ON users
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS locations_isolation ON locations;
CREATE POLICY locations_isolation ON locations
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

ALTER TABLE user_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_locations_isolation ON user_locations;
CREATE POLICY user_locations_isolation ON user_locations
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.org_id = app.current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.org_id = app.current_org_id()));

-- API keys are administrative credentials; field staff have no reason to
-- enumerate them even in hashed form.
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_keys_isolation ON api_keys;
CREATE POLICY api_keys_isolation ON api_keys
  USING (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'))
  WITH CHECK (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'));

-- --- Form configuration ----------------------------------------------------

ALTER TABLE subject_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subject_types_isolation ON subject_types;
CREATE POLICY subject_types_isolation ON subject_types
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS forms_isolation ON forms;
CREATE POLICY forms_isolation ON forms
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

ALTER TABLE form_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_versions_isolation ON form_versions;
CREATE POLICY form_versions_isolation ON form_versions
  USING (EXISTS (SELECT 1 FROM forms f WHERE f.id = form_id AND f.org_id = app.current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM forms f WHERE f.id = form_id AND f.org_id = app.current_org_id()));

/*
 * Who is named on a form.
 *
 * Readable across the tenant, because a worker's own screens ask "may I use
 * this?" through `can_use_form`, and an admin screen lists the current
 * selection. Writable by admins only — the WITH CHECK is what stops a worker
 * adding themselves to a form they were left off.
 */
ALTER TABLE form_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_access_isolation ON form_access;
CREATE POLICY form_access_isolation ON form_access
  USING (EXISTS (SELECT 1 FROM forms f WHERE f.id = form_id AND f.org_id = app.current_org_id()))
  WITH CHECK (
    EXISTS (SELECT 1 FROM forms f WHERE f.id = form_id AND f.org_id = app.current_org_id())
    AND app.actor_role() IN ('org_admin', 'super_admin')
  );

ALTER TABLE form_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_fields_isolation ON form_fields;
CREATE POLICY form_fields_isolation ON form_fields
  USING (EXISTS (
    SELECT 1 FROM form_versions fv
    JOIN forms f ON f.id = fv.form_id
    WHERE fv.id = form_version_id AND f.org_id = app.current_org_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM form_versions fv
    JOIN forms f ON f.id = fv.form_id
    WHERE fv.id = form_version_id AND f.org_id = app.current_org_id()
  ));

ALTER TABLE option_sets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS option_sets_isolation ON option_sets;
CREATE POLICY option_sets_isolation ON option_sets
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

ALTER TABLE options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS options_isolation ON options;
CREATE POLICY options_isolation ON options
  USING (EXISTS (
    SELECT 1 FROM option_sets os WHERE os.id = option_set_id AND os.org_id = app.current_org_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM option_sets os WHERE os.id = option_set_id AND os.org_id = app.current_org_id()
  ));

ALTER TABLE analytics_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analytics_views_isolation ON analytics_views;
CREATE POLICY analytics_views_isolation ON analytics_views
  USING (EXISTS (SELECT 1 FROM forms f WHERE f.id = form_id AND f.org_id = app.current_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM forms f WHERE f.id = form_id AND f.org_id = app.current_org_id()));

-- --- Collected data --------------------------------------------------------

-- The registry is location-scoped: a village worker searching for "Sunita"
-- must not page through every Sunita in the state, both for privacy and
-- because they would pick the wrong one.
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subjects_isolation ON subjects;
CREATE POLICY subjects_isolation ON subjects
  USING (org_id = app.current_org_id() AND app.can_see_location(location_id))
  WITH CHECK (org_id = app.current_org_id() AND app.can_see_location(location_id));

ALTER TABLE subject_relations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subject_relations_isolation ON subject_relations;
CREATE POLICY subject_relations_isolation ON subject_relations
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

/*
 * Submissions.
 *
 *   field_worker  own submissions only — they correct their own mistakes, not
 *                 a colleague's.
 *   supervisor    their assigned locations, narrowed to the forms they are an
 *                 audience of, which is what the review queue is for.
 *   org_admin     the whole organisation.
 *
 * The WITH CHECK clause additionally stops a field worker from writing a
 * submission attributed to someone else.
 *
 * **Why the form audience is here and not on `forms`.** Restricting reads of
 * `forms` would have been the obvious place and is the wrong one: the queue and
 * the timeline join that table only to resolve a form's *name*, so a worker
 * looking at their own past record would see it go blank. Access decides what
 * you may start and review, not what you may remember.
 */
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS submissions_isolation ON submissions;
CREATE POLICY submissions_isolation ON submissions
  USING (
    org_id = app.current_org_id()
    AND CASE
      WHEN app.actor_role() = 'field_worker' THEN submitted_by = app.current_user_id()
      WHEN app.actor_role() = 'supervisor' THEN
        -- A supervisor captures data too, and keeps sight of their own records
        -- whatever a form's audience says. Losing your own history because
        -- somebody re-scoped a form would be a bug wearing a policy's clothes.
        submitted_by = app.current_user_id()
        OR (app.can_see_location(location_id) AND app.can_use_form(form_id))
      ELSE app.can_see_location(location_id)
    END
  )
  WITH CHECK (
    org_id = app.current_org_id()
    AND CASE
      WHEN app.actor_role() = 'field_worker' THEN submitted_by = app.current_user_id()
      WHEN app.actor_role() = 'supervisor' THEN
        submitted_by = app.current_user_id()
        OR (app.can_see_location(location_id) AND app.can_use_form(form_id))
      ELSE app.can_see_location(location_id)
    END
  );

/*
 * A form's audience gates *new* records, and only new ones.
 *
 * RESTRICTIVE and `FOR INSERT`, which together are the whole point. RESTRICTIVE
 * because this must AND with `submissions_isolation` rather than offer a second
 * way in; INSERT-only because an UPDATE is a correction of a record that already
 * exists, and a worker who has been moved off a form must still be able to
 * finish one a supervisor sent back. Access governs what you may start, not what
 * you must finish — a rejected record nobody may touch is stuck for ever.
 *
 * This is the check that actually holds. `POST /api/submissions` takes a
 * `formVersionId` straight from the client, so gating the screens would leave
 * the door open to anyone willing to type a uuid.
 */
DROP POLICY IF EXISTS submissions_form_audience ON submissions;
CREATE POLICY submissions_form_audience ON submissions
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (app.can_use_form(form_id));

-- Inherits the submission's visibility: the EXISTS is itself filtered by the
-- policy above, so an actor sees exactly the history of the rows they can see.
ALTER TABLE submission_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS submission_revisions_isolation ON submission_revisions;
CREATE POLICY submission_revisions_isolation ON submission_revisions
  USING (EXISTS (SELECT 1 FROM submissions s WHERE s.id = submission_id))
  WITH CHECK (EXISTS (SELECT 1 FROM submissions s WHERE s.id = submission_id));

/*
 * Attachments follow the record they belong to, not merely the organisation.
 *
 * This was org-scoped only, while `/api/attachments/[id]` describes itself as
 * deciding visibility "by the same Row-Level Security that governs every other
 * read" — so a field worker restricted to their own submissions could still
 * fetch any attachment row in the organisation. Reaching one needed its uuid,
 * which made it a weak boundary rather than an open door; it was still not the
 * boundary the code said it was, and these are photographs of people.
 *
 * The EXISTS is itself filtered by `submissions_isolation`, the same trick
 * `submission_revisions_isolation` uses, so the two can never disagree about
 * who may see what.
 *
 * A file with no submission yet is the ordinary case rather than an edge one:
 * the bytes go up while the worker is still filling the form, and
 * `claimAttachments` attaches them when it is sent. Until then the row belongs
 * to whoever reserved it — which is also what stops one worker's abandoned
 * upload being visible to everybody else in the organisation.
 */
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attachments_isolation ON attachments;
CREATE POLICY attachments_isolation ON attachments
  USING (
    org_id = app.current_org_id()
    AND CASE
      WHEN submission_id IS NULL THEN uploaded_by = app.current_user_id()
      ELSE EXISTS (SELECT 1 FROM submissions s WHERE s.id = submission_id)
    END
  )
  WITH CHECK (
    org_id = app.current_org_id()
    AND CASE
      WHEN submission_id IS NULL THEN uploaded_by = app.current_user_id()
      ELSE EXISTS (SELECT 1 FROM submissions s WHERE s.id = submission_id)
    END
  );

/*
 * An organisation's logo.
 *
 * Writes are tenant-scoped like everything else. Reads are *not* served through
 * this connection at all: the login screen shows the logo before anyone is
 * signed in, so `/api/orgs/[slug]/logo` reads it on the owner connection and
 * serves it publicly. A logo is public branding by nature — it is the first
 * thing printed on a form — so that is a deliberate choice, not a gap.
 */
ALTER TABLE organisation_branding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organisation_branding_isolation ON organisation_branding;
CREATE POLICY organisation_branding_isolation ON organisation_branding
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'));

/*
 * The access log.
 *
 * Everyone in the organisation writes to it — a field worker searching the
 * registry logs a row — but only an administrator reads it. That asymmetry is
 * the point: a log a worker can read is a log that tells them which of their
 * colleagues has been checked on, and a log a worker can filter is one they can
 * use to find out who else has seen a beneficiary they are not entitled to see.
 *
 * Note there is no location scoping. An access log constrained to the reader's
 * own villages could not answer "who touched this person's data", which is the
 * only question it exists for.
 */
ALTER TABLE access_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_events_insert ON access_events;
CREATE POLICY access_events_insert ON access_events
  FOR INSERT
  WITH CHECK (org_id = app.current_org_id());

DROP POLICY IF EXISTS access_events_read ON access_events;
CREATE POLICY access_events_read ON access_events
  FOR SELECT
  USING (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'));

/*
 * Purposes and privacy notices.
 *
 * Readable by everyone in the organisation, because a field worker's phone has
 * to render the notice in order to read it out. Writable only by an
 * administrator: what an organisation tells people it does with their data is
 * not a per-worker setting.
 */
ALTER TABLE purposes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purposes_isolation ON purposes;
CREATE POLICY purposes_isolation ON purposes
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'));

ALTER TABLE consent_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_notices_isolation ON consent_notices;
CREATE POLICY consent_notices_isolation ON consent_notices
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'));

ALTER TABLE consent_notice_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_notice_versions_isolation ON consent_notice_versions;
CREATE POLICY consent_notice_versions_isolation ON consent_notice_versions
  USING (
    EXISTS (
      SELECT 1 FROM consent_notices n
      WHERE n.id = consent_notice_versions.notice_id AND n.org_id = app.current_org_id()
    )
  )
  WITH CHECK (
    app.actor_role() IN ('org_admin', 'super_admin')
    AND EXISTS (
      SELECT 1 FROM consent_notices n
      WHERE n.id = consent_notice_versions.notice_id AND n.org_id = app.current_org_id()
    )
  );

ALTER TABLE consent_notice_purposes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_notice_purposes_isolation ON consent_notice_purposes;
CREATE POLICY consent_notice_purposes_isolation ON consent_notice_purposes
  USING (
    EXISTS (
      SELECT 1
      FROM consent_notice_versions v
      JOIN consent_notices n ON n.id = v.notice_id
      WHERE v.id = consent_notice_purposes.notice_version_id
        AND n.org_id = app.current_org_id()
    )
  )
  WITH CHECK (
    app.actor_role() IN ('org_admin', 'super_admin')
    AND EXISTS (
      SELECT 1
      FROM consent_notice_versions v
      JOIN consent_notices n ON n.id = v.notice_id
      WHERE v.id = consent_notice_purposes.notice_version_id
        AND n.org_id = app.current_org_id()
    )
  );

/*
 * The consent log.
 *
 * Readable and writable across the organisation, not location-scoped. A field
 * worker has to be able to record a consent for somebody they are registering
 * right now — before any location is attached — and a supervisor deciding an
 * override may be sitting in a different village from the worker who captured
 * it. Scoping this to locations would make both impossible.
 *
 * There is no DELETE policy and no UPDATE policy at all: `mis_app` is separately
 * stripped of both privileges in 030, and the only legitimate mutation —
 * redacting a row for an erasure — happens on the owner connection with
 * `app.allow_purge` set.
 */
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_events_read ON consent_events;
CREATE POLICY consent_events_read ON consent_events
  FOR SELECT
  USING (org_id = app.current_org_id());

DROP POLICY IF EXISTS consent_events_insert ON consent_events;
CREATE POLICY consent_events_insert ON consent_events
  FOR INSERT
  WITH CHECK (org_id = app.current_org_id());

/*
 * Erasure requests, legal holds and programme counters.
 *
 * Administrators only, on both sides. A request to be forgotten names the
 * person who made it and why they were believed; a hold names a statute the
 * organisation is relying on. Neither is a field worker's business, and the
 * counters are aggregates that exist precisely so nobody needs row-level access
 * to reproduce a report.
 */
ALTER TABLE erasure_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS erasure_requests_isolation ON erasure_requests;
CREATE POLICY erasure_requests_isolation ON erasure_requests
  USING (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'))
  WITH CHECK (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'));

ALTER TABLE legal_holds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_holds_isolation ON legal_holds;
CREATE POLICY legal_holds_isolation ON legal_holds
  USING (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'))
  WITH CHECK (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'));

ALTER TABLE programme_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS programme_counters_isolation ON programme_counters;
CREATE POLICY programme_counters_isolation ON programme_counters
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id() AND app.actor_role() IN ('org_admin', 'super_admin'));

-- ---------------------------------------------------------------------------
-- Deletes on the tables only an administrator may write
-- ---------------------------------------------------------------------------
--
-- The policies above put `actor_role() IN ('org_admin','super_admin')` in
-- WITH CHECK, which governs INSERT and UPDATE. **DELETE consults USING alone**,
-- so it fell through the role check entirely: a field_worker on the application
-- connection could delete an organisation's branding, its purposes or its
-- published notices. Verified before the fix, in a rolled-back transaction:
-- `UPDATE purposes` was refused while `DELETE FROM purposes` returned DELETE 1.
--
-- The role predicate cannot simply be moved into USING, because USING also
-- governs SELECT and every field worker has to *read* purposes and notices to
-- render the consent screen. So the restriction is added where it belongs and
-- nowhere else.
--
-- RESTRICTIVE, which ANDs with the policy above rather than offering a second
-- way in. A permissive policy here would widen access, not narrow it — the
-- opposite of what is wanted.

DROP POLICY IF EXISTS organisation_branding_admin_delete ON organisation_branding;
CREATE POLICY organisation_branding_admin_delete ON organisation_branding AS RESTRICTIVE FOR DELETE
  USING (app.actor_role() IN ('org_admin', 'super_admin'));

DROP POLICY IF EXISTS purposes_admin_delete ON purposes;
CREATE POLICY purposes_admin_delete ON purposes AS RESTRICTIVE FOR DELETE
  USING (app.actor_role() IN ('org_admin', 'super_admin'));

DROP POLICY IF EXISTS consent_notices_admin_delete ON consent_notices;
CREATE POLICY consent_notices_admin_delete ON consent_notices AS RESTRICTIVE FOR DELETE
  USING (app.actor_role() IN ('org_admin', 'super_admin'));

DROP POLICY IF EXISTS consent_notice_versions_admin_delete ON consent_notice_versions;
CREATE POLICY consent_notice_versions_admin_delete ON consent_notice_versions AS RESTRICTIVE FOR DELETE
  USING (app.actor_role() IN ('org_admin', 'super_admin'));

DROP POLICY IF EXISTS consent_notice_purposes_admin_delete ON consent_notice_purposes;
CREATE POLICY consent_notice_purposes_admin_delete ON consent_notice_purposes AS RESTRICTIVE FOR DELETE
  USING (app.actor_role() IN ('org_admin', 'super_admin'));

DROP POLICY IF EXISTS programme_counters_admin_delete ON programme_counters;
CREATE POLICY programme_counters_admin_delete ON programme_counters AS RESTRICTIVE FOR DELETE
  USING (app.actor_role() IN ('org_admin', 'super_admin'));
