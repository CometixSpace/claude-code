import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './scan.mjs';
import { findMatches, captureFrom } from './match.mjs';

// ──────────────────────────────────────────────
//  Probe: try a match before writing a patch around it
//
//  Writing a site is mostly a loop of "does this predicate hit what I think,
//  and only that". The standalone scripts answered it with FOUND: lines; here
//  the question is asked directly — every hit across the tree, where it is,
//  and what `capture` would pull out of it.
//
//  Every hit is listed, not just the first. A predicate that looks unique in
//  the file you had open often is not: the voice gate's first draft matched
//  three functions of the same shape, and a probe listing all of them is what
//  catches that before it becomes a patch rewriting the wrong one.
// ──────────────────────────────────────────────

function markerPasses(source, marker) {
  if (marker === undefined) return true;
  return (Array.isArray(marker) ? marker : [marker]).some((m) => source.includes(m));
}

// `site` is shaped like a patch site: { marker?, match, capture? }. A bare
// match spec (anything with `node`, `where`, `contains` or `has` at the top)
// is accepted too.
export async function probe(layout, site, { limit = 20, width = 160 } = {}) {
  const spec = site.match ?? site;
  const report = { filesScanned: 0, filesParsed: 0, hits: [] };

  for (const rel of layout.files) {
    const source = await readFile(join(layout.root, rel), 'utf8');
    report.filesScanned++;
    if (!markerPasses(source, site.marker)) continue;

    let ast;
    try {
      ast = parse(source);
    } catch {
      continue;
    }
    report.filesParsed++;

    for (const node of findMatches(ast, { ...spec, nth: 'all' }, source)) {
      report.hits.push({
        file: rel,
        type: node.type,
        name: node.id?.name ?? node.key?.name ?? node.key?.value ?? node.callee?.name,
        start: node.start,
        bytes: node.end - node.start,
        captures: {
          ...captureFrom(node, spec.capture, source),
          ...captureFrom(node, site.capture, source),
        },
        excerpt: source.slice(node.start, Math.min(node.end, node.start + width)).replace(/\s+/g, ' '),
      });
    }
  }

  report.total = report.hits.length;
  report.hits = report.hits.slice(0, limit);
  return report;
}
