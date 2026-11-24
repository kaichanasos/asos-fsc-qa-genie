const PLACEHOLDER = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Resolves {{env.NAME}} placeholders to real values at the last moment, and
 * redacts those values from anything sent to the model or written to disk.
 * Only placeholders written in the task file can be resolved, so the model
 * (or a page trying to manipulate it) cannot pull other environment variables.
 */
export class Secrets {
  private readonly allowed: Set<string>;
  private readonly known = new Map<string, string>(); // value -> placeholder

  constructor(task: string) {
    this.allowed = new Set(placeholderNames(task));
    this.resolve(task); // fail fast on missing variables, and register their values for redaction
  }

  resolve(text: string): string {
    return text.replace(PLACEHOLDER, (placeholder, name: string) => {
      if (!this.allowed.has(name)) {
        throw new Error(`${placeholder} is not used in the task file; only placeholders written in the task can be used`);
      }
      const value = process.env[name];
      if (value === undefined) throw new Error(`Environment variable ${name} is not set (referenced as ${placeholder})`);
      if (value) this.known.set(value, `{{env.${name}}}`);
      return value;
    });
  }

  hasPlaceholder(text: string): boolean {
    return text.search(PLACEHOLDER) !== -1;
  }

  redact(text: string): string {
    // Longest first, so a secret that contains another secret is replaced whole.
    const values = [...this.known.keys()].sort((a, b) => b.length - a.length);
    return values.reduce((out, value) => out.replaceAll(value, this.known.get(value)!), text);
  }
}

/** The NAMEs of the {{env.NAME}} placeholders in a text. */
export function placeholderNames(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
}
