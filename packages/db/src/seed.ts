/**
 * Demo data: one education NGO, wired end to end.
 *
 * Deliberately realistic rather than minimal — a location hierarchy, three
 * roles, a registration form and an encounter form with skip logic. It is what
 * the Phase 0 acceptance path runs against, and it is the fastest way for
 * someone new to see what the product actually does.
 *
 * Re-runnable: the demo organisation is dropped and rebuilt each time.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { analyticsSchemaName } from '@sangraha/form-engine';
import { loadRootEnv } from '../../../load-env.mjs';
import { deleteOrganisationBySlug } from './admin/delete-organisation';
import { hashPin } from './auth/pin';
import { regenerateFormViews } from './analytics/generate';
import {
  formFields,
  formVersions,
  forms,
  locations,
  optionSets,
  options,
  organisations,
  subjectTypes,
  toLtreeLabel,
  userLocations,
  users,
} from './schema/index';
import type { Database } from './client';

loadRootEnv();

const ORG_SLUG = 'shiksha-demo';

// Weak on purpose, and printed at the end. Never reachable in production:
// `npm run db:seed` is a development script and the PINs are rotated on first
// login by `must_change_pin`.
const DEMO_PINS = {
  admin: '284917',
  supervisor: '571390',
  worker: '639284',
} as const;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. On a fresh clone: cp .env.example .env');
  }

  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client) as unknown as Database;

  try {
    // Re-runnable: any previous demo organisation, including whatever data has
    // been captured against it since, is removed first.
    await deleteOrganisationBySlug(db, ORG_SLUG);
    console.log('→ seeding demo organisation');

    const org = await seedOrganisation(db);
    const places = await seedLocations(db, org.id);
    await seedUsers(db, org.id, places);
    const optionSetIds = await seedOptionSets(db, org.id);
    const studentTypeId = await seedSubjectType(db, org.id);

    const registrationFormId = await seedRegistrationForm(db, org.id, studentTypeId, optionSetIds);
    const attendanceFormId = await seedAttendanceForm(db, org.id, studentTypeId, optionSetIds);

    console.log('→ generating analytics views');
    for (const formId of [registrationFormId, attendanceFormId]) {
      const result = await regenerateFormViews(db, formId);
      console.log(`   ${result.schema}.{${result.created.join(", ")}}`);
    }

    printSummary();
  } finally {
    await client.end();
  }
}

async function seedOrganisation(db: Database) {
  const [org] = await db
    .insert(organisations)
    .values({
      name: 'Shiksha Foundation (demo)',
      slug: ORG_SLUG,
      defaultLocale: 'en',
      enabledLocales: ['en', 'hi', 'kn'],
      // An education NGO's hierarchy. A health NGO would configure
      // district → block → village instead, with no code change.
      locationLevels: [
        { key: 'district', label: { en: 'District', hi: 'ज़िला', kn: 'ಜಿಲ್ಲೆ' } },
        { key: 'block', label: { en: 'Block', hi: 'ब्लॉक', kn: 'ತಾಲ್ಲೂಕು' } },
        { key: 'school', label: { en: 'School', hi: 'विद्यालय', kn: 'ಶಾಲೆ' } },
      ],
    })
    .returning();
  if (!org) throw new Error('failed to create organisation');
  return org;
}

interface SeededPlaces {
  districtId: string;
  blockId: string;
  schoolAId: string;
  schoolBId: string;
}

async function seedLocations(db: Database, orgId: string): Promise<SeededPlaces> {
  // Ids are generated up front so each ltree path can embed its ancestors.
  const districtId = randomUUID();
  const blockId = randomUUID();
  const schoolAId = randomUUID();
  const schoolBId = randomUUID();

  const districtPath = toLtreeLabel(districtId);
  const blockPath = `${districtPath}.${toLtreeLabel(blockId)}`;

  await db.insert(locations).values([
    {
      id: districtId,
      orgId,
      name: { en: 'Belagavi', hi: 'बेलगावी', kn: 'ಬೆಳಗಾವಿ' },
      level: 0,
      path: districtPath,
      externalCode: '27-20',
    },
    {
      id: blockId,
      orgId,
      parentId: districtId,
      name: { en: 'Bailhongal', hi: 'बैलहोंगल', kn: 'ಬೈಲಹೊಂಗಲ' },
      level: 1,
      path: blockPath,
    },
    {
      id: schoolAId,
      orgId,
      parentId: blockId,
      name: { en: 'GHPS Sampgaon', hi: 'जीएचपीएस सम्पगाँव', kn: 'ಸ.ಹಿ.ಪ್ರಾ.ಶಾಲೆ ಸಂಪಗಾವ' },
      level: 2,
      path: `${blockPath}.${toLtreeLabel(schoolAId)}`,
      externalCode: 'UDISE-27200100101',
    },
    {
      id: schoolBId,
      orgId,
      parentId: blockId,
      name: { en: 'GHPS Kittur', hi: 'जीएचपीएस कित्तूर', kn: 'ಸ.ಹಿ.ಪ್ರಾ.ಶಾಲೆ ಕಿತ್ತೂರು' },
      level: 2,
      path: `${blockPath}.${toLtreeLabel(schoolBId)}`,
      externalCode: 'UDISE-27200100102',
    },
  ]);

  return { districtId, blockId, schoolAId, schoolBId };
}

async function seedUsers(db: Database, orgId: string, places: SeededPlaces): Promise<void> {
  const [adminPin, supervisorPin, workerPin] = await Promise.all([
    hashPin(DEMO_PINS.admin),
    hashPin(DEMO_PINS.supervisor),
    hashPin(DEMO_PINS.worker),
  ]);

  const created = await db
    .insert(users)
    .values([
      {
        orgId,
        username: 'admin',
        pinHash: adminPin!,
        fullName: 'Meera Joshi',
        role: 'org_admin',
        locale: 'en',
        mustChangePin: false,
      },
      {
        orgId,
        username: 'supervisor',
        pinHash: supervisorPin!,
        fullName: 'Anil Patil',
        role: 'supervisor',
        locale: 'kn',
        mustChangePin: false,
      },
      {
        orgId,
        username: 'sunita',
        pinHash: workerPin!,
        fullName: 'Sunita Devi',
        role: 'field_worker',
        locale: 'hi',
        mustChangePin: false,
      },
      {
        orgId,
        username: 'ramesh',
        pinHash: workerPin!,
        fullName: 'Ramesh Hiremath',
        role: 'field_worker',
        locale: 'kn',
        mustChangePin: false,
      },
    ])
    .returning({ id: users.id, username: users.username });

  const byUsername = new Map(created.map((u) => [u.username, u.id]));

  // The supervisor is assigned the block, which by subtree containment covers
  // both schools. Each worker gets one school.
  await db.insert(userLocations).values([
    { userId: byUsername.get('supervisor')!, locationId: places.blockId },
    { userId: byUsername.get('sunita')!, locationId: places.schoolAId },
    { userId: byUsername.get('ramesh')!, locationId: places.schoolBId },
  ]);
}

interface SeededOptionSets {
  gender: string;
  absenceReason: string;
  grade: string;
}

async function seedOptionSets(db: Database, orgId: string): Promise<SeededOptionSets> {
  const [genderSet, absenceSet, gradeSet] = await db
    .insert(optionSets)
    .values([
      { orgId, code: 'gender', name: { en: 'Gender', hi: 'लिंग', kn: 'ಲಿಂಗ' } },
      {
        orgId,
        code: 'absence_reason',
        name: { en: 'Reason for absence', hi: 'अनुपस्थिति का कारण', kn: 'ಗೈರುಹಾಜರಿಗೆ ಕಾರಣ' },
      },
      { orgId, code: 'grade', name: { en: 'Grade', hi: 'कक्षा', kn: 'ತರಗತಿ' } },
    ])
    .returning({ id: optionSets.id, code: optionSets.code });

  await db.insert(options).values([
    { optionSetId: genderSet!.id, code: 'f', label: { en: 'Girl', hi: 'लड़की', kn: 'ಹುಡುಗಿ' }, sortOrder: 0 },
    { optionSetId: genderSet!.id, code: 'm', label: { en: 'Boy', hi: 'लड़का', kn: 'ಹುಡುಗ' }, sortOrder: 1 },
    { optionSetId: genderSet!.id, code: 'o', label: { en: 'Other', hi: 'अन्य', kn: 'ಇತರೆ' }, sortOrder: 2 },

    { optionSetId: absenceSet!.id, code: 'illness', label: { en: 'Illness', hi: 'बीमारी', kn: 'ಅನಾರೋಗ್ಯ' }, sortOrder: 0 },
    { optionSetId: absenceSet!.id, code: 'work', label: { en: 'Household work', hi: 'घर का काम', kn: 'ಮನೆಗೆಲಸ' }, sortOrder: 1 },
    { optionSetId: absenceSet!.id, code: 'migration', label: { en: 'Family migrated', hi: 'परिवार पलायन', kn: 'ಕುಟುಂಬ ವಲಸೆ ಹೋಗಿದೆ' }, sortOrder: 2 },
    { optionSetId: absenceSet!.id, code: 'unknown', label: { en: 'Not known', hi: 'पता नहीं', kn: 'ಗೊತ್ತಿಲ್ಲ' }, sortOrder: 3 },

    ...Array.from({ length: 8 }, (_, i) => ({
      optionSetId: gradeSet!.id,
      code: `g${i + 1}`,
      label: { en: `Class ${i + 1}`, hi: `कक्षा ${i + 1}`, kn: `${i + 1}ನೇ ತರಗತಿ` },
      sortOrder: i,
    })),
  ]);

  return { gender: genderSet!.id, absenceReason: absenceSet!.id, grade: gradeSet!.id };
}

async function seedSubjectType(db: Database, orgId: string): Promise<string> {
  const [type] = await db
    .insert(subjectTypes)
    .values({
      orgId,
      code: 'student',
      name: { en: 'Student', hi: 'छात्र', kn: 'ವಿದ್ಯಾರ್ಥಿ' },
      icon: 'GraduationCap',
      // What a field worker sees in a search result.
      displayNameFields: ['full_name'],
    })
    .returning({ id: subjectTypes.id });
  return type!.id;
}

/** Registers a student once; every later attendance record hangs off this. */
async function seedRegistrationForm(
  db: Database,
  orgId: string,
  subjectTypeId: string,
  optionSetIds: SeededOptionSets,
): Promise<string> {
  const { formId, versionId } = await createPublishedForm(db, {
    orgId,
    slug: 'student_registration',
    name: { en: 'Register a student', hi: 'छात्र पंजीकरण', kn: 'ವಿದ್ಯಾರ್ಥಿ ನೋಂದಣಿ' },
    formType: 'registration',
    subjectTypeId,
  });

  await db.insert(formFields).values([
    {
      formVersionId: versionId,
      key: 'full_name',
      label: { en: "Student's full name", hi: 'छात्र का पूरा नाम', kn: 'ವಿದ್ಯಾರ್ಥಿಯ ಪೂರ್ಣ ಹೆಸರು' },
      dataType: 'short_text',
      isRequired: true,
      sortOrder: 0,
      config: { maxLength: 120, allowVoiceInput: true },
    },
    {
      formVersionId: versionId,
      key: 'gender',
      label: { en: 'Girl or boy?', hi: 'लड़की या लड़का?', kn: 'ಹುಡುಗಿಯೇ ಅಥವಾ ಹುಡುಗನೇ?' },
      dataType: 'single_choice',
      isRequired: true,
      sortOrder: 1,
      optionSetId: optionSetIds.gender,
      config: { display: 'buttons' },
    },
    {
      formVersionId: versionId,
      key: 'date_of_birth',
      label: { en: 'Date of birth', hi: 'जन्म तिथि', kn: 'ಹುಟ್ಟಿದ ದಿನಾಂಕ' },
      dataType: 'date',
      isRequired: false,
      sortOrder: 2,
      config: { showTodayShortcut: false },
    },
    {
      formVersionId: versionId,
      key: 'grade',
      label: { en: 'Which class?', hi: 'कौन सी कक्षा?', kn: 'ಯಾವ ತರಗತಿ?' },
      dataType: 'single_choice',
      isRequired: true,
      sortOrder: 3,
      optionSetId: optionSetIds.grade,
      config: { display: 'buttons' },
    },
    {
      formVersionId: versionId,
      key: 'guardian_phone',
      label: { en: "Guardian's mobile number", hi: 'अभिभावक का मोबाइल नंबर', kn: 'ಪೋಷಕರ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ' },
      help: {
        en: 'Ten digits. Leave blank if there is none.',
        hi: 'दस अंक। न हो तो खाली छोड़ें।',
        kn: 'ಹತ್ತು ಅಂಕಿಗಳು. ಇಲ್ಲದಿದ್ದರೆ ಖಾಲಿ ಬಿಡಿ.',
      },
      dataType: 'phone',
      isRequired: false,
      sortOrder: 4,
      config: { defaultCountry: 'IN', nationalDigits: 10 },
    },
  ]);

  return formId;
}

/** The repeat event: one row per student per day, with skip logic. */
async function seedAttendanceForm(
  db: Database,
  orgId: string,
  subjectTypeId: string,
  optionSetIds: SeededOptionSets,
): Promise<string> {
  const { formId, versionId } = await createPublishedForm(db, {
    orgId,
    slug: 'school_attendance',
    name: { en: 'School attendance', hi: 'स्कूल उपस्थिति', kn: 'ಶಾಲಾ ಹಾಜರಾತಿ' },
    formType: 'encounter',
    subjectTypeId,
  });

  await db.insert(formFields).values([
    {
      formVersionId: versionId,
      key: 'attendance_date',
      label: { en: 'Date', hi: 'तारीख', kn: 'ದಿನಾಂಕ' },
      dataType: 'date',
      isRequired: true,
      sortOrder: 0,
      config: { showTodayShortcut: true, maxRelativeDays: 0 },
    },
    {
      formVersionId: versionId,
      key: 'present',
      label: { en: 'Was the student present?', hi: 'क्या छात्र उपस्थित था?', kn: 'ವಿದ್ಯಾರ್ಥಿ ಹಾಜರಿದ್ದರೇ?' },
      dataType: 'boolean',
      isRequired: true,
      sortOrder: 1,
      config: {
        trueLabel: { en: 'Present', hi: 'उपस्थित', kn: 'ಹಾಜರು' },
        falseLabel: { en: 'Absent', hi: 'अनुपस्थित', kn: 'ಗೈರುಹಾಜರು' },
      },
    },
    {
      formVersionId: versionId,
      key: 'absence_reason',
      label: { en: 'Why were they absent?', hi: 'वे क्यों अनुपस्थित थे?', kn: 'ಏಕೆ ಗೈರುಹಾಜರಾಗಿದ್ದರು?' },
      dataType: 'single_choice',
      isRequired: true,
      sortOrder: 2,
      optionSetId: optionSetIds.absenceReason,
      // The canonical skip-logic case: only ask for a reason after "Absent".
      visibilityRule: { op: 'eq', field: 'present', value: false },
      config: { display: 'buttons' },
    },
    {
      formVersionId: versionId,
      key: 'notes',
      label: { en: 'Anything else to note?', hi: 'और कुछ कहना है?', kn: 'ಇನ್ನೇನಾದರೂ ಬರೆಯಬೇಕೆ?' },
      dataType: 'long_text',
      isRequired: false,
      sortOrder: 3,
      config: { rows: 3, allowVoiceInput: true },
    },
  ]);

  return formId;
}

async function createPublishedForm(
  db: Database,
  input: {
    orgId: string;
    slug: string;
    name: Record<string, string>;
    formType: 'registration' | 'encounter' | 'standalone';
    subjectTypeId: string;
  },
): Promise<{ formId: string; versionId: string }> {
  const [form] = await db
    .insert(forms)
    .values({
      orgId: input.orgId,
      slug: input.slug,
      name: input.name,
      formType: input.formType,
      subjectTypeId: input.subjectTypeId,
    })
    .returning({ id: forms.id });

  const [version] = await db
    .insert(formVersions)
    .values({
      formId: form!.id,
      versionNumber: 1,
      status: 'published',
      publishedAt: new Date(),
    })
    .returning({ id: formVersions.id });

  await db
    .update(forms)
    .set({ currentVersionId: version!.id })
    .where(eq(forms.id, form!.id));

  return { formId: form!.id, versionId: version!.id };
}

function printSummary(): void {
  console.log(`
✓ Demo organisation ready — "Shiksha Foundation (demo)"

  Sign in at http://localhost:3000 — the organisation is filled in for you

    Role         Username      PIN
    ─────────────────────────────────────
    Org admin    admin         ${DEMO_PINS.admin}
    Supervisor   supervisor    ${DEMO_PINS.supervisor}
    Field work   sunita        ${DEMO_PINS.worker}   (GHPS Sampgaon, in Hindi)
    Field work   ramesh        ${DEMO_PINS.worker}   (GHPS Kittur, in Kannada)

  Forms:  student_registration, school_attendance
  Views:  ${analyticsSchemaName(ORG_SLUG)}.{student_registration, school_attendance}
`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
