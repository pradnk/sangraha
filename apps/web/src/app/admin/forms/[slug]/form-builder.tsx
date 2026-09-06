'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Fingerprint,
  Info,
  Languages,
  Rocket,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { FieldDataType, FormVersionDefinition, I18nText } from '@sangraha/form-engine';
import { localise } from '@sangraha/form-engine';
import { FormCapture } from '@/components/field/form-capture';
import { FieldPalette, PLAIN_NAMES } from '@/components/admin/field-palette';
import { SubjectTypePanel } from './subject-type-panel';
import { FieldEditor, type OptionSetSummary } from '@/components/admin/field-editor';
import {
  addFieldAction,
  archiveFieldAction,
  deleteFieldAction,
  discardDraftAction,
  publishAction,
  reorderFieldsAction,
  updateFieldAction,
  type BuilderState,
} from './actions';
import { translateFormAction } from './translate-actions';

/**
 * The form builder.
 *
 * Questions on the left, the real capture UI on the right. The preview is not a
 * mock — it is the same `FormCapture` a field worker uses, in `preview` mode —
 * so what the admin sees while editing is what will actually reach the phone,
 * including skip logic behaviour.
 *
 * Every edit round-trips to the server rather than being buffered behind a Save
 * button. Slower per keystroke, but there is no unsaved state to lose and no
 * second copy of the form's truth living in the browser.
 */
export function FormBuilder({
  slug,
  formName,
  formType,
  subjectTypeId,
  subjectTypes,
  unregisteredCount,
  version,
  publishState,
  versionNumber,
  answerCounts,
  optionSets,
  purposes,
  locale,
  canTranslate,
  extraLocales,
}: {
  slug: string;
  formName: I18nText;
  formType: 'registration' | 'encounter' | 'standalone';
  /** Null on a form that is about somebody but has never said who. */
  subjectTypeId: string | null;
  subjectTypes: { id: string; name: I18nText; code: string }[];
  unregisteredCount: number;
  version: FormVersionDefinition | null;
  /** never = no version has ever gone out to field workers. */
  publishState: 'never' | 'draft' | 'published';
  versionNumber: number | null;
  answerCounts: Record<string, number>;
  optionSets: OptionSetSummary[];
  purposes: { id: string; code: string; name: Record<string, string> }[];
  locale: string;
  /** False when no translation provider is configured — the button is hidden. */
  canTranslate: boolean;
  /** Languages beyond English this organisation has turned on. */
  extraLocales: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<BuilderState>({});
  /** Field awaiting a delete confirmation, by id. */
  const [removing, setRemoving] = useState<string | null>(null);

  const fields = (version?.fields ?? [])
    .filter((f) => !f.parentGroupId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const selected = fields.find((f) => f.id === selectedId) ?? null;
  const selectedIndex = selected ? fields.indexOf(selected) : -1;

  /** Runs an action, surfaces whatever it says, and refreshes from the server. */
  const run = (action: () => Promise<BuilderState>) =>
    startTransition(async () => {
      const result = await action();
      setMessage(result);
      if (result.selectId) setSelectedId(result.selectId);
      router.refresh();
    });

  const move = (direction: -1 | 1) => {
    if (selectedIndex < 0) return;
    moveField(selectedIndex, direction);
  };

  /**
   * Swaps a question with its neighbour.
   *
   * Takes the index rather than reading the selection, so a row can be moved
   * without selecting it first — putting a form in order should not mean
   * select, move, select, move with the list shifting under the cursor.
   */
  function moveField(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const order = fields.map((f) => f.id);
    [order[index], order[target]] = [order[target]!, order[index]!];
    run(() => reorderFieldsAction(slug, order));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/admin/forms"
          className="inline-flex items-center gap-1.5 text-brand-700 hover:underline"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Forms
        </Link>
        <h1 className="text-xl font-bold">{localise(formName, locale, slug)}</h1>

        {publishState === 'never' ? (
          <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700">
            Not published yet
          </span>
        ) : publishState === 'draft' ? (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
            Unpublished changes
          </span>
        ) : (
          <span className="rounded-full bg-affirm-50 px-2.5 py-1 text-xs font-medium text-affirm-700">
            Published · version {versionNumber}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Needs somewhere to translate *into* and a provider to do it. When
              either is missing the button is not shown — but silence is why an
              admin comes away thinking the feature does not exist, so the
              reason is spelled out below instead. */}
          {canTranslate && extraLocales.length > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await translateFormAction(slug);
                  setMessage(
                    result.error
                      ? { error: result.error }
                      : {
                          warning: result.filled
                            ? `Filled in ${result.filled} translation${result.filled === 1 ? '' : 's'}. They are machine-made drafts — check them before publishing.`
                            : 'Every question already has a translation.',
                        },
                  );
                  router.refresh();
                })
              }
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
            >
              <Languages aria-hidden className="h-4 w-4" />
              Translate
            </button>
          ) : null}
          {publishState === 'draft' ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => discardDraftAction(slug))}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
            >
              <Undo2 aria-hidden className="h-4 w-4" />
              Discard changes
            </button>
          ) : null}
          <button
            type="button"
            // Only enabled when there is actually something unpublished.
            disabled={pending || publishState !== 'draft'}
            onClick={() => run(() => publishAction(slug))}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <Rocket aria-hidden className="h-4 w-4" />
            Publish to field workers
          </button>
        </div>
      </div>

      {message.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700"
        >
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.error}
        </p>
      ) : null}
      {message.warning ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-amber-900">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.warning}
        </p>
      ) : null}

      {/*
       * Why there is no Translate button.
       *
       * It used to simply not be there, which reads as "this product cannot do
       * that" rather than "you have not switched on a second language". The
       * two causes need different things done about them, so they say
       * different things.
       */}
      {extraLocales.length === 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          <Languages aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>
            This organisation only uses English, so there is nothing to translate into. Turn on
            another language under{' '}
            <Link href="/admin/settings#languages" className="font-medium text-brand-700 underline">
              Organisation
            </Link>{' '}
            and a <strong>Translate</strong> button appears here.
          </span>
        </p>
      ) : !canTranslate ? (
        <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          <Languages aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>
            Questions can be translated into {extraLocales.length === 1 ? 'this' : 'these'}{' '}
            language{extraLocales.length === 1 ? '' : 's'} by hand below. Automatic translation
            needs a Google Translate credential — see <code>GOOGLE_TRANSLATE_API_KEY</code> in the
            README.
          </span>
        </p>
      ) : null}

      {/* Above the questions: a registration form pointed at nobody collects
          answers and registers no one, and that has to be the first thing an
          admin sees on this screen, not a detail below the fold. */}
      <SubjectTypePanel
        slug={slug}
        formType={formType}
        subjectTypeId={subjectTypeId}
        subjectTypes={subjectTypes}
        unregisteredCount={unregisteredCount}
        locale={locale}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px_360px]">
        {/* Questions */}
        <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Questions</h2>

          {fields.length === 0 ? (
            <p className="rounded-lg bg-slate-50 p-4 text-center text-slate-500">
              No questions yet. Add one from the list on the right.
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {fields.map((field, index) => {
                const answers = answerCounts[field.key] ?? 0;
                const isSelected = field.id === selectedId;

                return (
                  <li
                    key={field.id}
                    className={`flex items-start gap-1 rounded-lg border ${
                      isSelected ? 'border-brand-500 bg-brand-50' : 'border-slate-200'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(field.id)}
                      className="flex min-w-0 flex-1 items-start gap-3 rounded-l-lg p-2.5 text-left hover:bg-slate-50/60"
                    >
                      <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-slate-400">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">
                            {localise(field.label, locale, field.key)}
                          </span>
                          {field.isRequired ? (
                            <span aria-label="required" className="text-deny-500">
                              *
                            </span>
                          ) : null}
                          {field.isUnique ? (
                            <Fingerprint
                              aria-label="must not repeat"
                              className="h-3.5 w-3.5 shrink-0 text-brand-500"
                            />
                          ) : null}
                          {field.isArchived ? (
                            <EyeOff
                              aria-label="no longer asked"
                              className="h-3.5 w-3.5 shrink-0 text-slate-400"
                            />
                          ) : null}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {PLAIN_NAMES[field.dataType]?.name ?? field.dataType}
                          {field.visibilityRule ? ' · shown conditionally' : ''}
                          {answers ? ` · ${answers} answers` : ''}
                        </span>
                      </span>
                    </button>

                    {/*
                     * Reordering and removing, on the row itself.
                     *
                     * These used to be reachable only by selecting a question
                     * and working in the editor panel — so putting a form in
                     * order meant select, move, select, move, with the list
                     * jumping under the cursor each time. Here it is the list
                     * you are looking at that you act on.
                     */}
                    <span className="flex shrink-0 items-center gap-0.5 py-2 pr-1.5">
                      <RowButton
                        label={`Move "${localise(field.label, locale, field.key)}" up`}
                        disabled={pending || index === 0}
                        onClick={() => moveField(index, -1)}
                      >
                        <ChevronUp aria-hidden className="h-4 w-4" />
                      </RowButton>
                      <RowButton
                        label={`Move "${localise(field.label, locale, field.key)}" down`}
                        disabled={pending || index === fields.length - 1}
                        onClick={() => moveField(index, 1)}
                      >
                        <ChevronDown aria-hidden className="h-4 w-4" />
                      </RowButton>

                      {/*
                       * The same rule as the editor, not a looser one: a
                       * question holding answers is archived, never deleted,
                       * because deleting it would hide answers a field worker
                       * actually collected from every report.
                       */}
                      {answers === 0 ? (
                        <RowButton
                          label={`Delete "${localise(field.label, locale, field.key)}"`}
                          tone="danger"
                          disabled={pending}
                          onClick={() => setRemoving(field.id)}
                        >
                          <Trash2 aria-hidden className="h-4 w-4" />
                        </RowButton>
                      ) : (
                        <RowButton
                          label={
                            field.isArchived
                              ? `Ask "${localise(field.label, locale, field.key)}" again`
                              : `Stop asking "${localise(field.label, locale, field.key)}"`
                          }
                          disabled={pending}
                          onClick={() =>
                            run(() => archiveFieldAction(slug, field.id, !field.isArchived))
                          }
                        >
                          {field.isArchived ? (
                            <ArchiveRestore aria-hidden className="h-4 w-4" />
                          ) : (
                            <Archive aria-hidden className="h-4 w-4" />
                          )}
                        </RowButton>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {/* Confirmed once, in place, naming the question — a delete button on
              every row is easy to hit by accident. */}
          {removing ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
              <span className="flex-1">
                Delete “{localise(
                  fields.find((f) => f.id === removing)?.label ?? {},
                  locale,
                  '',
                )}”?
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const id = removing;
                  setRemoving(null);
                  if (selectedId === id) setSelectedId(null);
                  run(() => deleteFieldAction(slug, id));
                }}
                className="rounded-lg bg-deny-500 px-3 py-1.5 font-medium text-white"
              >
                Delete for good
              </button>
              <button
                type="button"
                onClick={() => setRemoving(null)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5"
              >
                Keep it
              </button>
            </div>
          ) : null}

          <div className="border-t border-slate-200 pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Add a question
            </h3>
            <FieldPalette
              busy={pending}
              onAdd={(type: FieldDataType, config?: Record<string, unknown>) =>
                run(() => addFieldAction(slug, type, config))
              }
            />
          </div>
        </section>

        {/* Editor for the selected question */}
        <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4">
          {selected ? (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Edit question</h2>
                <span className="flex gap-1">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={pending || selectedIndex === 0}
                    onClick={() => move(-1)}
                    className="rounded border border-slate-300 p-1 disabled:opacity-30"
                  >
                    <ChevronUp aria-hidden className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={pending || selectedIndex === fields.length - 1}
                    onClick={() => move(1)}
                    className="rounded border border-slate-300 p-1 disabled:opacity-30"
                  >
                    <ChevronDown aria-hidden className="h-4 w-4" />
                  </button>
                </span>
              </div>

              <FieldEditor
                key={selected.id}
                field={selected}
                // A rule may only depend on a question the worker has already
                // been asked, so only earlier fields are offered.
                earlierFields={fields.slice(0, selectedIndex)}
                optionSets={optionSets}
                purposes={purposes}
                answerCount={answerCounts[selected.key] ?? 0}
                locale={locale}
                busy={pending}
                onPatch={(patch) =>
                  run(() => updateFieldAction(slug, { fieldId: selected.id, ...patch }))
                }
                onDelete={() => {
                  setSelectedId(null);
                  run(() => deleteFieldAction(slug, selected.id));
                }}
                onArchive={(archived) =>
                  run(() => archiveFieldAction(slug, selected.id, archived))
                }
              />
            </>
          ) : (
            <p className="rounded-lg bg-slate-50 p-4 text-center text-slate-500">
              Choose a question to edit it.
            </p>
          )}
        </section>

        {/* Live preview */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">On a phone</h2>
          <div className="overflow-hidden rounded-[2rem] border-8 border-slate-800 bg-white shadow-lg">
            <div className="theme-field h-[600px] overflow-y-auto">
              {version && fields.some((f) => !f.isArchived) ? (
                <FormCapture
                  // Remounts whenever the form changes, so the preview always
                  // starts from the first question rather than stranding the
                  // admin mid-way through a form they just edited.
                  key={previewKey(fields)}
                  version={version}
                  locale={locale}
                  locationId={null}
                  preview
                />
              ) : (
                <p className="p-5 text-field-base text-slate-500">
                  Add a question to see the form here.
                </p>
              )}
            </div>
          </div>
          <p className="text-center text-xs text-slate-500">
            This is the real screen a field worker sees. Nothing you enter here is saved.
          </p>
        </section>
      </div>
    </div>
  );
}

/** Changes whenever anything the preview renders changes. */
function previewKey(fields: { id: string; label: I18nText; isRequired: boolean; isArchived: boolean }[]): string {
  return fields
    .map((f) => `${f.id}:${Object.values(f.label).join('|')}:${f.isRequired}:${f.isArchived}`)
    .join(',');
}

/** A small square control on a question row. Icon-only, so the label matters. */
function RowButton({
  label,
  onClick,
  disabled,
  tone = 'default',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-1.5 disabled:opacity-25 ${
        tone === 'danger'
          ? 'text-deny-600 hover:bg-deny-50'
          : 'text-slate-500 hover:bg-slate-200 hover:text-slate-900'
      }`}
    >
      {children}
    </button>
  );
}
