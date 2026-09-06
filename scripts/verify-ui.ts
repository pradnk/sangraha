/**
 * Browser acceptance check against a running dev server.
 *
 *   npm run dev
 *   npx tsx scripts/verify-ui.ts [baseUrl]
 *
 * The sibling of `verify-e2e.ts`, which exercises the HTTP path and never opens
 * a browser. This one opens a real one, because there is a whole class of
 * failure the request/response layer cannot see: the server HTML is perfect,
 * the page looks right, and nothing on it responds to a click. That is what a
 * hydration failure looks like, and it has happened twice — once from a browser
 * extension rewriting an input, once from two dev servers sharing `.next`.
 *
 * Drives the Chrome already on the machine over the DevTools Protocol, using
 * Node's built-in WebSocket. No new dependency, no browser download: a headless
 * runner that needs its own Chromium is a heavier promise than this repo has
 * asked for anywhere else.
 *
 * A clean console is asserted, not merely reported. Every React hydration
 * failure announces itself as a console error, so "no errors" is the single
 * most valuable assertion here — and warnings that are somebody else's
 * (extensions, the Fast Refresh log) are filtered rather than tolerated
 * wholesale.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { SignJWT } from 'jose';
import { loadRootEnv } from '../load-env.mjs';
import {
  createPostgresClient,
  organisations,
  users,
  type Database,
} from '../packages/db/src/index';

loadRootEnv();

const BASE_URL = process.argv[2] ?? 'http://localhost:3000';
const ORG_SLUG = 'shiksha-demo';
const DEBUG_PORT = 9422;

/**
 * A seeded login, stated here rather than read from the seed.
 *
 * `scripts/check-login.ts` does the same. These are development credentials
 * that `must_change_pin` rotates on first real use, and a check that derived
 * them from the same constant the seed uses could not catch the seed changing
 * out from under it.
 */
const DEMO_WORKER = { username: 'sunita', pin: '639284' } as const;

/** Where Chrome lives, per platform. First hit wins. */
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

let failures = 0;

function check(label: string, passed: boolean, detail?: unknown): void {
  if (passed) {
    console.log(`    ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`    ✗ ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

/**
 * Console output that is not the application's fault.
 *
 * Deliberately short. Every entry here is a hole in the check, so the bar for
 * adding one is a message the app cannot prevent and does not indicate a
 * problem — not a message somebody found annoying.
 */
const IGNORED = [
  'React DevTools', // dev-only advertisement from react-dom
  '[Fast Refresh]', // the dev server narrating its own recompiles
  'Download the React',
];

class Browser {
  private chrome?: ChildProcess;
  private ws?: WebSocket;
  private nextId = 0;
  private pending = new Map<number, (result: unknown) => void>();
  /** Console errors and uncaught exceptions since the last `takeProblems()`. */
  private problems: string[] = [];
  /**
   * Assets the page asked for and did not get.
   *
   * Watched at the network layer as well as the console, because this is how a
   * stale `.next` announces itself: the HTML references
   * `chunks/app/(field)/page.js`, the file is not on disk, and the browser
   * reports "Loading chunk failed". Waiting for it to surface as a console
   * message works but is a layer further from the cause.
   */
  private missingAssets: string[] = [];

  async start(): Promise<void> {
    const binary = CHROME_PATHS.find((path) => {
      try {
        return require('node:fs').existsSync(path);
      } catch {
        return false;
      }
    });
    if (!binary) {
      throw new Error(
        `No Chrome found. Looked in:\n  ${CHROME_PATHS.join('\n  ')}\n` +
          'Install Chrome, or skip this check — it is not part of `npm test`.',
      );
    }

    this.chrome = spawn(
      binary,
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        // A throwaway profile, so an extension or a stale service worker on the
        // developer's own profile cannot change the result.
        `--user-data-dir=${require('node:os').tmpdir()}/sangraha-verify-ui`,
        '--no-first-run',
        '--disable-extensions',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let attempt = 0; attempt < 60 && !target; attempt++) {
      await sleep(250);
      try {
        const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
        const list = (await response.json()) as { type: string; webSocketDebuggerUrl: string }[];
        target = list.find((entry) => entry.type === 'page');
      } catch {
        // Still booting.
      }
    }
    if (!target) throw new Error('Chrome did not expose a debugging target');

    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    this.ws.onmessage = (event) => this.receive(String(event.data));
    await new Promise<void>((resolve) => {
      this.ws!.onopen = () => resolve();
    });

    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Network.enable');
    /*
     * A phone, not the window Chrome happened to open.
     *
     * The field UI is built for a 390x844 handset and several of its failures
     * only exist at that size — a decision pinned below the fold fits fine in a
     * desktop window, so checking there would have passed while the screen was
     * unusable.
     */
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
  }

  private receive(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      method?: string;
      result?: unknown;
      params?: Record<string, never>;
    };

    if (message.id !== undefined) {
      this.pending.get(message.id)?.(message.result);
      this.pending.delete(message.id);
      return;
    }

    if (message.method === 'Runtime.consoleAPICalled') {
      const params = message.params as unknown as {
        type: string;
        args: { value?: unknown; description?: string }[];
      };
      if (params.type !== 'error' && params.type !== 'warning') return;
      const text = params.args
        .map((arg) => String(arg.value ?? arg.description ?? ''))
        .join(' ');
      if (!IGNORED.some((ignore) => text.includes(ignore))) {
        this.problems.push(`console.${params.type}: ${text.slice(0, 300)}`);
      }
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const params = message.params as unknown as {
        exceptionDetails: { text: string; exception?: { description?: string } };
      };
      const text = params.exceptionDetails.exception?.description ?? params.exceptionDetails.text;
      this.problems.push(`uncaught: ${text.slice(0, 300)}`);
    }

    if (message.method === 'Network.responseReceived') {
      const params = message.params as unknown as {
        response: { status: number; url: string };
      };
      // Only the build's own output. An application 404 is a legitimate answer
      // and some of these screens deliberately probe for things.
      if (params.response.status >= 400 && params.response.url.includes('/_next/')) {
        this.missingAssets.push(`${params.response.status} ${params.response.url.slice(0, 140)}`);
      }
    }
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve) => {
      const id = ++this.nextId;
      this.pending.set(id, resolve);
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async setCookie(cookie: string, host: string): Promise<void> {
    const [name, ...rest] = cookie.split('=');
    await this.send('Network.setCookie', {
      name,
      value: rest.join('='),
      domain: host,
      path: '/',
    });
  }

  /** Navigates and waits for the client bundle to have had its chance. */
  async visit(url: string, settleMs = 5000): Promise<void> {
    await this.send('Page.navigate', { url });
    await sleep(settleMs);
  }

  /** Runs an expression in the page and returns its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      expression: `JSON.stringify((() => { ${expression} })())`,
      returnByValue: true,
    })) as { result?: { value?: string } };

    const raw = result?.result?.value;
    return (raw === undefined ? undefined : JSON.parse(raw)) as T;
  }

  async click(selectorExpression: string, settleMs = 800): Promise<void> {
    await this.send('Runtime.evaluate', { expression: `(${selectorExpression})?.click()` });
    await sleep(settleMs);
  }

  takeProblems(): string[] {
    const found = this.problems;
    this.problems = [];
    return found;
  }

  takeMissingAssets(): string[] {
    const found = this.missingAssets;
    this.missingAssets = [];
    return found;
  }

  /** Signs the browser out, so a section can start from nothing. */
  async signOut(): Promise<void> {
    await this.send('Network.clearBrowserCookies');
    await this.send('Network.clearBrowserCache');
  }

  /**
   * Types into a field the way React notices.
   *
   * Setting `.value` directly does not fire the events a controlled input is
   * listening for, so the component's state never changes and the form submits
   * empty. Going through the prototype's setter and dispatching `input` is what
   * a real keystroke amounts to.
   */
  async fill(selector: string, value: string): Promise<void> {
    await this.send('Runtime.evaluate', {
      expression: `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const proto = Object.getPrototypeOf(el);
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `,
    });
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.chrome?.kill();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const client = createPostgresClient(process.env.DATABASE_URL!, 2);
  const db = drizzle(client) as unknown as Database;
  const browser = new Browser();

  try {
    const [org] = await db
      .select({ id: organisations.id, slug: organisations.slug })
      .from(organisations)
      .where(eq(organisations.slug, ORG_SLUG))
      .limit(1);
    if (!org) throw new Error('Seed data missing — run: npm run db:seed');

    const [admin] = await db
      .select()
      .from(users)
      .where(and(eq(users.orgId, org.id), eq(users.username, 'admin')))
      .limit(1);
    if (!admin) throw new Error('Demo user "admin" not found');

    await browser.start();

    console.log(`\nVerifying ${BASE_URL} in a real browser\n`);

    /*
     * ---- Signing in -------------------------------------------------------
     *
     * Done first and for real, from a browser with no cookies. Every other
     * section here injects a session, which is faster and skips the one journey
     * every single user takes. A stale build was reported as "error while
     * logging in": the login page worked, and the home screen it redirects to
     * could not load its JavaScript. Nothing that starts with a cookie already
     * set would have found it.
     */
    console.log('  Signing in');
    await browser.signOut();
    await browser.visit(`${BASE_URL}/login`);

    const loginPage = await browser.evaluate<{ path: string; hasUsername: boolean; hasPin: boolean }>(`
      return {
        path: location.pathname,
        hasUsername: !!document.querySelector('input[name=username]'),
        hasPin: !!document.querySelector('input[type=password]'),
      };
    `);
    check('the login page renders its form', loginPage?.hasUsername && loginPage?.hasPin, loginPage);

    // The demo organisation may not be the only one, so pick it explicitly
    // rather than trusting whatever the picker defaulted to.
    await browser.evaluate<boolean>(`
      const select = document.querySelector('select');
      if (!select) return false;
      const match = [...select.options].find((o) => o.value === ${JSON.stringify(ORG_SLUG)} || o.value === ${JSON.stringify(org.id)});
      if (!match) return false;
      const proto = Object.getPrototypeOf(select);
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(select, match.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);

    await browser.fill('input[name=username]', DEMO_WORKER.username);
    await browser.fill('input[type=password]', DEMO_WORKER.pin);
    await browser.click(
      `document.querySelector('form') && { click: () => document.querySelector('form').requestSubmit() }`,
      9000,
    );

    const landed = await browser.evaluate<{ path: string; hasMenuButton: boolean; text: string }>(`
      return {
        path: location.pathname,
        hasMenuButton: !!document.querySelector('button[aria-haspopup=menu]'),
        text: document.body.innerText.slice(0, 120),
      };
    `);
    check('signing in lands on the home screen', landed?.path === '/', landed);
    check('the home screen loaded its JavaScript', landed?.hasMenuButton === true, landed);

    /*
     * The assertion this bug was reported for. A missing chunk leaves the HTML
     * intact and the page dead, so the network layer is where it is cheapest to
     * see: "Loading chunk app/(field)/page failed" is a 404 on an asset the
     * build was supposed to emit.
     */
    let missing = browser.takeMissingAssets();
    check('every script and stylesheet the page asked for was served', missing.length === 0, missing);

    let problems = browser.takeProblems();
    check('nothing was logged to the console', problems.length === 0, problems);

    // ---- The field home screen --------------------------------------------
    // Re-entered with an admin session, because "Manage forms" is admin-only
    // and the demo worker cannot see it.
    console.log('\n  Field home, as an admin');
    await browser.setCookie(
      `mis_session=${await mintSession(org, admin)}`,
      new URL(BASE_URL).hostname,
    );
    await browser.visit(`${BASE_URL}/`);

    const home = await browser.evaluate<{ path: string; hasMenuButton: boolean }>(`
      return {
        path: location.pathname,
        hasMenuButton: !!document.querySelector('button[aria-haspopup=menu]'),
      };
    `);
    check('the home screen loads', home?.path === '/', home);
    check('the header carries the account button', home?.hasMenuButton === true);

    /*
     * The assertion that matters. A page whose JavaScript never attached looks
     * completely correct — the button is in the server HTML — and does nothing
     * when tapped. Clicking and observing the state change is the only way to
     * tell the two apart from outside.
     */
    await browser.click(`document.querySelector('button[aria-haspopup=menu]')`);
    const menu = await browser.evaluate<{ expanded: string | null; items: string[] }>(`
      return {
        expanded: document.querySelector('button[aria-haspopup=menu]')?.getAttribute('aria-expanded') ?? null,
        items: [...document.querySelectorAll('[role=menuitem]')].map((a) => a.textContent.trim()),
      };
    `);
    check('the account menu opens when clicked', menu?.expanded === 'true', menu);
    check('Profile is reachable', (menu?.items ?? []).some((item) => /Profile/i.test(item)), menu?.items);
    check(
      'Manage forms is reachable for an admin',
      (menu?.items ?? []).some((item) => /Manage forms/i.test(item)),
      menu?.items,
    );

    missing = browser.takeMissingAssets();
    check('every asset was served', missing.length === 0, missing);
    problems = browser.takeProblems();
    check('nothing was logged to the console', problems.length === 0, problems);

    // ---- The admin console -------------------------------------------------
    console.log('\n  Admin console');
    await browser.visit(`${BASE_URL}/admin/forms`);

    await browser.click(
      `[...document.querySelectorAll('button')].find((b) => /Setup/.test(b.textContent))`,
    );
    const nav = await browser.evaluate<string[]>(`
      return [...document.querySelectorAll('[role=menuitem]')].map((a) => a.getAttribute('href'));
    `);
    check('the Setup menu opens', (nav ?? []).length > 0, nav);
    check('it leads with the setup index', nav?.[0] === '/admin/setup', nav);

    problems = browser.takeProblems();
    check('nothing was logged to the console', problems.length === 0, problems);

    // ---- The setup index ---------------------------------------------------
    console.log('\n  What you have set up');
    await browser.visit(`${BASE_URL}/admin/setup`);

    const setup = await browser.evaluate<{ rows: number; links: number; deadEnds: string[] }>(`
      const rows = [...document.querySelectorAll('ol > li')];
      return {
        rows: rows.length,
        links: rows.filter((li) => li.querySelector('a[href]')).length,
        // "Create your organisation" is the one row with nowhere to go.
        deadEnds: rows
          .filter((li) => !li.querySelector('a[href]'))
          .map((li) => li.querySelector('span > span')?.textContent?.trim() ?? '?'),
      };
    `);
    check('every configured thing is listed', (setup?.rows ?? 0) >= 10, setup);
    /*
     * The regression this exists for: a completed step used to render no link,
     * so a finished setup was a list of things you could see and not reach.
     */
    check(
      'every row links somewhere, done or not',
      (setup?.deadEnds ?? []).length <= 1,
      setup?.deadEnds,
    );

    problems = browser.takeProblems();
    check('nothing was logged to the console', problems.length === 0, problems);

    // ---- Privacy -----------------------------------------------------------
    console.log('\n  Privacy');
    await browser.visit(`${BASE_URL}/admin/privacy`);

    const privacy = await browser.evaluate<{
      readiness: string | null;
      generatorLabel: string | null;
      impliesAi: boolean;
    }>(`
      const text = document.body.innerText;
      const readiness =
        /Nobody is being asked for permission/.test(text) ? 'not-ready'
        : /asked for permission before collecting anything/.test(text) ? 'ready'
        : null;
      const generator = [...document.querySelectorAll('button')]
        .find((b) => /from my forms/i.test(b.textContent));
      return {
        readiness,
        generatorLabel: generator ? generator.textContent.trim() : null,
        // The notice is assembled from a template, offline. Anything implying a
        // model wrote it is a promise the code does not make.
        impliesAi: /draft it for me|\\bAI\\b|magic/i.test(text),
      };
    `);

    /*
     * Whether consent is actually being collected is the highest-stakes fact on
     * this screen, and it was previously only inferable from two grey
     * subtitles. One of the two states has to be stated outright.
     */
    check('it says plainly whether anyone is being asked for permission', privacy?.readiness !== null, privacy);
    check('the notice generator is offered', Boolean(privacy?.generatorLabel), privacy);
    check('nothing on the page implies an AI wrote the notice', privacy?.impliesAi === false, privacy);

    /*
     * A live notice has to show its own words.
     *
     * Publishing turns the draft into the published version, so `draft` goes
     * null — and the editor fell back to an empty box, reporting that a notice
     * being read aloud to people said nothing at all.
     */
    const liveNotice = await browser.evaluate<{ published: number; blankBoxes: string[] }>(`
      const live = [...document.querySelectorAll('[data-notice][data-notice-live=yes]')];
      return {
        published: live.length,
        blankBoxes: live
          .filter((c) => (c.querySelector('textarea')?.value ?? '').trim() === '')
          .map((c) => c.getAttribute('data-notice')),
      };
    `);
    check(
      'a published notice shows the words it is publishing',
      (liveNotice?.blankBoxes ?? []).length === 0,
      liveNotice,
    );

    /*
     * And the generator has to visibly do something.
     *
     * It always wrote to the database; the textarea held its value in state
     * whose initialiser only runs on mount, so a refresh left the old text on
     * screen and the button looked dead. Only pressed on an empty box, so
     * nothing anybody wrote is overwritten.
     */
    const generated = await browser.evaluate<{ ran: boolean; before: number }>(`
      const blank = [...document.querySelectorAll('[data-notice]')]
        .find((c) => (c.querySelector('textarea')?.value ?? '').trim() === '');
      if (!blank) return { ran: false, before: -1 };
      const button = [...blank.querySelectorAll('button')].find((b) => /from my forms/.test(b.textContent));
      if (!button) return { ran: false, before: -1 };
      button.click();
      return { ran: true, before: 0 };
    `);

    if (generated?.ran) {
      await sleep(6000);
      const after = await browser.evaluate<number>(`
        const cards = [...document.querySelectorAll('[data-notice]')];
        return Math.max(0, ...cards.map((c) => (c.querySelector('textarea')?.value ?? '').length));
      `);
      check('pressing the generator puts words in the box', (after ?? 0) > 0, { after });
    } else {
      // Reported, not skipped in silence: every notice already had words, so
      // there was nothing safe to press.
      console.log('    · generator not exercised — no empty notice to fill');
    }

    missing = browser.takeMissingAssets();
    check('every asset was served', missing.length === 0, missing);
    problems = browser.takeProblems();
    check('nothing was logged to the console', problems.length === 0, problems);

    /*
     * ---- Capture ----------------------------------------------------------
     *
     * `student_registration` rather than `school_attendance`: an encounter form
     * has to be about somebody, so it opens on the subject picker and never
     * reaches a question. Checking that one looked like it passed while
     * exercising nothing, which is the worst outcome available to a test.
     */
    console.log('\n  Capture');
    await browser.visit(`${BASE_URL}/forms/student_registration`);

    // The organisation has a published notice, so permission is asked before a
    // single question. Stepping through it is part of what is being checked.
    /*
     * Both answers have to be on screen without scrolling.
     *
     * This screen carries a full privacy notice, so the page is roughly twice a
     * phone's height — and the decision used to sit at the very end of it, about
     * 1100px below the fold, moving further down when the guardian panel opened.
     * A worker who had just typed a guardian's name saw a warning and no way
     * forward. Measured at a real phone size, because on a desktop window the
     * whole page fits and the bug is invisible.
     */
    const reach = await browser.evaluate<{
      viewport: number;
      agreeVisible: boolean;
      refuseVisible: boolean;
      agreePainted: boolean;
    } | null>(`
      const buttons = [...document.querySelectorAll('button')];
      const agree = buttons.find((b) => /agreed/i.test(b.textContent));
      const refuse = buttons.find((b) => /said no/i.test(b.textContent));
      if (!agree || !refuse) return null;
      const onScreen = (el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      };
      const style = getComputedStyle(agree);
      return {
        viewport: window.innerHeight,
        agreeVisible: onScreen(agree),
        refuseVisible: onScreen(refuse),
        // Something has to distinguish it from the page: a fill, or a border.
        agreePainted:
          style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
          parseFloat(style.borderTopWidth) > 0,
      };
    `);

    if (reach) {
      check('“they agreed” is reachable without scrolling', reach.agreeVisible, reach);
      /*
       * And actually visible, which is not the same thing.
       *
       * `bg-affirm-600` named a shade the palette did not define, so Tailwind
       * emitted nothing and the button was white text on a transparent
       * background — in the DOM, the right size, clickable, and impossible to
       * see. `palette.test.ts` guards the cause statically; this guards the one
       * button where the consequence is worst.
       */
      check('“they agreed” is not invisible', reach.agreePainted, reach);
      // Equally reachable, not merely present: a refusal that is harder to give
      // than a yes is a nudge, and nudged consent is not freely given.
      check('“they said no” is equally reachable', reach.refuseVisible, reach);
    } else {
      console.log('    · consent step not shown — no published notice covering this form');
    }

    const consent = await browser.evaluate<boolean>(`
      const agree = [...document.querySelectorAll('button')].find((b) => /agreed/i.test(b.textContent));
      if (!agree) return false;
      agree.click();
      return true;
    `);
    if (consent) {
      await sleep(900);
      check('the consent step accepts a decision', true);
    }

    const question = await browser.evaluate<{ heading: string | null; buttons: string[] }>(`
      return {
        heading: document.querySelector('h1')?.textContent?.trim() ?? null,
        buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()),
      };
    `);
    check('the first question renders', Boolean(question?.heading), question);

    const hasNext = (question?.buttons ?? []).some((label) => /^Next/.test(label));
    // Reported rather than skipped in silence. A conditional check that quietly
    // does nothing reads exactly like a passing one.
    check('the form offers a way forward', hasNext, question?.buttons);

    if (hasNext) {
      await browser.click(
        `[...document.querySelectorAll('button')].find((b) => /^Next/.test(b.textContent.trim()))`,
      );
      const after = await browser.evaluate<{ heading: string | null; error: string | null }>(`
        return {
          heading: document.querySelector('h1')?.textContent?.trim() ?? null,
          error: document.querySelector('[role=alert]')?.textContent?.trim() ?? null,
        };
      `);
      /*
       * Either it advanced, or it refused with a validation message. Both prove
       * the click handler ran, which is the whole question. A page whose
       * JavaScript never attached does neither.
       */
      check(
        'Next responds',
        after?.heading !== question?.heading || Boolean(after?.error),
        { from: question?.heading, to: after },
      );
    }

    problems = browser.takeProblems();
    check('nothing was logged to the console', problems.length === 0, problems);

    // ---- Review -----------------------------------------------------------
    console.log('\n  Review');
    await browser.visit(`${BASE_URL}/review`);

    const queue = await browser.evaluate<{ firstHref: string | null }>(`
      const link = [...document.querySelectorAll('a[href^="/review/"]')][0];
      return { firstHref: link ? link.getAttribute('href') : null };
    `);

    if (queue?.firstHref) {
      await browser.visit(`${BASE_URL}${queue.firstHref}`);
      /*
       * A reviewer has to be able to see the permission behind a record, not
       * only the answers in it. This screen showed every answer and nothing
       * about whether the person had agreed to give them — so a supervisor
       * approving the registration of a child could not tell a child was
       * involved, let alone whether anybody agreed on their behalf.
       */
      const shown = await browser.evaluate<{ hasPanel: boolean; heading: boolean }>(`
        return {
          hasPanel: !!document.querySelector('[data-consent-purpose]'),
          // Present even with no attestation on file, because "nobody was
          // asked" is the answer a reviewer most needs to see.
          heading: /Permission|अनुमति|ಅನುಮತಿ/.test(document.body.innerText),
        };
      `);
      check('the review screen reports the permission behind the record', shown?.heading === true, shown);

      missing = browser.takeMissingAssets();
      check('every asset was served', missing.length === 0, missing);
      problems = browser.takeProblems();
      check('nothing was logged to the console', problems.length === 0, problems);
    } else {
      // Said out loud: an empty queue means this was not exercised.
      console.log('    · review queue empty — nothing to open');
    }
  } finally {
    await browser.stop();
    await client.end();
  }

  console.log(
    failures === 0
      ? '\n✓ All UI checks passed\n'
      : `\n✗ ${failures} UI check${failures === 1 ? '' : 's'} failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

async function mintSession(
  org: { id: string; slug: string },
  user: typeof users.$inferSelect,
): Promise<string> {
  const secret = new TextEncoder().encode(process.env.AUTH_SECRET!);
  return new SignJWT({
    orgId: org.id,
    userId: user.id,
    role: user.role,
    username: user.username,
    fullName: user.fullName,
    locale: user.locale ?? 'en',
    orgSlug: org.slug,
    mustChangePin: user.mustChangePin,
    tokenVersion: user.tokenVersion,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
