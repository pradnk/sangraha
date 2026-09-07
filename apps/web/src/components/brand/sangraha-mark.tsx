/**
 * The Sangraha mark.
 *
 * Scattered points gathering into one — many observations from many places,
 * collected into something whole. `sangraha` (संग्रह · ಸಂಗ್ರಹ · సంగ్రహ ·
 * സംഗ്രഹം) means exactly that.
 *
 * Used sparingly and deliberately: on the sign-in page for an installation with
 * no organisation yet, on the signup screen, and in documentation. Inside a
 * live organisation the header carries *their* mark, not this one — see
 * `OrgBrand`.
 */
export function SangrahaMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Sangraha"
      className={className}
    >
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <circle cx="32" cy="13" r="4.5" fill="#fff" opacity="0.55" />
      <circle cx="51" cy="32" r="4.5" fill="#fff" opacity="0.7" />
      <circle cx="32" cy="51" r="4.5" fill="#fff" opacity="0.85" />
      <circle cx="13" cy="32" r="4.5" fill="#fff" opacity="0.7" />
      <circle cx="32" cy="32" r="10" fill="#fff" />
    </svg>
  );
}

/**
 * Mark plus wordmark.
 *
 * The name is set in plain weight rather than anything decorative — it has to
 * sit beside a hundred different NGO logos without competing with them.
 */
export function SangrahaLogo({
  size = 'md',
  showTagline = false,
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg';
  showTagline?: boolean;
  className?: string;
}) {
  const scale = { sm: 24, md: 32, lg: 44 }[size];
  const text = { sm: 'text-lg', md: 'text-2xl', lg: 'text-3xl' }[size];

  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <SangrahaMark size={scale} className="shrink-0 text-brand-600" />
      <span className="flex flex-col leading-none">
        <span className={`${text} font-semibold tracking-tight text-slate-900`}>Sangraha</span>
        {showTagline ? (
          <span className="mt-1 text-xs text-slate-500">Data collection for the social sector</span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The quiet co-brand carried in the header of every signed-in screen.
 *
 * Deliberately understated, and deliberately *not* first. The organisation's
 * own mark keeps the leading position on the left; this sits in the middle,
 * smaller and in grey, so the product is identifiable without a field worker
 * feeling they were handed somebody else's software. That balance is the whole
 * point — see `OrgBrand`.
 *
 * Not a link. Tapping the logo in a header conventionally means "go home", and
 * that is what the organisation's mark on the left already does; a second
 * home-ish target would be a coin toss.
 *
 * On a narrow phone the word drops away and only the mark remains. The header
 * there already carries a truncated organisation name, the send queue, the
 * bell and a person's name — a full wordmark in the middle would push one of
 * those out, and the organisation's name is not the thing to sacrifice.
 *
 * **Quiet is not the same as invisible.** This was `text-slate-400` on white,
 * which measures 2.56:1 — below the 4.5:1 WCAG AA needs for text, and below
 * even the 3:1 floor for a UI element. It was not understated, it was
 * unreadable, and on a sunlit phone screen it was gone altogether.
 *
 * Fixed with colour rather than size, which is the distinction that matters
 * here: the mark carries the product's own accent and the word sits in
 * slate-600 (7.58:1), at the same 18px it always was. Nothing grew, nothing
 * moved, and the organisation's logo still leads on the left. Making this
 * *bigger* would have been the wrong fix to the same complaint.
 */
export function SangrahaCoBrand({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none inline-flex select-none items-center gap-1.5 ${className}`}
    >
      <SangrahaMark size={18} className="shrink-0 text-brand-600" />
      <span className="hidden text-sm font-medium tracking-tight text-slate-600 sm:inline">
        Sangraha
      </span>
    </span>
  );
}
