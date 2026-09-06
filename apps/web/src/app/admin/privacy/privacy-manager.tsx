'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FileText,
  Plus,
  Target,
  Trash2,
} from 'lucide-react';
import type { I18nText } from '@sangraha/form-engine';
// Type-only: a value import from `@sangraha/db` drags postgres into the browser.
import type {
  ConsentSummary,
  ErasureRequestRow,
  HeldBack,
  LawfulBasis,
  NoticeDetail,
  PendingOverride,
  Purpose,
} from '@sangraha/db';
import { t } from '@/lib/i18n';
import {
  createNoticeAction,
  createPurposeAction,
  decideOverrideAction,
  discardNoticeAction,
  generateNoticeAction,
  publishNoticeAction,
  saveNoticeDraftAction,
  updatePurposeAction,
  type PrivacyState,
} from './actions';
import { purgeAction, type HeldBackRequest } from './erasure-actions';

/**
 * Privacy, in an NGO administrator's words rather than the Act's.
 *
 * Nobody here has a Data Protection Officer or wants to learn what a "lawful
 * basis" is. What they do know is what their programme does and who it serves,
 * so the questions are asked that way — "why do you collect this?" rather than
 * "specify the purpose of processing".
 */
export function PrivacyManager({
  purposes,
  notices,
  unattributed,
  identityMissing,
  summary,
  overrides,
  erasures,
  holds,
  locale,
}: {
  purposes: Purpose[];
  notices: NoticeDetail[];
  unattributed: { formSlug: string; key: string; label: I18nText }[];
  identityMissing: string[];
  summary: ConsentSummary;
  overrides: PendingOverride[];
  erasures: ErasureRequestRow[];
  holds: HeldBack[];
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<PrivacyState>({});
  const [newPurpose, setNewPurpose] = useState('');
  const [newNotice, setNewNotice] = useState('');

  const run = (work: () => Promise<PrivacyState>) =>
    startTransition(async () => {
      setMessage(await work());
      router.refresh();
    });

  /*
   * The two things that decide whether anybody is ever asked for permission.
   *
   * `consentRequirementFor` returns null — and the capture screen shows no
   * consent step at all — unless a live purpose rests on consent *and* a
   * published notice covers it. Both were only discoverable by reading the two
   * section subtitles and inferring it, so an organisation could register
   * children for weeks without being asked anything and without being told.
   */
  const consentPurposes = purposes.filter(
    (purpose) =>
      purpose.isActive &&
      (purpose.lawfulBasis === 'consent' || purpose.lawfulBasis === 'guardian_consent'),
  );
  const publishedNotices = notices.filter((notice) => notice.currentVersionId !== null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Privacy</h1>
        <p className="mt-1 text-slate-600">
          What you collect, why you collect it, and what you tell people about it.
        </p>
      </div>

      <ConsentReadiness
        hasConsentPurpose={consentPurposes.length > 0}
        hasPublishedNotice={publishedNotices.length > 0}
      />

      {message.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-sm text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.error}
        </p>
      ) : null}

      {identityMissing.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            A notice has to name your organisation and say how to complain to it.{' '}
            <Link href="/admin/settings" className="font-medium underline">
              Fill in your legal details
            </Link>{' '}
            first.
          </span>
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="People who agreed" value={summary.peopleWithConsent} />
        <Figure
          label="Said no or withdrew"
          value={summary.peopleWithoutConsent}
          muted={summary.peopleWithoutConsent === 0}
        />
        {/* Loud on purpose. This is the highest-penalty failure in the Act and
            the one nobody would otherwise go looking for. */}
        <Figure
          label="Children with no guardian"
          value={summary.childrenWithoutGuardian}
          alarming={summary.childrenWithoutGuardian > 0}
        />
        <Figure
          label="Waiting for a supervisor"
          value={summary.overridesPending}
          alarming={summary.overridesPending > 0}
        />
      </dl>

      {summary.medianSecondsShown !== null && summary.medianSecondsShown < 15 ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {/* The only objective signal of attestation quality that exists, given
              there is no signature. A training problem nothing else reveals. */}
          Your team spends a median of <strong>{summary.medianSecondsShown} seconds</strong> on the
          notice screen. That is not long enough to read it out — it is worth checking they know
          they are meant to.
        </p>
      ) : null}

      {overrides.length > 0 ? (
        <section className="rounded-lg border border-deny-200 bg-deny-50 p-4">
          <h2 className="text-sm font-semibold text-deny-800">
            {overrides.length} record{overrides.length === 1 ? '' : 's'} about a child with no
            guardian named
          </h2>
          <p className="mt-1 text-xs text-deny-700">
            A worker recorded these and moved on, which is right — stopping them mid-visit produces
            invented names. Someone needs to look at each one and say what happened. The record
            stays marked either way.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {overrides.map((override) => (
              <OverrideRow key={override.eventId} override={override} pending={pending} run={run} />
            ))}
          </ul>
        </section>
      ) : null}

      <section
        id="purposes"
        className="flex flex-col gap-3 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <div className="flex items-center gap-2">
          <Target aria-hidden className="h-4 w-4 text-brand-600" />
          <h2 className="font-semibold">Why you collect things</h2>
        </div>
        <p className="text-xs text-slate-500">
          {/* The Act's word is "purpose"; the reason it matters is that agreement
              has to be to something specific. Said as the consequence, not the term. */}
          People agree to a specific thing, not to &ldquo;data collection&rdquo; in general. Each of
          these is one thing you do — running a programme, delivering a scheme — and every question
          on your forms should belong to one.{' '}
          <strong className="text-slate-700">
            Until at least one of these rests on the person&rsquo;s permission, your team is never
            asked to get it.
          </strong>
        </p>

        {purposes.length === 0 ? (
          <p className="rounded bg-slate-50 p-4 text-center text-sm text-slate-500">
            Nothing yet. Start with the programme you run.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {purposes.map((purpose) => (
              <PurposeRow key={purpose.id} purpose={purpose} locale={locale} pending={pending} run={run} />
            ))}
          </ul>
        )}

        <div className="flex gap-2 pt-1">
          <input
            value={newPurpose}
            onChange={(event) => setNewPurpose(event.target.value)}
            placeholder="run the mid-day meal programme"
            maxLength={200}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={pending || newPurpose.trim().length < 3}
            onClick={() =>
              run(async () => {
                const result = await createPurposeAction({ name: newPurpose.trim() });
                if (result.ok) setNewPurpose('');
                return result;
              })
            }
            className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            <Plus aria-hidden className="h-4 w-4" />
            Add
          </button>
        </div>
      </section>

      {unattributed.length > 0 ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">
            {unattributed.length} question{unattributed.length === 1 ? '' : 's'} you ask that no
            reason covers
          </h2>
          <p className="mt-1 text-xs text-amber-800">
            {/* The check that stops a notice going quietly out of date as forms
                grow. A warning, never a block. */}
            These are being collected but are not explained in any notice. Open the form and say
            what each is for.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {unattributed.slice(0, 24).map((field) => (
              <li key={`${field.formSlug}.${field.key}`}>
                <Link
                  href={`/admin/forms/${field.formSlug}`}
                  className="inline-block rounded border border-amber-300 bg-white px-2 py-0.5 text-xs hover:bg-amber-100"
                >
                  {t(field.label, locale, field.key)}
                </Link>
              </li>
            ))}
            {unattributed.length > 24 ? (
              <li className="px-2 py-0.5 text-xs text-amber-800">
                and {unattributed.length - 24} more
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <ErasureSection erasures={erasures} holds={holds} pending={pending} run={run} locale={locale} />

      <section
        id="notices"
        className="flex flex-col gap-3 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <div className="flex items-center gap-2">
          <FileText aria-hidden className="h-4 w-4 text-brand-600" />
          <h2 className="font-semibold">What you tell people</h2>
        </div>
        <p className="text-xs text-slate-500">
          The words your team reads out before collecting anything. You do not have to write it from
          scratch — Sangraha knows every question your forms ask and what each is for, so it can
          assemble the first draft and you correct it.{' '}
          <strong className="text-slate-700">
            A draft shows nobody anything: it is publishing that puts it in front of people.
          </strong>
        </p>

        {notices.map((notice) => (
          <NoticeCard
            /*
             * Keyed on the server's copy of the words, not just the id.
             *
             * The editor holds the text in `useState`, whose initialiser runs
             * only on mount — so `revalidatePath` plus `router.refresh()` handed
             * the card fresh props and the textarea went on showing the old
             * value. "Write it from my forms" wrote the notice to the database
             * and the box did not move, which reads exactly like a dead button.
             *
             * Changing the key remounts it, which is the same idiom
             * `admin/settings/identity-form.tsx` uses for the same reason.
             * Typing is safe: the key is built from the *server* value, which
             * does not change while somebody types.
             */
            key={`${notice.id}:${notice.draft?.id ?? 'none'}:${notice.currentVersionId ?? 'none'}:${
              notice.draft?.body.en ?? notice.publishedBody?.en ?? ''
            }:${(notice.draft?.purposeIds ?? []).join(',')}`}
            notice={notice}
            purposes={purposes}
            locale={locale}
            pending={pending}
            run={run}
          />
        ))}

        {/*
         * Walled off from the notices above it.
         *
         * This used to be a bare input sitting directly under the last notice's
         * card, with a placeholder that read like prose — so it was taken for
         * that notice's own name field, which is exactly what it looks like.
         * Titled, boxed, and asking for a short label rather than a sentence.
         */}
        <div className="mt-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-800">
            {notices.length === 0 ? 'Write your first notice' : 'Add another notice'}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {notices.length === 0
              ? 'Most organisations need one. Give it a short name for your own reference — you will write the words people hear in the next step.'
              : 'Only if you tell different groups different things. A short name for your own reference, not words anybody is read.'}
          </p>
          <div className="mt-2 flex gap-2">
            <input
              value={newNotice}
              onChange={(event) => setNewNotice(event.target.value)}
              placeholder="e.g. Beneficiary notice"
              maxLength={200}
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={pending || newNotice.trim().length < 3}
              onClick={() =>
                run(async () => {
                  const result = await createNoticeAction(newNotice.trim());
                  if (result.ok) setNewNotice('');
                  return result;
                })
              }
              className="inline-flex shrink-0 items-center gap-1 rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              <Plus aria-hidden className="h-4 w-4" />
              {notices.length === 0 ? 'Start it' : 'Add'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Whether anybody is actually being asked for permission.
 *
 * Two things have to be true, and neither is guessable from the screens below:
 * a purpose has to rest on consent, and a notice covering it has to be
 * *published*. Miss either and the capture screen quietly skips the consent step
 * — no notice read out, no attestation recorded, including for children — and
 * nothing anywhere says so.
 *
 * So it is said here, at the top, in the consequence rather than the mechanism.
 * "You have no published notice" is a fact about the database; "your team is
 * collecting answers without asking anyone" is the thing an administrator needs
 * to know, and it is the same fact.
 *
 * Loud while it is wrong and quiet once it is right — a permanent green banner
 * is furniture, and furniture is not read.
 */
function ConsentReadiness({
  hasConsentPurpose,
  hasPublishedNotice,
}: {
  hasConsentPurpose: boolean;
  hasPublishedNotice: boolean;
}) {
  if (hasConsentPurpose && hasPublishedNotice) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-affirm-200 bg-affirm-50 p-3 text-sm text-affirm-800">
        <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Your team is asked for permission before collecting anything, and shown the notice you
          published. Re-publish it whenever you add a purpose or a new kind of question.
        </span>
      </p>
    );
  }

  return (
    <section className="rounded-lg border-2 border-deny-300 bg-deny-50 p-4">
      <h2 className="flex items-start gap-2 font-semibold text-deny-800">
        <AlertCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
        Nobody is being asked for permission
      </h2>
      <p className="mt-2 text-sm text-deny-700">
        Your team can collect answers right now without reading anything out and without recording
        that anyone agreed — including for children, where the law asks most of you. Two things have
        to be in place, and both are on this page:
      </p>

      <ol className="mt-3 flex flex-col gap-2 text-sm">
        <Requirement
          done={hasConsentPurpose}
          href="#purposes"
          title="Say why you collect data"
          detail="One line per thing you do with it, each marked as resting on the person's permission. Questions are attributed to these, and the notice is written from them."
          action="Go to purposes"
        />
        <Requirement
          done={hasPublishedNotice}
          href="#notices"
          title="Publish the notice"
          detail="The words your team reads out. A draft is not enough — until a version is published there is nothing for them to show anyone."
          action="Go to notices"
        />
      </ol>
    </section>
  );
}

function Requirement({
  done,
  href,
  title,
  detail,
  action,
}: {
  done: boolean;
  href: string;
  title: string;
  detail: string;
  action: string;
}) {
  return (
    <li className="flex items-start gap-3 rounded border border-slate-200 bg-white p-3">
      <span className="mt-0.5 shrink-0">
        {done ? (
          <CheckCircle2 aria-label="done" className="h-5 w-5 text-affirm-600" />
        ) : (
          <span
            aria-label="not done"
            className="block h-5 w-5 rounded-full border-2 border-deny-400"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block font-medium ${done ? 'text-slate-500' : 'text-slate-900'}`}>
          {title}
        </span>
        {done ? null : <span className="mt-0.5 block text-slate-600">{detail}</span>}
        {done ? null : (
          <Link href={href} className="mt-1 inline-block font-medium text-brand-700 underline">
            {action} ↓
          </Link>
        )}
      </span>
    </li>
  );
}

function Figure({
  label,
  value,
  muted,
  alarming,
}: {
  label: string;
  value: number;
  muted?: boolean;
  alarming?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        alarming ? 'border-deny-200 bg-deny-50' : 'border-slate-200 bg-white'
      }`}
    >
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={`mt-0.5 text-2xl font-semibold tabular-nums ${
          alarming ? 'text-deny-700' : muted ? 'text-slate-300' : 'text-slate-900'
        }`}
      >
        {value.toLocaleString('en-IN')}
      </dd>
    </div>
  );
}

function OverrideRow({
  override,
  pending,
  run,
}: {
  override: PendingOverride;
  pending: boolean;
  run: (work: () => Promise<PrivacyState>) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <li className="rounded border border-deny-200 bg-white p-3">
      <p className="text-sm">
        <Link href={`/people/${override.subjectId}`} className="font-medium text-brand-700 underline">
          Open the record
        </Link>{' '}
        · {override.purposeCode} ·{' '}
        {override.minorBasis === 'worker_declared'
          ? 'the worker said they are under 18'
          : 'their recorded age says they are under 18'}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="What happened? e.g. mother was present but had no document"
          className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="button"
          disabled={pending || reason.trim().length < 10}
          onClick={() => run(() => decideOverrideAction(override.eventId, reason))}
          className="rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Record this
        </button>
      </div>
    </li>
  );
}

/** Said as a consequence, because that is what an administrator is choosing. */
const BASIS_LABEL: Record<LawfulBasis, string> = {
  consent: 'We ask, and they can say no',
  guardian_consent: 'A parent or guardian agrees',
  voluntary: 'They gave it to us themselves, for this',
  state_benefit: 'Required to deliver a government scheme',
  medical_emergency: 'A medical emergency',
  employment: 'Our own staff records',
};

function PurposeRow({
  purpose,
  locale,
  pending,
  run,
}: {
  purpose: Purpose;
  locale: string;
  pending: boolean;
  run: (work: () => Promise<PrivacyState>) => void;
}) {
  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[1fr_16rem]">
      <div>
        <p className="text-sm font-medium">{t(purpose.name, locale, purpose.code)}</p>
        <p className="font-mono text-xs text-slate-400">{purpose.code}</p>
      </div>
      <div className="flex flex-col gap-2">
        <select
          value={purpose.lawfulBasis}
          disabled={pending}
          onChange={(event) =>
            run(() =>
              updatePurposeAction(purpose.id, {
                lawfulBasis: event.target.value as LawfulBasis,
              }),
            )
          }
          className="rounded border border-slate-300 px-2 py-1.5 text-sm"
        >
          {(Object.keys(BASIS_LABEL) as LawfulBasis[]).map((basis) => (
            <option key={basis} value={basis}>
              {BASIS_LABEL[basis]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          Keep for
          <input
            type="number"
            min={0}
            max={1200}
            defaultValue={purpose.retentionMonths ?? ''}
            disabled={pending}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              const months = raw === '' ? null : Number(raw);
              if (months !== purpose.retentionMonths) {
                run(() => updatePurposeAction(purpose.id, { retentionMonths: months }));
              }
            }}
            className="w-20 rounded border border-slate-300 px-2 py-1"
          />
          months after it is finished
        </label>
      </div>
    </li>
  );
}

/**
 * One notice: what it covers, what it says, and getting it live.
 *
 * Rewritten because it was reported as "I am not sure how I publish. it is not
 * getting enabled." Three separate traps, all in this card:
 *
 *  1. **Publish was disabled with no reason given.** It needs at least one
 *     purpose ticked, and the pill that ticks them looked like a static tag.
 *     A disabled button that will not say what it wants is a dead end; now the
 *     button is always pressable and refuses out loud, naming what is missing.
 *
 *  2. **The purposes read as a label, not a choice.** "This notice explains ·
 *     student scholarship" is a sentence, so nobody clicked it. They are now
 *     visibly checkboxes, with the tick drawn, under a question.
 *
 *  3. **Nothing said what order to do things in.** Numbered, because an
 *     administrator doing this once a year should not have to infer a sequence.
 *
 * The coverage also defaults to every purpose on a notice that has never been
 * published, which is what the generated wording already describes — leaving
 * them unticked while the text below covered everything was simply inconsistent.
 */
function NoticeCard({
  notice,
  purposes,
  locale,
  pending,
  run,
}: {
  notice: NoticeDetail;
  purposes: Purpose[];
  locale: string;
  pending: boolean;
  run: (work: () => Promise<PrivacyState>) => void;
}) {
  const draft = notice.draft;
  const published = notice.versions.find((version) => version.id === notice.currentVersionId);

  /*
   * The draft's words, or the published ones when there is no open draft.
   *
   * Publishing turns the draft into the published version, leaving `draft` null
   * — so this fell back to an empty box for a notice that was live and 966
   * characters long, which reads as "the notice we are reading out is blank".
   * Editing from here creates a new draft seeded with these same words, so what
   * is shown is what will be edited.
   */
  const [body, setBody] = useState(draft?.body.en ?? notice.publishedBody?.en ?? '');
  const [covered, setCovered] = useState<string[]>(() => {
    if (draft?.purposeIds?.length) return draft.purposeIds;
    // A notice nobody has published yet is being set up, and covering
    // everything is the answer for almost every organisation — they have one
    // notice and it explains all of their reasons. Visible and editable, never
    // silent: the ticks are drawn.
    return published ? [] : purposes.filter((purpose) => purpose.isActive).map((p) => p.id);
  });
  /** Set when Publish is pressed and cannot proceed. */
  const [refused, setRefused] = useState<string | null>(null);

  const missing: string[] = [];
  if (covered.length === 0) missing.push('tick at least one reason in step 1');
  if (body.trim() === '') missing.push('write the words in step 2');

  const publish = () => {
    if (missing.length > 0) {
      /*
       * Refuses when pressed rather than sitting greyed out.
       *
       * The disabled version gave an administrator nothing to act on — the
       * button simply did not respond, and the reason was two fields away and
       * unstated. Saying it at the moment of the attempt is the difference
       * between a dead end and an instruction.
       */
      setRefused(`Before publishing, ${missing.join(' and ')}.`);
      return;
    }
    setRefused(null);
    run(async () => {
      const saved = await saveNoticeDraftAction(notice.id, { en: body }, covered);
      if (!saved.ok) return saved;
      return publishNoticeAction(notice.id);
    });
  };

  return (
    <div
      /*
       * A stable handle for `scripts/verify-ui.ts`.
       *
       * Matching these cards by their text meant also matching every ancestor
       * that contains them, so a check read one card's status against another
       * card's textarea and reported a bug that was not there.
       */
      data-notice={notice.slug}
      data-notice-live={published ? 'yes' : 'no'}
      className={`rounded-lg border p-4 ${
        published ? 'border-slate-200' : 'border-brand-300 bg-brand-50/20'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{t(notice.name, locale, notice.slug)}</h3>
        {published ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-affirm-50 px-2 py-0.5 text-xs font-medium text-affirm-700">
            <CheckCircle2 aria-hidden className="h-3 w-3" />
            Being read to people (version {published.versionNumber})
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            <AlertCircle aria-hidden className="h-3 w-3" />
            Not published — nobody sees this yet
          </span>
        )}
      </div>

      {/* ---- 1. What it covers ---------------------------------------------- */}
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-slate-800">
          1. Which of your reasons does this notice cover?
        </legend>
        {purposes.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">
            None to choose from yet — add one under <strong>Why you collect things</strong> above.
          </p>
        ) : (
          <>
            <p className="mt-0.5 text-xs text-slate-500">
              Tap to choose. Permission has to be for something specific, so a notice covering
              nothing cannot be published.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {purposes.map((purpose) => {
                const on = covered.includes(purpose.id);
                return (
                  <label
                    key={purpose.id}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                      on
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-slate-400 bg-white text-slate-700 hover:border-slate-600'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      className="sr-only"
                      onChange={() => {
                        setRefused(null);
                        setCovered(
                          on ? covered.filter((id) => id !== purpose.id) : [...covered, purpose.id],
                        );
                      }}
                    />
                    {/* Drawn, not implied by colour alone. The previous version
                        differed only in border tint, which read as a tag. */}
                    {on ? (
                      <Check aria-hidden className="h-3 w-3" strokeWidth={3} />
                    ) : (
                      <span aria-hidden className="h-3 w-3 rounded-sm border border-slate-400" />
                    )}
                    {t(purpose.name, locale, purpose.code)}
                  </label>
                );
              })}
            </div>
          </>
        )}
      </fieldset>

      {/* ---- 2. The words --------------------------------------------------- */}
      <div className="mt-4">
        <p className="text-sm font-medium text-slate-800">2. The words your team reads out</p>
        <div className="mt-2">
          {/*
           * Above the box, not below it.
           *
           * This is where an empty notice starts, so it belongs where somebody
           * looks before typing rather than under the thing they were supposed
           * to have filled in. It is not a language model and there is no key to
           * configure: it reads the organisation's legal details, its purposes,
           * and the questions attributed to each, and assembles the notice from
           * a template — see `composeNotice`. Deterministic, which is what makes
           * the published hash meaningful.
           */}
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => generateNoticeAction(notice.id, body.trim() !== ''))}
            title="Assembled from your purposes and the questions attributed to them. No internet, no AI."
            className="inline-flex items-center gap-1 rounded border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-800 disabled:opacity-40"
          >
            <FileText aria-hidden className="h-4 w-4" />
            {body.trim() === '' ? 'Write it from my forms' : 'Rebuild from my forms'}
          </button>
        </div>
        <textarea
          value={body}
          onChange={(event) => {
            setRefused(null);
            setBody(event.target.value);
          }}
          rows={10}
          placeholder="Press “Write it from my forms” above, then correct what comes out."
          className="mt-2 w-full rounded border border-slate-300 p-3 font-sans text-sm leading-relaxed"
        />
      </div>

      {/* ---- 3. Go live ----------------------------------------------------- */}
      <div className="mt-4 border-t border-slate-200 pt-3">
        <p className="text-sm font-medium text-slate-800">
          3. {published ? 'Publish your changes' : 'Publish it'}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Publishing is what puts it in front of people — until then your team is asked for nobody&rsquo;s
          permission. It also freezes these words, so anyone who agrees afterwards is agreeing to this
          exact version and you can show what they were told.
        </p>

        {refused ? (
          <p
            role="alert"
            className="mt-2 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-900"
          >
            <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            {refused}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={publish}
            className="inline-flex items-center gap-1 rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            <CheckCircle2 aria-hidden className="h-4 w-4" />
            {published ? 'Publish new version' : 'Publish'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setRefused(null);
              run(() => saveNoticeDraftAction(notice.id, { en: body }, covered));
            }}
            className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
          >
            Save and finish later
          </button>
          {/* Stated beside the button as well as on refusal, so somebody who has
              not pressed it yet still knows what is outstanding. */}
          {missing.length > 0 ? (
            <span className="text-xs text-slate-500">Still to do: {missing.join(', ')}.</span>
          ) : null}

          {/*
           * Only while it has never been published.
           *
           * `slug` comes from the name and cannot change, so a first attempt
           * that got the name wrong — or a second one created by accident — was
           * permanent clutter on the screen that matters most, with no way back.
           * A published notice is deliberately not removable: it is the record
           * of what people were told before they agreed.
           */}
          {published ? null : (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Throw away “${t(notice.name, locale, notice.slug)}”? Nobody has been read it, so nothing is lost.`)) return;
                run(() => discardNoticeAction(notice.id));
              }}
              className="ml-auto inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:border-deny-300 hover:text-deny-700 disabled:opacity-40"
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
              Throw this one away
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


/**
 * Requests to be forgotten.
 *
 * Two things an administrator has to be able to tell apart: a record that is
 * hidden and a record that is gone. Hiding happens the moment somebody asks —
 * the Act requires processing to stop, not to stop eventually — and the purge
 * is a separate, deliberate act so an erasure entered in error is recoverable
 * until it runs.
 */
function ErasureSection({
  erasures,
  holds,
  pending,
  run,
  locale,
}: {
  erasures: ErasureRequestRow[];
  holds: HeldBack[];
  pending: boolean;
  run: (work: () => Promise<PrivacyState>) => void;
  locale: string;
}) {
  const [keep, setKeep] = useState('');
  const [rehearsal, setRehearsal] = useState<Record<string, number> | null>(null);
  /*
   * Reported after a rehearsal *and* after the real run. A hold defers an
   * erasure rather than refusing it, so this is the only place the operator is
   * told that somebody who asked to be forgotten has not been.
   */
  const [heldBack, setHeldBack] = useState<HeldBackRequest[]>([]);

  const waiting = erasures.filter((request) => request.status === 'accepted');

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-center gap-2">
        <Trash2 aria-hidden className="h-4 w-4 text-brand-600" />
        <h2 className="font-semibold">People who asked to be forgotten</h2>
      </div>

      {erasures.length === 0 ? (
        <p className="text-xs text-slate-500">
          Nobody has asked yet. When they do, open their record and use &ldquo;Forget this
          person&rdquo; — they are hidden from everyone straight away.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {erasures.map((request) => (
            <li key={request.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
              <span className="font-medium">
                {request.subjectNameAtRequest ?? 'Name already removed'}
              </span>
              <StatusWord status={request.status} />
              <span className="ml-auto text-xs text-slate-500">
                {new Intl.DateTimeFormat(`${locale}-IN`, { dateStyle: 'medium' }).format(
                  request.receivedAt,
                )}
              </span>
              {request.refusalStatute ? (
                <span className="w-full text-xs text-slate-600">
                  Held under {request.refusalStatute}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {holds.length > 0 ? (
        <p className="rounded bg-slate-50 p-3 text-xs text-slate-600">
          {/* Purpose-scoped, so this names what is held rather than implying
              everything is. */}
          Some data is held under {holds.map((hold) => hold.statute).join(', ')}. That covers only
          the purposes those laws apply to — everything else is still erased.
        </p>
      ) : null}

      {waiting.length > 0 ? (
        <div className="rounded-lg border border-deny-200 bg-deny-50 p-4">
          <h3 className="text-sm font-semibold text-deny-800">
            {waiting.length} waiting to be permanently erased
          </h3>
          <p className="mt-1 text-xs text-deny-700">
            They are already hidden from everyone. This step removes the data for good and cannot
            be undone. Rehearse it first — it will tell you exactly what it would touch.
          </p>

          <label className="mt-3 flex flex-col gap-1 text-xs text-deny-800">
            Answers worth keeping for your reports, without the person
            <input
              value={keep}
              onChange={(event) => setKeep(event.target.value)}
              placeholder="village, grade"
              className="rounded border border-deny-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
            <span>
              {/* The inversion that makes this defensible: a field nobody
                  thought about is removed, not retained. */}
              Everything else is removed, including anything you forget to list here.
            </span>
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await purgeAction(splitFields(keep), true);
                  setRehearsal(result.summary ?? null);
                  setHeldBack(result.heldBack ?? []);
                  return result;
                })
              }
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
            >
              Rehearse
            </button>
            <button
              type="button"
              disabled={pending || rehearsal === null}
              onClick={() =>
                run(async () => {
                  const result = await purgeAction(splitFields(keep), false);
                  setRehearsal(null);
                  setHeldBack(result.heldBack ?? []);
                  return result;
                })
              }
              className="rounded bg-deny-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              Erase permanently
            </button>
          </div>

          {rehearsal ? (
            <p className="mt-2 text-xs text-deny-800">
              Would affect {rehearsal.subjects} record(s). Nothing has changed yet.
            </p>
          ) : null}

          {/* Stated whether or not anything else happened. A statutory hold is
              the one outcome where the request stays open and the person is
              still on file, and it lifts on a date rather than on a decision. */}
          {heldBack.length > 0 ? (
            <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="font-medium">
                {heldBack.length} request(s) were not carried out. A retention law still
                covers some of what they asked to have removed.
              </p>
              <ul className="mt-2 space-y-1">
                {heldBack.map((entry) => (
                  <li key={entry.subjectPseudonym}>
                    <span className="font-mono">{entry.subjectPseudonym}</span> — kept under{' '}
                    {entry.statutes.join(', ')} until {entry.until}
                  </li>
                ))}
              </ul>
              <p className="mt-2">
                They stay hidden in the meantime, and nothing needs re-filing: run this
                again after the last of those dates and it will complete on its own.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const splitFields = (text: string): string[] =>
  text
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);

const STATUS_WORDS: Record<string, { text: string; className: string }> = {
  requested: { text: 'just asked', className: 'bg-slate-100 text-slate-700' },
  accepted: { text: 'hidden, not yet erased', className: 'bg-amber-100 text-amber-800' },
  completed: { text: 'erased', className: 'bg-affirm-50 text-affirm-700' },
  refused: { text: 'held back', className: 'bg-deny-50 text-deny-700' },
};

function StatusWord({ status }: { status: string }) {
  const word = STATUS_WORDS[status] ?? { text: status, className: 'bg-slate-100 text-slate-700' };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${word.className}`}>
      {word.text}
    </span>
  );
}
