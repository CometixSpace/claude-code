// Bun.Transpiler — strips TypeScript and compiles JSX.
//
// Function-hook modules are authored in TS/TSX and handed to the transpiler
// before being loaded. Returning the source unchanged leaves `import type`
// and annotations in place, which the parser downstream rejects.
//
// Sucrase rather than a full type-checking compiler: this only has to erase
// types and compile JSX, which is what it does in a single pass.

const { transform } = require('sucrase');
const { parse } = require('acorn');

exports.transformSync = (code, loader) => {
  const transforms = loader === 'ts' ? ['typescript']
    : loader === 'tsx' ? ['typescript', 'jsx']
    : ['jsx'];

  const output = transform(code, {
    transforms,
    disableESTransforms: true,
    production: true,
    // Bun compiles JSX to h()/Fragment calls rather than the automatic
    // runtime, and the hook modules are written against that.
    jsxRuntime: 'classic',
    jsxPragma: 'h',
    jsxFragmentPragma: 'Fragment',
  }).code;

  // A module that declared nothing but types has to come back empty, and
  // callers check that literally. Sucrase leaves the comments behind, so
  // blank them out while keeping offsets — line numbers still have to line
  // up with the original for anything reporting against it.
  const comments = [];
  parse(output, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments });
  let result = output;
  for (const { start, end } of comments.reverse()) {
    result = result.slice(0, start)
      + result.slice(start, end).replace(/[^\r\n]/g, ' ')
      + result.slice(end);
  }
  return result;
};
