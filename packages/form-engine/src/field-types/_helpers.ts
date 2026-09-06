import type { SqlContext } from '../registry';

/** `data->>'key'` — the answer as text. */
export const jsonText = (ctx: SqlContext): string =>
  `${ctx.data}->>${ctx.literal(ctx.field.key)}`;

/** `data->'key'` — the answer as jsonb, for arrays and nested objects. */
export const jsonValue = (ctx: SqlContext): string =>
  `${ctx.data}->${ctx.literal(ctx.field.key)}`;

/**
 * Postgres types the analytics views are allowed to emit, each with a
 * corresponding `analytics.try_*` function installed by the migrations.
 */
export type SafePgType =
  | 'numeric'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'timestamptz'
  | 'uuid'
  | 'double precision';

const TRY_FUNCTIONS: Record<SafePgType, string> = {
  numeric: 'analytics.try_numeric',
  bigint: 'analytics.try_bigint',
  boolean: 'analytics.try_boolean',
  date: 'analytics.try_date',
  time: 'analytics.try_time',
  timestamp: 'analytics.try_timestamp',
  timestamptz: 'analytics.try_timestamptz',
  uuid: 'analytics.try_uuid',
  'double precision': 'analytics.try_double',
};

/**
 * Casts an extracted answer without ever raising.
 *
 * A plain `::numeric` would abort the entire view — every column, every row —
 * the moment one submission held an unparseable value. That can happen
 * legitimately: an admin widens a question's type, or a bulk import lands
 * something unexpected. These wrappers return NULL for that single cell
 * instead, so a bad value costs one answer rather than a whole report.
 */
export const safeCast = (expr: string, pgType: SafePgType): string =>
  `${TRY_FUNCTIONS[pgType]}(${expr})`;

/** Plain string rendering for CSV/Excel export. */
export const exportAsString = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);
