import Link from 'next/link';
import { ArrowRight, Check, Circle } from 'lucide-react';
import { getSetupProgress } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { DismissSetup } from './dismiss-setup';

/**
 * Everything this organisation has set up, and what it has not.
 *
 * Started life as an onboarding checklist and stopped being only that. Setting
 * up is not an event that finishes: an NGO that adds a programme needs a new
 * purpose and a re-published notice, one that opens a district needs places and
 * people, one that hires a Kannada-speaking team needs a language. The
 * checklist framing actively got in the way of that — a completed step hid its
 * own link, so the screen turned into a wall of green ticks leading nowhere.
 *
 * So every row always links, and every row says what is actually there ("4
 * purposes", "2 languages") rather than only whether it is non-empty. What
 * changes when the required rows are all done is the framing at the top, not
 * the usefulness of the page.
 *
 * Ordered by dependency, not importance: places before people (people are
 * assigned to places), purposes before the form (questions are attributed to
 * one as they are written), the form before the notice (the notice is drafted
 * from the questions), and languages before all of it — the Translate button
 * only exists once a second language is on, so an admin who picks languages
 * afterwards has to go back and translate questions they have already written.
 */
export default async function SetupPage() {
  const session = await requireRole(['org_admin', 'super_admin']);
  const progress = await withSession(session, (tx) => getSetupProgress(tx, session.orgId));
  const { counts } = progress;

  const steps = [
    {
      done: true,
      title: 'Create your organisation',
      state: 'Done — you are its administrator.',
      body: null,
      href: null,
      action: null,
    },
    {
      done: progress.hasPlaces,
      title: 'Add your places',
      state: count(counts.places, 'place'),
      body: 'Districts, blocks, villages, schools — whatever your work is organised by. Assigning someone a place gives them everything inside it, so a block coordinator needs one assignment, not one per village.',
      href: '/admin/places',
      action: 'Add places',
    },
    {
      done: progress.hasExtraLanguage,
      title: 'Choose your languages',
      state: count(counts.languages, 'language'),
      body: 'Turn on the languages your team reads, before you write any questions. Do it now and a Translate button sits beside your questions as you build, filling in a first draft for you to check. Turn one on afterwards and you have to reopen every form, translate it, and publish it again. Skip this if your team works in English.',
      href: '/admin/settings#languages',
      action: 'Choose languages',
      optional: true,
    },
    {
      done: progress.hasPurposes,
      title: 'Say why you collect data',
      state: count(counts.purposes, 'purpose'),
      body: 'One line for each thing you do with what you collect — "run the after-school programme", "report numbers to our funder". You attribute each question to one as you build your form, and the privacy notice is written from them. Nothing asks anyone for permission until this exists.',
      href: '/admin/privacy#purposes',
      action: 'List your purposes',
      // The one most likely to be revisited: a new programme is a new purpose,
      // and a purpose added later needs the notice re-published behind it.
      recurring: 'Add one whenever you start a new programme.',
    },
    {
      done: progress.hasForm,
      title: 'Build your first form',
      state: count(counts.forms, 'form'),
      body: 'Add questions and watch them appear on a phone beside you. Write them in English; if you turned a second language on above, the Translate button beside them fills in a first draft for you to check.',
      href: '/admin/forms/new',
      action: 'Create a form',
      // Once there is a form, the useful destination is the list of them, not
      // another blank one.
      doneHref: '/admin/forms',
      doneAction: 'Go to forms',
      recurring: 'Add a form whenever you start collecting something new.',
    },
    {
      done: progress.hasPublishedForm,
      title: 'Publish it',
      state: `${counts.publishedForms} of ${counts.forms} published`,
      body: 'Nothing reaches field workers until you press Publish. You can keep editing afterwards; they carry on with the published version until you publish again.',
      href: '/admin/forms',
      action: 'Go to forms',
      doneAction: 'Go to forms',
    },
    {
      done: progress.hasPublishedNotice,
      title: 'Publish your privacy notice',
      state: counts.notices > 0 ? count(counts.notices, 'notice') : 'None published',
      body: 'Sangraha drafts it from the questions you built and the purposes behind them — read it, change the wording, publish. Until it is published your team is asked for nobody’s permission, because there is nothing to read out, and a child can be registered with no guardian ever agreeing.',
      href: '/admin/privacy#notices',
      action: 'Write the notice',
      recurring: 'Re-publish it after adding a purpose or a new kind of question.',
    },
    {
      done: progress.hasPrivacyContact,
      title: 'Say who handles privacy questions',
      state: counts.privacyContact ?? 'Nobody named',
      body: 'Anyone whose information you hold can ask to see it, correct it, or have it deleted — the law gives them that right, and your organisation is the one answerable for it. Name the person who handles those requests and how to reach them. It goes into the privacy notice your team reads out.',
      href: '/admin/settings#legal',
      action: 'Add the details',
      recurring: 'Change it when that person leaves.',
    },
    {
      done: progress.hasTeam,
      title: 'Add your team',
      state: count(counts.people, 'person', 'people'),
      body: 'Each person gets a sign-in name and a one-time PIN to pass on. They choose their own the first time they sign in, so you never hold their credentials.',
      href: '/admin/users',
      action: 'Add people',
      recurring: 'People join and leave; this is where that happens.',
    },
    {
      done: progress.hasLogo,
      title: 'Add your logo',
      state: progress.hasLogo ? 'Uploaded' : 'Not set',
      body: 'It appears at the top of every screen your team sees, and on the sign-in page — so the app looks like yours, not like software someone handed them. Without one your organisation’s name is shown, which also looks fine.',
      href: '/admin/settings#logo',
      action: 'Upload a logo',
      optional: true,
    },
    {
      done: progress.hasSubmission,
      title: 'Try it on a phone',
      state: count(counts.records, 'record'),
      body: 'Open the field app on your own phone and fill the form in. It is the same screen your team will see. Then check it appears under Records to check.',
      href: '/',
      action: 'Open the field app',
      // "Change" would be nonsense here — this row is a door, not a setting.
      doneAction: 'Open the field app',
    },
  ];

  const required = steps.filter((step) => !step.optional);
  const remaining = required.filter((step) => !step.done).length;
  const settingUp = remaining > 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold">{settingUp ? 'Getting started' : 'What you have set up'}</h1>
        <p className="mt-1 text-slate-600">
          {settingUp
            ? `${remaining} ${remaining === 1 ? 'step' : 'steps'} to go before your team can collect data. You can do these in any order, but this one works well.`
            : 'Everything your organisation is configured with, and where to change it. None of it is fixed — come back whenever you add a programme, a district or a language.'}
        </p>
      </div>

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={`flex gap-4 rounded-lg border p-4 ${
              step.done ? 'border-slate-200 bg-white' : 'border-brand-200 bg-white'
            }`}
          >
            <span className="mt-0.5 shrink-0">
              {step.done ? (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-affirm-500">
                  <Check aria-label="done" className="h-4 w-4 text-white" strokeWidth={3} />
                </span>
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-slate-300 text-xs font-semibold text-slate-500">
                  {index + 1}
                </span>
              )}
            </span>

            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className={`font-semibold ${step.done ? 'text-slate-600' : 'text-slate-900'}`}>
                  {step.title}
                </span>
                {step.optional ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    optional
                  </span>
                ) : null}
              </span>

              {/* What is actually there. On a finished setup this is the whole
                  point of the row — a tick says "something exists", and an
                  administrator deciding whether to add a fourth purpose needs
                  to know there are three. */}
              <span className="mt-0.5 block text-sm font-medium text-slate-500">{step.state}</span>

              {/* The explanation is why-you-would, and stops being the point
                  once you have done it. Kept for the rows still outstanding. */}
              {step.body && !step.done ? (
                <span className="mt-1 block text-slate-600">{step.body}</span>
              ) : null}

              {step.done && step.recurring ? (
                <span className="mt-1 block text-sm text-slate-500">{step.recurring}</span>
              ) : null}

              {/*
               * Always a link, done or not.
               *
               * A completed row used to render no link at all, which turned
               * this screen into a list of things you could see and not reach —
               * exactly when an organisation adding its second programme comes
               * looking for where purposes live.
               */}
              {step.href ? (
                <Link
                  href={(step.done && step.doneHref) || step.href}
                  className="mt-2 inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
                >
                  {step.done ? (step.doneAction ?? 'Change') : step.action}
                  <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                </Link>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">Where your data goes</h2>
        <p className="mt-1 text-slate-600">
          Every published form gets its own table of clean, typed columns, named after your
          questions. Point Metabase, Superset or Excel at it and the data is already in shape — no
          export step, no JSON to unpick. Renaming a question later never moves its column.
        </p>
      </div>

      {remaining === 0 && !progress.dismissed ? (
        <DismissSetup />
      ) : (
        <Circle aria-hidden className="hidden" />
      )}
    </div>
  );
}

/** "1 purpose" / "4 purposes" / "No purposes yet". */
function count(total: number, singular: string, plural = `${singular}s`): string {
  if (total === 0) return `No ${plural} yet`;
  return `${total} ${total === 1 ? singular : plural}`;
}
