/**
 * Which page numbers a pager shows.
 *
 * Two chevrons were fine at four pages and useless at forty. The rule has to
 * fit any length into roughly the same width, always offer the first and last,
 * and never render a gap that hides only one page — an ellipsis standing in for
 * a single number is a worse link than the number.
 */
import { describe, expect, it } from 'vitest';
import { pageNumbers } from '../[slug]/records-pager';

describe('page numbers', () => {
  it('shows them all when they fit', () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps the first and last reachable from the middle', () => {
    const pages = pageNumbers(20, 40);

    expect(pages[0]).toBe(1);
    expect(pages.at(-1)).toBe(40);
    expect(pages).toContain(20);
    // The window around where you are.
    expect(pages).toContain(19);
    expect(pages).toContain(21);
  });

  it('stays about the same width wherever you are', () => {
    const widths = [1, 2, 5, 20, 39, 40].map((page) => pageNumbers(page, 40).length);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
  });

  it('never uses an ellipsis to hide a single page', () => {
    for (const page of [1, 2, 3, 4, 5, 19, 20, 21, 36, 37, 38, 39, 40]) {
      const pages = pageNumbers(page, 40);
      pages.forEach((entry, i) => {
        if (entry !== null) return;
        const before = pages[i - 1];
        const after = pages[i + 1];
        // A gap must stand for at least two pages, or it is just a worse link.
        expect(after! - before!).toBeGreaterThan(2);
      });
    }
  });

  it('is always ascending, with no repeats', () => {
    for (const page of [1, 7, 20, 33, 40]) {
      const numbers = pageNumbers(page, 40).filter((n): n is number => n !== null);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it('never offers a page that does not exist', () => {
    for (const total of [1, 2, 8, 40]) {
      for (let page = 1; page <= total; page += 1) {
        for (const entry of pageNumbers(page, total)) {
          if (entry === null) continue;
          expect(entry).toBeGreaterThanOrEqual(1);
          expect(entry).toBeLessThanOrEqual(total);
        }
      }
    }
  });
});
