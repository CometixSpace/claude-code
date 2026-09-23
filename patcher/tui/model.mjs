import { withRequires, dependentsOf } from '../core/registry.mjs';
import { isPartial, planChange } from '../core/session.mjs';

// ──────────────────────────────────────────────
//  The picker's state, without the picker
//
//  What is ticked, what a toggle drags along with it, and what each row
//  should say — decided here, in plain functions, so the rules can be tested
//  without rendering anything and the component only draws.
//
//  The ticks are the *desired* set, not a list of commands. Applying makes
//  the install match it, whatever that takes; the rows show the difference
//  between the two until then.
// ──────────────────────────────────────────────

// What starts ticked: what is applied — or, when nothing is but the memory
// holds a choice, that choice. The second case is an upgrade: npm replaced
// the package, patched files and state together, and the picker's job is to
// make putting them back one keypress.
export function initialDesired(install) {
  const applied = [...install.applied.keys()];
  if (applied.length > 0 || !install.remembered?.ids?.length) return new Set(applied);
  const offered = install.remembered.ids.filter((id) => install.applicable.some((p) => p.id === id));
  return new Set(withRequires(install.applicable, offered).ids);
}

// Whether the ticks were restored from memory rather than read off the files.
export function restoredFromMemory(install) {
  return install.applied.size === 0 && (install.remembered?.ids?.length ?? 0) > 0;
}

// Tick or untick one row. The set stays closed under `requires` both ways:
// ticking pulls in what the patch needs, unticking drops what needs it.
// `note` says what else moved, since a row changing by itself is confusing.
export function toggle(install, desired, id) {
  const skipped = install.skipped.find((p) => p.id === id);
  if (skipped) {
    return { desired, note: `${id} needs Claude Code ${skipped.versions}; this is ${install.version}` };
  }
  const next = new Set(desired);
  if (next.has(id)) {
    const also = dependentsOf(install.applicable, [id]).filter((d) => next.has(d));
    next.delete(id);
    for (const d of also) next.delete(d);
    return { desired: next, note: also.length ? `also unticked ${also.join(', ')}, which ${also.length === 1 ? 'requires' : 'require'} ${id}` : null };
  }
  const { ids } = withRequires(install.applicable, [id]);
  const also = ids.filter((x) => x !== id && !next.has(x));
  for (const x of ids) next.add(x);
  return { desired: next, note: also.length ? `also ticked ${also.join(', ')}, required by ${id}` : null };
}

// One row's mark, relative to what is applied now:
//   applied   ticked, and applied            [x]
//   add       ticked, not applied            [+]
//   remove    applied (even partly), unticked [-]
//   repair    markers partly gone, ticked    [~] — apply restores and redoes it
//   off       neither                        [ ]
//   skipped   outside its version range      ( )
export function rowState(install, desired, id) {
  if (install.skipped.some((p) => p.id === id)) return 'skipped';
  const state = install.applied.get(id);
  const want = desired.has(id);
  if (isPartial(state)) return want ? 'repair' : 'remove';
  if (state) return want ? 'applied' : 'remove';
  return want ? 'add' : 'off';
}

// What applying would do, or null when the ticks already match the install.
export function pending(install, desired) {
  const plan = planChange(install, [...desired]);
  const changes = plan.add.length + plan.remove.length + plan.repair.length;
  return changes === 0 ? null : plan;
}

// The rows, in the order `list` prints them: applicable first, then those
// outside their version range, which can be looked at but not ticked.
export function rows(install) {
  return [...install.applicable, ...install.skipped];
}
