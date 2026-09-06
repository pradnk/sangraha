/**
 * The PIN an administrator reads out over the phone.
 *
 * It is a live credential on a live tenant from the moment it is issued until
 * the worker changes it, so where the digits come from matters as much as what
 * they look like. No database here — this is a pure function and the policy is
 * the whole of it.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateTemporaryPin } from '../queries/admin-users';

describe('a temporary PIN', () => {
  it('does not come from Math.random', () => {
    /*
     * The defect this pins down. `Math.random` is a PRNG whose internal state
     * is recoverable from a short run of its output, so PINs issued in one
     * session would predict the next — and an administrator issuing a handful
     * in a row is the normal way this function is used.
     *
     * Asserted on the call rather than on the output, because no test of six
     * digits can tell a weak generator from a strong one.
     */
    const weak = vi.spyOn(Math, 'random');

    for (let i = 0; i < 50; i += 1) generateTemporaryPin();

    expect(weak).not.toHaveBeenCalled();
    weak.mockRestore();
  });

  it('is six digits, and keeps a leading zero', () => {
    // A PIN formatted from a single number loses its leading zeros, and
    // `042917` is a PIN somebody has to be able to type.
    const pins = Array.from({ length: 500 }, () => generateTemporaryPin());

    for (const pin of pins) expect(pin).toMatch(/^\d{6}$/);
    expect(pins.some((pin) => pin.startsWith('0'))).toBe(true);
  });

  it('never issues one the strength policy would then refuse', () => {
    // An issued PIN that cannot be set is a support call, so the rejection loop
    // is not decoration.
    for (let i = 0; i < 2000; i += 1) {
      const pin = generateTemporaryPin();
      expect(pin).not.toMatch(/^(\d)\1*$/);
      expect('01234567890123456789'.includes(pin)).toBe(false);
      expect('09876543210987654321'.includes(pin)).toBe(false);
    }
  });

  it('does not repeat itself over a run', () => {
    // Not a randomness test — a broken generator returning a constant would
    // pass everything above.
    const pins = new Set(Array.from({ length: 500 }, () => generateTemporaryPin()));
    expect(pins.size).toBeGreaterThan(450);
  });
});
