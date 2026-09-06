import { localise } from './i18n';
import type { I18nText } from './types';

/**
 * Writing the privacy notice for an organisation, from what it already collects.
 *
 * The Act requires the notice to be *itemised* — what data, for what purpose —
 * and an NGO administrator faced with a blank page labelled "privacy notice"
 * will either copy someone else's or give up. The system already knows every
 * question it asks and, once each is attributed to a purpose, what each is for.
 * So it can write the first draft.
 *
 * **Grouped by purpose, never by field.** A forty-question form becomes a
 * forty-bullet notice, and a forty-bullet notice read aloud on a doorstep is
 * not heard — which makes the consent that follows it worse than a short honest
 * one. One sentence per purpose, naming the data inside it.
 *
 * **A seed, never an overwrite.** What comes out of here is a starting point an
 * administrator edits into their own words. The same rule `applyTranslations`
 * follows for machine translation, and for the same reason: generated text that
 * silently replaces written text destroys work somebody did deliberately.
 */

export interface NoticePurpose {
  name: I18nText;
  description?: I18nText | null;
  /** True when this purpose relies on consent rather than a legitimate use. */
  requiresConsent: boolean;
  fields: { key: string; label: I18nText; dataDescription?: I18nText | null }[];
}

export interface NoticeOrganisation {
  legalName: string | null;
  name: string;
  grievanceOfficerName: string | null;
  grievanceOfficerEmail: string | null;
  grievanceOfficerPhone: string | null;
}

/**
 * How a question is described in a notice.
 *
 * The explicit `dataDescription` if the admin wrote one, else the label with
 * its question mark taken off — "Guardian's phone?" is a fine thing to ask and
 * a silly thing to claim you collect. Falls back to the key, which is ugly but
 * never blank; a notice with a gap in the list of what you collect is worse
 * than one with an awkward word in it.
 */
export function describeField(
  field: { key: string; label: I18nText; dataDescription?: I18nText | null },
  locale: string,
): string {
  const described = field.dataDescription ? localise(field.dataDescription, locale, '') : '';
  if (described) return described;

  const label = localise(field.label, locale, field.key);
  return label.replace(/\s*[?？]\s*$/, '').trim() || field.key;
}

/** Joins a list the way a person would read it aloud. */
function readable(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Composes a draft notice in one language.
 *
 * Deliberately plain: short sentences, no defined terms, nothing a reader has
 * to hold in their head. It is going to be read aloud to someone who may be
 * standing in a doorway, possibly not reading along, possibly in a hurry. Legal
 * completeness that nobody hears is not compliance.
 *
 * English only for now. The generated draft is then machine-translated through
 * the existing pipeline and reviewed, which is the same path organisation
 * content already takes — writing per-language templates here would mean this
 * file, rather than the organisation, deciding the words in twenty-two
 * languages.
 */
export function composeNotice(
  org: NoticeOrganisation,
  purposes: NoticePurpose[],
  locale = 'en',
): string {
  const who = org.legalName?.trim() || org.name;
  const lines: string[] = [];

  lines.push(`${who} is collecting some information about you.`);
  lines.push('');
  lines.push('This is what we collect, and why.');
  lines.push('');

  for (const purpose of purposes) {
    const what = readable(purpose.fields.map((field) => describeField(field, locale)));
    const why = localise(purpose.name, locale, '');
    const detail = purpose.description ? localise(purpose.description, locale, '') : '';

    if (!what) continue;

    // "so that we can run the mid-day meal programme" reads as a reason;
    // "for: nutrition_survey" reads as a database.
    lines.push(`• We collect ${what}, so that we can ${lower(why)}.`);
    if (detail) lines.push(`  ${detail}`);
  }

  lines.push('');

  const consented = purposes.filter((purpose) => purpose.requiresConsent);
  if (consented.length > 0) {
    lines.push('You do not have to agree. If you do not, we will still help you where we can.');
    lines.push(
      'You can change your mind at any time. Tell any of our staff, and we will stop using your information for anything you have not agreed to.',
    );
  }

  const legitimate = purposes.filter((purpose) => !purpose.requiresConsent);
  if (legitimate.length > 0) {
    /*
     * Said plainly rather than omitted. Where a Section 7 legitimate use
     * applies there is nothing to agree to and nothing to withdraw — and
     * letting someone believe they had agreed to something they could later
     * take back would be the more misleading choice.
     */
    lines.push(
      'Some of this we must collect in order to provide a government scheme or service. That part does not depend on your agreement, and we cannot stop collecting it while we are helping you with that scheme.',
    );
  }

  lines.push('');
  lines.push('You can ask us at any time to show you what we hold about you, to correct it, or to delete it.');

  const contact = [org.grievanceOfficerPhone, org.grievanceOfficerEmail].filter(Boolean).join(' or ');
  if (org.grievanceOfficerName && contact) {
    lines.push(`If you are unhappy with how we have handled your information, speak to ${org.grievanceOfficerName} on ${contact}.`);
  }

  /*
   * The residue, disclosed rather than discovered.
   *
   * Erasure genuinely cannot reach a spreadsheet already downloaded, or a
   * database backup until it rotates out. Saying so is the honest position and
   * it is also the only one that survives somebody checking.
   */
  lines.push('');
  lines.push(
    'If you ask us to delete your information, we will. Two things we cannot undo: reports we have already given to a funder or the government, and our backup copies, which are erased on their own schedule. We will also keep a record — without your name — that you agreed and later asked us to delete, because we have to be able to show we followed the rules.',
  );

  return lines.join('\n').trim();
}

/** Sentence-cases a purpose name for use mid-sentence. */
const lower = (text: string): string =>
  text.length > 1 && text[1] === text[1]?.toLowerCase()
    ? text.charAt(0).toLowerCase() + text.slice(1)
    : text;

/**
 * A stable hash of the exact words shown, so a device can prove what it
 * displayed.
 *
 * Normalises line endings and trailing whitespace only — anything cleverer and
 * the phone and the server would disagree about what "the same text" means,
 * turning every consent into a mismatch.
 *
 * Async because it uses Web Crypto, which is what both the browser and Node
 * have in common; a synchronous hash would mean bundling an implementation.
 */
export async function hashNoticeText(text: string): Promise<string> {
  const normalised = text.replace(/\r\n/g, '\n').trimEnd();
  const bytes = new TextEncoder().encode(normalised);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
