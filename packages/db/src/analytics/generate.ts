import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  analyticsSchemaName,
  generateFormViews,
  generateSubjectTypeView,
  generateSubjectsBaseView,
  pgIdentifier,
  type GeneratedView,
} from '@sangraha/form-engine';
import type { Database } from '../client';
import { appRoleName } from '../app-role';
import { analyticsViews, forms, organisations, subjectTypes } from '../schema/index';
import { loadFormVersionDefinitions } from '../queries/form-definitions';

export interface RegenerateResult {
  formSlug: string;
  schema: string;
  created: string[];
  dropped: string[];
}

/**
 * Rebuilds a form's analytics views. Called whenever a version is published.
 *
 * This is DDL, so it runs on the owner connection — never the request-serving
 * one. The publish route calls it after committing the new version.
 *
 * `CREATE VIEW` is close to instantaneous and takes no lock on the underlying
 * data, which is the property that makes a non-technical admin clicking
 * "Publish" a safe operation. The equivalent with real tables would be an ALTER
 * holding an exclusive lock while field workers are mid-submission.
 */
export async function regenerateFormViews(
  db: Database,
  formId: string,
): Promise<RegenerateResult> {
  const [row] = await db
    .select({ form: forms, orgSlug: organisations.slug })
    .from(forms)
    .innerJoin(organisations, eq(organisations.id, forms.orgId))
    .where(eq(forms.id, formId))
    .limit(1);
  if (!row) throw new Error(`Form ${formId} not found`);

  const schema = analyticsSchemaName(row.orgSlug);
  await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${pgIdentifier(schema)}`));
  // The application reads its own analytics views (for exports and the
  // dashboard), so it needs USAGE on each org schema as they appear.
  await db.execute(
    sql.raw(`GRANT USAGE ON SCHEMA ${pgIdentifier(schema)} TO ${pgIdentifier(appRoleName())}`),
  );

  /*
   * The registry dimension, refreshed on every publish.
   *
   * Untracked in `analytics_views`, which is keyed by form — this view belongs
   * to the organisation, not to any one form. Its column list is fixed, so
   * CREATE OR REPLACE always succeeds and there is no stale version to sweep.
   * Created even when the org has registered nobody yet, so that an encounter
   * view's `subject_id` always has something to join to.
   */
  await applyView(db, schema, generateSubjectsBaseView(row.form.orgId, schema), null);

  const versions = await loadFormVersionDefinitions(db, formId);
  if (versions.length === 0) {
    // Nothing published yet: remove any views left from a previous state
    // rather than leaving a stale one that quietly reports old columns.
    const dropped = await dropViewsExcept(db, formId, schema, []);
    return { formSlug: row.form.slug, schema, created: [], dropped };
  }

  const generated = generateFormViews({
    formId,
    formSlug: row.form.slug,
    schema,
    versions,
    labelLocale: 'en',
  });

  /*
   * A registration form also defines a kind of subject, so publishing it
   * refreshes that type's flattened dimension view alongside its own data
   * view. Recorded against this form so the two are regenerated and dropped
   * together — the registration form is the only thing that determines the
   * view's columns.
   */
  if (row.form.formType === 'registration' && row.form.subjectTypeId) {
    const [type] = await db
      .select({ code: subjectTypes.code })
      .from(subjectTypes)
      .where(eq(subjectTypes.id, row.form.subjectTypeId))
      .limit(1);

    if (type) {
      generated.push(
        generateSubjectTypeView({
          orgId: row.form.orgId,
          subjectTypeId: row.form.subjectTypeId,
          subjectTypeCode: type.code,
          schema,
          versions,
          labelLocale: 'en',
        }),
      );
    }
  }

  for (const view of generated) {
    await applyView(db, schema, view, formId);
  }

  const keep = generated.map((v) => v.name);
  const dropped = await dropViewsExcept(db, formId, schema, keep);

  return { formSlug: row.form.slug, schema, created: keep, dropped };
}

/**
 * Replaces one view and grants the application read access to it.
 *
 * `formId` null means the view is not recorded in `analytics_views` — used for
 * organisation-level dimensions that no single form owns.
 */
async function applyView(
  db: Database,
  schema: string,
  view: GeneratedView,
  formId: string | null,
): Promise<void> {
  // A view whose column list changes cannot be CREATE OR REPLACE'd — Postgres
  // only permits appending columns. Adding or removing a question routinely
  // changes the list, so the old view is dropped first. There is no data in a
  // view to lose.
  await db.execute(
    sql.raw(`DROP VIEW IF EXISTS ${pgIdentifier(schema)}.${pgIdentifier(view.name)} CASCADE`),
  );
  await db.execute(sql.raw(view.sql));
  await db.execute(
    sql.raw(
      `GRANT SELECT ON ${pgIdentifier(schema)}.${pgIdentifier(view.name)} TO ${pgIdentifier(appRoleName())}`,
    ),
  );

  if (!formId) return;

  await db
    .insert(analyticsViews)
    .values({
      formId,
      schemaName: schema,
      viewName: view.name,
      repeatGroupKey: view.repeatGroupKey,
      definitionSql: view.sql,
    })
    .onConflictDoUpdate({
      target: [analyticsViews.schemaName, analyticsViews.viewName],
      set: {
        formId,
        repeatGroupKey: view.repeatGroupKey,
        definitionSql: view.sql,
        generatedAt: new Date(),
      },
    });
}

/**
 * Removes views this form no longer needs.
 *
 * The case that matters: an admin deletes a repeating group. Its child view
 * would otherwise linger, still queryable and still returning rows, long after
 * the question is gone.
 */
async function dropViewsExcept(
  db: Database,
  formId: string,
  schema: string,
  keep: string[],
): Promise<string[]> {
  const stale = await db
    .select({ viewName: analyticsViews.viewName, schemaName: analyticsViews.schemaName })
    .from(analyticsViews)
    .where(
      keep.length > 0
        ? and(eq(analyticsViews.formId, formId), notInArray(analyticsViews.viewName, keep))
        : eq(analyticsViews.formId, formId),
    );

  for (const view of stale) {
    await db.execute(
      sql.raw(
        `DROP VIEW IF EXISTS ${pgIdentifier(view.schemaName)}.${pgIdentifier(view.viewName)} CASCADE`,
      ),
    );
  }

  if (stale.length > 0) {
    await db.delete(analyticsViews).where(
      and(
        eq(analyticsViews.schemaName, schema),
        inArray(
          analyticsViews.viewName,
          stale.map((s) => s.viewName),
        ),
      ),
    );
  }

  return stale.map((s) => s.viewName);
}

/** Rebuilds every form's views — used after a deploy that changes the generator. */
export async function regenerateAllViews(db: Database): Promise<RegenerateResult[]> {
  const allForms = await db.select({ id: forms.id }).from(forms);
  const results: RegenerateResult[] = [];
  for (const form of allForms) {
    results.push(await regenerateFormViews(db, form.id));
  }
  return results;
}
