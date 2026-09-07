/**
 * Types for `load-env.mjs`.
 *
 * The loader is plain JavaScript so that `next.config.ts` can import it before
 * any TypeScript transform is set up, which is why it needs a declaration file
 * rather than simply being written in TypeScript.
 */
export declare function loadRootEnv(): void;

/**
 * Fills in `DATABASE_URL` / `DATABASE_APP_URL` from a provider's own variable
 * names. Called by `loadRootEnv`; exported for the tests. Returns one note per
 * variable it resolved, in the order they were resolved.
 */
export declare function resolveDatabaseEnv(env?: Record<string, string | undefined>): string[];

/** The project reference in a Supabase pooler username, or null anywhere else. */
export declare function poolerTenant(connectionString: string): string | null;

/** The same connection string as a different role, keeping any tenant suffix. */
export declare function applicationUrl(
  ownerUrl: string,
  role: string,
  password: string,
): string | null;

/** The default name of the non-owner role that serves requests. */
export declare const DEFAULT_APP_ROLE: string;
