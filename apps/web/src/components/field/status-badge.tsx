import { CheckCircle2, Clock, FileEdit, RotateCcw } from 'lucide-react';
import type { SubmissionStatus } from '@sangraha/db';
import { m, type MessageKey } from '@/lib/messages';

/**
 * Status shown as an icon plus a word, never a bare colour.
 *
 * Around 8% of men have red-green colour blindness, and this is exactly the
 * kind of green-tick / red-cross distinction that fails for them. The icon and
 * the label each carry the meaning on their own.
 */
const STYLES: Record<
  SubmissionStatus,
  { key: MessageKey; icon: typeof Clock; className: string }
> = {
  submitted: { key: 'statusSubmitted', icon: Clock, className: 'bg-slate-100 text-slate-700' },
  approved: { key: 'statusApproved', icon: CheckCircle2, className: 'bg-affirm-50 text-affirm-700' },
  rejected: { key: 'statusRejected', icon: RotateCcw, className: 'bg-deny-50 text-deny-700' },
  draft: { key: 'statusDraft', icon: FileEdit, className: 'bg-amber-50 text-amber-800' },
};

export function StatusBadge({ status, locale }: { status: SubmissionStatus; locale: string }) {
  const style = STYLES[status];
  const Icon = style.icon;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-field-sm font-medium ${style.className}`}
    >
      <Icon aria-hidden className="h-4 w-4" />
      {m(locale, style.key)}
    </span>
  );
}
