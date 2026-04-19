#!/usr/bin/env node
console.error('Error: claude-code platform package not installed.');
console.error('Either postinstall did not run (--ignore-scripts) or the');
console.error('platform-specific optional dependency was not downloaded.');
console.error('');
console.error('Run the postinstall manually:');
console.error('  node node_modules/@cometix/claude-code/install.cjs');
process.exit(1);
