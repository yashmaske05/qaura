'use strict';

// Copies the browser builds the app needs into src/vendor, so the packaged app ships
// only these files (not node_modules) and everything works offline.
// Runs automatically after `npm install` and before `npm run package`.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = path.join(root, 'src', 'vendor');

const FILES = [
  ['marked/lib/marked.umd.js', 'marked.umd.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js'],
  ['@highlightjs/cdn-assets/highlight.min.js', 'highlight.min.js'],
  ['@highlightjs/cdn-assets/languages/powershell.min.js', 'hljs-powershell.min.js'],
  ['@highlightjs/cdn-assets/languages/gherkin.min.js', 'hljs-gherkin.min.js'],
  ['@highlightjs/cdn-assets/languages/http.min.js', 'hljs-http.min.js'],
  ['@highlightjs/cdn-assets/languages/dockerfile.min.js', 'hljs-dockerfile.min.js'],
  ['@highlightjs/cdn-assets/languages/groovy.min.js', 'hljs-groovy.min.js'],
  ['mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js'],
  ['exceljs/dist/exceljs.min.js', 'exceljs.min.js'],
  ['docx/dist/index.iife.js', 'docx.iife.js'],
];
const PACKAGES = ['marked', 'dompurify', '@highlightjs/cdn-assets', 'mammoth', 'exceljs', 'docx'];

fs.mkdirSync(out, { recursive: true });
for (const [from, to] of FILES) fs.copyFileSync(nm(from), path.join(out, to));

// Keep the licence texts with the copied code.
const notices = PACKAGES.map((p) => {
  const pkg = JSON.parse(fs.readFileSync(nm(`${p}/package.json`), 'utf8'));
  const lic = fs.readdirSync(nm(p)).find((f) => /^licen[sc]e/i.test(f));
  return `${pkg.name} ${pkg.version} (${pkg.license})\n${'-'.repeat(60)}\n${lic ? fs.readFileSync(nm(`${p}/${lic}`), 'utf8').trim() : 'See package.'}\n`;
});
fs.writeFileSync(path.join(out, 'THIRD-PARTY-LICENSES.txt'), `${notices.join('\n\n')}\n`);
console.log(`Vendored ${FILES.length} files into src/vendor`);
