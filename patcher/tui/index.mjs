import React from 'react';
import { render } from 'ink';
import { App } from './app.mjs';

// Ctrl+C is handled by the app rather than by Ink: while files are being
// written, quitting has to wait, and Ink's default would unmount mid-run.
export async function runTui(install) {
  const app = render(React.createElement(App, { install }), { exitOnCtrlC: false });
  await app.waitUntilExit();
}
