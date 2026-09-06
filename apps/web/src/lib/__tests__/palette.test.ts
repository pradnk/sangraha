/**
 * Every custom colour a class names has to exist.
 *
 * Tailwind is silent about a shade that was never defined: `bg-affirm-600`
 * against a palette holding only 50, 500 and 700 emits no CSS whatsoever. The
 * element keeps whatever background it had, and `text-white` still applies — so
 * the consent screen's "they agreed" button was white text on nothing. Present,
 * focusable, clickable and completely invisible, and it stayed that way because
 * it also sat below the fold where nobody could see it was missing.
 *
 * That is not a mistake a person catches by reading a diff, and no other check
 * in this repo could see it: the class name is valid, the TypeScript compiles,
 * the component renders, and the button is in the DOM. Which is exactly the kind
 * of thing worth spending a test on.
 *
 * A static scan rather than a rendering test, deliberately. It needs no browser,
 * runs in `npm test`, and covers every file at once instead of the handful a
 * screenshot would.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../../tailwind.config';

/** The families defined in the config, as `family -> set of shades`. */
function definedShades(): Map<string, Set<string>> {
  const extend = (config.theme?.extend?.colors ?? {}) as Record<
    string,
    Record<string | number, string>
  >;

  const families = new Map<string, Set<string>>();
  for (const [family, scale] of Object.entries(extend)) {
    if (typeof scale !== 'object' || scale === null) continue;
    families.set(family, new Set(Object.keys(scale).map(String)));
  }
  return families;
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    // Tests are not rendered, and this file names broken classes in its own
    // explanation — scanning them would flag the description of the bug.
    if (entry === '__tests__') continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(tsx?|css)$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * Utilities that take a colour. Not exhaustive across all of Tailwind — it is
 * the set this codebase actually uses, and an unlisted one simply is not
 * checked rather than failing wrongly.
 */
const UTILITIES =
  'bg|text|border|ring|from|to|via|fill|stroke|divide|placeholder|accent|caret|outline|shadow|decoration';

describe('the custom colour palette', () => {
  const defined = definedShades();

  it('defines the families the design system is built on', () => {
    // A rename that dropped one of these would make every class using it
    // silently do nothing, which is the failure this file exists for.
    expect([...defined.keys()].sort()).toEqual(['affirm', 'brand', 'deny']);
  });

  it('has no class naming a shade that does not exist', () => {
    const families = [...defined.keys()].join('|');
    const pattern = new RegExp(`\\b(?:${UTILITIES})-(${families})-(\\d{2,3})\\b`, 'g');

    const broken: string[] = [];
    for (const file of sourceFiles(join(import.meta.dirname, '..', '..'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(pattern)) {
        const [token, family, shade] = match;
        if (defined.get(family!)!.has(shade!)) continue;
        const line = text.slice(0, match.index).split('\n').length;
        broken.push(`${token} at ${file.replace(/.*\/apps\/web\//, '')}:${line}`);
      }
    }

    expect(
      broken,
      'These classes generate no CSS at all, so the element keeps whatever it ' +
        'already had — white text on no background is invisible. Add the shade ' +
        'to tailwind.config.ts or use one that exists.',
    ).toEqual([]);
  });

  it('keeps every shade a real colour', () => {
    for (const [family, shades] of defined) {
      const scale = (
        (config.theme?.extend?.colors ?? {}) as Record<string, Record<string, string>>
      )[family]!;
      for (const shade of shades) {
        expect(scale[shade], `${family}-${shade}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
