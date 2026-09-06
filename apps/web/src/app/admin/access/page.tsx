import Link from 'next/link';
import { Download, Eye, FileText, LogIn, Search, Users } from 'lucide-react';
import { listAccessEvents, type AccessAction, type AccessEntry } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import type { SearchParams } from '@/lib/records-filters';

/**
 * Who looked at what.
 *
 * The screen that makes the access log worth having: a log nobody reads is
 * storage. Two questions it has to answer without filtering — has anything left
 * the building lately, and is anyone looking at far more than their work needs.
 *
 * `org_admin` only, enforced by the RLS policy as well as this guard. A log a
 * field worker can read tells them which colleague has been checked on.
 */
export default async function AccessLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireRole(['org_admin', 'super_admin']);
  const query = await searchParams;

  const only = typeof query.action === 'string' ? (query.action as AccessAction) : null;
  const entries = await withSession(session, (tx) =>
    listAccessEvents(tx, { action: only }, 200),
  );

  const exports = entries.filter((entry) => entry.action === 'export_csv');

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold">Who looked at what</h1>
        <p className="mt-1 text-slate-600">
          A record of every time someone opened or downloaded people&rsquo;s information. Kept
          because if information ever leaks, the law requires you to say who was affected — and
          that question has no answer without this.
        </p>
      </div>

      {exports.length > 0 ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {/* Surfaced separately because it is the one act that cannot be
              undone: once a spreadsheet is downloaded it is on a laptop, in an
              inbox, on somebody's drive. */}
          <strong>{exports.length}</strong>{' '}
          {exports.length === 1 ? 'spreadsheet has' : 'spreadsheets have'} been downloaded. A
          downloaded file cannot be recalled — it is worth knowing who has one.
        </p>
      ) : null}

      <nav className="flex flex-wrap gap-2">
        <Filter label="Everything" href="/admin/access" active={!only} />
        {(
          [
            ['export_csv', 'Downloads'],
            ['view_subject', 'Profiles opened'],
            ['search_subjects', 'Searches'],
            ['sign_in', 'Sign-ins'],
          ] as const
        ).map(([action, label]) => (
          <Filter
            key={action}
            label={label}
            href={`/admin/access?action=${action}`}
            active={only === action}
          />
        ))}
      </nav>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
          Nothing recorded yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 px-4 py-2.5">
              <Icon action={entry.action} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">
                  <strong>{entry.actorName ?? entry.actorUsername ?? 'Someone since removed'}</strong>{' '}
                  {describe(entry)}
                </span>
                {entry.scope ? (
                  <span className="block truncate font-mono text-xs text-slate-400">
                    filtered by {entry.scope}
                  </span>
                ) : null}
              </span>
              <time className="shrink-0 text-xs text-slate-500">
                {new Intl.DateTimeFormat(`${session.locale}-IN`, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(entry.at)}
              </time>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        Showing the most recent {entries.length}. This log is about your staff, so it is information
        about them too — it is kept only as long as it is useful for checking.
      </p>
    </div>
  );
}

/** Plain sentences. "view_records rowCount=50" is not something anyone reads. */
function describe(entry: AccessEntry): string {
  const n = entry.rowCount ?? 0;
  const people = n === 1 ? '1 person' : `${n} people`;

  switch (entry.action) {
    case 'export_csv':
      return `downloaded a spreadsheet of ${people}`;
    case 'view_subject':
      return 'opened one person’s full record';
    case 'view_record':
      return 'opened a single record';
    case 'view_records':
      return `looked through a list of ${people}`;
    case 'search_subjects':
      return `searched, and saw ${people}`;
    case 'check_duplicates':
      return `checked for an existing record, matching ${people}`;
    case 'sign_in':
      return 'signed in';
    default:
      return entry.action;
  }
}

const ICONS: Record<AccessAction, typeof Eye> = {
  export_csv: Download,
  view_subject: Users,
  view_record: FileText,
  view_records: Eye,
  search_subjects: Search,
  check_duplicates: Search,
  sign_in: LogIn,
};

function Icon({ action }: { action: AccessAction }) {
  const Glyph = ICONS[action] ?? Eye;
  const loud = action === 'export_csv';
  return (
    <Glyph
      aria-hidden
      className={`mt-0.5 h-4 w-4 shrink-0 ${loud ? 'text-amber-600' : 'text-slate-400'}`}
    />
  );
}

function Filter({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`rounded-full border px-3 py-1 text-sm ${
        active
          ? 'border-brand-600 bg-brand-600 font-medium text-white'
          : 'border-slate-300 text-slate-700 hover:bg-slate-50'
      }`}
    >
      {label}
    </Link>
  );
}
