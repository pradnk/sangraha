import { requireSession } from '@/lib/auth/guard';
import { FindPerson } from './find-person';

/**
 * Finding someone who is already registered.
 *
 * The entry point to the registry from the field. Everything the worker can
 * reach from here — the profile, the timeline, adding a visit — depends on
 * their being able to find the person in the first place, which is why search
 * is forgiving about spelling.
 */
export default async function FindPage() {
  const session = await requireSession();
  return <FindPerson locale={session.locale} />;
}
