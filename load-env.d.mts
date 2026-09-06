/**
 * Types for `load-env.mjs`.
 *
 * The loader is plain JavaScript so that `next.config.ts` can import it before
 * any TypeScript transform is set up, which is why it needs a declaration file
 * rather than simply being written in TypeScript.
 */
export declare function loadRootEnv(): void;
