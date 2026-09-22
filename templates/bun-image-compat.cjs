// Bun.Image — image handling for pasted and attached files.
//
// The bundle drives it exactly like sharp: `new Bun.Image(buf)` then
// .metadata(), .resize(w, h, {fit, withoutEnlargement}), .png({...}),
// .jpeg({quality}), .toBuffer(). So the constructor hands the input straight
// to sharp, whose JS half is bundled next to this file at build time and
// whose native half comes from the @img/sharp-* optional dependencies the
// main package already declares.
//
// The clipboard statics have no sharp equivalent — Bun reads the pasteboard
// natively. On macOS that is reachable through osascript; elsewhere there is
// no portable path, and both call sites are wrapped in try/catch, so the
// throw is what tells them to fall back.

const { execFileSync } = require('node:child_process');

const PASTEBOARD_PRELUDE = `ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const type = pb.availableTypeFromArray($(['public.png', 'public.tiff']));
`;

function runPasteboardScript(script) {
  if (process.platform !== 'darwin') {
    throw new Error('Clipboard images are only available on macOS');
  }
  return execFileSync(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', PASTEBOARD_PRELUDE + script],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

class BunImage {
  // Returns the sharp instance itself: the caller only ever chains sharp's
  // own methods off it, so there is nothing to wrap.
  constructor(input) {
    return require('./bun-sharp-compat.cjs')(input);
  }

  static hasClipboardImage() {
    return runPasteboardScript('type.isNil() ? "false" : "true";') === 'true';
  }

  static fromClipboard() {
    // TIFF is converted to PNG first — the pasteboard holds whichever the
    // source app wrote, and callers downstream expect PNG bytes.
    const data = runPasteboardScript(`if (type.isNil()) { ''; } else {
      let data = pb.dataForType(type);
      if (ObjC.unwrap(type) !== 'public.png') {
        data = $.NSBitmapImageRep.imageRepWithData(data)
          .representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      }
      ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    }`);
    return data ? new BunImage(Buffer.from(data, 'base64')) : null;
  }
}

module.exports = BunImage;
