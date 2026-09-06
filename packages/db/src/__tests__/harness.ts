/**
 * Test harness for the integration suites.
 *
 * Each suite builds its own throwaway organisations against the real database,
 * because the properties under test — Row-Level Security, ltree containment,
 * generated views — only exist in Postgres. Mocking them would test nothing.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, like, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { analyticsSchemaName } from '@sangraha/form-engine';
import { deleteOrganisation } from '../admin/delete-organisation';
import { createPostgresClient, type Database } from '../client';
import { hashPin } from '../auth/pin';
import {
  formFields,
  formVersions,
  forms,
  locations,
  organisations,
  subjectTypes,
  toLtreeLabel,
  userLocations,
  users,
} from '../schema/index';

export const hasDatabase = Boolean(process.env.DATABASE_URL && process.env.DATABASE_APP_URL);

let ownerClient: postgres.Sql | undefined;
let owner: Database | undefined;

export function ownerDb(): Database {
  if (!owner) {
    ownerClient = createPostgresClient(process.env.DATABASE_URL!, 4);
    owner = drizzle(ownerClient) as unknown as Database;
  }
  return owner;
}

export async function closeHarness(): Promise<void> {
  await ownerClient?.end();
  ownerClient = undefined;
  owner = undefined;
}

/**
 * Every organisation this harness creates is prefixed so it can be recognised
 * and swept later. A test run killed part-way through (Ctrl-C, a crash, a
 * failing `beforeAll`) never reaches its `afterAll`, and the leftovers are not
 * inert — they show up in the login screen's organisation picker.
 */
const TEST_ORG_PREFIX = 'test-';

/**
 * Anything created before this process started belongs to an earlier run.
 *
 * The cutoff matters: several suites, and several `describe` blocks within a
 * suite, each create their own organisation. Sweeping every `test-` org would
 * delete a sibling suite's fixtures out from under it.
 */
const RUN_STARTED_AT = new Date();

let sweptThisRun = false;

/**
 * Removes organisations left behind by earlier runs.
 *
 * Done at the start rather than the end, because the runs that leak are exactly
 * the ones that never reach their `afterAll` — a Ctrl-C, a crash, a failing
 * `beforeAll`. Left alone they accumulate, and they are not inert: they appear
 * in the login screen's organisation picker.
 */
async function sweepAbandonedTestOrgs(): Promise<void> {
  if (sweptThisRun) return;
  sweptThisRun = true;

  const db = ownerDb();
  const stale = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(
      and(
        like(organisations.slug, `${TEST_ORG_PREFIX}%`),
        lt(organisations.createdAt, RUN_STARTED_AT),
      ),
    );

  for (const org of stale) {
    await deleteOrganisation(db, org.id);
  }
}

export interface TestOrg {
  id: string;
  slug: string;
  analyticsSchema: string;
  districtId: string;
  villageAId: string;
  villageBId: string;
  adminId: string;
  supervisorId: string;
  workerAId: string;
  workerBId: string;
}

/** Creates an isolated organisation with two villages and four users. */
export async function createTestOrg(label: string): Promise<TestOrg> {
  await sweepAbandonedTestOrgs();

  const db = ownerDb();
  const slug = `${TEST_ORG_PREFIX}${label}-${randomUUID().slice(0, 8)}`;

  const [org] = await db
    .insert(organisations)
    .values({ name: `Test ${label}`, slug, enabledLocales: ['en'] })
    .returning({ id: organisations.id });

  const districtId = randomUUID();
  const villageAId = randomUUID();
  const villageBId = randomUUID();
  const districtPath = toLtreeLabel(districtId);

  await db.insert(locations).values([
    { id: districtId, orgId: org!.id, name: { en: 'District' }, level: 0, path: districtPath },
    {
      id: villageAId,
      orgId: org!.id,
      parentId: districtId,
      name: { en: 'Village A' },
      level: 1,
      path: `${districtPath}.${toLtreeLabel(villageAId)}`,
    },
    {
      id: villageBId,
      orgId: org!.id,
      parentId: districtId,
      name: { en: 'Village B' },
      level: 1,
      path: `${districtPath}.${toLtreeLabel(villageBId)}`,
    },
  ]);

  const pin = await hashPin('284917');
  const created = await db
    .insert(users)
    .values([
      { orgId: org!.id, username: 'admin', pinHash: pin, fullName: 'Admin', role: 'org_admin' },
      {
        orgId: org!.id,
        username: 'supervisor',
        pinHash: pin,
        fullName: 'Supervisor',
        role: 'supervisor',
      },
      { orgId: org!.id, username: 'worker_a', pinHash: pin, fullName: 'Worker A' },
      { orgId: org!.id, username: 'worker_b', pinHash: pin, fullName: 'Worker B' },
    ])
    .returning({ id: users.id, username: users.username });

  const byName = new Map(created.map((u) => [u.username, u.id]));

  // The supervisor is assigned the district, which covers both villages by
  // subtree containment; each worker gets a single village.
  await db.insert(userLocations).values([
    { userId: byName.get('supervisor')!, locationId: districtId },
    { userId: byName.get('worker_a')!, locationId: villageAId },
    { userId: byName.get('worker_b')!, locationId: villageBId },
  ]);

  return {
    id: org!.id,
    slug,
    analyticsSchema: analyticsSchemaName(slug),
    districtId,
    villageAId,
    villageBId,
    adminId: byName.get('admin')!,
    supervisorId: byName.get('supervisor')!,
    workerAId: byName.get('worker_a')!,
    workerBId: byName.get('worker_b')!,
  };
}

export interface TestFormField {
  key: string;
  dataType: string;
  isRequired?: boolean;
  config?: Record<string, unknown>;
  visibilityRule?: unknown;
  parentGroupKey?: string;
}

export interface PublishFormOptions {
  /** Add a version to an existing form instead of creating one. */
  formId?: string;
  versionNumber?: number;
  formType?: 'registration' | 'encounter' | 'standalone';
  /** Attach to an existing subject type rather than minting a throwaway one. */
  subjectTypeId?: string;
  /** Which answers compose a subject's display name. */
  displayNameFields?: string[];
  /** Which answers must match exactly for a duplicate check. */
  matchFields?: string[];
}

/** Creates and publishes a form version. Returns the form and version ids. */
export async function publishForm(
  org: TestOrg,
  slug: string,
  fields: TestFormField[],
  opts: PublishFormOptions = {},
): Promise<{ formId: string; versionId: string; subjectTypeId: string }> {
  const db = ownerDb();

  let formId = opts.formId;
  let subjectTypeId = opts.subjectTypeId;

  if (!subjectTypeId) {
    const [subjectType] = await db
      .insert(subjectTypes)
      .values({
        orgId: org.id,
        code: `subject_${toLtreeLabel(randomUUID()).slice(0, 12)}`,
        name: { en: 'Subject' },
        displayNameFields: opts.displayNameFields ?? [],
        matchFields: opts.matchFields ?? [],
      })
      .returning({ id: subjectTypes.id });
    subjectTypeId = subjectType!.id;
  } else if (opts.displayNameFields || opts.matchFields) {
    await db
      .update(subjectTypes)
      .set({
        ...(opts.displayNameFields ? { displayNameFields: opts.displayNameFields } : {}),
        ...(opts.matchFields ? { matchFields: opts.matchFields } : {}),
      })
      .where(eq(subjectTypes.id, subjectTypeId));
  }

  if (!formId) {
    const [form] = await db
      .insert(forms)
      .values({
        orgId: org.id,
        slug,
        name: { en: slug },
        formType: opts.formType ?? 'encounter',
        subjectTypeId,
      })
      .returning({ id: forms.id });
    formId = form!.id;
  }

  const [version] = await db
    .insert(formVersions)
    .values({
      formId,
      versionNumber: opts.versionNumber ?? 1,
      status: 'published',
      publishedAt: new Date(),
    })
    .returning({ id: formVersions.id });

  // Two passes so a child field can reference the group row created above it.
  const groupIds = new Map<string, string>();
  for (const [index, field] of fields.entries()) {
    if (field.parentGroupKey) continue;
    const [row] = await db
      .insert(formFields)
      .values({
        formVersionId: version!.id,
        key: field.key,
        label: { en: field.key },
        dataType: field.dataType as never,
        isRequired: field.isRequired ?? false,
        sortOrder: index,
        config: field.config ?? {},
        visibilityRule: (field.visibilityRule ?? null) as never,
      })
      .returning({ id: formFields.id });
    groupIds.set(field.key, row!.id);
  }
  for (const [index, field] of fields.entries()) {
    if (!field.parentGroupKey) continue;
    await db.insert(formFields).values({
      formVersionId: version!.id,
      key: field.key,
      label: { en: field.key },
      dataType: field.dataType as never,
      isRequired: field.isRequired ?? false,
      sortOrder: index,
      parentGroupId: groupIds.get(field.parentGroupKey),
      config: field.config ?? {},
    });
  }

  await db.update(forms).set({ currentVersionId: version!.id }).where(eq(forms.id, formId));

  return { formId, versionId: version!.id, subjectTypeId };
}

/** Removes an organisation created by `createTestOrg`. */
export async function dropTestOrg(org: TestOrg): Promise<void> {
  await deleteOrganisation(ownerDb(), org.id);
}
