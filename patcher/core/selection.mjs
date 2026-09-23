import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ──────────────────────────────────────────────
//  What was chosen, remembered outside the install
//
//  Everything else the patcher keeps lives in .claude-patcher/ inside the
//  package, which is right for state that describes those files — and is
//  exactly why it cannot answer "what did I have applied". Upgrading Claude
//  Code replaces the package directory, state included, and leaves an install
//  with nothing applied and no record that anything ever was.
//
//  So the set of applied patches is also written here, per install, after
//  every change. It is a memory of intent, never an authority on what is
//  applied — that stays with the markers in the files. A front end uses it
//  to offer the same choice again after an upgrade.
// ──────────────────────────────────────────────

export const SELECTION_FILE = join(homedir(), '.cometix', 'patcher', 'selection.json');

async function readAll(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

// Keyed by install root, so two installs — a global one and a project-local
// one — keep separate choices.
export async function readSelection(root, file = SELECTION_FILE) {
  return (await readAll(file))[root] ?? null;
}

export async function writeSelection(root, { ids, version }, file = SELECTION_FILE) {
  const all = await readAll(file);
  all[root] = { ids, version, at: new Date().toISOString() };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(all, null, 2)}\n`);
}
