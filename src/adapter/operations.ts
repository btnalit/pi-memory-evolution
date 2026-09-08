import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface OperationResource { path: string; name: string; kind: 'directory' | 'file' }
/** Small shell lexer for hints, not execution or a success verifier. Quoted semicolons
 * and heredoc bodies cannot manufacture separate commands. Unsupported syntax loses hints. */
export function shellCommands(command: string): string[][] {
 const result: string[][] = []; let words: string[] = [], word = '', quote = '', escaped = false;
 const flushWord = () => { if (word) words.push(word); word = ''; };
 const flush = () => { flushWord(); if (words.length) result.push(words); words = []; };
 for (let i = 0; i < Math.min(command.length, 8192); i++) {
  const c = command[i];
  if (escaped) { word += c; escaped = false; continue; }
  if (c === '\\' && quote !== "'") { escaped = true; continue; }
  if (quote) { if (c === quote) quote = ''; else word += c; continue; }
  if (c === '"' || c === "'") { quote = c; continue; }
  if (c === '<' && command[i+1] === '<') { flush(); return result; }
  if (';|&\n'.includes(c)) { flush(); continue; }
  if (/\s/u.test(c)) { flushWord(); continue; }
  word += c;
 }
 if (!quote && !escaped) flush();
 return result;
}

function commandWords(input: string[]): string[] {
 const words = [...input];
 if (words[0] === 'env') {
  words.shift();
  while (['-i','--ignore-environment','--'].includes(words[0])) words.shift();
 }
 while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? '')) words.shift();
 return words;
}

export function operationPriority(tool: string, args: string): number {
 if (tool === 'write' || tool === 'edit') return 3;
 if (tool !== 'bash') return 0;
 let priority = 0;
 for (const raw of shellCommands(args)) {
  const words = commandWords(raw);
  const executable = basename(words[0] ?? '');
  if (executable === 'git') {
   if (words.some(w => ['commit','push','merge','rebase','cherry-pick'].includes(w))) priority = Math.max(priority, 5);
   else if (words.some(w => ['status','log','show','diff','ls-remote'].includes(w))) priority = Math.max(priority, 4);
   else priority = Math.max(priority, 3);
  } else if (['npm','pnpm','yarn','bun','node','python','python3','pytest','cargo','go','make','cmake','tsc'].includes(executable)) priority = Math.max(priority, 4);
  else if (['systemctl','docker','podman','kubectl','pip','pip3','pacman','install','cp','mv','rm','mkdir','touch'].includes(executable)) priority = Math.max(priority, 3);
 }
 return priority;
}

function resource(value: string, cwd: string, directory: boolean): OperationResource | undefined {
 if (!value || /[$`*?(){}\n\r]/u.test(value) || value.startsWith('-')) return;
 let path = resolve(cwd, value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
 try { path = realpathSync(path); } catch { /* Synthetic/nonexistent resources retain literal identity. */ }
 // A file in a real checkout carries its repository identity, without a shell call.
 if (!directory) {
  let parent = dirname(path);
  for (let i = 0; i < 16; i++) {
   if (existsSync(join(parent, '.git'))) { path = parent; directory = true; break; }
   const next = dirname(parent); if (next === parent) break; parent = next;
  }
 }
 return { path, name: basename(path), kind: directory ? 'directory' : 'file' };
}

/** Only operation arguments supply resources; never tool output, source origins or cwd
 * by itself. An explicit cd/git -C is a directory hint, not proof a command succeeded. */
export function operationResources(tool: string, args: string, cwd: string): OperationResource[] {
 if (tool === 'write' || tool === 'edit' || tool === 'read') {
  const found = resource(args, cwd, false); return found ? [found] : [];
 }
 if (tool !== 'bash') return [];
 const result: OperationResource[] = []; let directory = cwd;
 for (const raw of shellCommands(args)) {
  const words = commandWords(raw);
  const executable = basename(words[0] ?? '');
  const index = executable === 'cd' ? 1 : executable === 'git' ? words.indexOf('-C') + 1 : 0;
  if (!index || !words[index]) continue;
  const found = resource(words[index], directory, true);
  if (found) { result.push(found); if (executable === 'cd') directory = found.path; }
 }
 return result;
}

export function isInternalObservation(tool: string, args: string, stateDir?: string): boolean {
 if (/^(?:memory_|memory$)/u.test(tool)) return true;
 if (!stateDir) return false;
 // Avoid feeding this extension's own database/diagnostics back as independent evidence.
 const normalized = args.replaceAll('\\', '/');
 const path = resolve(stateDir).replaceAll('\\', '/');
 return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + `(?=$|[\\s/"';)])`, 'u').test(normalized);
}
