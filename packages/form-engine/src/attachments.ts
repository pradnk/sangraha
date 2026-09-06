// Reading the registry means the registry has to exist. Imported here rather
// than relied on from the package index so this module works when it is the
// only thing a caller reaches for — the same guard `display.ts` carries.
import './field-types/index';

import { getFieldType } from './registry';
import type { FieldDefinition, FormVersionDefinition, SubmissionData } from './types';

/**
 * Finds every uploaded file a set of answers refers to.
 *
 * Photo, file and signature answers are the uuid of a row in `attachments`; the
 * bytes were uploaded before the submission was sent. The server needs the full
 * list to tie those rows to the submission once it lands, and erasure needs it
 * to know which objects to destroy.
 *
 * Reads `isAttachment` off the registry rather than naming the three types, so
 * a fourth kind of upload is covered the day it is registered — the same rule
 * that keeps the builder palette and the view generator from enumerating types.
 *
 * Repeating sections are walked too: a household roster with a photo of each
 * member holds its attachments one level down, and missing them would leave
 * every one of those files an orphan.
 */
export function collectAttachmentIds(
  version: FormVersionDefinition,
  data: SubmissionData,
): string[] {
  const found = new Set<string>();
  walk(
    version.fields.filter((field) => !field.parentGroupId),
    version.fields,
    data,
    found,
  );
  return [...found];
}

function walk(
  fields: FieldDefinition[],
  allFields: FieldDefinition[],
  data: SubmissionData,
  found: Set<string>,
): void {
  for (const field of fields) {
    const definition = getFieldType(field.dataType);
    const value = data[field.key];

    if (definition.isContainer) {
      const entries = Array.isArray(value) ? value : [];
      const children = allFields.filter((f) => f.parentGroupId === field.id);
      for (const entry of entries) {
        if (entry && typeof entry === 'object') {
          walk(children, allFields, entry as SubmissionData, found);
        }
      }
      continue;
    }

    if (!definition.isAttachment) continue;

    // A single uuid today, but stored as an array when a question accepts more
    // than one photo — both shapes are read so `maxCount` can grow without a
    // second pass over this code.
    if (typeof value === 'string' && value !== '') found.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item !== '') found.add(item);
    }
  }
}
