import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as acorn from 'acorn';
import { findMatches, captureFrom, resolveSpec } from './match.mjs';

// ──────────────────────────────────────────────
//  One pass, all sites
//
//  35 standalone scripts meant 35 full-tree walks. Here every selected patch
//  contributes its sites to a single traversal: each file is read once,
//  parsed at most once, and offered to every site whose marker survived the
//  cheap filter.
//
//  The marker filter is what makes this affordable. Parsing all ~2000 modules
//  costs seconds and hundreds of MB; a substring test over the raw text drops
//  all but a handful before acorn is ever called.
//
//  Two ordering rules matter:
//
//  Stages run in sequence, and later stages see what earlier ones captured.
//  context-limit needs exactly this — phase 1 rewrites the 200000 literals
//  and collects the variable names, phase 3 generates re-assignments from
//  those names. A flat list of sites cannot express that dependency.
//
//  Results are grouped by file, not by patch, because one file routinely
//  holds sites from several patches. Writing per patch would have each write
//  clobber the last.
// ──────────────────────────────────────────────

const PARSE_OPTIONS = { ecmaVersion: 'latest', ranges: false };

// Chunks are ESM, the legacy single bundle is CJS, and a stray file may be
// either. Try module first since that is the common case now.
function parse(source) {
  try {
    return acorn.parse(source, { ...PARSE_OPTIONS, sourceType: 'module' });
  } catch (moduleError) {
    try {
      return acorn.parse(source, { ...PARSE_OPTIONS, sourceType: 'script' });
    } catch {
      throw moduleError;
    }
  }
}

// Cheap gate: does this file mention the marker at all. A site without a
// marker is unfiltered and forces a parse of every file, which is why the
// schema pushes patch authors to supply one.
function passesMarker(source, marker) {
  if (marker === undefined || marker === null) return true;
  const markers = Array.isArray(marker) ? marker : [marker];
  return markers.some((m) => source.includes(m));
}

// A later stage usually has to *search by* what an earlier one found, not
// just splice it into text. cleanup-period is the plain case: stage 1 reads
// the constant's name out of `…cleanupPeriodDays ?? CONST`, and stage 2 can
// only find its declaration by looking for that exact name.
//
// resolveSpec itself lives in match.mjs, since subtree conditions need the
// same substitution against a node's own captures.

// Collect the sites of one stage across the tree.
//
// `values` carries captures from previous stages in; new captures are merged
// out, so a later stage can interpolate names an earlier one discovered.
async function runStage(stage, ctx, values) {
  const { root, files, sources } = ctx;
  const found = [];
  const satisfied = [];
  const captured = { ...values };

  for (const site of stage.sites) {
    // `in` narrows a site to the entry — for patches that touch boot order or
    // the shebang, so they never pay for a tree walk.
    //
    // `sameFileAs` narrows it to wherever a named earlier site matched, and
    // is a correctness requirement rather than an optimisation whenever a
    // site searches by a captured identifier. Each chunk is its own module
    // scope, so a minified name is only unique within one file: cleanup-period
    // captures `K` from `…cleanupPeriodDays ?? K` in one chunk, and an
    // unconstrained search for `K = <number>` also finds an unrelated `K` in
    // another chunk. Editing that one would corrupt a module the patch has
    // nothing to do with.
    let candidates = site.in === 'entry' ? files.slice(0, 1) : files;
    if (site.sameFileAs) {
      const anchor = ctx.siteFiles.get(site.sameFileAs);
      if (!anchor || anchor.length === 0) {
        throw new Error(`site "${site.id}" anchors to "${site.sameFileAs}", which matched nothing`);
      }
      candidates = anchor;
    }
    // `within` narrows further, to the byte range of a node an earlier site
    // matched. File scope is not enough once the thing being found is a
    // local of one function: the /config builder destructures
    // settingsData, setAppState and changeLog into single-letter locals,
    // and other functions in the same chunk carry properties of the same
    // names. Only the ones inside that builder are the right bindings.
    let ranges = null;
    if (site.within) {
      const anchors = ctx.siteNodes.get(site.within);
      if (!anchors || anchors.length === 0) {
        throw new Error(`site "${site.id}" is within "${site.within}", which matched nothing`);
      }
      ranges = anchors;
      candidates = [...new Set(anchors.map((a) => a.file))];
    }
    // Resolved per site, not per stage: a site can depend on a capture made
    // by an earlier site in the same stage.
    const matchSpec = resolveSpec(site.match, captured);
    const markerSpec = resolveSpec(site.marker, captured);
    let hits = 0;
    // Files whose marker passed but whose predicate matched nothing. Only
    // interesting if the site ends up with no hits at all — a marker is a
    // coarse text filter, so several files mentioning the word while one of
    // them holds the real shape is the normal case, not a drift signal.
    const nearMisses = [];

    for (const [done, rel] of candidates.entries()) {
      // A full scan takes seconds — 13 patches over 2000 files is about nine
      // — which is long enough that a front end has to show it moving.
      ctx.onProgress?.({ site: site.id, done, total: candidates.length });
      let source = sources.get(rel);
      if (source === undefined) {
        source = await readFile(join(root, rel), 'utf8');
        sources.set(rel, source);
      }

      if (!passesMarker(source, markerSpec)) continue;

      let ast = ctx.asts.get(rel);
      if (ast === undefined) {
        try {
          ast = parse(source);
        } catch (e) {
          ctx.parseFailures.push({ file: rel, message: e.message });
          ctx.asts.set(rel, null);
          continue;
        }
        ctx.asts.set(rel, ast);
      }
      if (ast === null) continue;

      // With a range constraint every candidate has to be seen before `nth`
      // picks, or the first match in the file — outside the range — would
      // be taken and then discarded.
      let nodes;
      if (ranges) {
        const inside = findMatches(ast, { ...matchSpec, nth: 'all' }, source)
          .filter((n) => ranges.some((r) => r.file === rel && n.start >= r.start && n.end <= r.end
            && !(n.start === r.start && n.end === r.end)));
        const nth = matchSpec.nth ?? 0;
        nodes = nth === 'all' ? inside : nth === 'last' ? inside.slice(-1)
          : inside[nth] ? [inside[nth]] : [];
      } else {
        nodes = findMatches(ast, matchSpec, source);
      }
      if (nodes.length === 0) {
        if (site.marker !== undefined) nearMisses.push({ site: site.id, file: rel });
        continue;
      }

      for (const node of nodes) {
        const local = captureFrom(node, site.capture, source);
        Object.assign(captured, local);
        // Each match carries its own captures alongside the running set.
        // With nth:"all" the values differ per node — the fold rewrite in
        // disable-collapse-read-search reads a different array and state
        // variable at every call site — and compiling all of them against
        // one shared object would give every rewrite the last match's names.
        found.push({ site, file: rel, node, source, values: { ...captured, ...local } });
        // Recorded so a later site can anchor to this one's file.
        const seen = ctx.siteFiles.get(site.id) ?? [];
        if (!seen.includes(rel)) seen.push(rel);
        ctx.siteFiles.set(site.id, seen);
        const spans = ctx.siteNodes.get(site.id) ?? [];
        spans.push({ file: rel, start: node.start, end: node.end });
        ctx.siteNodes.set(site.id, spans);
        hits++;
        if (site.nthFile !== 'all' && matchSpec.nth !== 'all') break;
      }
      if (hits > 0 && matchSpec.nth !== 'all' && site.nthFile !== 'all') break;
    }

    // Zero hits can mean two very different things, and `satisfiedWhen`
    // separates them.
    //
    // Upstream moves toward what some patches were forcing. On 2.1.280 the
    // keybinding gate already reads H("…",!0), so the site matching the
    // disabled form finds nothing — not because the shape drifted, but
    // because there is no longer anything to change. Reporting that as
    // possible drift trains the reader to ignore the warning that matters.
    if (hits === 0 && site.satisfiedWhen) {
      const spec = resolveSpec(site.satisfiedWhen, captured);
      for (const rel of candidates) {
        const source = sources.get(rel);
        const ast = source === undefined ? undefined : ctx.asts.get(rel);
        if (!ast) continue;
        if (findMatches(ast, spec, source).length > 0) {
          satisfied.push({ site: site.id, file: rel });
          break;
        }
      }
    }

    const wasSatisfied = satisfied.some((s) => s.site === site.id);
    if (hits === 0 && !wasSatisfied && nearMisses.length > 0) {
      ctx.markerOnly.push({ site: site.id, files: nearMisses.map((m) => m.file) });
    }

    if (hits === 0 && !wasSatisfied && (site.expect ?? 'required') === 'required') {
      return { ok: false, missing: site.id, found, captured };
    }
  }

  return { ok: true, found, satisfied, captured };
}

// Locate every site of one patch. Stages run in order; a required site that
// is absent fails the whole patch rather than applying half of it.
export async function scanPatch(patch, ctx) {
  const stages = patch.stages ?? [{ id: 'main', sites: patch.sites ?? [] }];
  let values = {};
  const all = [];
  const allSatisfied = [];

  for (const stage of stages) {
    // A stage can declare it only runs when an earlier one captured
    // something — context-limit skips its env-loader phase when no variable
    // was rewritten this run.
    if (stage.when && !evaluateWhen(stage.when, values)) continue;

    const result = await runStage(stage, ctx, values);
    all.push(...result.found);
    allSatisfied.push(...(result.satisfied ?? []));
    values = result.captured;
    if (!result.ok) {
      return { ok: false, missing: result.missing, stage: stage.id, sites: all, satisfied: allSatisfied, values };
    }
  }

  return { ok: true, sites: all, satisfied: allSatisfied, values };
}

// Stage guard. Deliberately not an expression language — the only condition
// the surveyed scripts need is "did the previous stage capture this".
function evaluateWhen(when, values) {
  if (when.captured) {
    const names = Array.isArray(when.captured) ? when.captured : [when.captured];
    return names.every((n) => values[n] !== undefined);
  }
  if (when.notCaptured) {
    const names = Array.isArray(when.notCaptured) ? when.notCaptured : [when.notCaptured];
    return names.every((n) => values[n] === undefined);
  }
  return true;
}

export function createScanContext({ root, files }) {
  return {
    root,
    files,
    sources: new Map(),   // rel → text, read once
    asts: new Map(),      // rel → AST | null, parsed once
    siteFiles: new Map(), // site id → files it matched in, for sameFileAs
    siteNodes: new Map(), // site id → node spans it matched, for within
    parseFailures: [],
    markerOnly: [],       // marker present, predicate matched nothing
    onProgress: null,     // ({ site, done, total }) per candidate file, if set
  };
}

export { parse };
