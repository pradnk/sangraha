import { listSignInOrganisations } from '@/lib/auth/organisations';
import { getOrgIdentityBySlug } from '@/lib/org-identity';
import { LoginForm } from './login-form';
import { Welcome } from './welcome';

/**
 * The login screen.
 *
 * The organisation is resolved for the worker, never typed: with a single
 * organisation the field does not appear at all, and with several it is a
 * dropdown of names. `?org=<slug>` still preselects one, for links sent to
 * staff.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; reason?: string }>;
}) {
  const [params, organisations] = await Promise.all([searchParams, listSignInOrganisations()]);

  /*
   * An empty installation gets the landing page instead of a sign-in form,
   * because there is nobody to sign in as yet. Returned here rather than from
   * inside `LoginForm` so it stays a server component — it has no state and no
   * handlers, and there is no reason to ship it to the browser. It also means
   * `LoginForm` below can assume it has at least one organisation.
   */
  if (organisations.length === 0) return <Welcome />;

  const requested = params.org && organisations.some((org) => org.slug === params.org)
    ? params.org
    : '';

  /*
   * The organisation's own mark, above its own sign-in box.
   *
   * Only resolvable when there is exactly one organisation, or one was named in
   * the URL — with several and none specified there is nobody's brand to show
   * yet, so the form falls back to a picker.
   */
  const single = organisations.length === 1 ? organisations[0]!.slug : requested;
  const identity = single ? await getOrgIdentityBySlug(single) : null;

  return (
    <main className="theme-field flex min-h-dvh flex-col bg-slate-50">
      <LoginForm
        organisations={organisations}
        defaultOrgSlug={requested}
        expired={params.reason === 'expired'}
        identity={identity}
      />
    </main>
  );
}
