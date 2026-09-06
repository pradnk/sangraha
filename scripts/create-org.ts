/**
 * Creates an organisation with its first administrator.
 *
 *   npm run org:create -- --name "Pratham Education" --admin meera
 *
 * A command rather than a screen, deliberately. Creating a tenant is a
 * platform-operator action, not something any user of the product should be able
 * to do — and on a self-hosted install there is nobody signed in yet to do it
 * from. Same shape as `createsuperuser`: it is how you bootstrap.
 *
 * Prints a temporary PIN once. It is stored only as an argon2 hash, so there is
 * no way to retrieve it afterwards; the administrator is forced to replace it on
 * first sign-in.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { toSnakeCase } from '../packages/form-engine/src/index';
import { loadRootEnv } from '../load-env.mjs';
import {
  createPostgresClient,
  deriveOrgSlug,
  generateTemporaryPin,
  provisionOrganisation,
  type Database,
} from '../packages/db/src/index';

loadRootEnv();

interface Args {
  name: string;
  admin: string;
  slug?: string;
  locales: string[];
  levels: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith('--')) flags.set(arg.slice(2), argv[i + 1] ?? '');
  }

  const name = flags.get('name')?.trim();
  const admin = flags.get('admin')?.trim().toLowerCase();

  if (!name || !admin) {
    console.error(
      [
        '',
        'Create an organisation and its first administrator.',
        '',
        '  npm run org:create -- --name "Pratham Education" --admin meera',
        '',
        'Options:',
        '  --name    <text>   Required. The organisation\'s display name.',
        '  --admin   <name>   Required. Sign-in name for the first administrator.',
        '  --slug    <text>   Optional. Defaults to a slug derived from --name.',
        '  --locales <list>   Optional. Comma-separated, e.g. en,hi,kn. Defaults to en.',
        '  --levels  <list>   Optional. Comma-separated place levels, e.g. District,Block,Village.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (!/^[a-z0-9_]+$/.test(admin)) {
    console.error('--admin must contain only lowercase letters, numbers and underscores.');
    process.exit(1);
  }

  return {
    name,
    admin,
    slug: flags.get('slug')?.trim() || undefined,
    locales: (flags.get('locales') || 'en')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
    levels: (flags.get('levels') || '')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. On a fresh clone: cp .env.example .env');
  }

  const client = createPostgresClient(url, 1);
  const db = drizzle(client) as unknown as Database;

  try {
    const pin = generateTemporaryPin();

    const result = await provisionOrganisation(db, {
      name: args.name,
      slug: args.slug,
      adminUsername: args.admin,
      adminPin: pin,
      // Issued, not chosen — so they are made to replace it on first sign-in.
      mustChangePin: true,
      locales: args.locales,
      locationLevels: args.levels.map((label) => ({
        key: toSnakeCase(label),
        label: { en: label },
      })),
    });

    if (!result.ok) {
      throw new Error(
        result.reason === 'slug_taken'
          ? `An organisation with the slug "${args.slug ?? deriveOrgSlug(args.name)}" already exists.`
          : `"${args.slug}" is not a usable slug. Use letters, numbers and hyphens.`,
      );
    }

    console.log(`
✓ Created "${args.name}"

    Sign-in address   /login?org=${result.slug}
    Administrator     ${args.admin}
    Temporary PIN     ${pin}

  The PIN is shown once and cannot be recovered — it is stored only as a hash.
  ${args.admin} will be asked to choose their own on first sign-in.

  Next: sign in, then follow the setup guide.
`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
