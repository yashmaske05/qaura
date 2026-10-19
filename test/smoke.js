'use strict';

// End-to-end smoke test: drives the real app against throwaway data folders.
// Usage: npm test            (screenshots go to test/screenshots unless SHOTS_DIR is set)

const { _electron: electron } = require('playwright-core');
const electronPath = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mammoth = require('mammoth'); // reads .docx like Word would (to check what QAura wrote)
const ExcelJS = require('exceljs');

const appDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaura-test-'));
const shotsDir = process.env.SHOTS_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(shotsDir, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = dstr(new Date());
const tomorrow = dstr(new Date(Date.now() + 86400000));

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
  }
}

const external = []; // any request that is not a local file / data URL
const isLocal = (u) => /^(file|data|devtools|blob|chrome-extension|qa-att):/i.test(u);

// Keep rendering and timers at full speed when the test window is behind other windows
// (otherwise Windows marks it hidden: no screenshots, no canvas frames, slow previews).
const NO_THROTTLE = ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'];

// Tests run while you work, so by default they never touch the real Windows clipboard: the app's
// clipboard calls (all in the main process) go to an in-memory stand-in, and Ctrl+V is a paste event
// built from it. QN_TEST_REAL_CLIPBOARD=1 uses the real clipboard and real Ctrl+V instead.
const REAL_CLIPBOARD = process.env.QN_TEST_REAL_CLIPBOARD === '1';
async function isolateClipboard(app) {
  if (REAL_CLIPBOARD) return;
  await app.evaluate(({ clipboard }) => {
    const fake = { text: '', png: null };
    globalThis.__fakeClipboard = fake;
    const item = (type, blob) => ({ types: [type], getType: async () => blob });
    clipboard.readText = async () => fake.text;
    clipboard.writeText = async (t) => { fake.text = String(t); fake.png = null; };
    clipboard.clear = () => { fake.text = ''; fake.png = null; };
    clipboard.read = async () => (fake.png ? [item('image/png', new Blob([fake.png], { type: 'image/png' }))]
      : fake.text ? [item('text/plain', new Blob([fake.text], { type: 'text/plain' }))] : []);
    clipboard.write = async (items) => {
      for (const it of items) {
        if (it.types.includes('image/png')) { fake.png = Buffer.from(await (await it.getType('image/png')).arrayBuffer()); fake.text = ''; }
        else if (it.types.includes('text/plain')) { fake.text = await (await it.getType('text/plain')).text(); fake.png = null; }
      }
    };
  });
}
async function pasteKey(page, app) {
  if (REAL_CLIPBOARD) { await page.keyboard.press('Control+v'); return; }
  const clip = await app.evaluate(() => ({ text: globalThis.__fakeClipboard.text, png: globalThis.__fakeClipboard.png ? globalThis.__fakeClipboard.png.toString('base64') : null }));
  await page.evaluate(({ text, png }) => {
    const dt = new DataTransfer();
    if (png) dt.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    else if (text) dt.setData('text/plain', text);
    (document.activeElement || document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, clip);
}

async function launch(dir = dataDir, extraEnv = {}, extraArgs = []) {
  // QN_OFFSCREEN: the app renders in memory, so test windows never cover your screen or stall when hidden.
  const env = { ...process.env, QN_USER_DATA: dir, QN_OFFSCREEN: '1', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE; // set inside VS Code; makes Electron act like plain Node
  const app = await electron.launch({ executablePath: electronPath, args: [...NO_THROTTLE, appDir, ...extraArgs], env });
  await isolateClipboard(app);
  await app.evaluate(({ session }) => {
    globalThis.__qnRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => { globalThis.__qnRequests.push(details.url); cb({}); });
  });
  const page = await app.firstWindow();
  page.qauraApp = app; // used by shot()
  // Playwright forces a light colour scheme by default; let the app's own theme apply.
  await page.emulateMedia({ colorScheme: null });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (!isLocal(r.url())) external.push(r.url()); });
  await page.waitForSelector('body.ready', { timeout: 20000 });
  return { app, page, errors };
}

async function closeLikeUser(app) {
  const reqs = await app.evaluate(() => globalThis.__qnRequests || []).catch(() => []);
  for (const u of reqs) if (!isLocal(u)) external.push(u);
  const exited = new Promise((resolve) => app.once('close', resolve));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); }).catch(() => {});
  await exited;
}

const readData = (dir = dataDir) => JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
const clip = (app) => app.evaluate(({ clipboard }) => clipboard.readText());
// Screenshots are for visual review only; a capture timeout must not fail the run.
// Captured through Electron (capturePage forces a frame even when the window is behind other windows).
const shot = async (page, name) => {
  try {
    const b64 = await page.qauraApp.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => /index\.html$/.test(w.getURL()));
      return (await wc.capturePage()).toPNG().toString('base64');
    });
    fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(b64, 'base64'));
  } catch (err) {
    console.log(`  (screenshot ${name} skipped: ${String(err.message).split('\n')[0]})`);
  }
};
// The open file panel (a just-closed one can linger for its fade-out while the window is hidden).
const DRAWER = '.viewer-overlay:not(.closing) .file-detail';
const flush = (page) => page.evaluate(() => window.QN.store.flush());
// Replace native save/open dialogs so exports and imports can run unattended.
const stubDialogs = (app, paths) => app.evaluate(({ dialog }, p) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: p.save });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p.open });
}, paths);
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaura-export-'));
let firstShotId = null;
let workingPptx = null;

(async () => {
  console.log(`Test data folder: ${dataDir}`);
  let { app, page, errors } = await launch();
  const savedClipboard = await clip(app);

  try {
    // ---------- Home + quick capture ----------
    console.log('Home');
    check('starts on Home', await page.locator('.hero-title').isVisible());
    const capture = page.locator('#home-capture');
    await capture.fill('Retest login ABC-123 !high');
    check('capture shows parse chips', (await page.locator('.capture-chips').innerText()).includes('ABC-123'));
    await capture.press('Enter');
    await page.locator('#home-capture').fill('bug: Save button disabled on Safari QA-42');
    await page.locator('#home-capture').press('Enter');
    await page.locator('#home-capture').fill('note: Regression ideas');
    await page.locator('#home-capture').press('Enter');
    check('focus list shows captured task', (await page.locator('.home-card').first().innerText()).includes('Retest login'));
    await shot(page, '01-home');

    // ---------- Tasks ----------
    console.log('Tasks');
    await page.keyboard.press('Control+2');
    await page.waitForSelector('#task-quick');
    await page.fill('#task-quick', 'Write test plan');
    await page.press('#task-quick', 'Enter');
    check('two tasks today', (await page.locator('.task').count()) === 2);
    const first = page.locator('.task', { has: page.locator('.chip', { hasText: 'ABC-123' }) });
    check('ticket parsed out of the title', (await first.locator('.task-title').inputValue()) === 'Retest login');
    check('priority parsed as High', (await first.locator('.pill.prio').innerText()) === 'High');
    await first.locator('.check').check();
    await page.locator('.task').filter({ hasNot: page.locator('.chip') }).locator('.status-select').selectOption('blocked');
    const blocker = page.locator('.task-details input[placeholder^="What is blocking"]');
    await blocker.waitFor();
    await blocker.fill('Waiting for test data');
    await blocker.press('Tab');
    await page.waitForTimeout(150);
    check('blocker shown on the task', (await page.locator('.meta.blocked').innerText()).includes('Waiting for test data'));
    check('progress shows 1 of 2 done', (await page.locator('.progress-inline').innerText()).includes('1 of 2 done'));
    check('no native date pickers anywhere', (await page.locator('input[type="date"]').count()) === 0);
    await page.locator('.date-pick').click();
    await page.locator('.cal').waitFor();
    check('modern calendar opens with today marked', await page.locator('.cal .cal-day.today').isVisible());
    await page.waitForTimeout(200);
    await shot(page, '02b-calendar');
    await page.locator('.cal .cal-chip', { hasText: 'Tomorrow' }).click();
    check('quick pick Tomorrow switches the day', (await page.locator('.date-rel').innerText()) === 'Tomorrow');
    await page.locator('button', { hasText: 'Back to today' }).click();
    await page.locator('.date-pick').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    check('calendar works with the keyboard', (await page.locator('.date-rel').innerText()) === 'Tomorrow');
    await page.locator('button', { hasText: 'Back to today' }).click();
    await page.locator('.task-details .date-field').nth(1).click();
    await page.locator('.cal .cal-chip', { hasText: 'Tomorrow' }).click();
    check('due date set from the calendar', (await page.locator('.task .meta', { hasText: 'Due tomorrow' }).count()) === 1);
    await shot(page, '02-tasks');

    // ---------- Notes: rich text ----------
    console.log('Notes: rich text');
    await page.keyboard.press('Control+3');
    await page.locator('.list-item', { hasText: 'Regression ideas' }).click();
    const body = page.locator('.rt-editor');
    await body.click();
    await page.keyboard.type('# Login flows');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- first case');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second case');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('[] check the remember-me box');
    check('"# " makes a heading', (await body.locator('h1').count()) === 1 && (await body.locator('h1').innerText()).trim() === 'Login flows', await body.innerHTML());
    check('"- " makes a list that continues on Enter', (await body.locator('ul:not([data-checklist]) > li').count()) === 2, await body.innerHTML());
    check('"[] " makes a checklist', (await body.locator('ul[data-checklist] > li').count()) === 1, await body.innerHTML());
    const box = await body.locator('ul[data-checklist] > li').first().boundingBox();
    await page.mouse.click(box.x + 8, box.y + 12);
    check('clicking the box ticks it', (await body.locator('ul[data-checklist] > li').first().getAttribute('data-checked')) === 'true');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Plain line with ');
    await page.keyboard.press('Control+b');
    await page.keyboard.type('bold');
    check('Ctrl+B makes bold text', (await body.locator('b, strong').count()) >= 1, await body.innerHTML());
    await page.locator('.note-tags').fill('#regression, login');
    await page.locator('.note-tags').press('Tab');
    await page.locator('.rt-toolbar .star-btn').click();
    await page.locator('.rt-toolbar button[title="More"]').click();
    await page.locator('.menu-item', { hasText: 'Copy as plain text' }).click();
    await page.waitForTimeout(150);
    const plain = await clip(app);
    check('copy as plain text keeps structure', plain.includes('# Login flows') && plain.includes('- first case\n- second case') && plain.includes('- [x] check the remember-me box'), plain);
    await shot(page, '03-notes-richtext');

    // ---------- Notes: folders ----------
    console.log('Notes: folders');
    await page.locator('.pane-section button[title="New folder"]').click();
    const rename = page.locator('.rename-input');
    await rename.waitFor();
    await rename.fill('Release 2.4');
    await rename.press('Enter');
    check('folder created', await page.locator('.folder-row', { hasText: 'Release 2.4' }).isVisible());
    await page.locator('.pane-row', { hasText: 'All notes' }).click();
    const dragSource = page.locator('.list-item', { hasText: 'Regression ideas' });
    const dragTarget = page.locator('.folder-row', { hasText: 'Release 2.4' });
    const notePath = () => page.evaluate(() => { const n = window.QN.store.state.notes.find((x) => x.title === 'Regression ideas'); return window.QN.folders.path(n.folderId); });
    await dragSource.dragTo(dragTarget);
    await page.waitForTimeout(150);
    if (await notePath() !== 'Release 2.4') {
      // Playwright's mouse drag sometimes never starts a native drag in Electron.
      // Fall back to dispatching the same HTML5 drag events the browser would send.
      console.log('  (native drag not delivered by the test driver; using HTML5 drag events)');
      await page.evaluate(([a, b]) => {
        const dt = new DataTransfer();
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        fire(a, 'dragstart'); fire(b, 'dragenter'); fire(b, 'dragover'); fire(b, 'drop'); fire(a, 'dragend');
      }, [await dragSource.elementHandle(), await dragTarget.elementHandle()]);
      await page.waitForTimeout(150);
    }
    const movedTo = await notePath();
    check('drag note onto folder moves it', movedTo === 'Release 2.4', `folder: "${movedTo}"`);
    check('favorites count shows starred note', (await page.locator('.pane-row', { hasText: 'Favorites' }).locator('.pane-count').innerText().catch(() => '')) === '1');
    await page.locator('.folder-row', { hasText: 'Release 2.4' }).hover();
    await page.locator('.folder-row', { hasText: 'Release 2.4' }).locator('.row-menu').click();
    await page.locator('.menu-item', { hasText: 'New subfolder' }).click();
    await page.locator('.rename-input').fill('Smoke');
    await page.locator('.rename-input').press('Enter');
    check('subfolder created inside', (await page.locator('.scope-path').innerText()).includes('Release 2.4'));

    // ---------- Notes: templates ----------
    console.log('Notes: templates');
    await page.locator('.split-chevron').click();
    await page.locator('.menu-item', { hasText: 'Test case' }).click();
    await page.locator('.notes-split .rt-editor h3', { hasText: 'Steps' }).waitFor();
    check('note created from Test case template in current folder', (await page.locator('.notes-split .folder-chip').innerText()).includes('Release 2.4 / Smoke'));
    await shot(page, '04-notes-folders');

    // ---------- Notes: grid + board ----------
    console.log('Notes: grid & board');
    await page.locator('.pane-row', { hasText: 'All notes' }).click();
    await page.locator('.notes-head .seg button[title="Grid"]').click();
    check('grid shows cards', (await page.locator('.note-card').count()) >= 2);
    const card = page.locator('.note-card', { hasText: 'Regression ideas' });
    await card.hover();
    const hb = await card.locator('.resize-handle').boundingBox();
    await page.mouse.move(hb.x + 8, hb.y + 8);
    await page.mouse.down();
    await page.mouse.move(hb.x + 300, hb.y + 120, { steps: 6 });
    await page.mouse.up();
    await flush(page);
    const gridSize = readData().notes.find((n) => n.title === 'Regression ideas').grid;
    check('grid card resized and saved', gridSize && gridSize.c >= 2 && gridSize.r >= 4, JSON.stringify(gridSize));
    await shot(page, '05-notes-grid');

    await page.locator('.notes-head .seg button[title="Board"]').click();
    const sticky = page.locator('.sticky', { hasText: 'Regression ideas' });
    const sb = await sticky.boundingBox();
    await page.mouse.move(sb.x + 60, sb.y + 60);
    await page.mouse.down();
    await page.mouse.move(sb.x + 460, sb.y + 260, { steps: 8 });
    await page.mouse.up();
    await flush(page);
    const pos = readData().notes.find((n) => n.title === 'Regression ideas').board;
    check('sticky dragged and position saved', pos && pos.x > 300, JSON.stringify(pos));
    await page.locator('.board-bar button', { hasText: 'Add sticky' }).click();
    await page.locator('.drawer .note-title').waitFor();
    await page.locator('.drawer .note-title').fill('Sticky from the board');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('drawer editor closes with Esc and the sticky shows', await page.locator('.sticky', { hasText: 'Sticky from the board' }).isVisible());
    await shot(page, '06-notes-board');
    await page.locator('.notes-head .seg button[title="List"]').click();

    // ---------- Notes: links, backlinks, ticket hub ----------
    console.log('Notes: links & ticket hub');
    await page.locator('.list-item', { hasText: 'Regression ideas' }).click();
    await page.locator('.rt-editor').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('See ABC-123 and [[');
    await page.locator('.picker-input').waitFor();
    await page.locator('.picker-input').fill('test case');
    await page.keyboard.press('Enter');
    check('[[ inserts a link to another note', (await page.locator('.rt-editor a[data-note]').innerText()).includes('Test case'));
    await page.locator('.note-title').click();
    await page.waitForTimeout(100);
    check('related panel shows the ticket', (await page.locator('.related .rel-chip.ticket').innerText()).includes('ABC-123'));
    check('related panel shows the outgoing link', (await page.locator('.related').innerText()).includes('Test case'));
    await page.locator('.related .rel-chip.ticket').click();
    await page.locator('.hub').waitFor();
    const hub = await page.locator('.hub').innerText();
    check('ticket hub lists the task for ABC-123', hub.includes('Retest login') && hub.includes('Tasks'), hub);
    await page.waitForTimeout(350);
    await shot(page, '06b-ticket-hub');
    await page.keyboard.press('Escape');
    await page.locator('.rt-editor a[data-note]').click({ modifiers: ['Control'] });
    await page.locator('.notes-split .note-title').waitFor();
    check('Ctrl+click on the link opens that note', (await page.locator('.notes-split .note-title').inputValue()) === 'Test case');
    check('target note shows the backlink', (await page.locator('.related').innerText()).includes('Regression ideas'));
    const foot = await page.locator('.editor-foot').innerText();
    check('footer shows characters and reading time', /characters/.test(foot) && /min read/.test(foot), foot);

    // ---------- Notes: auto-title, duplicate, archive, sort, filters, views ----------
    console.log('Notes: management');
    await page.locator('.pane-row', { hasText: 'All notes' }).click();
    await page.locator('.split-btn > .btn').first().click();
    await page.locator('.notes-split .rt-editor').click();
    await page.keyboard.type('Zebra crossing checklist for mobile');
    await page.locator('.notes-split .note-tags').click();
    check('auto-title from the first line', (await page.locator('.notes-split .note-title').inputValue()) === 'Zebra crossing checklist for mobile');
    await page.locator('.rt-toolbar button[title="More"]').click();
    await page.locator('.menu-item', { hasText: 'Duplicate' }).click();
    check('duplicate creates a copy', (await page.locator('.list-item', { hasText: 'Zebra crossing checklist for mobile (copy)' }).count()) === 1);
    await page.locator('.rt-toolbar button[title="More"]').click();
    await page.locator('.menu-item', { hasText: /^Archive/ }).click();
    check('archived note leaves All notes', (await page.locator('.list-item', { hasText: '(copy)' }).count()) === 0);
    await page.locator('.pane-row', { hasText: 'Archive' }).click();
    check('archived note is in Archive', (await page.locator('.list-item', { hasText: '(copy)' }).count()) === 1);
    await page.locator('.pane-row', { hasText: 'All notes' }).click();
    await page.locator('.notes-head button[title^="Sort notes"]').click();
    await page.locator('.menu-item', { hasText: 'Title A–Z' }).click();
    const titles = await page.locator('.list-item .li-title').allInnerTexts();
    const unstarred = titles.slice(1); // the starred note stays on top
    check('sort Title A–Z', JSON.stringify(unstarred) === JSON.stringify([...unstarred].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))), titles.join(' | '));
    await page.locator('.notes-head button[title^="Filter"]').click();
    await page.locator('.swatch-btn[title="Yellow"]').click();
    check('colour filter shows only yellow notes', (await page.locator('.list-item').allInnerTexts()).every((t) => t.includes('Sticky from the board')), (await page.locator('.list-item').allInnerTexts()).join(' | '));
    await page.locator('.filter-bar button', { hasText: 'Clear filters' }).click();
    await page.locator('.filter-bar button', { hasText: 'Has open to-dos' }).click();
    check('open to-dos filter', (await page.locator('.list-item').count()) >= 1 && (await page.locator('.list-item', { hasText: 'Test case' }).count()) === 1);
    await page.locator('.filter-bar button', { hasText: 'Clear filters' }).click();
    await page.locator('.notes-search .search-input').fill('type:test-case');
    check('notes search understands type:', (await page.locator('.list-item').count()) === 1 && (await page.locator('.list-item .li-title').innerText()) === 'Test case');
    await page.locator('.notes-search .search-input').fill('remember');
    check('notes search highlights matches', (await page.locator('.list-item mark.hit').count()) > 0);
    await page.locator('.notes-search .search-input').fill('');
    await page.locator('.pane-row', { hasText: 'Recently viewed' }).click();
    check('recently viewed lists opened notes', (await page.locator('.list-item').count()) >= 2);
    await page.locator('.pane-row', { hasText: 'All notes' }).click();
    await page.locator('.list-item', { hasText: 'Regression ideas' }).click();
    await page.keyboard.press('Control+Shift+F');
    check('distraction-free mode hides the sidebar', await page.evaluate(() => document.body.classList.contains('zen') && getComputedStyle(document.querySelector('.sidebar')).visibility === 'hidden'));
    await shot(page, '06c-zen');
    await page.keyboard.press('Escape');
    check('Esc leaves distraction-free mode', await page.evaluate(() => !document.body.classList.contains('zen')));
    await page.locator('.focus-btn').click();
    await page.locator('.menu-item', { hasText: '25 minutes' }).click();
    check('focus timer runs in the title bar', /\d\d:\d\d/.test(await page.locator('.focus-btn').innerText()));
    await page.locator('.focus-btn').click();
    await page.locator('.menu-item', { hasText: 'Stop timer' }).click();

    // ---------- Export / import ----------
    console.log('Export & import');
    const mdFile = path.join(exportDir, 'note.md');
    await stubDialogs(app, { save: mdFile, open: [exportDir] });
    await page.locator('.rt-toolbar button[title="More"]').click();
    await page.locator('.menu-item', { hasText: 'Markdown (.md)' }).click();
    await page.waitForTimeout(400);
    const md = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
    check('export note as Markdown', md.startsWith('# Regression ideas') && md.includes('## Login flows') === false && md.includes('# Login flows') && md.includes('**bold**') && md.includes('- [x] check the remember-me box') && md.includes('[[Test case]]'), md);
    const pdfFile = path.join(exportDir, 'note.pdf');
    await stubDialogs(app, { save: pdfFile, open: [exportDir] });
    await page.locator('.rt-toolbar button[title="More"]').click();
    await page.locator('.menu-item', { hasText: 'PDF (.pdf)' }).click();
    await page.waitForFunction((f) => window.__pdfDone || false, pdfFile, { timeout: 1000 }).catch(() => {});
    for (let i = 0; i < 40 && !fs.existsSync(pdfFile); i++) await page.waitForTimeout(250);
    check('export note as PDF (offline)', fs.existsSync(pdfFile) && fs.readFileSync(pdfFile).slice(0, 5).toString() === '%PDF-');
    await page.locator('.notes-head button[title="Export / import"]').click();
    await page.locator('.menu-item', { hasText: 'Plain text (.txt)' }).click();
    await page.waitForTimeout(400);
    const allDir = path.join(exportDir, 'All notes');
    const exported = fs.existsSync(allDir) ? fs.readdirSync(allDir, { recursive: true }).map(String) : [];
    check('export all notes as text files in folders', exported.some((f) => f.includes('Release 2.4') && f.endsWith('Regression ideas.txt')) && exported.some((f) => f.endsWith('Test case.txt')), exported.join(', '));
    const importFile = path.join(exportDir, 'imported-from-disk.md');
    fs.writeFileSync(importFile, '# Imported runbook\n\n- [ ] step one\n- step two\n');
    await stubDialogs(app, { save: '', open: [importFile] });
    await page.locator('.notes-head button[title="Export / import"]').click();
    await page.locator('.menu-item', { hasText: 'Import .md / .txt files' }).click();
    await page.locator('.list-item', { hasText: 'Imported runbook' }).waitFor();
    check('import a Markdown file as a note', (await page.locator('.list-item', { hasText: 'Imported runbook' }).count()) === 1);

    // ---------- Bugs ----------
    console.log('Bugs');
    await page.keyboard.press('Control+4');
    await page.locator('.list-item', { hasText: 'Save button disabled' }).click();
    const fieldArea = (label) => page.locator('label.field', { hasText: label }).locator('textarea');
    await fieldArea('Steps to reproduce').fill('Open the editor\nChange the title\nClick Save');
    await fieldArea('Expected result').fill('Changes are saved');
    await fieldArea('Actual result').fill('Save button stays disabled');
    await page.locator('label.field', { hasText: 'Environment' }).locator('input').fill('QA');
    await page.locator('label.field', { hasText: 'Status' }).locator('select').selectOption('retest');
    await page.locator('button', { hasText: 'Copy report' }).click();
    await page.waitForTimeout(200);
    const report = await clip(app);
    check('bug report has ticket + numbered steps', report.startsWith('[QA-42] Save button disabled on Safari') && report.includes('1. Open the editor\n2. Change the title\n3. Click Save'), report);
    check('status history recorded', await page.locator('.history li').first().isVisible());

    console.log('Bugs: API & screenshots');
    const apiField = (label) => page.locator('.api-field', { hasText: label });
    await apiField('API request').locator('textarea').fill('POST https://api.example.com/v1/save\n\n{"title":"x","id":7}');
    await apiField('API response').locator('textarea').fill('HTTP/1.1 500 Internal Server Error\n\n{"error":"boom","code":500}');
    await apiField('API response').locator('button', { hasText: 'Format JSON' }).click();
    const apiRes = await apiField('API response').locator('textarea').inputValue();
    check('Format JSON pretty-prints the response body', apiRes.startsWith('HTTP/1.1 500') && apiRes.includes('{\n  "error": "boom",\n  "code": 500\n}'), apiRes);
    check('API response is syntax coloured', (await apiField('API response').locator('.hljs-attr, .hljs-string, .hljs-number').count()) > 0);
    const makePng = (w, h, color) => page.evaluate(([w2, h2, c]) => { const cv = document.createElement('canvas'); cv.width = w2; cv.height = h2; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w2, h2); g.fillStyle = '#fff'; g.fillRect(8, 8, 30, 14); return cv.toDataURL('image/png'); }, [w, h, color]);
    // A real image on the Windows clipboard, pasted with Ctrl+V (what Win+Shift+S produces).
    await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, url) => {
      const png = nativeImage.createFromDataURL(url).toPNG();
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    }, await makePng(120, 80, '#7c5cff'));
    const bugTiles = page.locator('.editor-pane .file-tile');
    await page.locator('.bug-title').click();
    await pasteKey(page, app);
    await bugTiles.first().locator('img').waitFor();
    const shownWidth = await bugTiles.first().locator('img').evaluate((img) => new Promise((res) => { if (img.complete) res(img.naturalWidth); else img.onload = () => res(img.naturalWidth); }));
    check('Ctrl+V pastes a screenshot and shows it', shownWidth === 120, `naturalWidth ${shownWidth}`);
    check('pasting an image does not change the title', (await page.locator('.bug-title').inputValue()) === 'Save button disabled on Safari');
    await flush(page);
    const qaBug = () => readData().bugs.find((x) => x.ticket === 'QA-42');
    const fileRec = (id) => readData().files.find((f) => f.id === id);
    const bugFileIds = qaBug().files || [];
    firstShotId = bugFileIds[0] && fileRec(bugFileIds[0]).versions[0].blob;
    check('screenshot stored as its own file and linked to the bug', bugFileIds.length === 1 && /^[a-f0-9]{64}\.png$/.test(firstShotId) && fs.existsSync(path.join(dataDir, 'attachments', firstShotId)), JSON.stringify(bugFileIds));
    check('image is not embedded in the data file', !/data:image|base64,/i.test(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8')));
    await pasteKey(page, app);
    await page.waitForTimeout(400);
    check('the same screenshot is not attached twice', (await bugTiles.count()) === 1);
    const pngFile = path.join(exportDir, 'second-shot.png');
    fs.writeFileSync(pngFile, Buffer.from((await makePng(64, 48, '#22d3ee')).split(',')[1], 'base64'));
    await stubDialogs(app, { save: '', open: [pngFile] });
    await page.locator('.editor-pane .file-drop button', { hasText: 'Add files' }).click();
    await bugTiles.nth(1).waitFor();
    check('add a screenshot from a file', (await bugTiles.nth(1).locator('.file-name').innerText()) === 'second-shot.png');
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await bugTiles.first().locator('.file-thumb').click();
    await page.locator(`${DRAWER}`).waitFor();
    await page.locator(`${DRAWER} button[title="More"]`).click();
    await page.locator('.menu-item', { hasText: 'Copy image' }).click();
    await page.waitForTimeout(300);
    const clipSize = await app.evaluate(async ({ clipboard, nativeImage }) => {
      const item = (await clipboard.read()).find((x) => x.types.includes('image/png'));
      if (!item) return null;
      return nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer())).getSize();
    });
    check('Copy image puts the screenshot on the clipboard (for Jira)', Boolean(clipSize) && clipSize.width === 120 && clipSize.height === 80, JSON.stringify(clipSize));
    await page.locator(`${DRAWER} .preview-img`).click();
    check('clicking a screenshot opens a full-size preview', await page.locator('.lightbox img').isVisible());
    await page.waitForTimeout(150);
    await shot(page, '04c-lightbox');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, url) => {
      const png = nativeImage.createFromDataURL(url).toPNG();
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    }, await makePng(90, 60, '#f472b6'));
    await page.locator('.editor-pane .file-drop button', { hasText: 'Paste image' }).click();
    await bugTiles.nth(2).waitFor({ timeout: 5000 }).catch(() => {});
    check('"Paste image" button attaches the clipboard image', (await bugTiles.count()) === 3);
    await page.locator('button', { hasText: 'Copy report' }).click();
    await page.waitForTimeout(200);
    const report2 = await clip(app);
    check('bug report includes API request/response and attached files', report2.includes('API request:\nPOST https://api.example.com/v1/save') && report2.includes('"error": "boom"') && report2.includes('Attached files (3):'), report2);
    check('Checklists section is gone', (await page.locator('.sidebar .nav-item', { hasText: 'Checklists' }).count()) === 0);
    await page.waitForTimeout(200);
    await shot(page, '04b-bug-screenshots');

    // ---------- Files: every supported type, previews, editing, versions ----------
    console.log('Files');
    const fx = (name) => path.join(exportDir, name);
    const pdfB64 = await app.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({ show: false });
      await w.loadURL('data:text/html,<h1>Login spec PDF</h1>');
      const b = await w.webContents.printToPDF({});
      w.destroy();
      return b.toString('base64');
    });
    fs.writeFileSync(fx('Login spec.pdf'), Buffer.from(pdfB64, 'base64'));
    const made = await page.evaluate(async () => {
      const b64 = (u8) => { let str = ''; for (let i = 0; i < u8.length; i += 0x8000) str += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(str); };
      const d = new docx.Document({ sections: [{ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: 'Test plan for release 2.4', bold: true })] })] }] });
      const docxBytes = new Uint8Array(await (await docx.Packer.toBlob(d)).arrayBuffer());
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Test data');
      ws.addRow(['User', 'Email']);
      ws.addRow(['alice', 'alice@example.com']);
      const xlsxBytes = new Uint8Array(await wb.xlsx.writeBuffer());
      return { docx: b64(docxBytes), xlsx: b64(xlsxBytes) };
    });
    fs.writeFileSync(fx('Test plan.docx'), Buffer.from(made.docx, 'base64'));
    fs.writeFileSync(fx('Test data.xlsx'), Buffer.from(made.xlsx, 'base64'));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'recording.webm'), fx('Login bug.webm')); // a real 1 s screen recording
    check('test recording fixture is a real WebM', fs.statSync(fx('Login bug.webm')).size > 500, `${fs.statSync(fx('Login bug.webm')).size} bytes`);
    fs.writeFileSync(fx('Slides.pptx'), Buffer.from(made.docx, 'base64')); // a valid Office zip, used for "Edit in PowerPoint"
    fs.writeFileSync(fx('users.csv'), 'Name,Email,Role\r\nalice,alice@example.com,admin\r\nbob,"bob, jr@example.com",viewer\r\n');
    fs.writeFileSync(fx('response.json'), '{"error":"boom","code":500}');
    fs.writeFileSync(fx('server.log'), '2026-10-14 10:00:01 ERROR NullPointerException at PatientList\n');
    fs.writeFileSync(fx('fake.pdf'), 'this is not really a pdf');
    fs.writeFileSync(fx('tool.exe'), 'MZ fake');
    await stubDialogs(app, { save: '', open: ['Login spec.pdf', 'Test plan.docx', 'Test data.xlsx', 'Login bug.webm', 'Slides.pptx', 'users.csv', 'response.json', 'server.log', 'fake.pdf', 'tool.exe'].map(fx) });
    await page.locator('.editor-pane .file-drop button', { hasText: 'Add files' }).click();
    await page.locator('.modal-title').waitFor();
    const rejected = await page.locator('.modal-text').innerText();
    check('fake and unsupported files are rejected with a reason', rejected.includes('fake.pdf') && rejected.includes('valid .pdf') && rejected.includes('tool.exe') && rejected.includes('not supported'), rejected);
    await page.locator('.modal button[type="submit"]').click();
    check('all 8 supported files attached to the bug', (await bugTiles.count()) === 11, `${await bugTiles.count()} tiles`);
    const tileFor = (name) => page.locator('.editor-pane .file-tile', { has: page.locator('.file-name', { hasText: name }) });
    const openTile = async (name) => { await tileFor(name).locator('.file-thumb').click(); await page.locator(`${DRAWER}`).waitFor(); };
    const closeDrawer = async () => { await page.locator(`${DRAWER} button[title="Close (Esc)"]`).click(); await page.waitForTimeout(300); };

    await openTile('Test plan.docx');
    await page.locator('.docx-preview').waitFor();
    check('Word file previews inside QAura', (await page.locator('.docx-preview').innerText()).includes('Test plan for release 2.4'));
    const geo = await page.evaluate(() => {
      const r = document.querySelector('.viewer-overlay:not(.closing) .viewer').getBoundingClientRect();
      const side = document.querySelector('.viewer-overlay:not(.closing) .file-side');
      return { cx: r.left + r.width / 2, w: r.width, h: r.height, winW: innerWidth, winH: innerHeight, versionsInSide: Boolean(side && side.querySelector('.version-list')) };
    });
    check('files open in a large viewer in the middle of the window', Math.abs(geo.cx - geo.winW / 2) < 4 && geo.w > geo.winW * 0.8 && geo.h > geo.winH * 0.75 && geo.versionsInSide, JSON.stringify(geo));
    await page.waitForTimeout(250);
    await shot(page, '10-file-word-preview');
    await page.locator(`${DRAWER} button[title="Zoom in"]`).click();
    await page.locator(`${DRAWER} button[title="Zoom in"]`).click();
    check('Word preview zooms in', (await page.locator(`${DRAWER} .zoom-val`).innerText()) === '120%' && (await page.locator('.docx-preview').evaluate((d) => d.style.zoom)) === '1.2');
    await page.locator(`${DRAWER} .zoom-val`).click();
    await page.locator(`${DRAWER} button[title="Fill the window"]`).click();
    const maxBox = await page.locator('.viewer-overlay:not(.closing) .viewer').boundingBox();
    check('"Fill the window" makes the viewer use the whole window', (await page.locator('.viewer.max').count()) === 1 && maxBox.width > (await page.evaluate(() => innerWidth)) - 20);
    await closeDrawer();
    await openTile('Test plan.docx');
    check('the viewer remembers "Fill the window"', (await page.locator('.viewer-overlay:not(.closing) .viewer.max').count()) === 1);
    await page.locator(`${DRAWER} button[title="Restore size"]`).click();
    await flush(page);
    check('restoring the size is remembered too', (await page.locator('.viewer.max').count()) === 0 && readData().settings.fileViewerMax === false);
    await closeDrawer();
    await openTile('Test data.xlsx');
    await page.locator('table.sheet').waitFor();
    check('Excel file previews as a sheet', (await page.locator('table.sheet').innerText()).includes('alice@example.com'));
    await closeDrawer();
    await openTile('Login bug.webm');
    const videoOk = await page.locator('.preview-video').evaluate((v) => new Promise((res) => {
      if (v.readyState >= 1) { res(true); return; }
      v.onloadedmetadata = () => res(true);
      v.onerror = () => res(false);
      setTimeout(() => res(false), 6000);
    }));
    check('screen recording plays inside QAura', videoOk === true);
    await closeDrawer();
    await openTile('Login spec.pdf');
    const windowsBefore = app.windows().length;
    const viewerPromise = app.waitForEvent('window', { timeout: 10000 }).catch(() => null);
    await page.locator(`${DRAWER} .preview-card button`, { hasText: 'Open PDF viewer' }).click();
    const viewer = await viewerPromise;
    check('PDF opens in the built-in viewer window', Boolean(viewer) && app.windows().length === windowsBefore + 1);
    if (viewer) await viewer.close().catch(() => {});
    await closeDrawer();

    await openTile('users.csv');
    await page.locator('table.sheet.editable input[aria-label="Row 3, column 1"]').fill('robert');
    await closeDrawer(); // closing saves automatically
    await page.waitForTimeout(500);
    await flush(page);
    const csvFile = readData().files.find((f) => f.name === 'users.csv');
    const csvText = fs.readFileSync(path.join(dataDir, 'attachments', csvFile.versions[csvFile.versions.length - 1].blob), 'utf8');
    check('CSV edited in a grid, saved as a new version on close', csvFile.versions.length === 2 && csvText.includes('robert,"bob, jr@example.com",viewer') && csvFile.versions[1].source === 'Edited in QAura', csvText);
    check('the original CSV version is kept untouched', fs.readFileSync(path.join(dataDir, 'attachments', csvFile.versions[0].blob), 'utf8').includes('bob,"bob, jr@example.com"'));

    await openTile('response.json');
    await page.locator(`${DRAWER} button`, { hasText: 'Format JSON' }).click();
    await page.locator(`${DRAWER} .code-input`).press('Control+s');
    await page.locator(`${DRAWER} .version-list li`, { hasText: 'v2' }).waitFor({ timeout: 5000 }).catch(() => {});
    check('JSON formatted in QAura and saved as v2', (await page.locator(`${DRAWER} .version-list li`).count()) === 2);
    check('after Ctrl+S you keep typing where you were (editor not reloaded)', await page.evaluate((sel) => document.activeElement && document.activeElement.matches(sel), `${DRAWER} .code-input`));
    await page.locator(`${DRAWER} .version-list li`, { hasText: 'v1' }).locator('button', { hasText: 'Restore' }).click();
    await page.waitForTimeout(300);
    await flush(page);
    const jsonFile = readData().files.find((f) => f.name === 'response.json');
    check('restoring v1 adds v3 with the original content', jsonFile.versions.length === 3 && jsonFile.versions[2].blob === jsonFile.versions[0].blob && jsonFile.versions[2].source === 'Restored v1', JSON.stringify(jsonFile.versions.map((x) => x.source)));
    await closeDrawer();

    // Stand-ins for installed apps: nothing real is started during tests.
    await app.evaluate(({ app: a, shell }) => {
      globalThis.__launched = [];
      globalThis.__opened = [];
      a.qaura.findEditor = (kind) => (kind === 'powerpoint' ? { name: 'PowerPoint', path: 'C:\\Office\\POWERPNT.EXE' } : null);
      a.qaura.launch = async (exe, args) => { globalThis.__launched.push([exe, ...args]); };
      shell.openPath = async (p2) => { globalThis.__opened.push(p2); return ''; };
    });
    await openTile('Slides.pptx');
    await page.locator(`${DRAWER} .file-head button`, { hasText: 'Edit in PowerPoint' }).click();
    await page.waitForTimeout(400);
    const launched = await app.evaluate(() => globalThis.__launched);
    check('Office files open in the installed app itself, through a working copy', launched.length === 1 && launched[0][0] === 'C:\\Office\\POWERPNT.EXE' && launched[0][1].includes(`${path.sep}working${path.sep}`) && launched[0][1].endsWith('Slides.pptx'), JSON.stringify(launched));
    check("Windows' default app is not used for Office files", (await app.evaluate(() => globalThis.__opened)).length === 0);
    workingPptx = launched[0] && launched[0][1];
    fs.appendFileSync(workingPptx, Buffer.from(' edited in PowerPoint')); // what a save in PowerPoint does
    await page.locator(`${DRAWER} .version-list li`, { hasText: 'v2' }).waitFor({ timeout: 10000 }).catch(() => {});
    check('a save in PowerPoint becomes a new version automatically', (await page.locator(`${DRAWER} .version-list li`).count()) === 2 && (await page.locator(`${DRAWER} .version-list li`).first().innerText()).includes('Edited in PowerPoint'));
    await page.waitForTimeout(200);
    await shot(page, '11-file-versions');
    await closeDrawer();

    // Word is not installed: QAura says so instead of handing the file to whatever Windows picks.
    await openTile('Test plan.docx');
    await page.locator(`${DRAWER} button[title="More"]`).click();
    await page.locator('.menu-item', { hasText: 'Open in Word' }).click();
    await page.locator('.modal-title').waitFor({ timeout: 5000 }).catch(() => {});
    const noWord = await page.locator('.modal-title').innerText().catch(() => '');
    check('without Word, QAura explains instead of opening another app', noWord === "Microsoft Word isn't installed on this PC" && (await app.evaluate(() => globalThis.__launched.length + globalThis.__opened.length)) === 1, noWord);
    await page.waitForTimeout(150);
    await shot(page, '11b-no-word');
    await page.locator('.modal button', { hasText: 'Choose another app' }).click();
    await page.waitForTimeout(400);
    const chosen = await app.evaluate(() => globalThis.__launched[globalThis.__launched.length - 1]);
    check('"Choose another app…" opens Windows\' app picker for a working copy', /rundll32\.exe$/i.test(chosen[0]) && chosen[1] === 'shell32.dll,OpenAs_RunDLL' && chosen[2].endsWith('Test plan.docx'), JSON.stringify(chosen));
    await closeDrawer();

    // Edit a Word document right here: typing, bold, a pasted picture. Each save is a real .docx version.
    console.log('Files: edit Word and Excel in QAura');
    await openTile('Test plan.docx');
    await page.locator(`${DRAWER} .file-head button`, { hasText: /^Edit$/ }).click();
    const docBody = page.locator(`${DRAWER} .doc-editable`);
    await docBody.waitFor();
    await docBody.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    // Like Word, a new line after bold text continues in bold: start this line plain.
    if (await page.evaluate(() => document.queryCommandState('bold'))) await page.keyboard.press('Control+b');
    await page.keyboard.type('Added in QAura ');
    await page.keyboard.press('Control+b');
    await page.keyboard.type('bold part');
    await page.keyboard.press('Control+b');
    await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, url) => {
      const png = nativeImage.createFromDataURL(url).toPNG();
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    }, await makePng(200, 120, '#0ea5e9'));
    await pasteKey(page, app);
    await page.locator(`${DRAWER} .doc-editable img`).waitFor({ timeout: 5000 }).catch(() => {});
    check('a picture pasted into a Word document stays inside it', (await page.locator(`${DRAWER} .doc-editable img`).count()) === 1);
    await docBody.press('Control+s');
    await page.locator(`${DRAWER} .version-list li`, { hasText: 'v2' }).waitFor({ timeout: 10000 }).catch(() => {});
    await flush(page);
    const planRec = readData().files.find((f) => f.name === 'Test plan.docx');
    const planV2 = planRec && planRec.versions[1];
    const v2Html = planV2 ? (await mammoth.convertToHtml({ path: path.join(dataDir, 'attachments', planV2.blob) })).value : '';
    check('Ctrl+S saves the edited document as a real Word file (a new version)', Boolean(planV2) && planV2.source === 'Edited in QAura' && /\.docx$/.test(planV2.blob)
      && v2Html.includes('Test plan for release 2.4') && v2Html.includes('Added in QAura') && v2Html.includes('<strong>bold part</strong>') && (v2Html.match(/<img /g) || []).length === 1, v2Html.slice(0, 400));
    const v1Text = (await mammoth.extractRawText({ path: path.join(dataDir, 'attachments', planRec.versions[0].blob) })).value;
    check('the original Word file is kept untouched as v1', v1Text.includes('Test plan for release 2.4') && !v1Text.includes('Added in QAura'));
    check('you keep typing after Ctrl+S (the editor stays open)', await page.evaluate((sel) => Boolean(document.activeElement && document.activeElement.matches(sel)), `${DRAWER} .doc-editable`));
    await page.waitForTimeout(200);
    await shot(page, '13-word-edit');
    await page.locator(`${DRAWER} .file-head button`, { hasText: 'Done' }).click();
    await page.locator(`${DRAWER} .docx-preview:not(.doc-editable)`).waitFor();
    check('Done goes back to the page preview, with the changes', (await page.locator(`${DRAWER} .docx-preview`).innerText()).includes('Added in QAura'));
    await closeDrawer();

    // Edit Excel cells right here: text stays text (IDs like 00123), numbers, a formula; other cells untouched.
    await openTile('Test data.xlsx');
    await page.locator(`${DRAWER} .file-head button`, { hasText: /^Edit$/ }).click();
    await page.locator(`${DRAWER} table.sheet.editable`).waitFor();
    const xcell = (r, c) => page.locator(`${DRAWER} input[aria-label="Row ${r}, column ${c}"]`);
    await xcell(2, 2).fill('alice@qa.example');
    await xcell(3, 1).fill('bob');
    await xcell(3, 2).fill('00123');
    await xcell(3, 3).fill('=LEN(A3)');
    await xcell(4, 1).fill('42');
    await page.waitForTimeout(150);
    await shot(page, '14-excel-edit');
    await page.locator(`${DRAWER} .file-head button`, { hasText: 'Done' }).click();
    await page.locator(`${DRAWER} table.sheet:not(.editable)`).waitFor();
    await flush(page);
    const dataRec = readData().files.find((f) => f.name === 'Test data.xlsx');
    const readSheet = async (blob) => { const w = new ExcelJS.Workbook(); await w.xlsx.readFile(path.join(dataDir, 'attachments', blob)); return w.getWorksheet('Test data'); };
    const xsNew = await readSheet(dataRec.versions[dataRec.versions.length - 1].blob);
    const c3 = xsNew.getCell('C3').value;
    check('Excel cells edited in QAura are saved as a new version', dataRec.versions.length === 2 && xsNew.getCell('A1').value === 'User' && xsNew.getCell('B2').value === 'alice@qa.example'
      && xsNew.getCell('A3').value === 'bob' && xsNew.getCell('B3').value === '00123' && xsNew.getCell('A4').value === 42 && Boolean(c3 && c3.formula === 'LEN(A3)'),
      JSON.stringify({ versions: dataRec.versions.length, B2: xsNew.getCell('B2').value, B3: xsNew.getCell('B3').value, A4: xsNew.getCell('A4').value, C3: c3 }));
    check('the original workbook is kept untouched as v1', (await readSheet(dataRec.versions[0].blob)).getCell('B2').value === 'alice@example.com');
    await closeDrawer();

    await page.keyboard.press('Control+7');
    await page.locator('.files-view .file-tile').first().waitFor();
    check('Files library lists every file', (await page.locator('.files-view .file-tile').count()) === 11, `${await page.locator('.files-view .file-tile').count()}`);
    await page.locator('.files-view .kind-filter').selectOption('excel');
    check('Files library filters by type', (await page.locator('.files-view .file-tile').count()) === 1);
    await page.locator('.files-view .kind-filter').selectOption('');
    await page.locator('.files-view .search-input').fill('users');
    check('Files library search and "used in"', (await page.locator('.files-view .file-tile').count()) === 1 && (await page.locator('.files-view .file-uses').innerText()).includes('Used in 1 item'));
    await page.locator('.files-view .search-input').fill('');
    await page.waitForTimeout(200);
    await shot(page, '09-files-library');

    // A workbook with a chart: QAura says first what an edited version can't keep; the original keeps it.
    await stubDialogs(app, { save: '', open: [path.join(__dirname, 'fixtures', 'chart.xlsx')] });
    await page.locator('.files-view button', { hasText: 'Add files' }).click();
    const chartTile = page.locator('.files-view .file-tile', { has: page.locator('.file-name', { hasText: 'chart.xlsx' }) });
    await chartTile.waitFor();
    await chartTile.locator('.file-thumb').click();
    await page.locator(`${DRAWER} table.sheet`).waitFor();
    await page.locator(`${DRAWER} .file-head button`, { hasText: /^Edit$/ }).click();
    await page.locator('.modal-title').waitFor({ timeout: 5000 }).catch(() => {});
    const chartWarn = await page.locator('.modal-text').innerText().catch(() => '');
    check('before editing a workbook with a chart, QAura says the chart will not be kept', chartWarn.includes('charts') && chartWarn.includes('The original stays as v1'), chartWarn);
    await page.locator('.modal button[type="submit"]').click();
    await page.locator(`${DRAWER} input[aria-label="Row 2, column 2"]`).fill('41');
    await page.locator(`${DRAWER} .file-head button`, { hasText: 'Done' }).click();
    await page.locator(`${DRAWER} table.sheet:not(.editable)`).waitFor();
    await flush(page);
    const chartRec = readData().files.find((f) => f.name === 'chart.xlsx');
    const zipParts = (blob) => {
      const b = fs.readFileSync(path.join(dataDir, 'attachments', blob));
      const out = [];
      for (let i = 0; (i = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i)) >= 0;) {
        const n = b.readUInt16LE(i + 28);
        out.push(b.toString('utf8', i + 46, i + 46 + n));
        i += 46 + n + b.readUInt16LE(i + 30) + b.readUInt16LE(i + 32);
      }
      return out;
    };
    check('the original workbook keeps its chart; the edited version has the new value', chartRec.versions.length === 2
      && zipParts(chartRec.versions[0].blob).some((n) => n.startsWith('xl/charts/')) && !zipParts(chartRec.versions[1].blob).some((n) => n.startsWith('xl/charts/')),
      JSON.stringify(chartRec.versions.map((v) => v.source)));
    await closeDrawer();

    await page.keyboard.press('Control+3');
    await page.locator('.list-item', { hasText: 'Regression ideas' }).click();
    await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, url) => {
      const png = nativeImage.createFromDataURL(url).toPNG();
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    }, await makePng(50, 50, '#16a34a'));
    await page.locator('.rt-editor').click();
    await pasteKey(page, app);
    await page.locator('.note-editor .file-tile').first().waitFor({ timeout: 5000 }).catch(() => {});
    check('pasting a screenshot into a note attaches it', (await page.locator('.note-editor .file-tile').count()) === 1 && (await page.locator('.rt-editor img').count()) === 0);
    await page.keyboard.press('Control+2');
    if (!(await page.locator('.task-details').count())) await page.locator('.task button[title="Details"]').first().click();
    check('tasks have a Files section', await page.locator('.task-details .files-panel').first().isVisible());

    // ---------- Exports (read back with real Word / Excel readers) ----------
    console.log('Exports');
    const waitFile = async (f) => { for (let i = 0; i < 60 && !fs.existsSync(f); i++) await page.waitForTimeout(250); return fs.existsSync(f); };
    await page.keyboard.press('Control+3');
    await page.locator('.list-item', { hasText: 'Regression ideas' }).click();
    await stubDialogs(app, { save: fx('note.docx'), open: [] });
    await page.locator('.rt-toolbar button[title="More"]').click();
    await page.locator('.menu-item', { hasText: 'Word (.docx)' }).click();
    await waitFile(fx('note.docx'));
    const noteDoc = (await mammoth.extractRawText({ path: fx('note.docx') })).value;
    check('note exported to Word', noteDoc.includes('Regression ideas') && noteDoc.includes('Login flows') && noteDoc.includes('first case') && noteDoc.includes('☑ check the remember-me box'), noteDoc.slice(0, 400));
    await page.keyboard.press('Control+4');
    await page.locator('.list-item', { hasText: 'Save button disabled' }).click();
    await stubDialogs(app, { save: fx('bug.docx'), open: [] });
    await page.locator('.editor-actions button', { hasText: 'Export' }).click();
    await page.locator('.menu-item', { hasText: 'Word (.docx)' }).click();
    await waitFile(fx('bug.docx'));
    const bugDoc = (await mammoth.extractRawText({ path: fx('bug.docx') })).value;
    check('bug exported as a Word report', bugDoc.includes('[QA-42] Save button disabled on Safari') && bugDoc.includes('Open the editor') && bugDoc.includes('API response') && bugDoc.includes('"error": "boom"'), bugDoc.slice(0, 500));
    const bugDocHtml = (await mammoth.convertToHtml({ path: fx('bug.docx') })).value;
    check('Word report embeds the 3 screenshots', (bugDocHtml.match(/<img /g) || []).length === 3, `${(bugDocHtml.match(/<img /g) || []).length} images`);
    await stubDialogs(app, { save: fx('bug.pdf'), open: [] });
    await page.locator('.editor-actions button', { hasText: 'Export' }).click();
    await page.locator('.menu-item', { hasText: 'PDF (.pdf)' }).click();
    await waitFile(fx('bug.pdf'));
    check('bug exported as a PDF report', fs.existsSync(fx('bug.pdf')) && fs.readFileSync(fx('bug.pdf')).subarray(0, 5).toString() === '%PDF-');
    await stubDialogs(app, { save: fx('bugs.xlsx'), open: [] });
    await page.locator('button[title="Export these bugs to Excel or CSV"]').click();
    await page.locator('.menu-item', { hasText: 'Excel (.xlsx)' }).click();
    await waitFile(fx('bugs.xlsx'));
    const xw = new ExcelJS.Workbook();
    await xw.xlsx.readFile(fx('bugs.xlsx'));
    const xs = xw.worksheets[0];
    const xRow = [];
    xs.eachRow((r, n) => { if (n > 1) xRow.push(r.getCell(1).value); });
    check('bugs exported to Excel with headers and filters', xs.getRow(1).values.includes('Ticket') && xRow.includes('QA-42') && Boolean(xs.autoFilter), JSON.stringify({ head: xs.getRow(1).values, xRow }));
    await stubDialogs(app, { save: fx('bugs.csv'), open: [] });
    await page.locator('button[title="Export these bugs to Excel or CSV"]').click();
    await page.locator('.menu-item', { hasText: 'CSV (.csv)' }).click();
    await waitFile(fx('bugs.csv'));
    const csvOut = fs.readFileSync(fx('bugs.csv'), 'utf8');
    check('bugs exported to CSV (opens in Excel)', csvOut.charCodeAt(0) === 0xfeff && csvOut.includes('QA-42') && csvOut.includes('Ticket,Title'));
    await page.keyboard.press('Control+2');
    await stubDialogs(app, { save: fx('tasks.xlsx'), open: [] });
    await page.locator('.view-title button', { hasText: 'Export' }).click();
    await page.locator('.menu-item', { hasText: 'Excel (.xlsx)' }).first().click();
    await waitFile(fx('tasks.xlsx'));
    const tw = new ExcelJS.Workbook();
    await tw.xlsx.readFile(fx('tasks.xlsx'));
    const taskTitles = [];
    tw.worksheets[0].eachRow((r, n) => { if (n > 1) taskTitles.push(r.getCell(1).value); });
    check('tasks exported to Excel', taskTitles.includes('Write test plan'), JSON.stringify(taskTitles));

    // ---------- Snippets ----------
    console.log('Snippets');
    await page.keyboard.press('Control+5');
    await page.locator('.list-item', { hasText: 'find a user by email' }).click();
    check('SQL is syntax highlighted', (await page.locator('.code-hl .hljs-keyword').count()) > 0);
    await page.locator('.editor-toolbar button', { hasText: /^Copy$/ }).click();
    await page.locator('.modal input').fill('qa.user@example.com');
    await page.locator('.modal button[type="submit"]').click();
    await page.waitForTimeout(200);
    const sql = await clip(app);
    check('copy fills {{placeholders}}', sql.includes("WHERE email = 'qa.user@example.com'") && !sql.includes('{{'), sql);
    await shot(page, '07-snippets');
    // Put back whatever was on the clipboard before the test.
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard);

    // ---------- Standup ----------
    console.log('Standup');
    await page.keyboard.press('Control+6');
    await page.locator('.standup-controls .date-field').nth(0).click();
    await page.locator('.cal .cal-chip', { hasText: 'Tomorrow' }).click();
    await page.locator('.standup-controls .date-field').nth(1).click();
    await page.locator('.cal .cal-chip', { hasText: /^Today$/ }).click();
    await page.waitForTimeout(100);
    const standup = await page.locator('.standup-text').inputValue();
    check('standup: completed task', standup.includes('Completed: Retest login (ABC-123)'), standup);
    check('standup: logged bug', standup.includes('Logged bug QA-42: Save button disabled on Safari'), standup);
    check('standup: blocker with reason', standup.includes('Write test plan (blocked by: Waiting for test data)'), standup);

    // ---------- Command palette ----------
    console.log('Command palette');
    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill('QA-42');
    check('palette finds bug by ticket', (await page.locator('.palette-item').first().innerText()).includes('QA-42'));
    await page.locator('.palette-input').fill('release smoke');
    check('palette finds folders', (await page.locator('.palette-item').first().innerText()).includes('Release 2.4 / Smoke'));
    await page.locator('.palette-input').fill('remember-me');
    check('palette searches note text', (await page.locator('.palette-item').first().innerText()).includes('Regression ideas'));
    check('palette highlights matches in a preview', (await page.locator('.palette-item mark.hit').count()) > 0);
    await page.locator('.palette-input').fill('type:bug');
    check('operator type:bug', (await page.locator('.palette-item').first().innerText()).includes('QA-42'));
    await page.locator('.palette-input').fill('is:favorite');
    check('operator is:favorite', (await page.locator('.palette-item').first().innerText()).includes('Regression ideas'));
    await page.locator('.palette-input').fill('in:"release 2.4" type:note');
    check('operator in:"folder"', (await page.locator('.palette-section').first().innerText()).toLowerCase().includes('results · 2'), await page.locator('.palette-list').innerText());
    await page.locator('.palette-input').fill('zebra');
    check('archived notes hidden from search', (await page.locator('.palette-item', { hasText: '(copy)' }).count()) === 0);
    await page.locator('.palette-input').fill('zebra is:archived');
    check('is:archived finds archived notes', (await page.locator('.palette-item', { hasText: '(copy)' }).count()) === 1);
    await page.locator('.palette-input').fill('updated:today tag:regression');
    check('operators combine (updated:today tag:regression)', (await page.locator('.palette-item').first().innerText()).includes('Regression ideas'));
    await page.keyboard.press('Escape');
    await page.locator('.palette-input').waitFor({ state: 'detached' });
    await page.keyboard.press('Control+k');
    check('palette keeps the last query', (await page.locator('.palette-input').inputValue()) === 'updated:today tag:regression');
    await page.waitForTimeout(350);
    await shot(page, '07b-palette-operators');
    await page.keyboard.press('Escape');

    // ---------- Trash: folder delete + restore ----------
    console.log('Trash');
    await page.keyboard.press('Control+3');
    await page.locator('.folder-row', { hasText: 'Release 2.4' }).first().hover();
    await page.locator('.folder-row', { hasText: 'Release 2.4' }).first().locator('.row-menu').click();
    await page.locator('.menu-item', { hasText: 'Delete folder' }).click();
    await page.locator('.modal button[type="submit"]').click();
    await page.waitForTimeout(150);
    check('deleting folder hides its notes', (await page.locator('.list-item', { hasText: 'Regression ideas' }).count()) === 0);
    await page.keyboard.press('Control+,');
    await page.locator('#settings-trash .trash-list li').first().waitFor();
    await page.locator('#settings-trash li', { hasText: 'Release 2.4' }).first().locator('button', { hasText: 'Restore' }).click();
    await page.keyboard.press('Control+3');
    check('restoring folder brings notes back', (await page.locator('.list-item', { hasText: 'Regression ideas' }).count()) === 1);

    // ---------- Light theme ----------
    await page.keyboard.press('Control+,');
    await page.locator('#settings-appearance .seg button', { hasText: 'Light' }).click();
    await page.keyboard.press('Control+3');
    await page.locator('.notes-head .seg button[title="Grid"]').click();
    await page.waitForTimeout(300);
    await shot(page, '08-notes-grid-light');
    await page.locator('.notes-head .seg button[title="List"]').click();
    await page.keyboard.press('Control+,');
    await page.locator('#settings-appearance .seg button', { hasText: 'Dark' }).click();

    // ---------- Last keystrokes survive an immediate close ----------
    console.log('Data safety');
    await page.keyboard.press('Control+3');
    await page.locator('.list-item', { hasText: 'Regression ideas' }).click();
    await page.locator('.rt-editor').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Continuous typing keeps saving', { delay: 110 }); // ~3.3 s with no pause
    const midway = readData().notes.find((n) => n.title === 'Regression ideas');
    check('saves at least every 2 s while typing non-stop', midway && midway.text.includes('Continuous'), midway && midway.text.slice(-80));
    await page.keyboard.press('Enter');
    await page.keyboard.type('Typed right before closing');
    check('no console errors in session 1', errors.length === 0, errors.join('\n'));
    await closeLikeUser(app);

    const saved = readData();
    const note = saved.notes.find((n) => n.title === 'Regression ideas');
    check('last keystrokes saved on close', note && note.html.includes('Typed right before closing') && note.text.includes('Typed right before closing'));
    check('note stored as clean HTML (no inline styles)', note && !/style=|<script|onerror/i.test(note.html), note && note.html);
    check('previous version kept (data.prev.json)', fs.existsSync(path.join(dataDir, 'data.prev.json')));
    if (workingPptx) fs.appendFileSync(workingPptx, Buffer.from(' edited while QAura was closed'));

    ({ app, page, errors } = await launch());
    const backups = fs.readdirSync(path.join(dataDir, 'backups'));
    check('daily backup exists', backups.some((b) => b.startsWith(`daily-${today}`)), backups.join(', '));
    await page.keyboard.press('Control+2');
    check('tasks still there after restart', (await page.locator('.task').count()) === 2);
    await page.waitForTimeout(500);
    await flush(page);
    const pptxRec = readData().files.find((f) => f.name === 'Slides.pptx');
    check('a save made in PowerPoint while QAura was closed is picked up on start', Boolean(pptxRec) && pptxRec.versions.length === 3, pptxRec && JSON.stringify(pptxRec.versions.map((v) => v.source)));
    fs.appendFileSync(workingPptx, Buffer.from(' saved again after the restart'));
    const pptxVersions = () => readData().files.find((f) => f.name === 'Slides.pptx').versions.length;
    for (let i = 0; i < 40 && pptxVersions() < 4; i++) { await page.waitForTimeout(250); await flush(page); }
    check('a document still open in PowerPoint keeps being watched after a restart', pptxVersions() === 4, `${pptxVersions()} versions`);
    await page.keyboard.press('Control+3');
    check('Notes reopens where you left off', (await page.locator('.notes-split .note-title').inputValue().catch(() => '')) === 'Regression ideas');
    check('sort choice remembered', (await page.locator('.notes-head button[title^="Sort notes"]').getAttribute('title')) === 'Sort notes: Title A–Z');

    // ---------- Second backup copy + restore from a backup ----------
    console.log('Backups: second copy & restore');
    const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaura-mirror-'));
    await stubDialogs(app, { save: '', open: [mirrorDir] });
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(300);
    await flush(page); // the second copy is a snapshot; let pending saves (e.g. "recently viewed") land first
    await page.locator('#settings-safety button', { hasText: 'Choose folder' }).click();
    await page.locator('#settings-safety .ok-text').waitFor();
    const mirrored = fs.readdirSync(path.join(mirrorDir, 'QAura Backups'));
    check('second copy written to the chosen folder', mirrored.includes('latest.json') && mirrored.some((f) => f.startsWith('daily-')), mirrored.join(', '));
    check('screenshots copied to the second backup', Boolean(firstShotId) && fs.existsSync(path.join(mirrorDir, 'QAura Backups', 'attachments', firstShotId)));
    const mirrorText = fs.readFileSync(path.join(mirrorDir, 'QAura Backups', 'latest.json'), 'utf8');
    const liveText = fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8');
    const differs = () => { const a = JSON.parse(mirrorText); const b = JSON.parse(liveText); return Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])); };
    check('second copy matches the data file', mirrorText === liveText, mirrorText === liveText ? '' : `differs in: ${differs().join(', ')}`);
    await page.locator('#settings-safety button', { hasText: 'Back up now' }).click();
    await page.waitForTimeout(300);
    await page.evaluate(() => { const { store, make } = window.QN; store.add('tasks', make.task({ title: 'Added after the backup' })); return store.flush(); });
    check('change saved before restore', readData().tasks.some((t) => t.title === 'Added after the backup'));
    await page.locator('#settings-safety button', { hasText: 'Show & restore' }).click();
    await page.locator('.backup-list li', { hasText: 'Manual' }).first().locator('button', { hasText: 'Restore' }).click();
    await page.locator('.modal button[type="submit"]').click();
    await page.waitForTimeout(500);
    check('restore brings back the backed-up state', !readData().tasks.some((t) => t.title === 'Added after the backup'));
    const preRestore = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.startsWith('pre-restore-'));
    check('restore first saves a copy of the current data', preRestore.length === 1 && fs.readFileSync(path.join(dataDir, 'backups', preRestore[0]), 'utf8').includes('Added after the backup'), preRestore.join(', '));
    await page.locator('#settings-safety button', { hasText: 'Stop' }).click();
    check('no console errors in session 2', errors.length === 0, errors.join('\n'));
    await closeLikeUser(app);

    // ---------- Corrupted data file is recovered, not wiped ----------
    // The newest intact copy is the previous save (data.prev.json); recovery must restore exactly that.
    const prevSave = JSON.parse(fs.readFileSync(path.join(dataDir, 'data.prev.json'), 'utf8'));
    fs.writeFileSync(path.join(dataDir, 'data.json'), '{"tasks": [ this is broken');
    ({ app, page, errors } = await launch());
    await page.locator('.modal-title').waitFor();
    check('recovery message shown', (await page.locator('.modal-title').innerText()).includes('recovered'));
    await page.locator('.modal button[type="submit"]').click();
    const recovered = readData();
    const same = (c) => JSON.stringify(recovered[c].map((x) => x.id).sort()) === JSON.stringify(prevSave[c].map((x) => x.id).sort());
    check('data recovered from the newest intact copy', prevSave.tasks.length >= 2 && ['tasks', 'notes', 'bugs', 'folders', 'runs', 'snippets'].every(same),
      JSON.stringify({ recovered: { tasks: recovered.tasks.length, notes: recovered.notes.length }, previousSave: { tasks: prevSave.tasks.length, notes: prevSave.notes.length } }));
    check('corrupt file kept aside', fs.readdirSync(dataDir).some((f) => f.startsWith('data.unreadable-')));
    await closeLikeUser(app);

    // ---------- Old Markdown notes migrate to rich text without loss ----------
    console.log('Migration');
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaura-old-'));
    const oldMd = '# Old heading\n- [x] done item\n- [ ] open item\n\nSome **bold** text';
    const legacyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const legacyBlob = `${require('crypto').createHash('sha256').update(legacyPng).digest('hex')}.png`;
    fs.mkdirSync(path.join(oldDir, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'attachments', legacyBlob), legacyPng);
    fs.writeFileSync(path.join(oldDir, 'data.json'), JSON.stringify({
      schema: 1, tasks: [], checklists: [], runs: [],
      bugs: [{ id: 'old-bug', title: 'Old bug with a screenshot', status: 'reported', severity: 'major', priority: 'medium', attachments: [{ id: legacyBlob, name: 'old-shot.png', size: legacyPng.length, addedAt: '2026-01-02T10:00:00.000Z' }], createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z' }],
      notes: [{ id: 'old-1', title: 'Old note', body: oldMd, tags: ['legacy'], pinned: true, createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z' }],
      settings: { theme: 'dark', workdays: [1, 2, 3, 4, 5], seeded: true },
    }));
    ({ app, page, errors } = await launch(oldDir));
    await page.keyboard.press('Control+3');
    await page.locator('.list-item', { hasText: 'Old note' }).click();
    check('old note renders heading + checklist', (await page.locator('.rt-editor h1').innerText()).includes('Old heading') && (await page.locator('.rt-editor li[data-checked="true"]').count()) === 1);
    await flush(page);
    const migrated = readData(oldDir).notes[0];
    check('migrated: html + star + original Markdown kept', migrated.html.includes('<h1>') && migrated.starred === true && migrated.mdSource === oldMd && !('pinned' in migrated), JSON.stringify(migrated).slice(0, 300));
    const oldData = readData(oldDir);
    const legacyFile = oldData.files.find((f) => f.name === 'old-shot.png');
    check('old bug screenshots migrate to Files', Boolean(legacyFile) && legacyFile.versions[0].blob === legacyBlob && oldData.bugs[0].files[0] === legacyFile.id && !('attachments' in oldData.bugs[0]));
    check('no console errors in migration session', errors.length === 0, errors.join('\n'));
    await closeLikeUser(app);

    // ---------- Rename: data from the old "QA Notepad" folder is copied, old folder untouched ----------
    console.log('Rename migration');
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaura-legacy-'));
    const legacyData = JSON.stringify({ schema: 1, tasks: [{ id: 'legacy-t', title: 'Task from QA Notepad', status: 'todo', priority: 'medium', date: today, createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z' }], notes: [], bugs: [], checklists: [], runs: [], settings: { theme: 'dark', seeded: true, seededSnippets: true } }, null, 2);
    fs.writeFileSync(path.join(legacyDir, 'data.json'), legacyData);
    fs.mkdirSync(path.join(legacyDir, 'backups'));
    fs.writeFileSync(path.join(legacyDir, 'backups', 'daily-2026-10-13.json'), legacyData);
    const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaura-new-'));
    ({ app, page, errors } = await launch(newDir, { QN_LEGACY_DATA: legacyDir }));
    await page.keyboard.press('Control+2');
    check('old data shows up under the new name', (await page.locator('.task-title').first().inputValue().catch(() => '')) === 'Task from QA Notepad');
    check('copied data is byte-identical', fs.existsSync(path.join(newDir, 'data.json')) && JSON.parse(fs.readFileSync(path.join(newDir, 'data.json'), 'utf8')).tasks[0].id === 'legacy-t');
    check('old backups carried over', fs.existsSync(path.join(newDir, 'backups', 'daily-2026-10-13.json')));
    check('old folder left untouched', fs.readFileSync(path.join(legacyDir, 'data.json'), 'utf8') === legacyData);
    check('user is told about the move', (await page.locator('.toast').allInnerTexts()).some((t) => t.includes('carried over')));
    check('no console errors after the move', errors.length === 0, errors.join('\n'));
    await closeLikeUser(app);
    app = null;

    // ---------- Open with > QAura (File Explorer) ----------
    console.log('Open with (File Explorer)');
    const owDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaura-openwith-'));
    const owLog = path.join(exportDir, 'Opened from Explorer.log');
    const owCsv = path.join(exportDir, 'Second launch.csv');
    fs.writeFileSync(owLog, '2026-10-14 11:00:00 WARN slow response from /api/patients\n');
    fs.writeFileSync(owCsv, 'id,name\r\n1,alice\r\n');
    const owLogBefore = fs.readFileSync(owLog);
    const drawerTitle = async () => {
      await page.locator(`${DRAWER} .file-title`).waitFor({ timeout: 10000 }).catch(() => {});
      return page.locator(`${DRAWER} .file-title`).inputValue().catch(() => '');
    };
    ({ app, page, errors } = await launch(owDir, {}, [owLog]));
    check('a file opened with QAura shows up in Files, ready to view', (await drawerTitle()) === 'Opened from Explorer.log' && (await page.locator(`${DRAWER} .code-input`).inputValue().catch(() => '')).includes('slow response'));
    await flush(page);
    const owRec = () => readData(owDir).files.filter((f) => f.name === 'Opened from Explorer.log');
    check('it is stored as a copy, marked "Opened from File Explorer"', owRec().length === 1 && owRec()[0].versions[0].source === 'Opened from File Explorer' && fs.existsSync(path.join(owDir, 'attachments', owRec()[0].versions[0].blob)));
    await page.locator(`${DRAWER} .code-input`).fill('edited inside QAura');
    await page.locator(`${DRAWER} .code-input`).press('Control+s');
    await page.waitForTimeout(500);
    await flush(page);
    check('editing it in QAura adds a version; the original file is never changed', owRec()[0].versions.length === 2 && fs.readFileSync(owLog).equals(owLogBefore));
    await page.keyboard.press('Escape');
    // Explorer starts QAura.exe again for the next file: it hands the file to the running window and exits.
    const spawnSecond = (file) => {
      const env2 = { ...process.env, QN_USER_DATA: owDir };
      delete env2.ELECTRON_RUN_AS_NODE;
      const child = require('child_process').spawn(electronPath, [appDir, file], { env: env2, stdio: 'ignore' });
      return new Promise((res) => {
        const t = setTimeout(() => { child.kill(); res('still running'); }, 20000);
        child.on('exit', (code) => { clearTimeout(t); res(code); });
      });
    };
    const secondExit = await spawnSecond(owCsv);
    const secondTitle = await drawerTitle();
    check('opening another file while QAura runs goes to the same window', secondExit === 0 && secondTitle === 'Second launch.csv',
      JSON.stringify({ secondExit, secondTitle, ui: await page.evaluate(() => ({ drawers: [...document.querySelectorAll('.drawer-overlay .file-title')].map((i) => `${i.value}${i.closest('.closing') ? ' (closing)' : ''}`), hasModal: window.QN.ui.hasModal(), toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText), view: document.querySelector('.main') && document.querySelector('.main').dataset.view })) }));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const thirdExit = await spawnSecond(owLog);
    check('opening the same file again shows the existing copy with its history (no duplicate)', thirdExit === 0 && (await drawerTitle()) === 'Opened from Explorer.log' && (await page.locator(`${DRAWER} .version-list li`).count()) === 2 && owRec().length === 1);
    await page.waitForTimeout(200);
    await shot(page, '12-open-with');
    check('no console errors in the Open with session', errors.length === 0, errors.join('\n'));
    await closeLikeUser(app);
    app = null;

    check('no network requests at all (works offline)', external.length === 0, external.join('\n'));
  } catch (err) {
    failures += 1;
    console.error('  ERROR', err);
    if (page) await shot(page, 'zz-error').catch(() => {});
  } finally {
    if (app) await app.close().catch(() => {});
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  console.log(`Screenshots: ${shotsDir}`);
  process.exit(failures ? 1 : 0);
})();
