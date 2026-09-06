/**
 * The logo resize decision.
 *
 * The bug this guards against: a large image was sent as-is and Next.js rejected
 * the request with "Body exceeded 1 MB limit" before any of our own validation
 * ran, surfacing as an unhandled error. The fix is to shrink it in the browser
 * first, so the decision about *whether* and *how far* is the thing worth
 * testing — the canvas call around it is glue.
 */
import { describe, expect, it } from 'vitest';
import { describeSize, planLogoResize } from '../image';

describe('planLogoResize', () => {
  it('leaves a small, correctly sized image alone', () => {
    // Re-encoding this would only lose quality.
    const plan = planLogoResize(240, 80, 26 * 1024, 'image/png');

    expect(plan.needsWork).toBe(false);
    expect(plan.targetWidth).toBe(240);
    expect(plan.targetHeight).toBe(80);
  });

  it('shrinks the print-resolution logo that used to crash the upload', () => {
    // 1400x1400, 6.4 MB — the actual failing case.
    const plan = planLogoResize(1400, 1400, 6.4 * 1024 * 1024, 'image/png');

    expect(plan.needsWork).toBe(true);
    expect(plan.targetHeight).toBe(512);
    expect(plan.targetWidth).toBe(512);
  });

  it('keeps the aspect ratio of a wide banner', () => {
    const plan = planLogoResize(3000, 600, 2 * 1024 * 1024, 'image/png');

    expect(plan.targetWidth).toBe(1024);
    // 3000x600 is 5:1; scaled to 1024 wide that is 205 tall.
    expect(plan.targetHeight).toBe(205);
    expect(plan.targetWidth / plan.targetHeight).toBeCloseTo(5, 1);
  });

  it('constrains by height when the image is tall', () => {
    const plan = planLogoResize(600, 3000, 2 * 1024 * 1024, 'image/png');

    expect(plan.targetHeight).toBe(512);
    expect(plan.targetWidth).toBe(102);
  });

  it('re-encodes a correctly sized image that is simply too heavy', () => {
    // Within the dimension limits but a 900 KB PNG — still worth shrinking.
    const plan = planLogoResize(800, 400, 900 * 1024, 'image/png');

    expect(plan.needsWork).toBe(true);
    expect(plan.targetWidth).toBe(800);
    expect(plan.targetHeight).toBe(400);
  });

  it('always re-encodes an SVG, so only pixels are ever stored', () => {
    // Rasterising is what makes accepting SVG safe: the document, and anything
    // it could carry, is discarded.
    const plan = planLogoResize(200, 100, 4 * 1024, 'image/svg+xml');

    expect(plan.needsWork).toBe(true);
  });

  it('never produces a zero dimension', () => {
    const plan = planLogoResize(4000, 1, 3 * 1024 * 1024, 'image/png');

    expect(plan.targetWidth).toBeGreaterThan(0);
    expect(plan.targetHeight).toBeGreaterThan(0);
  });
});

describe('describeSize', () => {
  it('reads naturally at both scales', () => {
    expect(describeSize(26 * 1024)).toBe('26 KB');
    expect(describeSize(6.4 * 1024 * 1024)).toBe('6.4 MB');
  });
});
