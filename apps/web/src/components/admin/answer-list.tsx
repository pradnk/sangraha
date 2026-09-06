import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import type { DisplayAnswer } from '@sangraha/form-engine';

/**
 * A record's answers, on an admin screen.
 *
 * Deliberately not the field version in `components/field/answer-list.tsx`.
 * That one is `text-field-*` and `rounded-field` — sized for a worker reading
 * outdoors on a phone — and CLAUDE.md keeps the two design systems apart. Same
 * data, same rules, different reader: an admin at a desk scanning a whole
 * record at once.
 *
 * A question that was skipped is absent entirely (the formatter drops it); one
 * that was asked and left blank reads "Not answered", because the difference
 * matters to whoever is checking the record.
 */
export function AnswerList({ answers }: { answers: DisplayAnswer[] }) {
  if (answers.length === 0) {
    return <p className="text-sm text-slate-500">This form has no questions.</p>;
  }

  return (
    <dl className="divide-y divide-slate-100">
      {answers.map((answer) => (
        <div key={answer.key} className="grid gap-1 py-2.5 sm:grid-cols-[14rem_1fr] sm:gap-4">
          <dt className="text-sm text-slate-500">{answer.label}</dt>
          <dd className="text-sm text-slate-900">
            {answer.entries ? (
              <RepeatEntries answer={answer} />
            ) : answer.isEmpty ? (
              <span className="italic text-slate-400">Not answered</span>
            ) : (
              <Value answer={answer} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Value({ answer }: { answer: DisplayAnswer }) {
  // An answer pointing at a person is the whole reason this screen links out:
  // it is the edge that turns a pile of forms into a record you can follow.
  if (answer.subjectId) {
    return (
      <Link
        href={`/people/${answer.subjectId}`}
        className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
      >
        {answer.value}
        <ExternalLink aria-hidden className="h-3 w-3 shrink-0 opacity-60" />
      </Link>
    );
  }

  // `whitespace-pre-line` so a long-text answer keeps the paragraphs somebody
  // typed rather than collapsing into one block.
  return <span className="whitespace-pre-line">{answer.value}</span>;
}

/**
 * Repeating groups — the one place in Records they are visible at all.
 *
 * The generated view has no column for a repeat group (they become their own
 * child view), so the table upstairs cannot show them. Here they render in
 * full.
 */
function RepeatEntries({ answer }: { answer: DisplayAnswer }) {
  if (!answer.entries?.length) {
    return <span className="italic text-slate-400">None</span>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {answer.entries.map((entry, index) => (
        <li key={index} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {index + 1}
          </p>
          <AnswerList answers={entry} />
        </li>
      ))}
    </ol>
  );
}
