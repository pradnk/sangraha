import { customType, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { I18nText } from '@sangraha/form-engine';

/**
 * Postgres `ltree`, used for the location hierarchy.
 *
 * A materialised path makes "everything under Nashik district" a single indexed
 * `path <@ 'n...'` lookup instead of a recursive CTE, which matters because
 * every field-worker query is scoped by location.
 */
export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'ltree';
  },
});

/** Translatable text: `{ en: 'Name', hi: 'नाम' }`. */
export const i18nText = (name: string) => jsonb(name).$type<I18nText>();

export const primaryId = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/**
 * ltree labels accept only `[A-Za-z0-9_]`, so a uuid's hyphens are replaced and
 * a leading letter is prepended (a label may not start with a digit).
 */
export const toLtreeLabel = (id: string): string => `n${id.replaceAll('-', '_')}`;

export const fromLtreeLabel = (label: string): string =>
  label.replace(/^n/, '').replaceAll('_', '-');
