import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

/**
 * What `<input type="datetime-local">` produces: a wall-clock reading with no
 * timezone. Seconds are optional — browsers omit them unless a step demands it.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const configSchema = z.object({
  minuteStep: z.number().int().min(1).max(60).default(5),
});

type Config = z.infer<typeof configSchema>;

export const datetimeFieldType: FieldTypeDefinition<Config> = {
  type: 'datetime',
  labelKey: 'fieldType.datetime',
  icon: 'CalendarClock',
  configSchema,
  /*
   * A wall-clock reading, exactly like its `date` and `time` siblings.
   *
   * This used to require a full offset-bearing instant, which nothing could
   * ever satisfy: the only thing that writes this field is
   * `<input type="datetime-local">`, and that yields `2026-08-06T14:30` — no
   * seconds and no zone. Every entry was rejected as an invalid date and time,
   * so the field type was unusable from the day it shipped.
   */
  valueSchema: (field) => {
    const schema = z.string().regex(ISO_DATETIME, 'invalidDateTime');
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    {
      suffix: '',
      // `timestamp`, not `timestamptz`: what was captured is a local reading,
      // and casting it to an instant would silently attach whatever timezone
      // the database session happened to be in.
      pgType: 'timestamp',
      expr: (ctx) => safeCast(jsonText(ctx), 'timestamp'),
    },
  ],
  toExportValue: exportAsString,
};
