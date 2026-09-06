'use client';

import { Check, X } from 'lucide-react';
import type {
  FieldDataType,
  FieldDefinition,
  FormVersionDefinition,
  TextFormat,
} from '@sangraha/form-engine';
import { formatExample, formatInputMode, formatWantsCapitals } from '@sangraha/form-engine';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';
import { AttachmentAnswer } from './attachment-answer';
import { GeopointAnswer } from './geopoint-answer';
import { RepeatGroupAnswer } from './repeat-group-answer';
import { SignatureAnswer } from './signature-answer';
import { SubjectRefAnswer } from './subject-ref-answer';
import { VoiceInputButton } from './voice-input-button';

/**
 * Renders one question.
 *
 * The React renderers live here rather than in `@sangraha/form-engine` so that
 * package stays framework-free (it also runs in migrations, the API and the
 * view generator, none of which should pull in React). The coupling is kept
 * safe by `question-input.test.ts`, which fails if a registered field type has
 * no renderer and no explicit deferral.
 */

export interface QuestionInputProps {
  field: FieldDefinition;
  config: Record<string, unknown>;
  value: unknown;
  locale: string;
  /**
   * The form version this question belongs to.
   *
   * Only a repeating section needs it — its child questions are stored flat in
   * `version.fields` under a `parentGroupId`, so there is nowhere else to find
   * them. Optional so every other renderer stays independent of the form.
   */
  version?: FormVersionDefinition;
  onChange: (value: unknown) => void;
}

/**
 * Field types the field UI does not render yet.
 *
 * Listed explicitly so the coverage test can distinguish "deliberately later"
 * from "someone forgot". Empty today — every registered type is answerable.
 */
export const DEFERRED_FIELD_TYPES: readonly FieldDataType[] = [];

export function QuestionInput(props: QuestionInputProps) {
  switch (props.field.dataType) {
    case 'short_text':
    case 'long_text':
      return <TextAnswer {...props} />;
    case 'phone':
      return <PhoneAnswer {...props} />;
    case 'number':
    case 'integer':
      return <NumberAnswer {...props} />;
    case 'date':
      return <DateAnswer {...props} />;
    case 'time':
      return <BasicAnswer {...props} inputType="time" />;
    case 'datetime':
      return <BasicAnswer {...props} inputType="datetime-local" />;
    case 'boolean':
      return <BooleanAnswer {...props} />;
    case 'single_choice':
      return <SingleChoiceAnswer {...props} />;
    case 'multi_choice':
      return <MultiChoiceAnswer {...props} />;
    case 'rating':
      return <RatingAnswer {...props} />;
    case 'calculated':
      return <CalculatedAnswer {...props} />;
    case 'subject_ref':
      return <SubjectRefAnswer {...props} />;
    case 'geopoint':
      return <GeopointAnswer {...props} />;
    case 'repeat_group':
      return <RepeatGroupAnswer {...props} />;
    // Photo and file differ only in what they accept and how the chosen file is
    // previewed, which is the component's own business — a second near-identical
    // renderer would be two places to fix the upload path.
    case 'photo':
    case 'file':
      return <AttachmentAnswer {...props} />;
    case 'signature':
      return <SignatureAnswer {...props} />;
    default:
      return <NotYetSupported dataType={props.field.dataType} />;
  }
}

function TextAnswer({ field, config, value, locale, onChange }: QuestionInputProps) {
  const multiline = field.dataType === 'long_text';
  const text = typeof value === 'string' ? value : '';

  /*
   * A question set to a format gets the keyboard that suits it and an example
   * to copy the shape of. An Aadhaar question that opens a full QWERTY keyboard
   * is twelve chances to mistype.
   */
  const format = (config.format as TextFormat) ?? 'any';
  const pattern = typeof config.formatPattern === 'string' ? config.formatPattern : undefined;
  const example = formatExample(format, pattern);

  // Dictating an email address does not work: speech recognition writes "at"
  // rather than "@". Offered wherever the answer is ordinary prose.
  const allowVoice = config.allowVoiceInput !== false && format === 'any';

  return (
    <div className="flex items-start gap-3">
      {multiline ? (
        <textarea
          value={text}
          onChange={(event) => onChange(event.target.value)}
          rows={Number(config.rows ?? 4)}
          maxLength={Number(config.maxLength ?? 4000)}
          className="field-control flex-1 py-3"
        />
      ) : (
        <input
          type="text"
          value={text}
          onChange={(event) => onChange(event.target.value)}
          maxLength={Number(config.maxLength ?? 255)}
          inputMode={formatInputMode(format)}
          autoCapitalize={formatWantsCapitals(format) ? 'characters' : 'none'}
          autoCorrect={format === 'any' ? undefined : 'off'}
          spellCheck={format === 'any' ? undefined : false}
          placeholder={example || undefined}
          className="field-control flex-1 py-3"
        />
      )}
      {allowVoice ? (
        <VoiceInputButton
          locale={locale}
          // Appends rather than replaces, so a worker can dictate a correction
          // or a second sentence without losing what is already there.
          onTranscript={(transcript) => onChange(text ? `${text} ${transcript}` : transcript)}
        />
      ) : null}
    </div>
  );
}

function PhoneAnswer({ value, onChange }: QuestionInputProps) {
  return (
    <input
      type="tel"
      inputMode="tel"
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value)}
      // Not restricted to digits on the way in: the validator normalises
      // "+91 98765 43210" and "098765-43210" alike, and rejecting them at the
      // keystroke would just confuse someone typing the number they know.
      className="field-control py-3 tracking-wide"
    />
  );
}

function NumberAnswer({ field, config, value, onChange }: QuestionInputProps) {
  const unit = typeof config.unit === 'string' ? config.unit : null;

  return (
    <div className="flex items-center gap-3">
      <input
        type="number"
        // `decimal` gives a keypad with a decimal point; `numeric` omits it.
        inputMode={field.dataType === 'integer' ? 'numeric' : 'decimal'}
        step={field.dataType === 'integer' ? 1 : 'any'}
        min={typeof config.min === 'number' ? config.min : undefined}
        max={typeof config.max === 'number' ? config.max : undefined}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(event) => onChange(event.target.value)}
        className="field-control flex-1 py-3"
      />
      {unit ? <span className="text-field-base text-slate-600">{unit}</span> : null}
    </div>
  );
}

function DateAnswer({ config, value, locale, onChange }: QuestionInputProps) {
  const showToday = config.showTodayShortcut !== false;

  return (
    <div className="flex flex-col gap-3">
      <input
        type="date"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        className="field-control py-3"
      />
      {showToday ? (
        // Most dates captured in the field are today's. One tap beats three
        // spins of a date picker.
        <button
          type="button"
          onClick={() => onChange(new Date().toISOString().slice(0, 10))}
          className="field-button border-2 border-brand-500 bg-white text-brand-700"
        >
          {m(locale, 'today')}
        </button>
      ) : null}
    </div>
  );
}

function BasicAnswer({
  value,
  onChange,
  inputType,
}: QuestionInputProps & { inputType: string }) {
  return (
    <input
      type={inputType}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value)}
      className="field-control py-3"
    />
  );
}

function BooleanAnswer({ config, value, locale, onChange }: QuestionInputProps) {
  const labels = config as { trueLabel?: Record<string, string>; falseLabel?: Record<string, string> };
  const yes = t(labels.trueLabel, locale, m(locale, 'yes'));
  const no = t(labels.falseLabel, locale, m(locale, 'no'));

  // Two full-width buttons, each with an icon as well as a colour. Colour alone
  // would fail for red-green colour blindness.
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => onChange(true)}
        aria-pressed={value === true}
        className={
          value === true
            ? 'field-button bg-affirm-500 text-white'
            : 'field-button border-2 border-slate-300 bg-white text-slate-800'
        }
      >
        <Check aria-hidden className="h-6 w-6" />
        {yes}
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        aria-pressed={value === false}
        className={
          value === false
            ? 'field-button bg-deny-500 text-white'
            : 'field-button border-2 border-slate-300 bg-white text-slate-800'
        }
      >
        <X aria-hidden className="h-6 w-6" />
        {no}
      </button>
    </div>
  );
}

function SingleChoiceAnswer({ field, value, locale, onChange }: QuestionInputProps) {
  const options = (field.optionSet?.options ?? []).filter((option) => option.isActive);

  // Full-width buttons rather than a <select>: a native dropdown is a small
  // target, hides the choices until tapped, and renders inconsistently on the
  // low-end Android browsers this has to work on.
  return (
    <div className="flex flex-col gap-3">
      {options.map((option) => {
        const selected = value === option.code;
        return (
          <button
            key={option.code}
            type="button"
            onClick={() => onChange(option.code)}
            aria-pressed={selected}
            className={
              selected
                ? 'field-button justify-start bg-brand-600 text-white'
                : 'field-button justify-start border-2 border-slate-300 bg-white text-slate-800'
            }
          >
            {selected ? <Check aria-hidden className="h-6 w-6 shrink-0" /> : null}
            <span className="text-left">{t(option.label, locale, option.code)}</span>
          </button>
        );
      })}
    </div>
  );
}

function MultiChoiceAnswer({ field, value, locale, onChange }: QuestionInputProps) {
  const options = (field.optionSet?.options ?? []).filter((option) => option.isActive);
  const selected = Array.isArray(value) ? (value as string[]) : [];

  const toggle = (code: string) =>
    onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);

  return (
    <div className="flex flex-col gap-3">
      {options.map((option) => {
        const isSelected = selected.includes(option.code);
        return (
          <button
            key={option.code}
            type="button"
            onClick={() => toggle(option.code)}
            aria-pressed={isSelected}
            className={
              isSelected
                ? 'field-button justify-start bg-brand-600 text-white'
                : 'field-button justify-start border-2 border-slate-300 bg-white text-slate-800'
            }
          >
            <span
              aria-hidden
              className={
                isSelected
                  ? 'flex h-7 w-7 shrink-0 items-center justify-center rounded border-2 border-white bg-white'
                  : 'h-7 w-7 shrink-0 rounded border-2 border-slate-400'
              }
            >
              {isSelected ? <Check className="h-5 w-5 text-brand-600" /> : null}
            </span>
            <span className="text-left">{t(option.label, locale, option.code)}</span>
          </button>
        );
      })}
    </div>
  );
}

function RatingAnswer({ config, value, onChange }: QuestionInputProps) {
  const max = Number(config.max ?? 5);
  const display = String(config.display ?? 'faces');
  // Faces need no reading at all, which is why they are the default for
  // satisfaction and wellbeing questions.
  const faces = ['😞', '🙁', '😐', '🙂', '😀'];

  return (
    <div className="flex flex-wrap gap-3">
      {Array.from({ length: max }, (_, index) => {
        const score = index + 1;
        const selected = value === score;
        const glyph =
          display === 'faces'
            ? (faces[Math.round((index / Math.max(1, max - 1)) * (faces.length - 1))] ?? '🙂')
            : display === 'stars'
              ? '★'
              : String(score);

        return (
          <button
            key={score}
            type="button"
            onClick={() => onChange(score)}
            aria-label={`${score} / ${max}`}
            aria-pressed={selected}
            className={
              selected
                ? 'flex min-h-tap-lg min-w-tap-lg items-center justify-center rounded-field bg-brand-600 text-2xl text-white'
                : 'flex min-h-tap-lg min-w-tap-lg items-center justify-center rounded-field border-2 border-slate-300 bg-white text-2xl'
            }
          >
            {glyph}
          </button>
        );
      })}
    </div>
  );
}

function CalculatedAnswer({ config, value }: QuestionInputProps) {
  const unit = typeof config.unit === 'string' ? config.unit : null;

  // Read-only: computed from earlier answers and shown so the worker can sanity
  // check it. Never an input, so it is never required.
  return (
    <output className="flex min-h-tap items-center rounded-field bg-slate-100 px-4 text-field-lg font-semibold text-slate-800">
      {value === null || value === undefined || value === '' ? '—' : String(value)}
      {unit ? <span className="ml-2 text-field-base font-normal text-slate-600">{unit}</span> : null}
    </output>
  );
}

function NotYetSupported({ dataType }: { dataType: FieldDataType }) {
  return (
    <p className="rounded-field bg-amber-50 p-4 text-field-sm text-amber-900">
      This question type ({dataType}) cannot be answered in the app yet.
    </p>
  );
}
