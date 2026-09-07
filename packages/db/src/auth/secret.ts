/**
 * The one definition of `AUTH_SECRET`.
 *
 * It does two jobs, and both of them fail quietly when it is weak. It signs
 * every session cookie, so a guessable value lets anyone mint a session for any
 * organisation and any role — including `org_admin` — without touching a
 * password. And it peppers the consent pseudonyms in `subjectPseudonym`, where
 * a known pepper means the pseudonyms can be recomputed by whoever knows it.
 *
 * There were two checks before this, in two packages, and neither was enough.
 * `session.ts` required 32 characters; `consent.ts` required only that
 * something was set. Between them sat the real hole: `.env.example` shipped
 *
 *   AUTH_SECRET=replace-me-with-a-random-32-byte-secret
 *
 * which is 39 characters and passed the length check comfortably. Anyone who
 * copied the example file into a deployment's environment — the obvious thing
 * to do, and what the README tells you to do before the part where you replace
 * it — got a working installation signed with a string published in this
 * repository. Nothing looked wrong, because nothing was wrong until someone
 * looked at the file.
 *
 * So the placeholder is now rejected by name, everywhere, including in
 * development. A default that is insecure unless its operator read the right
 * paragraph is the same mistake `signupMode` already corrected once.
 */

/**
 * Long enough that guessing is not the attack.
 *
 * HS256 keys shorter than the hash are the documented weakness of the
 * algorithm; `openssl rand -base64 32` yields 44 characters and clears this
 * without anyone having to think about it.
 */
const MINIMUM_LENGTH = 32;

/**
 * Values that are plainly not secrets.
 *
 * The first is the one this repository shipped. The rest are the shapes people
 * reach for when filling a field they intend to come back to, which they then
 * do not.
 */
const PLACEHOLDERS = [
  'replace-me-with-a-random-32-byte-secret',
  'replace-me-with-a-random-secret',
  'your-secret-here',
  'changeme',
  'secret',
  'password',
];

/**
 * Guidance rather than a bare complaint, and different in a build.
 *
 * A deployment has no `.env` to edit and no shell to edit it from, so naming
 * one there sends the reader looking for a file that does not exist. Same
 * lesson as `migrate.ts`.
 */
function guidance(problem: string): string {
  const deployed = Boolean(process.env.VERCEL || process.env.CI);

  return [
    problem,
    '',
    'It signs every session cookie and peppers the consent pseudonyms. A',
    'guessable value lets anyone mint a session for any organisation and any',
    'role, without a PIN, and nothing about the installation would look wrong.',
    '',
    'Generate one:',
    '  openssl rand -base64 32',
    '',
    ...(deployed
      ? [
          "Set it in your deployment platform's environment variables — for every",
          'environment you deploy, since one scoped only to production is absent',
          'from a preview build — then deploy again.',
        ]
      : ['Then put it in .env at the repo root.']),
  ].join('\n');
}

/**
 * The validated secret.
 *
 * Throws rather than falling back to anything. There is no safe default for
 * this value, and a generated-per-boot one would invalidate every session on
 * every deploy while looking like it worked.
 *
 * The length is reported on failure but the value never is: these messages end
 * up in build logs and error trackers.
 */
export function authSecret(): string {
  const value = process.env.AUTH_SECRET?.trim();

  if (!value) throw new Error(guidance('AUTH_SECRET is not set.'));

  const normalised = value.toLowerCase();
  if (PLACEHOLDERS.includes(normalised) || normalised.includes('replace-me')) {
    throw new Error(guidance('AUTH_SECRET is still a placeholder, not a secret.'));
  }

  if (value.length < MINIMUM_LENGTH) {
    throw new Error(
      guidance(
        `AUTH_SECRET is ${value.length} characters; it must be at least ${MINIMUM_LENGTH}.`,
      ),
    );
  }

  return value;
}
