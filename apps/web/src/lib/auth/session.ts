import 'server-only';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { authSecret, type RequestContext } from '@sangraha/db';

/**
 * Sessions.
 *
 * A signed, stateless JWT in an httpOnly cookie. Stateless because the field
 * app has to work over an intermittent connection without a session lookup on
 * every request, and because it keeps self-hosting to two containers — no Redis.
 *
 * The trade-off is that a session cannot be revoked before it expires. That is
 * mitigated by `tokenVersion`: bumping a user's version (on PIN reset, role
 * change or deactivation) invalidates their outstanding tokens on next use.
 */

const COOKIE_NAME = 'mis_session';
const ALGORITHM = 'HS256';

export interface SessionPayload extends RequestContext {
  username: string;
  fullName: string;
  locale: string;
  orgSlug: string;
  mustChangePin: boolean;
  tokenVersion: number;
}

// Validated in one place, shared with the consent pepper that uses the same
// value — see `authSecret`. A length check here and a truthiness check there
// was how the example placeholder came to pass both.
function secret(): Uint8Array {
  return new TextEncoder().encode(authSecret());
}

function maxAgeSeconds(): number {
  // Long by web standards, deliberately. A field worker re-authenticating
  // mid-village because a session lapsed is a real cost; the PIN is a weak
  // secret either way and the lockout policy is what protects the account.
  const days = Number(process.env.SESSION_MAX_AGE_DAYS ?? 30);
  return days * 24 * 60 * 60;
}

export async function createSession(payload: SessionPayload): Promise<void> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSeconds()}s`)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Allows http on localhost during development; required in production.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds(),
  });
}

export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALGORITHM] });
    return payload as unknown as SessionPayload;
  } catch {
    // Expired, tampered with, or signed under a rotated secret. All three mean
    // "not signed in" — there is nothing useful to tell the user beyond that.
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** The RLS context for the signed-in user, or null. */
export function toRequestContext(session: SessionPayload): RequestContext {
  return { orgId: session.orgId, userId: session.userId, role: session.role };
}
