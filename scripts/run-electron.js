'use strict';

// Runs Electron with the given arguments, e.g. "." to start the app.
// VS Code (and tools running inside it) set ELECTRON_RUN_AS_NODE, which makes
// Electron behave like plain Node, so clear it first.
const { spawn } = require('child_process');
const path = require('path');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const child = spawn(electronPath, args.length ? args : [path.resolve(__dirname, '..')], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
