/**
 * What kind of text a short-text question accepts.
 *
 * The point of doing it this way rather than shipping an `email` field type, a
 * `pan` field type and so on: an organisation needs a format we have never
 * heard of about as often as it needs one we have. A state-specific ration card
 * number should not require a release.
 *
 * **No regular expressions from administrators.** A mistyped one silently
 * rejects real beneficiary data with no clue why, and a badly formed one can
 * hang the server on every submission. Instead a custom format is written as a
 * mask — `A` for a letter, `9` for a digit, anything else literal — which
 * cannot backtrack, cannot be ambiguous, and reads correctly to someone who has
 * never programmed. It also happens to describe Indian ID numbers exactly:
 * `AAAAA9999A` is a PAN.
 */

export const TEXT_FORMATS = [
  'any',
  'email',
  'url',
  'pan',
  'aadhaar',
  'pincode',
  'ifsc',
  'pattern',
] as const;

export type TextFormat = (typeof TEXT_FORMATS)[number];

export interface TextFormatSpec {
  /** Message key the capture screen turns into words. */
  messageKey: string;
  /** An example, shown to the admin and used as the input placeholder. */
  example: string;
  /** The mask this format is, where one exists. */
  mask?: string;
  test?: (value: string) => boolean;
  /** Keyboard hint for the phone. */
  inputMode?: 'email' | 'url' | 'numeric' | 'text';
  /** Whether to upper-case the answer before storing it. */
  upperCase?: boolean;
}

/**
 * Deliberately lenient. The job is to catch a typo, not to adjudicate RFC 5322 —
 * refusing a real address a worker cannot correct is worse than accepting an
 * odd one somebody can fix later.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_LIKE = /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/;

export const FORMAT_SPECS: Record<Exclude<TextFormat, 'any' | 'pattern'>, TextFormatSpec> = {
  email: {
    messageKey: 'invalidEmail',
    example: 'rahul@ngo.org',
    test: (value) => EMAIL.test(value),
    inputMode: 'email',
  },
  url: {
    messageKey: 'invalidUrl',
    example: 'ngo.org/report',
    test: (value) => URL_LIKE.test(value),
    inputMode: 'url',
  },
  pan: {
    messageKey: 'invalidPan',
    example: 'ABCDE1234F',
    mask: 'AAAAA9999A',
    inputMode: 'text',
    upperCase: true,
  },
  aadhaar: {
    messageKey: 'invalidAadhaar',
    example: '9999 9999 9999',
    mask: '9999 9999 9999',
    inputMode: 'numeric',
  },
  pincode: {
    messageKey: 'invalidPincode',
    example: '560001',
    mask: '999999',
    inputMode: 'numeric',
  },
  ifsc: {
    messageKey: 'invalidIfsc',
    example: 'HDFC0001234',
    mask: 'AAAA0999999',
    inputMode: 'text',
    upperCase: true,
  },
};

/** Characters a mask may contain beyond `A` and `9`, kept deliberately small. */
const MASK_LITERALS = /^[A9 \-/.]+$/;

export function isValidMask(mask: string): boolean {
  const trimmed = mask.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 40 &&
    MASK_LITERALS.test(trimmed) &&
    /[A9]/.test(trimmed)
  );
}

/**
 * Checks a value against a mask, character by character.
 *
 * A plain loop rather than a compiled expression: there is no backtracking to
 * go wrong, the cost is exactly the length of the input, and an administrator's
 * typo can only ever make the mask stricter or looser — never catastrophic.
 */
export function matchesMask(value: string, mask: string): boolean {
  const text = value.trim();
  const pattern = mask.trim();
  if (text.length !== pattern.length) return false;

  for (let i = 0; i < pattern.length; i += 1) {
    const slot = pattern[i]!;
    const char = text[i]!;

    if (slot === 'A') {
      if (!/[A-Za-z]/.test(char)) return false;
    } else if (slot === '9') {
      if (!/[0-9]/.test(char)) return false;
    } else if (char !== slot) {
      return false;
    }
  }

  return true;
}

export interface TextFormatCheck {
  ok: boolean;
  /** Message key when it failed. */
  messageKey?: string;
}

/** Applies whichever format a question is set to. */
export function checkTextFormat(
  value: string,
  format: TextFormat,
  customMask?: string,
): TextFormatCheck {
  if (format === 'any') return { ok: true };

  if (format === 'pattern') {
    // A question set to "a pattern I set" with no pattern yet accepts
    // anything, rather than rejecting every answer while an admin is still
    // typing the mask.
    if (!customMask || !isValidMask(customMask)) return { ok: true };
    return matchesMask(value, customMask) ? { ok: true } : { ok: false, messageKey: 'invalidPattern' };
  }

  const spec = FORMAT_SPECS[format];
  if (!spec) return { ok: true };

  const passes = spec.mask ? matchesMask(value, spec.mask) : (spec.test?.(value) ?? true);
  return passes ? { ok: true } : { ok: false, messageKey: spec.messageKey };
}

/** The example to show for a format, including a custom one. */
export function formatExample(format: TextFormat, customMask?: string): string {
  if (format === 'pattern') return customMask?.trim() ?? '';
  if (format === 'any') return '';
  return FORMAT_SPECS[format]?.example ?? '';
}

export function formatInputMode(format: TextFormat): TextFormatSpec['inputMode'] {
  if (format === 'any' || format === 'pattern') return undefined;
  return FORMAT_SPECS[format]?.inputMode;
}

/**
 * Whether the phone keyboard should start in capitals.
 *
 * True for the formats written in capitals — a PAN, an IFSC — and emphatically
 * not for an email address, where capitals are wrong and autocorrect helpfully
 * capitalising the first letter is a common source of a refused answer.
 */
export function formatWantsCapitals(format: TextFormat): boolean {
  if (format === 'any' || format === 'pattern') return false;
  return FORMAT_SPECS[format]?.upperCase === true;
}
