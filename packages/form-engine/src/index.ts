/**
 * @sangraha/form-engine
 *
 * The single source of truth for what a form is and what its answers mean.
 * The builder, the field capture UI, the REST API, CSV export and the analytics
 * view generator all read from here, so a field type only ever has to be
 * defined once.
 */

// Registering the built-in types on import means every consumer gets a
// populated registry without having to remember a setup call.
import './field-types/index';

export * from './types';
export * from './i18n';
export * from './registry';
export * from './rules';
export * from './calc';
export * from './validation';
export * from './analytics-view';
export * from './display';
export * from './text-formats';
export * from './import/table';
export * from './import/infer';
export * from './translation';
export * from './notice';
export * from './minor';
export * from './attachments';
export { registerBuiltInFieldTypes } from './field-types/index';
export type { CalcNode } from './field-types/calculated';
export type { SafePgType } from './field-types/_helpers';
