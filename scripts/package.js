'use strict';

// Builds dist\QAura-win32-x64. Uses the packager API directly because npm runs
// scripts through cmd.exe on Windows, where "^" in --ignore patterns is silently eaten.
const path = require('path');

const root = path.resolve(__dirname, '..');

(async () => {
  const { packager } = await import('@electron/packager');
  const out = await packager({
    dir: root,
    name: 'QAura',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    asar: true,
    icon: path.join(root, 'build', 'icon.ico'),
    // Anchored to the project root, so folders such as node_modules/*/dist are kept.
    ignore: [/^\/dist(\/|$)/, /^\/test(\/|$)/, /^\/scripts(\/|$)/, /^\/README\.md$/],
  });

  // Harden the exe: ignore ELECTRON_RUN_AS_NODE / NODE_OPTIONS from the environment, so the app
  // always starts as itself (and cannot be reused as a generic Node runtime).
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  for (const dir of out) {
    await flipFuses(path.join(dir, 'QAura.exe'), {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    });
  }
  console.log(`Wrote ${out.join(', ')}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
