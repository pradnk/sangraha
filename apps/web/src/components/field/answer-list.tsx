import { Download, MapPin } from 'lucide-react';
import type { DisplayAnswer } from '@sangraha/form-engine';
import { m } from '@/lib/messages';

/**
 * Renders a submission's answers.
 *
 * Shared by the worker's own record and the supervisor review screen so both
 * see the same values formatted the same way — a reviewer querying a number
 * should never be looking at a differently rendered version of it.
 *
 * A question that was skipped is absent entirely (the formatter drops it);
 * one that was asked and left blank shows "Not answered", because the
 * difference matters to whoever is checking the record.
 */
export function AnswerList({
  answers,
  locale,
}: {
  answers: DisplayAnswer[];
  locale: string;
}) {
  return (
    <dl className="flex flex-col divide-y divide-slate-200">
      {answers.map((answer) => (
        <div key={answer.key} className="flex flex-col gap-1 py-3">
          <dt className="text-field-sm text-slate-500">{answer.label}</dt>
          <dd className="text-field-base text-slate-900">
            {answer.entries ? (
              <RepeatEntries answer={answer} locale={locale} />
            ) : answer.isEmpty ? (
              <span className="italic text-slate-400">{m(locale, 'notAnswered')}</span>
            ) : (
              <Value answer={answer} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One answer, rendered as the thing it is.
 *
 * The formatter turns every value into a string, which is right for a CSV cell
 * and wrong on a screen: an attachment comes out as its uuid, and a reviewer
 * checking whether a consent form was really signed cannot do it by reading a
 * uuid. The three attachment types and the location are the cases where the
 * string is a reference to something rather than the answer itself.
 */
function Value({ answer }: { answer: DisplayAnswer }) {
  switch (answer.dataType) {
    case 'photo':
    case 'signature':
      return (
        <a href={`/api/attachments/${answer.value}`} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- served by an
              authorised proxy route the image optimiser cannot fetch. */}
          <img
            src={`/api/attachments/${answer.value}`}
            alt={answer.label}
            loading="lazy"
            className="max-h-56 rounded border border-slate-200 bg-white object-contain"
          />
        </a>
      );

    case 'file':
      return (
        <a
          href={`/api/attachments/${answer.value}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-tap items-center gap-2 text-brand-700 underline"
        >
          <Download aria-hidden className="h-4 w-4 shrink-0" />
          {answer.label}
        </a>
      );

    case 'geopoint':
      return <Location value={answer.value} />;

    default:
      return <>{answer.value}</>;
  }
}

/**
 * A recorded position.
 *
 * A `geo:` link rather than an embedded map. Loading a tile would send the
 * coordinates of somebody's home to a mapping provider every time a reviewer
 * opened the record — and these are the homes of people an NGO works with.
 * Handing them to the phone's own map app only when the reviewer taps keeps
 * that a deliberate act rather than a side effect of reading.
 */
function Location({ value }: { value: string }) {
  const [lat, lon] = value.split(',');
  if (!lat || !lon) return <>{value}</>;

  return (
    <a
      href={`geo:${lat},${lon}?q=${lat},${lon}`}
      className="inline-flex min-h-tap items-center gap-2 font-mono text-brand-700 underline"
    >
      <MapPin aria-hidden className="h-4 w-4 shrink-0" />
      {lat}, {lon}
    </a>
  );
}

function RepeatEntries({ answer, locale }: { answer: DisplayAnswer; locale: string }) {
  if (!answer.entries?.length) {
    return <span className="italic text-slate-400">{m(locale, 'notAnswered')}</span>;
  }

  return (
    <ol className="flex flex-col gap-3">
      {answer.entries.map((entry, index) => (
        <li key={index} className="rounded-field bg-slate-50 p-3">
          <p className="mb-1 text-field-sm font-semibold text-slate-500">{index + 1}</p>
          <AnswerList answers={entry} locale={locale} />
        </li>
      ))}
    </ol>
  );
}
