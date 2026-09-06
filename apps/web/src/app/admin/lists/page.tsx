import { countAnswersForOption, listOptionSets } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { ListsEditor } from './lists-editor';

/**
 * Answer lists.
 *
 * Their own page rather than being buried inside one question's editor: a list
 * is shared between questions and between forms, and editing it from a single
 * question would hide that an edit ripples outward.
 */
export default async function ListsPage() {
  const session = await requireRole(['org_admin', 'super_admin']);

  const sets = await withSession(session, async (tx) => {
    const all = await listOptionSets(tx, session.orgId);

    // Usage counts per option, so the UI can refuse a destructive delete before
    // the admin attempts it rather than after.
    return Promise.all(
      all.map(async (set) => ({
        ...set,
        options: await Promise.all(
          set.options.map(async (option) => ({
            ...option,
            answerCount: await countAnswersForOption(tx, session.orgId, set.id, option.code),
          })),
        ),
      })),
    );
  });

  return <ListsEditor sets={sets} locale={session.locale} />;
}
