import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readLegacyFile } from './legacy.ts';

export const LEGACY_FILES = ['agenda_candidates.yaml', 'self_agenda.yaml', 'signals.jsonl', 'evolution_journal.md'] as const;
export function legacyFiles(dir: string): string[] { return LEGACY_FILES.filter(name => existsSync(join(dir, name))); }

/** Explicit copy-only archive. Never delete originals, execute old plans, or follow symlinks. */
export function archiveLegacyFiles(dir: string): { directory?: string; count: number } {
 const files = LEGACY_FILES.map(name => ({ name, data: readLegacyFile(join(dir, name)) })).filter(file => file.data !== undefined);
 if (!files.length) return { count: 0 };
 const parent = join(dir, 'legacy-archives');
 mkdirSync(parent, { recursive: true, mode: 0o700 });
 const directory = mkdtempSync(join(parent, 'archive-'));
 try {
  const manifest = files.map(({ name, data }) => {
   writeFileSync(join(directory, name), data!, { flag: 'wx', mode: 0o600 });
   return { name, bytes: data!.length, sha256: createHash('sha256').update(data!).digest('hex') };
  });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ version: 1, originalsRetained: true, files: manifest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, count: files.length };
 } catch {
  rmSync(directory, { recursive: true, force: true });
  throw new Error('Legacy archive failed; originals unchanged');
 }
}
