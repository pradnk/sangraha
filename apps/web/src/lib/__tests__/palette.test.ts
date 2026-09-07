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

/**
 * The co-brand has to be readable, not merely present.
 *
 * `SangrahaCoBrand` shipped as `text-slate-400` on a white header: 2.56:1,
 * which is below the 4.5:1 WCAG AA asks of text and below even the 3:1 floor
 * for a UI element. It was reported as "not very visible", and it was not a
 * matter of taste — on a sunlit phone it was gone.
 *
 * The failure mode is the same one this file already guards against, one step
 * further on: the class is valid, the shade exists, the CSS is emitted, and the
 * result is still unreadable. Only a number catches that.
 *
 * Pinned to the two colours the component actually names, so that darkening it
 * back into invisibility fails here rather than in the field.
 */
describe('co-brand contrast', () => {
  /** WCAG relative luminance. */
  function luminance(hex: string): number {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  }

  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  // Tailwind's own slate scale; the config extends `brand` but not `slate`.
  const SLATE_600 = '#475569';
  const WHITE = '#ffffff';

  it('is a sanity check that agrees with the known failure', () => {
    // The shade the component used to carry, kept as the reason the rest exists.
    expect(contrast('#94a3b8', WHITE)).toBeLessThan(3);
  });

  it('sets the wordmark dark enough to read on a white header', () => {
    expect(contrast(SLATE_600, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it('sets the mark dark enough to read on a white header', () => {
    const brand = (config.theme?.extend?.colors as Record<string, Record<string, string>>).brand!;
    expect(contrast(brand['600']!, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it('still uses those two colours', () => {
    const component = readFileSync(
      join(import.meta.dirname, '..', '..', 'components', 'brand', 'sangraha-mark.tsx'),
      'utf8',
    );
    const coBrand = component.slice(component.indexOf('export function SangrahaCoBrand'));
    expect(coBrand, 'the mark should carry the product accent').toContain('text-brand-600');
    expect(coBrand, 'the wordmark should be slate-600 or darker').toContain('text-slate-600');
  });
});
