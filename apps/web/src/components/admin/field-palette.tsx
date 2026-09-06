'use client';

import {
  AlignLeft,
  Binary,
  Calendar,
  CalendarClock,
  Camera,
  CircleDot,
  Clock,
  Hash,
  IdCard,
  Link2,
  Mail,
  ListChecks,
  MapPin,
  Paperclip,
  PenLine,
  Phone,
  Repeat,
  Sigma,
  Star,
  ToggleLeft,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { listFieldTypes, type FieldDataType } from '@sangraha/form-engine';
import { DEFERRED_FIELD_TYPES } from '@/components/field/question-input';

/**
 * Icons named by the field type registry, imported explicitly.
 *
 * A namespace import of lucide-react pulls the whole library into the bundle —
 * it cost this page 174 kB. The registry supplies an icon *name*, so the
 * mapping has to live somewhere; here it is, small and tree-shakeable.
 */
const ICONS: Record<string, LucideIcon> = {
  Type,
  AlignLeft,
  Hash,
  Binary,
  Calendar,
  Clock,
  CalendarClock,
  ToggleLeft,
  CircleDot,
  ListChecks,
  Camera,
  Paperclip,
  MapPin,
  Phone,
  PenLine,
  Star,
  Repeat,
  Sigma,
  Link2,
};

/**
 * The add-a-question palette.
 *
 * Every type is named in the words a programme manager would use — "Choose one
 * answer", not "enum" — and paired with an icon. The list is read from the
 * field type registry, so a new type appears here the moment it is registered,
 * with no second place to update.
 *
 * Types the capture UI cannot yet render are hidden rather than shown broken.
 */
const PLAIN_NAMES: Record<FieldDataType, { name: string; hint: string }> = {
  short_text: { name: 'Short text', hint: 'A name, a place' },
  long_text: { name: 'Long text', hint: 'Notes, a description' },
  number: { name: 'Number', hint: 'Weight, height, amount' },
  integer: { name: 'Whole number', hint: 'A count, an age' },
  date: { name: 'Date', hint: 'Picked from a calendar' },
  time: { name: 'Time', hint: 'Hours and minutes' },
  datetime: { name: 'Date and time', hint: 'Both together' },
  boolean: { name: 'Yes or no', hint: 'Two big buttons' },
  single_choice: { name: 'Choose one answer', hint: 'From a list you set' },
  multi_choice: { name: 'Choose several answers', hint: 'Tick any that apply' },
  phone: { name: 'Phone number', hint: 'Ten digits' },
  rating: { name: 'Rating', hint: 'Faces or stars' },
  calculated: { name: 'Calculated', hint: 'Worked out from other answers' },
  photo: { name: 'Photo', hint: 'Taken with the camera' },
  file: { name: 'File', hint: 'A document' },
  signature: { name: 'Signature', hint: 'Signed on screen' },
  geopoint: { name: 'GPS location', hint: 'Where the worker is' },
  subject_ref: { name: 'Link to a person', hint: 'Pick someone already registered' },
  repeat_group: { name: 'Repeating section', hint: '"Add another…"' },
};

/**
 * Tiles that are a field type with a format already chosen.
 *
 * Somebody collecting an email address looks for "Email", not for "Short text,
 * then change a setting". These create an ordinary text question with the
 * format preset — one mechanism underneath, still changeable afterwards — so
 * the palette stays discoverable without a second kind of field to maintain.
 */
const PRESETS: {
  key: string;
  type: FieldDataType;
  icon: LucideIcon;
  name: string;
  hint: string;
  config: Record<string, unknown>;
}[] = [
  {
    key: 'email',
    type: 'short_text',
    icon: Mail,
    name: 'Email address',
    hint: 'rahul@ngo.org',
    config: { format: 'email' },
  },
  {
    key: 'aadhaar',
    type: 'short_text',
    icon: IdCard,
    name: 'Aadhaar number',
    hint: '12 digits, checked',
    config: { format: 'aadhaar' },
  },
];

export function FieldPalette({
  onAdd,
  busy,
}: {
  onAdd: (type: FieldDataType, config?: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const available = listFieldTypes()
    .map((definition) => definition.type)
    .filter((type) => !DEFERRED_FIELD_TYPES.includes(type));

  return (
    <div className="grid grid-cols-2 gap-2">
      {available.map((type) => {
        const meta = PLAIN_NAMES[type];
        const definition = listFieldTypes().find((d) => d.type === type)!;
        const Icon = ICONS[definition.icon] ?? CircleDot;

        return (
          <button
            key={type}
            type="button"
            disabled={busy}
            onClick={() => onAdd(type)}
            className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-2.5 text-left hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50"
          >
            <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
            <span className="min-w-0">
              {/*
               * Wrapped, not truncated. The hint is the only thing telling a
               * programme manager what "Calculated" or "Link to a person"
               * means, and "Worked out from oth…" tells them nothing — the
               * words were being cut off exactly where they started to explain.
               */}
              <span className="block font-medium">{meta.name}</span>
              <span className="block text-xs leading-snug text-slate-500">{meta.hint}</span>
            </span>
          </button>
        );
      })}

      {PRESETS.map((preset) => (
        <button
          key={preset.key}
          type="button"
          disabled={busy}
          onClick={() => onAdd(preset.type, preset.config)}
          className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-2.5 text-left hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50"
        >
          <preset.icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
          <span className="min-w-0">
            <span className="block font-medium">{preset.name}</span>
            <span className="block text-xs leading-snug text-slate-500">{preset.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export { PLAIN_NAMES };
