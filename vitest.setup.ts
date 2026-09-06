// Vitest does not read .env, and the integration tests need real database
// credentials. Shares one loader with next.config.ts so there is a single
// definition of where configuration comes from.
import { loadRootEnv } from './load-env.mjs';

loadRootEnv();
