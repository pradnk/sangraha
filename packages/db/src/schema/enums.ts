import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * These are genuinely closed sets tied to application behaviour, so a Postgres
 * enum is worth the migration cost. Field data types deliberately are *not* an
 * enum — see `FieldDataType` in @sangraha/form-engine.
 */

export const userRoleEnum = pgEnum('user_role', [
  /** Captures data. Sees only their assigned locations and their own submissions. */
  'field_worker',
  /** Reviews, approves and corrects their team's submissions. */
  'supervisor',
  /** Builds forms, manages users, locations, exports and integrations. */
  'org_admin',
  /** Platform operator. Crosses organisation boundaries; SaaS only. */
  'super_admin',
]);

export const formTypeEnum = pgEnum('form_type', [
  /** Creates or updates a subject in the registry. */
  'registration',
  /** An event attached to an existing subject — a visit, a class, a follow-up. */
  'encounter',
  /** Not tied to any subject — a village survey, a grievance intake. */
  'standalone',
]);

export const formVersionStatusEnum = pgEnum('form_version_status', [
  'draft',
  'published',
  'archived',
]);

export const submissionStatusEnum = pgEnum('submission_status', [
  /** Started but not sent. Never appears in analytics. */
  'draft',
  'submitted',
  'approved',
  'rejected',
]);

export const subjectStatusEnum = pgEnum('subject_status', ['active', 'inactive', 'exited']);

export const revisionChangeTypeEnum = pgEnum('revision_change_type', [
  'created',
  'updated',
  'status_changed',
  'deleted',
]);

/**
 * What somebody did with personal data.
 *
 * A closed set on purpose: a breach report has to enumerate the ways data can
 * leave, and a free-text action column would let a new egress path ship without
 * anyone noticing it was never added here.
 */
export const accessActionEnum = pgEnum('access_action', [
  /** A file left the building. The one that cannot be recalled. */
  'export_csv',
  /** Opened one person's profile. */
  'view_subject',
  /** Opened one record in full. */
  'view_record',
  /** Opened a form's record table — a page of many people at once. */
  'view_records',
  /** Searched the registry by name or attribute. */
  'search_subjects',
  /**
   * Ran the cross-location duplicate check, which deliberately reaches past
   * the caller's own locations. Logged because unmetered it is an oracle for
   * "does this phone number exist in this organisation".
   */
  'check_duplicates',
  'sign_in',
]);

/**
 * Why an organisation is allowed to process someone's data.
 *
 * The DPDP Act gives exactly two routes: the person consented, or one of the
 * "legitimate uses" in Section 7 applies. Modelling only consent would have
 * been simpler and would have misrepresented scheme-delivery work, where the
 * Act does not require consent at all — and asking for consent you do not need
 * is its own harm, because withdrawing it then implies an erasure the
 * organisation may be legally unable to perform.
 */
export const lawfulBasisEnum = pgEnum('lawful_basis', [
  /** The person agreed, having been given notice. Section 6. */
  'consent',
  /** A guardian agreed on behalf of a child or a person with a disability. Section 9. */
  'guardian_consent',
  /** Voluntarily provided for this very purpose, with no objection. Section 7(a). */
  'voluntary',
  /** Delivering a State subsidy, benefit, service, certificate, licence or permit. Section 7(b). */
  'state_benefit',
  /** Responding to a medical emergency or threat to life. Section 7(f). */
  'medical_emergency',
  /** Employment purposes — this is the basis for staff records. Section 7(i). */
  'employment',
]);

/**
 * What happened to a consent, as an event rather than a state.
 *
 * No `expired`. Expiry is a function of the clock, not something that happens,
 * and there is no job runner to fire it — a derived `valid_until` is correct on
 * every deployment the instant midnight passes, including a self-hosted box
 * nobody has scheduled anything on.
 */
export const consentActionEnum = pgEnum('consent_action', [
  /** A person agreed. */
  'given',
  /** A person withdrew. As easy to do as to give — Section 6(4). */
  'withdrawn',
  /** A person was asked and said no. Worth recording: it is not the same as never having asked. */
  'refused',
  /**
   * The organisation relied on a legitimate use.
   *
   * Deliberately not `given`: a person gives consent, an organisation asserts a
   * basis. Collapsing the two makes it impossible to count how much of your
   * processing rests on somebody's actual decision.
   */
  'asserted',
]);

/** How the organisation knows whether someone is a child. */
export const minorBasisEnum = pgEnum('minor_basis', [
  /** A recorded date of birth. */
  'dob',
  /** A recorded age in years, common where no birth date was ever documented. */
  'age_field',
  /** The worker was asked and answered. */
  'worker_declared',
  /** Nobody knows. Never treated as "adult". */
  'unknown',
]);

/** Where a request to be forgotten has got to. */
export const erasureStatusEnum = pgEnum('erasure_status', [
  'requested',
  /** Honoured. The row is soft-deleted and awaiting the purge. */
  'accepted',
  /** Physically gone or stripped of identity. */
  'completed',
  /** Held back under a statute, with the ground recorded. */
  'refused',
]);

/** What honouring an erasure actually does to the record. */
export const erasureModeEnum = pgEnum('erasure_mode', [
  /**
   * Strip the identifiers, keep a de-identified row so counts survive.
   *
   * Called pseudonymisation and not anonymisation, deliberately: village plus
   * age plus caste is near-unique at NGO scale and location is retained by
   * definition, so the result is still personal data and still in scope. It
   * does not discharge the erasure duty on its own.
   */
  'pseudonymise',
  /** Physically remove the rows. */
  'hard_delete',
]);
