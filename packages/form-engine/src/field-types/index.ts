/**
 * The field type catalogue.
 *
 * Adding a type is a two-line change here plus one new module in this folder.
 * Nothing else in the codebase enumerates field types — the builder palette,
 * the capture renderer, request validation, CSV export and the analytics view
 * generator all read from this registry.
 */
import { registerFieldType } from '../registry';

import { booleanFieldType } from './boolean';
import { calculatedFieldType } from './calculated';
import { dateFieldType } from './date';
import { datetimeFieldType } from './datetime';
import { fileFieldType } from './file';
import { geopointFieldType } from './geopoint';
import { integerFieldType } from './integer';
import { longTextFieldType } from './long-text';
import { multiChoiceFieldType } from './multi-choice';
import { numberFieldType } from './number';
import { phoneFieldType } from './phone';
import { photoFieldType } from './photo';
import { ratingFieldType } from './rating';
import { repeatGroupFieldType } from './repeat-group';
import { shortTextFieldType } from './short-text';
import { signatureFieldType } from './signature';
import { singleChoiceFieldType } from './single-choice';
import { subjectRefFieldType } from './subject-ref';
import { timeFieldType } from './time';

let registered = false;

/** Idempotent so tests and hot reload can call it freely. */
export function registerBuiltInFieldTypes(): void {
  if (registered) return;
  registered = true;

  registerFieldType(shortTextFieldType);
  registerFieldType(longTextFieldType);
  registerFieldType(numberFieldType);
  registerFieldType(integerFieldType);
  registerFieldType(dateFieldType);
  registerFieldType(timeFieldType);
  registerFieldType(datetimeFieldType);
  registerFieldType(booleanFieldType);
  registerFieldType(singleChoiceFieldType);
  registerFieldType(multiChoiceFieldType);
  registerFieldType(photoFieldType);
  registerFieldType(fileFieldType);
  registerFieldType(geopointFieldType);
  registerFieldType(phoneFieldType);
  registerFieldType(signatureFieldType);
  registerFieldType(ratingFieldType);
  registerFieldType(repeatGroupFieldType);
  registerFieldType(calculatedFieldType);
  registerFieldType(subjectRefFieldType);
}

registerBuiltInFieldTypes();

export { calculatedFieldType, type CalcNode } from './calculated';
