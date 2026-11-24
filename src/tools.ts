import { z } from 'zod';
import type { FunctionTool } from 'openai/resources/responses/responses';
import type { BrowserSession } from './browser.ts';
import type { Secrets } from './secrets.ts';

export interface ToolContext {
  browser: BrowserSession;
  secrets: Secrets;
  /** Values the model saved with `remember`. Shown with every new page snapshot, so they survive snapshot trimming. */
  memory: Map<string, string>;
}

export interface Verdict {
  status: 'passed' | 'failed';
  summary: string;
}

export interface ToolOutcome {
  /** What happened, in words. The agent appends a fresh page snapshot. */
  message: string;
  /** Durable Playwright locator of the target element, kept as evidence and for future replay. */
  locator?: string;
  verdict?: Verdict;
}

export interface Tool {
  name: string;
  spec: FunctionTool;
  run(args: unknown, context: ToolContext): Promise<ToolOutcome>;
}

function defineTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>, context: ToolContext) => Promise<ToolOutcome>,
): Tool {
  const { $schema, ...parameters } = z.toJSONSchema(schema);
  return {
    name,
    spec: { type: 'function', name, description, parameters, strict: false },
    async run(args, context) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new Error(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`);
      return run(parsed.data, context);
    },
  };
}

const target = {
  ref: z.string().describe('Element ref from the latest page snapshot, e.g. "e12"'),
  element: z.string().describe('Short human-readable description of the element, e.g. "Sign in button"'),
};

export const tools: Tool[] = [
  defineTool(
    'navigate',
    'Open a URL in the current tab.',
    z.object({ url: z.string() }),
    async ({ url }, { browser, secrets }) => {
      await browser.page.goto(secrets.resolve(url));
      return { message: `Navigated to ${url}` };
    },
  ),

  defineTool(
    'click',
    'Click an element on the page.',
    z.object({ ...target, double: z.boolean().optional().describe('Double-click instead of single click') }),
    async ({ ref, element, double }, { browser }) => {
      const { locator, description } = await browser.locate(ref);
      await (double ? locator.dblclick() : locator.click());
      return { message: `${double ? 'Double-clicked' : 'Clicked'} ${element}`, locator: description };
    },
  ),

  defineTool(
    'type',
    'Fill a text field, replacing its current value. Pass {{env.NAME}} secret placeholders verbatim; the tool substitutes the real value.',
    z.object({ ...target, text: z.string(), submit: z.boolean().optional().describe('Press Enter after typing') }),
    async ({ ref, element, text, submit }, { browser, secrets }) => {
      const { locator, description } = await browser.locate(ref);
      if (secrets.hasPlaceholder(text)) await browser.mask(locator); // first, so the value never shows on screen
      await locator.fill(secrets.resolve(text));
      if (submit) await locator.press('Enter');
      return { message: `Typed "${text}" into ${element}${submit ? ' and pressed Enter' : ''}`, locator: description };
    },
  ),

  defineTool(
    'hover',
    'Move the mouse over an element, e.g. to open a menu that appears on hover. With no ref, move the mouse to an empty corner of the page instead, which closes menus that stay open while the mouse is over them.',
    z.object({ ref: target.ref.optional(), element: target.element.optional() }),
    async ({ ref, element }, { browser }) => {
      if (!ref) {
        await browser.moveMouseAway();
        return { message: 'Moved the mouse away from the page content' };
      }
      const { locator, description } = await browser.locate(ref);
      await locator.hover();
      return { message: `Hovered over ${element ?? ref}`, locator: description };
    },
  ),

  defineTool(
    'scroll',
    'Scroll a list, table or panel, or the page. Snapshots already include content outside the visible area, so only scroll when content appears as you scroll (long lists or tables that load more rows, infinite feeds). With ref, scrolls the scrollable box around that element: pass the list or any row in it. With no ref, scrolls the page.',
    z.object({
      ref: target.ref.optional(),
      element: target.element.optional(),
      direction: z.enum(['down', 'up', 'right', 'left']),
      screens: z.number().min(0.1).max(10).optional().describe('How far, in heights (or widths) of the visible part of the list or page. Default 1'),
    }),
    async ({ ref, element, direction, screens = 1 }, { browser }) => {
      const target = ref ? await browser.locate(ref) : undefined;
      const where = ref ? ` in ${element ?? ref}` : '';
      const moved = await browser.scroll(direction, screens, target?.locator);
      const message = moved
        ? `Scrolled ${direction}${where}`
        : `Nothing moved scrolling ${direction}${where}: already at the end, or nothing there scrolls.${ref ? '' : ' To scroll a list or table, pass its ref or the ref of a row in it.'}`;
      return { message, locator: target?.description };
    },
  ),

  defineTool(
    'select_option',
    'Select one or more options in a dropdown (<select>).',
    z.object({ ...target, values: z.array(z.string()).describe('Option labels or values to select') }),
    async ({ ref, element, values }, { browser }) => {
      const { locator, description } = await browser.locate(ref);
      await locator.selectOption(values);
      return { message: `Selected ${values.map((v) => `"${v}"`).join(', ')} in ${element}`, locator: description };
    },
  ),

  defineTool(
    'press_key',
    'Press a key or key combination on the focused element, e.g. "Enter", "Escape", "Tab", "Control+A".',
    z.object({ key: z.string() }),
    async ({ key }, { browser }) => {
      await browser.page.keyboard.press(key);
      return { message: `Pressed ${key}` };
    },
  ),

  defineTool(
    'wait_for',
    'Wait for text to appear (or disappear), or for a number of seconds. Use when the page is still loading or updating.',
    z.object({
      text: z.string().optional().describe('Text to wait for'),
      gone: z.boolean().optional().describe('Wait for the text to disappear instead of appear'),
      seconds: z.number().min(0).max(30).optional().describe('Fixed time to wait'),
    }),
    async ({ text, gone, seconds }, { browser }) => {
      if (text === undefined && seconds === undefined) throw new Error('Provide text or seconds');
      if (seconds) await browser.page.waitForTimeout(seconds * 1000);
      if (text !== undefined) {
        await browser.page.getByText(text).first().waitFor({ state: gone ? 'hidden' : 'visible', timeout: 15_000 });
      }
      return { message: text !== undefined ? `"${text}" ${gone ? 'disappeared' : 'appeared'}` : `Waited ${seconds}s` };
    },
  ),

  defineTool(
    'remember',
    'Save a value from the page (an ID, code, name...) to use in a later step. Old page snapshots are removed from the conversation, so anything needed later must be saved here. Saving the same name again replaces the value.',
    z.object({
      name: z.string().min(1).describe('What the value is, e.g. "Product Code"'),
      value: z.string().describe('The value exactly as shown on the page'),
    }),
    async ({ name, value }, { memory }) => {
      memory.set(name, value);
      return { message: `Remembered ${name} = "${value}"` };
    },
  ),

  defineTool(
    'finish',
    'End the test with a verdict. This is the only way to end the test.',
    z.object({
      status: z.enum(['passed', 'failed']),
      summary: z.string().describe('What was verified; for failures, which step failed and expected vs actual'),
    }),
    async (verdict) => ({ message: `Test ${verdict.status}`, verdict }),
  ),
];

export const toolSpecs = tools.map((tool) => tool.spec);

export function findTool(name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}
