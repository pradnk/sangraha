import { z } from 'zod';
import type { AnalyticsColumn, FieldTypeDefinition, SqlContext } from '../registry';
import { safeCast, type SafePgType } from './_helpers';

const configSchema = z.object({
  /** Reject a reading worse than this, in metres. Indoors a phone will happily
   *  report a 2km-accurate fix, which is worse than no reading at all. */
  requiredAccuracyM: z.number().min(5).max(1000).default(100),
  /** Lets the worker save anyway after repeated failures, flagged as low quality. */
  allowManualOverride: z.boolean().default(true),
});

type Config = z.infer<typeof configSchema>;

/** Stored shape: `{ lat, lon, accuracy, capturedAt }`. */
const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
});

const member = (suffix: string, path: string, pgType: SafePgType): AnalyticsColumn => ({
  suffix,
  pgType,
  expr: (ctx: SqlContext) =>
    safeCast(`${ctx.data}->${ctx.literal(ctx.field.key)}->>${ctx.literal(path)}`, pgType),
});

export const geopointFieldType: FieldTypeDefinition<Config> = {
  type: 'geopoint',
  labelKey: 'fieldType.geopoint',
  icon: 'MapPin',
  configSchema,
  valueSchema: (field) => (field.isRequired ? pointSchema : pointSchema.optional().nullable()),
  // Split into scalar columns so the view is directly mappable in any BI tool
  // without unpacking JSON.
  analyticsColumns: () => [
    member('_lat', 'lat', 'double precision'),
    member('_lon', 'lon', 'double precision'),
    member('_accuracy_m', 'accuracy', 'double precision'),
  ],
  toExportValue: (value) => {
    const point = pointSchema.safeParse(value);
    return point.success ? `${point.data.lat},${point.data.lon}` : '';
  },
};
