import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Everything a run produces goes through here, so the storage location
 * (local folder today, blob storage / CI artifacts later) is swappable in one place.
 */
export class RunArtifacts {
  readonly dir: string;
  private readonly redact: (text: string) => string;

  private constructor(dir: string, redact: (text: string) => string) {
    this.dir = dir;
    this.redact = redact;
  }

  static async create(runsDir: string, taskName: string, redact: (text: string) => string): Promise<RunArtifacts> {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
    const dir = path.resolve(runsDir, `${stamp}_${slug(taskName)}`);
    await mkdir(path.join(dir, 'screenshots'), { recursive: true });
    return new RunArtifacts(dir, redact);
  }

  path(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  /** Returns the absolute path to write to and the path relative to the run folder (for the report). */
  screenshotFile(step: number, label: string): { absolute: string; relative: string } {
    const relative = `screenshots/step-${String(step).padStart(3, '0')}-${slug(label)}.png`;
    return { absolute: this.path(relative), relative };
  }

  async log(event: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ time: new Date().toISOString(), ...event });
    await appendFile(this.path('transcript.jsonl'), this.redact(line) + '\n');
  }

  async write(name: string, content: string): Promise<void> {
    await mkdir(path.dirname(this.path(name)), { recursive: true });
    await writeFile(this.path(name), this.redact(content));
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'step';
}
