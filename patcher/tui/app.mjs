import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import { describeLayout } from '../core/layout.mjs';
import { reconcile, restoreAll } from '../core/session.mjs';
import {
  initialDesired, restoredFromMemory, toggle, rowState, pending, rows,
} from './model.mjs';

// ──────────────────────────────────────────────
//  The picker
//
//  Inline, not fullscreen: it draws below the prompt, and what it did stays
//  in the terminal's scrollback after it exits. Everything worth keeping —
//  the header, each patch's scan result, what was written — goes through
//  <Static>, which Ink prints once above the live region and never redraws.
//  The live region is only ever the list or the progress line.
//
//  No JSX, so the source runs as it is, straight from a clone.
// ──────────────────────────────────────────────

const h = React.createElement;

const MARKS = {
  applied: ['[x]', 'green'],
  add: ['[+]', 'cyan'],
  remove: ['[-]', 'red'],
  repair: ['[~]', 'yellow'],
  off: ['[ ]', undefined],
  skipped: ['( )', 'gray'],
};
const RISK = { low: 'green', medium: 'yellow', high: 'red' };
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const KEYS = '↑↓ move · space toggle · a apply · c check · r restore all · q quit';

// A log line is a list of parts: plain strings, or [text, textProps].
function Line({ parts }) {
  return h(Text, null, ...parts.map((p, i) => (typeof p === 'string' ? p : h(Text, { key: i, ...p[1] }, p[0]))));
}

function Header({ install }) {
  return h(Box, { flexDirection: 'column' },
    h(Text, null,
      h(Text, { bold: true }, `Claude Code ${install.version ?? 'unknown'}`),
      h(Text, { dimColor: true }, `  ·  ${describeLayout(install.layout)}`)),
    h(Text, { dimColor: true }, install.cli));
}

function Row({ patch, state, focused }) {
  const [mark, color] = MARKS[state];
  const skipped = state === 'skipped';
  return h(Box, null,
    h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: 'cyan' }, focused ? '›' : ' ')),
    h(Box, { width: 4, flexShrink: 0 }, h(Text, { color }, mark)),
    h(Box, { width: 31, flexShrink: 0 },
      h(Text, { bold: focused, color: focused ? 'cyan' : skipped ? 'gray' : undefined, wrap: 'truncate-end' }, patch.id)),
    h(Box, { flexGrow: 1, flexShrink: 1 },
      h(Text, { dimColor: skipped, wrap: 'truncate-end' }, skipped ? `needs ${patch.versions}` : patch.title)),
    h(Box, { width: 7, flexShrink: 0, justifyContent: 'flex-end' },
      h(Text, { color: RISK[patch.risk] }, patch.risk ?? '')));
}

function PendingLine({ plan }) {
  if (!plan) return h(Text, { dimColor: true }, 'no changes');
  const parts = [
    ...plan.add.map((id) => [` +${id}`, { color: 'cyan' }]),
    ...plan.remove.map((id) => [` −${id}`, { color: 'red' }]),
    ...plan.repair.map((id) => [` ~${id}`, { color: 'yellow' }]),
  ];
  if (plan.restoreFirst) parts.push([`  · restores, then re-applies ${plan.want.length}`, { dimColor: true }]);
  return h(Line, { parts: [['pending', { bold: true }], ...parts] });
}

function Progress({ live, frame }) {
  const spin = h(Text, { color: 'cyan' }, SPINNER[frame % SPINNER.length]);
  if (!live || live.phase !== 'scan') {
    const label = { write: 'writing', verify: 'verifying', restore: 'restoring' }[live?.phase] ?? 'working';
    return h(Text, null, spin, ` ${label}…`);
  }
  const cells = 16;
  const fraction = (live.index + (live.total ? live.done / live.total : 0)) / live.count;
  const filled = Math.min(cells, Math.round(fraction * cells));
  return h(Text, null, spin, ' scanning ',
    h(Text, { color: 'cyan' }, '▰'.repeat(filled)), h(Text, { dimColor: true }, '▱'.repeat(cells - filled)),
    ` ${live.index + 1}/${live.count}  `,
    h(Text, { bold: true }, live.patch), h(Text, { dimColor: true }, ` › ${live.site}  ${live.done}/${live.total}`));
}

function memoryNote(install) {
  const r = install.remembered;
  return `Nothing is applied here. ${r.ids.length} patch(es) were on ${r.version ?? 'the previous install'} `
    + '— ticked again; press a to apply them.';
}

export function App({ install }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  // Session calls mutate `install` (its applied set); bumping this redraws.
  const [, setTick] = useState(0);
  const [desired, setDesired] = useState(() => initialDesired(install));
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState('select'); // select | confirm | running | done
  const [question, setQuestion] = useState(null); // { text, onYes }
  const [note, setNote] = useState(() => (restoredFromMemory(install) ? memoryNote(install) : null));
  const [log, setLog] = useState([{ id: 0, header: true }]);
  const [frame, setFrame] = useState(0);
  // Progress arrives once per file scanned — thousands a second. It is
  // written to a ref and sampled on a timer, so drawing costs the same
  // whatever the event rate.
  const live = useRef(null);

  const list = rows(install);
  const say = (...parts) => setLog((l) => [...l, { id: l.length, parts }]);
  // A heading opens each run's block of lines, set off from the one before.
  const heading = (text) => setLog((l) => [...l, { id: l.length, gap: true, parts: [[text, { bold: true }]] }]);

  useEffect(() => {
    if (mode !== 'running') return undefined;
    const t = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(t);
  }, [mode]);

  // Leaving: the last frame is a one-line summary, which is what stays in
  // the scrollback under the log. exit() after it has been committed.
  useEffect(() => {
    if (mode === 'done') exit();
  }, [mode]);

  const onEvent = (e) => {
    if (e.type === 'progress') live.current = { phase: 'scan', ...e };
    else if (e.type === 'phase') live.current = { phase: e.phase };
    else if (e.type === 'restored') {
      say(['↺ ', { color: 'yellow' }], `restored ${e.restored.files.length} file(s) first`,
        ['  to re-apply without what was taken out', { dimColor: true }]);
    }
    else if (e.type === 'scanned') {
      const { patch, result } = e;
      if (!result.ok) {
        say(['  ✗ ', { color: 'red' }], patch.id, [`  site "${result.missing}" not found (stage ${result.stage})`, { color: 'red' }]);
        return;
      }
      const satisfied = result.satisfied?.length ? ` · ${result.satisfied.length} already satisfied upstream` : '';
      say(['  ✓ ', { color: 'green' }], patch.id, [`  ${result.sites.length} site(s)${satisfied}`, { dimColor: true }]);
    }
  };

  async function run(kind, want = desired) {
    setMode('running');
    setNote(null);
    live.current = { phase: kind === 'restore' ? 'restore' : 'scan', index: 0, count: 1, done: 0, total: 0 };
    let changed = false;
    try {
      if (kind === 'restore') {
        heading('restore');
        const r = await restoreAll(install);
        say(['↺ ', { color: 'yellow' }], `restored ${r.files.length} file(s)`,
          [r.patches.length ? `  removed ${r.patches.join(', ')}` : '', { dimColor: true }]);
        changed = r.files.length > 0;
      } else {
        const dryRun = kind === 'check';
        heading(dryRun ? 'check' : 'apply');
        const { plan, restored, report } = await reconcile(install, [...want], { dryRun, onEvent });
        if (report.markerOnly.length > 0) {
          say(['  ! ', { color: 'yellow' }], `${report.markerOnly.length} site(s) found their marker but matched nothing — shape may have drifted`);
        }
        for (const v of report.verify) say(['  ✗ ', { color: 'red' }], `${v.id}: verification failed — ${v.problems.join('; ')}`);
        if (dryRun) {
          say(['  ', {}], report.applied.length
            ? `${report.applied.length} patch(es) ready; nothing written`
            : 'nothing to add', [plan.restoreFirst ? '  · removals are not simulated: they restore, then re-apply' : '', { dimColor: true }]);
        } else {
          for (const { id, files } of report.assets) {
            say(['  + ', { color: 'cyan' }], `${id}: installed ${files.length} file(s)`, [
              `  ${(files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1)}MB`, { dimColor: true }]);
          }
          if (report.written.length > 0) {
            say(['✓ ', { color: 'green' }], `applied ${report.applied.length} patch(es) across ${report.written.length} file(s)`);
          }
          changed = Boolean(restored) || report.written.length > 0;
        }
      }
    } catch (e) {
      say(['✗ ', { color: 'red' }], e.message);
    }
    live.current = null;
    if (kind !== 'check') setDesired(initialDesired(install));
    if (changed) setNote('Restart Claude Code for this to take effect.');
    setTick((t) => t + 1);
    setMode('select');
  }

  function ask(text, onYes) {
    setQuestion({ text, onYes });
    setMode('confirm');
  }

  function apply(want = desired) {
    const plan = pending(install, want);
    if (!plan) { setNote('Nothing to apply — the ticks match the install.'); return; }
    if (!plan.restoreFirst) { run('apply', want); return; }
    const out = [...plan.remove, ...plan.repair].join(', ');
    ask(`Taking out ${out} restores every touched file, then re-applies ${plan.want.length}. Continue?`, () => run('apply', want));
  }

  function restore() {
    if (install.applied.size === 0) { setNote('Nothing to restore — no patch is applied.'); return; }
    ask(`Restore every touched file, removing all ${install.applied.size} patch(es)?`, () => run('restore'));
  }

  useInput((input, key) => {
    if (mode === 'confirm') {
      if (input === 'y') { setQuestion(null); question.onYes(); }
      else if (input === 'n' || key.escape || key.return) { setQuestion(null); setMode('select'); }
      return;
    }
    if (key.ctrl && input === 'c') { setMode('done'); return; }
    if (key.upArrow || key.downArrow) {
      setCursor((c) => (c + (key.upArrow ? -1 : 1) + list.length) % list.length);
      return;
    }
    if (key.return) { apply(); return; }
    if (key.escape) { setMode('done'); return; }

    // Keys that arrive together — a held j repeating, a paste — come as one
    // string. Each is applied in turn against the state the previous one
    // left, then committed once; comparing the whole string to 'j' would
    // drop them all.
    let c = cursor;
    let d = desired;
    let n;
    for (const ch of input) {
      if (ch === 'k') c = (c - 1 + list.length) % list.length;
      else if (ch === 'j') c = (c + 1) % list.length;
      else if (ch === ' ') ({ desired: d, note: n } = toggle(install, d, list[c].id));
      else if ('qacr'.includes(ch)) {
        setCursor(c);
        setDesired(d);
        if (ch === 'q') setMode('done');
        else if (ch === 'a') apply(d);
        else if (ch === 'c') run('check', d);
        else restore();
        return;
      }
    }
    setCursor(c);
    setDesired(d);
    if (n !== undefined) setNote(n);
  }, { isActive: mode === 'select' || mode === 'confirm' });

  const logView = h(Static, { items: log }, (item) => (item.header
    ? h(Header, { key: item.id, install })
    : h(Box, { key: item.id, marginTop: item.gap ? 1 : 0 }, h(Line, { parts: item.parts }))));

  if (mode === 'done') {
    const ids = [...install.applied.keys()];
    return h(Box, { flexDirection: 'column' }, logView,
      h(Box, { marginTop: 1 }, h(Text, { dimColor: !ids.length }, ids.length ? `${ids.length} patch(es) applied: ${ids.join(', ')}` : 'no patches applied')));
  }

  if (mode === 'running') {
    return h(Box, { flexDirection: 'column' }, logView, h(Progress, { live: live.current, frame }));
  }

  const focused = list[cursor];
  return h(Box, { flexDirection: 'column', width }, logView,
    h(Box, { flexDirection: 'column', marginTop: 1 },
      ...list.map((p, i) => h(Row, { key: p.id, patch: p, state: rowState(install, desired, p.id), focused: i === cursor }))),
    h(Box, { marginTop: 1, paddingLeft: 2, width },
      h(Text, { dimColor: true, wrap: 'wrap' }, focused.description ?? focused.title)),
    h(Box, { marginTop: 1, paddingLeft: 2 }, h(PendingLine, { plan: pending(install, desired) })),
    note ? h(Box, { paddingLeft: 2, width }, h(Text, { color: 'yellow', wrap: 'wrap' }, note)) : null,
    h(Box, { paddingLeft: 2 }, mode === 'confirm'
      ? h(Text, { color: 'yellow' }, `${question.text} `, h(Text, { bold: true }, '(y/N)'))
      : h(Text, { dimColor: true }, KEYS)));
}
