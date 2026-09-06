import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id.
 *
 * The literal is used rather than the library's `Algorithm` enum because that
 * is declared as an ambient `const enum`, which cannot be imported under
 * `isolatedModules` (Next.js requires it). Stated explicitly rather than left
 * to the library default, since which Argon2 variant is in use is a
 * security-relevant decision worth being able to read off the page: Argon2id is
 * the hybrid that resists both GPU cracking and side-channel attacks.
 */
const ARGON2ID = 2;

/**
 * PIN hashing.
 *
 * A numeric PIN has a tiny search space — a 6-digit PIN is one of a million.
 * Two things compensate, and both are necessary:
 *
 *   1. Online: `users.failed_attempts` / `locked_until` lock the account after
 *      a handful of wrong tries. This is the defence that actually matters.
 *   2. Offline: if the database is ever exposed, these parameters make a
 *      million-candidate sweep per user expensive rather than instant.
 *
 * A PIN was chosen over a password deliberately — see the auth notes — because
 * field workers share devices, have no email, and forget passwords. Accepting
 * that trade-off means being serious about these two mitigations.
 */

/** Six digits, not four: four is 10,000 candidates, which lockout alone cannot carry. */
export const MIN_PIN_LENGTH = 6;
export const MAX_PIN_LENGTH = 12;

// ~64 MiB and 3 passes. Tuned to stay under roughly 100 ms on modest server
// hardware, so login on a slow connection is not made slower still.
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export class WeakPinError extends Error {
  constructor(readonly reason: 'too_short' | 'too_long' | 'not_numeric' | 'too_common') {
    super(`PIN rejected: ${reason}`);
    this.name = 'WeakPinError';
  }
}

/**
 * Sequences and repeats, which is what people pick when left alone.
 *
 * Blocking these costs a worker one extra attempt at setup and removes the
 * candidates an attacker would try first.
 */
function isTooCommon(pin: string): boolean {
  if (/^(\d)\1*$/.test(pin)) return true; // 111111
  const ascending = '01234567890123456789';
  const descending = '09876543210987654321';
  return ascending.includes(pin) || descending.includes(pin);
}

export function assertPinAcceptable(pin: string): void {
  if (!/^\d+$/.test(pin)) throw new WeakPinError('not_numeric');
  if (pin.length < MIN_PIN_LENGTH) throw new WeakPinError('too_short');
  if (pin.length > MAX_PIN_LENGTH) throw new WeakPinError('too_long');
  if (isTooCommon(pin)) throw new WeakPinError('too_common');
}

export async function hashPin(pin: string): Promise<string> {
  assertPinAcceptable(pin);
  return hash(pin, ARGON2_OPTIONS);
}

/**
 * A hash of an unguessable random value, for verifying against when no such
 * user exists.
 *
 * Deliberately skips the strength policy: this is never anybody's PIN, it
 * exists only so that a missing username costs the same time as a wrong PIN
 * and cannot be distinguished from one.
 */
export async function createDecoyHash(): Promise<string> {
  return hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
}

/**
 * Checks a PIN. Returns false rather than throwing on a malformed hash, so a
 * corrupt row denies access instead of returning a 500 that reveals it exists.
 */
export async function verifyPin(pinHash: string, pin: string): Promise<boolean> {
  try {
    return await verify(pinHash, pin, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
