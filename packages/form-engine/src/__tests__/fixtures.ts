import type {
  FieldDataType,
  FieldDefinition,
  FormVersionDefinition,
  OptionSetDefinition,
} from '../types';

export function field(
  key: string,
  dataType: FieldDataType,
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    id: overrides.id ?? `id-${key}`,
    key,
    label: { en: key },
    dataType,
    isRequired: false,
    isUnique: false,
    sortOrder: 0,
    parentGroupId: null,
    optionSet: null,
    config: {},
    visibilityRule: null,
    isArchived: false,
    ...overrides,
  };
}

export function optionSet(code: string, codes: string[]): OptionSetDefinition {
  return {
    id: `os-${code}`,
    code,
    name: { en: code },
    options: codes.map((c, i) => ({
      code: c,
      label: { en: c.toUpperCase() },
      sortOrder: i,
      isActive: true,
    })),
  };
}

export function version(
  versionNumber: number,
  fields: FieldDefinition[],
  overrides: Partial<FormVersionDefinition> = {},
): FormVersionDefinition {
  return {
    id: `fv-${versionNumber}`,
    formId: 'form-1',
    formSlug: 'school_attendance',
    versionNumber,
    name: { en: 'School attendance' },
    formType: 'encounter',
    subjectTypeId: null,
    fields: fields.map((f, i) => ({ ...f, sortOrder: f.sortOrder || i })),
    ...overrides,
  };
}
