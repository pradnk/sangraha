import { z } from 'zod';

/**
 * The shape of a consent event as a device sends it.
 *
 * Lives here rather than beside the route because both `/api/consent` and
 * `/api/submissions` accept it — and because Next refuses any export from a
 * route file that is not a handler.
 */
export const consentEventSchema = z.object({
  clientEventUuid: z.string().uuid(),
  subjectId: z.string().uuid(),
  purposeId: z.string().uuid(),
  action: z.enum(['given', 'withdrawn', 'refused', 'asserted']),
  lawfulBasis: z.enum([
    'consent',
    'guardian_consent',
    'voluntary',
    'state_benefit',
    'medical_emergency',
    'employment',
  ]),
  noticeVersionId: z.string().uuid().nullish(),
  noticeLocale: z.string().min(2).max(8).nullish(),
  noticeTextSha256: z.string().length(64).nullish(),
  noticeSecondsShown: z.number().int().min(0).max(86_400).nullish(),
  noticeReadAloud: z.boolean().nullish(),
  clientOccurredAt: z.string().datetime().nullish(),

  subjectIsMinor: z.boolean().nullish(),
  minorBasis: z.enum(['dob', 'age_field', 'worker_declared', 'unknown']).nullish(),
  guardianName: z.string().max(200).nullish(),
  guardianRelationship: z.string().max(100).nullish(),
  guardianContact: z.string().max(50).nullish(),
  /*
   * The *type* of document the worker saw — "ration card" — never its number.
   * Collecting an identifier to prove we were careful about identifiers would
   * be its own harm.
   */
  guardianEvidenceSeen: z.string().max(100).nullish(),
  guardianVerified: z.boolean().nullish(),
  pendingOverride: z.boolean().optional(),
});
