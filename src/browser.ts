import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Config } from './config.ts';

const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_TIMEOUT_MS = 3_000;
const MAX_SNAPSHOT_CHARS = 60_000;
/** Part of a box scrolled per "screen", so rows at the edge stay in view and none are skipped. */
const SCROLL_STEP = 0.8;
/** Fields whose contents the model never sees, even when a person typed them in by hand: passwords, emails and usernames. */
const HIDDEN_FIELDS = [
  'input[type=password]',
  'input[type=email]',
  'input[autocomplete~=username i]',
  'input[autocomplete~=email i]',
  'input[name*=email i]',
  'input[id*=email i]',
].join(', ');
const HIDDEN_VALUE = '<hidden>';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** The only module that knows how the browser is launched; everything else talks to this. */
export class BrowserSession {
  closed = false;
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly tracing: boolean;
  private pages: Page[] = []; // the last one is the active tab
  private events: string[] = [];
  private masks: Locator[] = [];
  /** Email addresses seen in hidden fields. Hidden everywhere for the rest of the run, as pages repeat them as text. */
  private emails = new Set<string>();

  private constructor(browser: Browser, context: BrowserContext, tracing: boolean) {
    this.browser = browser;
    this.context = context;
    this.tracing = tracing;
  }

  static async start(config: Config): Promise<BrowserSession> {
    const browser = config.browserWsEndpoint
      ? await chromium.connect(config.browserWsEndpoint)
      : await chromium.launch({ headless: config.headless, channel: config.browserChannel, handleSIGINT: false }).catch((err: unknown) => {
          if (!config.browserChannel) throw err;
          const name = config.browserChannel === 'chrome' ? 'Google Chrome' : config.browserChannel === 'msedge' ? 'Microsoft Edge' : config.browserChannel;
          throw new Error(`${name} could not be started. Check it is installed. (${err instanceof Error ? err.message.split('\n')[0] : err})`);
        });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    if (config.trace) await context.tracing.start({ screenshots: true, snapshots: true });

    const session = new BrowserSession(browser, context, config.trace);
    browser.on('disconnected', () => (session.closed = true));
    context.on('page', (page) => session.track(page));
    session.track(await context.newPage());
    return session;
  }

  get page(): Page {
    const page = this.pages.at(-1);
    if (!page) throw new Error('The browser has no open tabs');
    return page;
  }

  /** Resolves a snapshot ref, failing fast if it is stale. Returns the ref locator and a durable locator description. */
  async locate(ref: string): Promise<{ locator: Locator; description: string }> {
    const locator = this.page.getByRef(ref);
    try {
      const description = (await locator.normalize()).toString();
      return { locator, description };
    } catch {
      throw new Error(`Element ref "${ref}" is not in the latest snapshot. Use a ref from the most recent snapshot.`);
    }
  }

  /** Moves the mouse to the bottom-left corner in small steps, so menus that open on hover see it leave and close. */
  async moveMouseAway(): Promise<void> {
    const { height } = this.page.viewportSize() ?? { height: 800 };
    await this.page.mouse.move(1, height - 1, { steps: 10 });
  }

  /**
   * Scrolls the nearest scrollable box around the element (a list, table or panel), or the page without one.
   * Returns false when nothing moved: already at the end, or nothing there scrolls.
   */
  async scroll(direction: ScrollDirection, screens: number, locator?: Locator): Promise<boolean> {
    return (locator ?? this.page.locator('body')).evaluate(scrollBox, { direction, screens: screens * SCROLL_STEP });
  }

  /** Masks an element in all later screenshots, and shows its text as dots on screen (used for fields holding secrets). */
  async mask(locator: Locator): Promise<void> {
    await locator.evaluate((field) => (field as HTMLElement).style.setProperty('-webkit-text-security', 'disc')).catch(() => {});
    this.masks.push(await locator.normalize().catch(() => locator));
  }

  /** Best-effort wait for the page to stop changing after an action. */
  async settle(): Promise<void> {
    const page = this.page;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }

  async screenshot(path: string): Promise<boolean> {
    const page = this.page;
    const mask = this.masks.filter((locator) => locator.page() === page);
    return page.screenshot({ path, mask }).then(() => true, () => false);
  }

  async snapshot(): Promise<string> {
    // Read first: a page snapshot must be the latest one so the model's refs work, and if someone submits
    // a sign-in form mid-snapshot, the field is gone afterwards but its value is in the tree.
    const refs = await this.hiddenFieldRefs();
    const typed = await this.hiddenFieldValues();
    let tree: string;
    try {
      tree = await this.page.ariaSnapshot({ mode: 'ai' });
    } catch {
      // Usually the page navigated mid-snapshot; try once more after it settles.
      await this.settle();
      tree = await this.page.ariaSnapshot({ mode: 'ai' });
    }
    typed.push(...(await this.hiddenFieldValues()));
    for (const value of typed) if (EMAIL.test(value)) this.emails.add(value);
    tree = hideFieldValues(tree, refs, typed);
    if (tree.length > MAX_SNAPSHOT_CHARS) tree = tree.slice(0, MAX_SNAPSHOT_CHARS) + '\n... [snapshot truncated]';
    const title = await this.page.title().catch(() => '');
    return hideEmails(`URL: ${this.page.url()}\nTitle: ${title}\nOpen tabs: ${this.pages.length}\n\`\`\`yaml\n${tree}\n\`\`\``, this.emails);
  }

  /** Things that happened on their own since the last call (dialogs, tabs opening/closing). */
  drainEvents(): string[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** Stops the browser. Without a path, the trace is discarded. */
  async close(tracePath?: string): Promise<void> {
    if (this.tracing && !this.closed) await this.context.tracing.stop({ path: tracePath }).catch(() => {});
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  /** What is typed into hidden fields, in every frame of the active tab. */
  private async hiddenFieldValues(): Promise<string[]> {
    const values = await Promise.all(
      this.page.frames().map((frame) =>
        frame.locator(HIDDEN_FIELDS).evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value)).catch(() => []),
      ),
    );
    return values.flat().filter(Boolean);
  }

  /** Snapshot refs of hidden fields in every frame. An element keeps its ref, so the next page snapshot uses the same ones. */
  private async hiddenFieldRefs(): Promise<string[]> {
    const fields = await Promise.all(this.page.frames().map((frame) => frame.locator(HIDDEN_FIELDS).all().catch(() => [])));
    const snapshots = await Promise.all(fields.flat().map((field) => field.ariaSnapshot({ mode: 'ai', timeout: 1000 }).catch(() => '')));
    return snapshots.map((snapshot) => snapshot.match(/\[ref=(\w+)\]/)?.[1]).filter((ref) => ref !== undefined);
  }

  private track(page: Page): void {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    if (this.pages.length > 1) this.events.push('A new tab opened and is now the active tab.');
    page.on('close', () => {
      this.pages = this.pages.filter((p) => p !== page);
      if (this.pages.length === 0) this.closed = true;
      else this.events.push('A tab was closed; the most recently opened remaining tab is now active.');
    });
    page.on('dialog', (dialog) => {
      this.events.push(`A ${dialog.type()} dialog appeared with message "${dialog.message()}" and was accepted.`);
      dialog.accept().catch(() => {});
    });
  }
}

/**
 * Runs in the page, so it may only use its arguments and browser globals.
 * Scrolling fires scroll events, so lists that render rows as you scroll load them.
 */
function scrollBox(start: Element, { direction, screens }: { direction: ScrollDirection; screens: number }): boolean {
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const canScroll = (box: Element) => {
    const overflow = getComputedStyle(box)[vertical ? 'overflowY' : 'overflowX'];
    const room = vertical ? box.scrollHeight - box.clientHeight : box.scrollWidth - box.clientWidth;
    return room > 1 && /auto|scroll|overlay/.test(overflow);
  };
  let box: Element | null = start;
  while (box && !canScroll(box)) box = box.parentElement;
  box ??= start.ownerDocument.scrollingElement ?? start.ownerDocument.documentElement;
  const position = () => (vertical ? box.scrollTop : box.scrollLeft);
  const before = position();
  const distance = sign * screens * (vertical ? box.clientHeight : box.clientWidth);
  box.scrollBy({ top: vertical ? distance : 0, left: vertical ? 0 : distance, behavior: 'instant' });
  return position() !== before;
}

/** Replaces what the snapshot shows inside hidden fields, found by ref or by what was typed into them. */
function hideFieldValues(tree: string, refs: string[], typed: string[]): string {
  if (refs.length === 0 && typed.length === 0) return tree;
  return tree.replace(/^(\s*- .*\[ref=(\w+)\][^:\n]*): (.+)$/gm, (line, element: string, ref: string, shown: string) =>
    refs.includes(ref) || typed.includes(unquote(shown)) ? `${element}: ${HIDDEN_VALUE}` : line,
  );
}

/** Replaces the email addresses anywhere in the text, in any letter case and also URL-encoded (as in a login_hint). */
function hideEmails(text: string, emails: Set<string>): string {
  // Longest first, so an address that contains another is replaced whole.
  const forms = [...emails].flatMap((email) => [email, encodeURIComponent(email)]).sort((a, b) => b.length - a.length);
  for (const form of forms) {
    const needle = form.toLowerCase();
    let at: number;
    while ((at = text.toLowerCase().indexOf(needle)) !== -1) text = text.slice(0, at) + HIDDEN_VALUE + text.slice(at + form.length);
  }
  return text;
}

/** Snapshot values are YAML; ones with special characters are double-quoted with JSON escapes. */
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
