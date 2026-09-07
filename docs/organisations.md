# Adding a new organisation

Two routes onto the system: self-serve signup at `/start` with a guided
setup, and `npm run org:create` from a shell.

---

## Self-serve

Go to **`/start`**. Four questions — organisation name, your name, a sign-in
name, a PIN — and you are its administrator, signed in, looking at a setup
guide.

The guide at `/admin/setup` walks through what comes next, and each step marks
itself done by looking at your actual data rather than at a checkbox:

1. Add your places
2. Choose your languages — optional
3. Say why you collect data
4. Build your first form (in English)
5. Publish it
6. Publish your privacy notice
7. Say who handles privacy questions
8. Add your team — each person gets a one-time PIN to pass on
9. Add your logo — optional
10. Try it on your own phone

Each step links to the specific card it names — `/admin/settings#languages`,
`/admin/privacy#notices` — rather than to the top of a page holding four
unrelated things.

**It is not only a checklist.** Setting up does not finish: a new programme is a
new purpose and a re-published notice, a new district is places and people, a
new team is a language. So every row always links, done or not, and every row
shows what is actually there — "4 purposes", "2 of 3 published", the name of
whoever handles privacy requests. Once the required rows are done the heading
becomes **What you have set up**, and it is the first entry in the **Setup**
menu: the index of the seven screens under it, for an admin who knows they need
to change something and not which screen holds it.

**The Privacy screen says outright whether anyone is being asked.** Consent is
only collected when a live purpose rests on the person's permission *and* a
notice covering it has been published — miss either and the capture screen
silently skips the step. That was inferable from two grey subtitles and nothing
else, so the top of `/admin/privacy` now states which of the two states you are
in, and lists the missing half with a link to it.

**"Write it from my forms" is not an AI call.** It reads your legal details, your
purposes, and which questions are attributed to each, and assembles a notice from
a template (`composeNotice`) — offline, no key, and the same words for the same
inputs, which is what makes the published hash worth anything. It used to be
labelled "Draft it for me" beside a sparkle icon, which read as a language model
and made people distrust a notice the system had honestly derived from their own
forms. `npm run verify:ui` fails if that implication comes back.

**Purposes and the notice are steps, not paperwork.** Nothing asks anyone for
permission until a purpose exists whose lawful basis is consent *and* a
published notice covers it — `consentRequirementFor` returns null otherwise and
the capture screen shows no consent step at all. Both are legitimate states, so
they are not enforced; what is not acceptable is finding out by accident, which
is why a form that will ask nobody says so when it is published.

Languages come *before* the first form on purpose. The **Translate** button in
the form builder only appears once a second language is switched on, so an
organisation that picks its languages first gets a machine-made first draft
offered as it writes each question. Switch a language on afterwards and nothing
is backfilled: every existing form has to be reopened, translated and published
again.

A banner across the admin console shows how many steps remain until you dismiss
it.

**Who is allowed to sign up** is `SIGNUP_MODE` in `.env`:

| | |
|---|---|
| `open` | Anyone with the URL. The default, so a fresh clone works. |
| `code` | A shared `SIGNUP_CODE` is required. Good for onboarding known partners. |
| `closed` | No signup; use the command below. |

> **Change this on a public deployment.** Left open, anyone who finds the URL can
> create an organisation in your database.

## From the command line

For self-hosting, scripting, or when signup is closed:

```bash
npm run org:create -- --name "Pratham Education" --admin meera \
  --locales en,hi,kn --levels District,Block,School
```

It prints a sign-in address and a one-time PIN. Unlike self-serve, the PIN is
*issued*, so that administrator is made to choose their own on first sign-in.

| Option | |
|---|---|
| `--name` | Required. Display name, shown on the sign-in screen. |
| `--admin` | Required. Sign-in name for the first administrator. |
| `--slug` | Optional. Defaults to a slug from the name. **Permanent** — it names the analytics schema. |
| `--locales` | Optional. `en`, `hi`, `kn`. English is always included. |
| `--levels` | Optional. Place level names, outermost first. |

To remove one, with everything in it:

```bash
npm run org:delete -- --slug pratham-education --confirm
```

**The login screen adapts.** With one organisation there is no organisation field
at all. With several it becomes a dropdown of names — so use
`/login?org=<slug>` in links to staff to preselect theirs.

> For real multi-tenant SaaS, replace the dropdown with subdomain resolution
> (`pratham.example.org`). A public list of every customer is fine for a
> self-hosted install and wrong for SaaS.

---

[← Back to the README](../README.md)
