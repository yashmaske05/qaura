'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, ClipboardItem, Menu, nativeTheme, screen, protocol, net, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { execFileSync, spawn } = require('child_process');

// Screenshots are shown in the page through this private, read-only scheme (qa-att://img/<id>).
protocol.registerSchemesAsPrivileged([{ scheme: 'qa-att', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// Tests point the app at a throwaway folder so they never touch real data.
if (process.env.QN_USER_DATA) app.setPath('userData', path.resolve(process.env.QN_USER_DATA));

const COLLECTIONS = ['tasks', 'notes', 'bugs', 'checklists', 'runs', 'folders', 'snippets', 'noteTemplates', 'files'];
const KEEP = { daily: 90, rolling: 40, safety: 40 };
const AUTO_BACKUP_MS = 30 * 60 * 1000;
const BACKUP_RE = /^(daily|launch|auto|manual|safety|pre-import|pre-restore)-[\d_-]+\.json$/;
const THEMES = ['dark', 'light', 'system'];
const DARK_BG = '#0b0d12';
const LIGHT_BG = '#f4f5f8';

let win = null;
let lastText = null; // exactly what is in data.json right now
let readOnly = false; // set when existing data could not be read safely
let changedSinceBackup = false;
let mirrorStatus = null;

const paths = {
  dir: () => app.getPath('userData'),
  data: () => path.join(paths.dir(), 'data.json'),
  prev: () => path.join(paths.dir(), 'data.prev.json'),
  config: () => path.join(paths.dir(), 'config.json'),
  backups: () => path.join(paths.dir(), 'backups'),
  attachments: () => path.join(paths.dir(), 'attachments'),
  working: () => path.join(paths.dir(), 'working'),
};

// ---------- small helpers ----------

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d = new Date()) => `${localDate(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* wait */ }
  }
}

// Write to a temp file, flush it to disk, then swap it in. A crash mid-write
// can never leave a half-written data file behind.
function writeDurable(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Antivirus or OneDrive can hold a file for a moment on Windows.
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(60 * (attempt + 1));
    }
  }
}

function isValidData(d) {
  return d && typeof d === 'object' && !Array.isArray(d) &&
    COLLECTIONS.every((c) => d[c] === undefined || Array.isArray(d[c]));
}

function countsOf(d) {
  const counts = {};
  for (const c of COLLECTIONS) counts[c] = Array.isArray(d[c]) ? d[c].length : 0;
  return counts;
}

const totalOf = (d) => Object.values(countsOf(d)).reduce((a, b) => a + b, 0);

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(text);
  if (!isValidData(data)) throw new Error('Unexpected data format');
  return { text, data };
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths.config(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(paths.dir(), { recursive: true });
    writeDurable(paths.config(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('Could not write config', err);
  }
  return cfg;
}

// ---------- backups ----------

function listBackupFiles(dir = paths.backups()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => BACKUP_RE.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, kind: name.match(/^([a-z-]+?)-\d/)[1], size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

const groupOf = (kind) => (kind === 'daily' ? 'daily' : kind === 'launch' || kind === 'auto' ? 'rolling' : 'safety');

function prune(dir = paths.backups()) {
  const seen = { daily: 0, rolling: 0, safety: 0 };
  for (const f of listBackupFiles(dir)) {
    const g = groupOf(f.kind);
    seen[g] += 1;
    if (seen[g] > KEEP[g]) {
      try { fs.unlinkSync(path.join(dir, f.name)); } catch { /* keep going */ }
    }
  }
}

function snapshot(kind, text = lastText) {
  if (!text) return null;
  fs.mkdirSync(paths.backups(), { recursive: true });
  let name = `${kind}-${stamp()}.json`;
  if (fs.existsSync(path.join(paths.backups(), name))) name = `${kind}-${stamp()}-${Date.now() % 1000}.json`;
  writeDurable(path.join(paths.backups(), name), text);
  prune();
  return name;
}

function dailyBackup() {
  if (!lastText) return;
  const file = path.join(paths.backups(), `daily-${localDate()}.json`);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(paths.backups(), { recursive: true });
  writeDurable(file, lastText);
  prune();
}

function launchSnapshot() {
  if (!lastText) return;
  const newest = listBackupFiles().find((f) => groupOf(f.kind) === 'rolling');
  if (newest) {
    try {
      if (fs.readFileSync(path.join(paths.backups(), newest.name), 'utf8') === lastText) return;
    } catch { /* take a fresh one */ }
  }
  snapshot('launch');
}

// Optional second copy (e.g. a OneDrive folder) so data survives losing this laptop.
function mirrorNow() {
  const { mirrorDir } = readConfig();
  if (!mirrorDir) {
    mirrorStatus = null;
    return;
  }
  try {
    const target = path.join(mirrorDir, 'QAura Backups');
    fs.mkdirSync(target, { recursive: true });
    if (lastText) writeDurable(path.join(target, 'latest.json'), lastText);
    for (const f of listBackupFiles()) {
      const dest = path.join(target, f.name);
      if (f.kind === 'daily' && !fs.existsSync(dest)) fs.copyFileSync(path.join(paths.backups(), f.name), dest);
    }
    prune(target);
    copyAttachments(paths.attachments(), path.join(target, 'attachments'));
    mirrorStatus = { ok: true, at: Date.now() };
  } catch (err) {
    mirrorStatus = { ok: false, at: Date.now(), error: err.message };
  }
}

function periodicBackup() {
  try {
    dailyBackup();
    if (changedSinceBackup) {
      snapshot('auto');
      changedSinceBackup = false;
      mirrorNow();
    }
  } catch (err) {
    console.error('Periodic backup failed', err);
  }
}

// ---------- one-time move from the old name ("QA Notepad") ----------

let migrationNotice = '';

// Copies (never moves) the old data folder's files into the new one. The old folder is left
// untouched as an extra safety copy. Runs only when the new folder has no data yet.
function migrateLegacyData() {
  if (fs.existsSync(paths.data())) return;
  const legacyDirs = process.env.QN_USER_DATA
    ? (process.env.QN_LEGACY_DATA ? [path.resolve(process.env.QN_LEGACY_DATA)] : [])
    : [path.join(app.getPath('appData'), 'QA Notepad')];
  for (const oldDir of legacyDirs) {
    const oldData = path.join(oldDir, 'data.json');
    if (!fs.existsSync(oldData)) continue;
    fs.mkdirSync(paths.dir(), { recursive: true });
    for (const f of ['data.json', 'data.prev.json', 'config.json']) {
      const src = path.join(oldDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(paths.dir(), f));
    }
    const oldBackups = path.join(oldDir, 'backups');
    if (fs.existsSync(oldBackups)) {
      fs.mkdirSync(paths.backups(), { recursive: true });
      for (const f of fs.readdirSync(oldBackups)) {
        const dest = path.join(paths.backups(), f);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(oldBackups, f), dest);
      }
    }
    if (!fs.readFileSync(oldData).equals(fs.readFileSync(paths.data()))) {
      fs.unlinkSync(paths.data());
      throw new Error(`Copying your data from ${oldDir} did not verify, so nothing was changed.`);
    }
    writeConfig({ migratedFrom: oldDir, migratedAt: new Date().toISOString() });
    migrationNotice = `Your data was carried over from the old "QA Notepad" folder. The original stays untouched at ${oldDir}.`;
    return;
  }
}

// ---------- load / save ----------

function loadData() {
  try {
    migrateLegacyData();
  } catch (err) {
    readOnly = true;
    return { data: null, error: err.message };
  }
  const res = loadDataInner();
  if (migrationNotice && res.data) res.notice = migrationNotice;
  return res;
}

function loadDataInner() {
  const dataFile = paths.data();
  const exists = fs.existsSync(dataFile);
  if (exists) {
    try {
      const { text, data } = readJson(dataFile);
      lastText = text;
      afterLoad();
      return { data };
    } catch { /* fall through to recovery */ }
  }

  // Main file missing or unreadable: try the previous save, then backups, newest first.
  const candidates = [
    { file: paths.prev(), label: 'the previous save' },
    ...listBackupFiles().map((f) => ({ file: path.join(paths.backups(), f.name), label: `backup "${f.name}"` })),
  ].filter((c) => fs.existsSync(c.file));

  if (!exists && !candidates.length) return { data: null, firstRun: true };

  for (const c of candidates) {
    try {
      const { text, data } = readJson(c.file);
      let kept = '';
      if (exists) {
        const aside = path.join(paths.dir(), `data.unreadable-${stamp()}.json`);
        fs.renameSync(dataFile, aside);
        kept = ` The unreadable file was kept as "${path.basename(aside)}" in the data folder.`;
      }
      writeDurable(dataFile, text);
      lastText = text;
      afterLoad();
      return {
        data,
        warning: `Your main data file ${exists ? 'could not be read' : 'was missing'}, so it was restored from ${c.label}.${kept} Please check that your most recent changes are there.`,
      };
    } catch { /* try the next one */ }
  }

  readOnly = true;
  return {
    data: null,
    error: `Your data file could not be read and no usable backup was found. Nothing was changed or overwritten. The app stays read-only until this is fixed. Data folder: ${paths.dir()}`,
  };
}

function afterLoad() {
  try {
    dailyBackup();
    launchSnapshot();
    mirrorNow();
  } catch (err) {
    console.error('Startup backup failed', err);
  }
}

function saveData(text) {
  if (readOnly) throw new Error('Read-only mode: your data could not be loaded safely, so saving is disabled.');
  if (typeof text !== 'string') throw new Error('Invalid data');
  const data = JSON.parse(text);
  if (!isValidData(data)) throw new Error('Refusing to save data in an unexpected format');
  if (text === lastText) return { ok: true, unchanged: true };

  fs.mkdirSync(paths.dir(), { recursive: true });
  const firstEver = !lastText;
  // The first change of a new day: keep the day's starting state as the daily backup.
  if (lastText) {
    try { dailyBackup(); } catch (err) { console.error('Daily backup failed', err); }
  }
  if (lastText) {
    // If a save suddenly drops a lot of items, keep a copy of what was there first.
    try {
      const before = totalOf(JSON.parse(lastText));
      if (before >= 5 && totalOf(data) < before * 0.6) snapshot('safety', lastText);
    } catch { /* not fatal */ }
    writeDurable(paths.prev(), lastText);
  }
  writeDurable(paths.data(), text);
  lastText = text;
  changedSinceBackup = true;
  if (firstEver) {
    try { dailyBackup(); } catch (err) { console.error('Daily backup failed', err); } // back up brand-new data straight away
  }
  return { ok: true };
}

// ---------- file store ----------
// Every file (screenshot, PDF, Word, Excel, CSV, log, video…) is stored once in attachments\ under
// its SHA-256, e.g. <hash>.docx. Stored files are never changed or deleted, so every version and every
// backup keeps working. Editing in Word/Excel happens on a separate "working copy" that QAura watches:
// each save there becomes a new version.

const FILE_TYPES = {
  png: 'image', jpg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  mp4: 'video', webm: 'video',
  pdf: 'pdf', docx: 'word', xlsx: 'excel', csv: 'csv', pptx: 'powerpoint',
  txt: 'text', log: 'text', json: 'text', xml: 'text', har: 'text', yaml: 'text', yml: 'text', sql: 'text', md: 'text',
};
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8', har: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8', md: 'text/markdown; charset=utf-8',
};
const BLOB_RE = new RegExp(`^[a-f0-9]{64}\\.(${Object.keys(FILE_TYPES).join('|')})$`);
const MAX_FILE = 100 * 1024 * 1024;
const MAX_TEXT = 5 * 1024 * 1024;
const SUPPORTED = 'images, MP4/WebM, PDF, DOCX, XLSX, CSV, PPTX, TXT, LOG, JSON, XML, HAR, YAML, SQL, MD';

const normExt = (name) => {
  const e = path.extname(String(name || '')).slice(1).toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function imageExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 2 && buf.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

// Check the bytes really are the claimed type (not just the file name).
function looksValid(buf, ext) {
  const kind = FILE_TYPES[ext];
  if (ext === 'mp4') return buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp';
  if (ext === 'webm') return buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  if (ext === 'pdf') return buf.toString('ascii', 0, 5) === '%PDF-';
  if (kind === 'word' || kind === 'excel' || kind === 'powerpoint') return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  if (kind === 'text' || kind === 'csv') return !buf.subarray(0, 65536).includes(0);
  return false;
}

function storeBytes(bytes, name) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.length) throw new Error('The file is empty.');
  if (buf.length > MAX_FILE) throw new Error('Files larger than 100 MB cannot be added.');
  let ext = normExt(name);
  const img = imageExt(buf);
  if (img && (!ext || FILE_TYPES[ext] === 'image')) ext = img; // trust the bytes for images
  if (!FILE_TYPES[ext]) throw new Error(`.${ext || 'unknown'} files are not supported. Supported: ${SUPPORTED}.`);
  if (FILE_TYPES[ext] !== 'image' && !looksValid(buf, ext)) throw new Error(`This does not look like a valid .${ext} file.`);
  const blob = `${sha256(buf)}.${ext}`;
  fs.mkdirSync(paths.attachments(), { recursive: true });
  const file = path.join(paths.attachments(), blob);
  if (!fs.existsSync(file)) writeDurable(file, buf);
  changedSinceBackup = true;
  return { blob, size: buf.length, ext, kind: FILE_TYPES[ext], name: path.basename(String(name || `file.${ext}`)) };
}

function blobFile(blob) {
  if (typeof blob !== 'string' || !BLOB_RE.test(blob)) throw new Error('Invalid file reference');
  const file = path.join(paths.attachments(), blob);
  if (!fs.existsSync(file)) throw new Error('This file is missing from the attachments folder.');
  return file;
}

function copyAttachments(fromDir, toDir) {
  let names = [];
  try { names = fs.readdirSync(fromDir).filter((n) => BLOB_RE.test(n)); } catch { return 0; }
  if (!names.length) return 0;
  fs.mkdirSync(toDir, { recursive: true });
  let copied = 0;
  for (const n of names) {
    const dest = path.join(toDir, n);
    if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(fromDir, n), dest); copied += 1; }
  }
  return copied;
}

function attachmentStats() {
  let count = 0;
  let bytes = 0;
  try {
    for (const n of fs.readdirSync(paths.attachments())) {
      if (!BLOB_RE.test(n)) continue;
      count += 1;
      bytes += fs.statSync(path.join(paths.attachments(), n)).size;
    }
  } catch { /* none yet */ }
  return { count, bytes };
}

// Serves stored files to the page (qa-att://f/<blob>), with byte ranges so videos can seek.
function serveBlob(request) {
  try {
    const blob = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
    const file = blobFile(blob);
    const size = fs.statSync(file).size;
    const type = MIME[normExt(blob)] || 'text/plain; charset=utf-8';
    const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      start = Math.min(start, size - 1);
      end = Math.min(Math.max(end, start), size - 1);
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------- files opened from File Explorer ("Open with > QAura") ----------

const openedFiles = []; // waiting for the window to take them
const filesFromArgs = (argv) => (Array.isArray(argv) ? argv.slice(1) : []).filter((a) => typeof a === 'string' && !a.startsWith('-') && path.isAbsolute(a));

function queueOpened(list) {
  for (const p of (Array.isArray(list) ? list : []).slice(0, 50)) {
    try {
      if (typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isFile() && !openedFiles.includes(p)) openedFiles.push(p);
    } catch { /* not a file */ }
  }
  if (openedFiles.length && win && !win.isDestroyed()) win.webContents.send('files:opened');
}

// ---------- working copies (edit in Word / Excel / any app; every save becomes a version) ----------

const watching = new Map(); // fileId -> { file, timer }

function workingDir(fileId) {
  if (typeof fileId !== 'string' || !/^[\w-]{6,64}$/.test(fileId)) throw new Error('Invalid file');
  return path.join(paths.working(), fileId);
}
function readSidecar(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.qaura.json'), 'utf8')); } catch { return null; }
}
function writeSidecar(dir, data) {
  writeDurable(path.join(dir, '.qaura.json'), JSON.stringify(data));
}

// If the working copy was saved since QAura last looked, store it as a new version.
function importWorkingChange(fileId) {
  const dir = workingDir(fileId);
  const side = readSidecar(dir);
  if (!side) return null;
  const file = path.join(dir, side.name);
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; } // missing or still locked: try again later
  if (!buf.length || `${sha256(buf)}.${normExt(side.name)}` === side.blob) return null;
  let stored;
  try { stored = storeBytes(buf, side.name); } catch (err) { console.error('Could not store edited file', err); return null; }
  writeSidecar(dir, { ...side, blob: stored.blob, syncedAt: new Date().toISOString() });
  return { fileId, blob: stored.blob, size: stored.size, app: true, appName: side.app || '' };
}

function notifyChange(change) {
  if (change && win && !win.isDestroyed()) win.webContents.send('files:changed', change);
}

function watchWorking(fileId, file) {
  if (watching.has(fileId)) fs.unwatchFile(watching.get(fileId).file);
  const entry = { file, timer: null };
  watching.set(fileId, entry);
  // Polling is reliable with Office's "write temp file, then rename" saves.
  fs.watchFile(file, { interval: 1000 }, () => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => notifyChange(importWorkingChange(fileId)), 1200);
  });
}

// appName: the app it is opened in (shown on the versions it saves).
function openWorkingCopy(fileId, blob, name, appName) {
  blobFile(blob); // validates the reference
  const dir = workingDir(fileId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = normExt(blob);
  const fname = `${safeName(String(name || 'file').replace(/\.[^.]+$/, ''))}.${ext}`;
  const pending = importWorkingChange(fileId); // never lose an unsynced save
  if (pending) {
    notifyChange(pending);
    blob = pending.blob; // that save is now the newest version; reopen it as it is
  }
  const side = readSidecar(dir);
  const file = path.join(dir, fname);
  if (!side || side.blob !== blob || side.name !== fname || !fs.existsSync(file)) {
    if (side && side.name !== fname && fs.existsSync(path.join(dir, side.name))) {
      try { fs.unlinkSync(path.join(dir, side.name)); } catch { /* still open elsewhere */ }
    }
    fs.copyFileSync(blobFile(blob), file);
    writeSidecar(dir, { name: fname, blob, syncedAt: new Date().toISOString() });
  }
  const current = readSidecar(dir);
  if (current && (current.app || '') !== (appName || '')) writeSidecar(dir, { ...current, app: appName || '' });
  watchWorking(fileId, file);
  return file;
}

// Desktop apps that edit Office files in place. QAura starts them directly, so the file opens in the
// real editor even when Windows sends that file type to another app (on some PCs, an online one).
const EDITORS = {
  word: [['Word', 'winword.exe'], ['LibreOffice', 'soffice.exe']],
  excel: [['Excel', 'excel.exe'], ['LibreOffice', 'soffice.exe']],
  csv: [['Excel', 'excel.exe'], ['LibreOffice', 'soffice.exe']],
  powerpoint: [['PowerPoint', 'powerpnt.exe'], ['LibreOffice', 'soffice.exe']],
};
const RUNDLL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');

// Where an app is installed, from Windows' "App Paths" registration (Office and LibreOffice register there).
function installedApp(exe) {
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
      const p = m && m[1].trim().replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (_, v) => process.env[v] || '');
      if (p && fs.existsSync(p)) return p;
    } catch { /* not registered in this hive */ }
  }
  if (exe === 'soffice.exe') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      const p = base && path.join(base, 'LibreOffice', 'program', 'soffice.exe');
      if (p && fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Kept on `app` so the automated tests can stand in for real apps.
app.qaura = {
  findEditor(kind) {
    for (const [name, exe] of EDITORS[kind] || []) {
      const p = installedApp(exe);
      if (p) return { name, path: p };
    }
    return null;
  },
  launch: (exe, args) => new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  }),
};

// A read-only copy for viewers (videos, images, PDFs) so other apps never touch the store.
function viewCopy(blob, name) {
  const source = blobFile(blob);
  const dir = path.join(paths.working(), 'view', blob.slice(0, 16));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(String(name || 'file').replace(/\.[^.]+$/, ''))}.${normExt(blob)}`);
  if (!fs.existsSync(file)) fs.copyFileSync(source, file);
  return file;
}

function openPdfViewer(blob, name) {
  const v = new BrowserWindow({
    width: 1000,
    height: 820,
    title: `${name || 'PDF'} — QAura`,
    show: !OFFSCREEN,
    autoHideMenuBar: true,
    backgroundColor: '#2a2a2e',
    icon: fs.existsSync(path.join(__dirname, 'build', 'icon.png')) ? path.join(__dirname, 'build', 'icon.png') : undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true },
  });
  v.setMenu(null);
  v.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  v.loadFile(viewCopy(blob, name));
}

// ---------- export helpers ----------

const EXPORT_EXT = { md: 'Markdown', txt: 'Text', html: 'HTML', docx: 'Word document', xlsx: 'Excel workbook', csv: 'CSV (Excel)' };
const exportData = (content) => (typeof content === 'string' ? content : Buffer.from(content));

// File-system-safe name: no path separators, reserved characters or "." / ".." tricks.
function safeName(s) {
  const clean = String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80);
  return clean || 'Untitled';
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

// Renders an HTML document to PDF in a hidden window with scripts disabled. Fully offline.
async function renderPdf(html) {
  const tmp = path.join(app.getPath('temp'), `qaura-export-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await w.loadFile(tmp);
    return await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally {
    w.destroy();
    fs.unlink(tmp, () => {});
  }
}

// ---------- window ----------

function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? DARK_BG : LIGHT_BG, symbolColor: dark ? '#c7cdd8' : '#3b4252', height: 40 };
}

function applyTheme() {
  if (!win || win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay(overlayColors());
    win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG);
  } catch { /* overlay not supported on this platform */ }
}

function onSomeDisplay(b) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80);
}

// Automated tests only: render in memory, so test runs never pop up on screen or stall when covered.
const OFFSCREEN = process.env.QN_OFFSCREEN === '1';

function createWindow() {
  const cfg = readConfig();
  const b = cfg.bounds || {};
  const opts = {
    width: b.width || 1320,
    height: b.height || 860,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'QAura',
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      offscreen: OFFSCREEN,
    },
  };
  if (Number.isFinite(b.x) && Number.isFinite(b.y) && onSomeDisplay({ ...b, width: opts.width })) {
    opts.x = b.x;
    opts.y = b.y;
  }
  const iconFile = path.join(__dirname, 'build', 'icon.png');
  if (fs.existsSync(iconFile)) opts.icon = iconFile;

  win = new BrowserWindow(opts);
  win.once('ready-to-show', () => {
    if (OFFSCREEN) return;
    if (cfg.maximized) win.maximize();
    win.show();
  });
  win.webContents.on('did-finish-load', () => {
    if (Number.isFinite(cfg.zoom)) win.webContents.setZoomLevel(cfg.zoom);
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.on('close', () => {
    writeConfig({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  });
  win.on('closed', () => { win = null; });

  // Links never navigate the app window; web links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    const zoomBy = (delta) => {
      const level = delta === 0 ? 0 : Math.max(-3, Math.min(4, win.webContents.getZoomLevel() + delta));
      win.webContents.setZoomLevel(level);
      writeConfig({ zoom: level });
      event.preventDefault();
    };
    if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (ctrl && (key === '=' || key === '+')) zoomBy(0.5);
    else if (ctrl && key === '-') zoomBy(-0.5);
    else if (ctrl && key === '0') zoomBy(0);
  });

  win.webContents.on('context-menu', (_event, params) => {
    const items = [];
    for (const s of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    }
    if (params.misspelledWord) {
      items.push(
        { label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
        { type: 'separator' },
      );
    }
    if (params.linkURL && /^https?:\/\//i.test(params.linkURL)) {
      items.push(
        { label: 'Open link in browser', click: () => shell.openExternal(params.linkURL) },
        { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    while (items.length && items[items.length - 1].type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || !win) return;
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'QAura hit a problem and will reload.',
      detail: `Everything saved before the problem is safe on disk. (${details.reason})`,
    }).then(() => win && win.reload());
  });
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('data:load', () => loadData());
  ipcMain.handle('data:save', (_e, text) => saveData(text));
  ipcMain.on('data:save-sync', (event, text) => {
    try {
      saveData(text);
      event.returnValue = { ok: true };
    } catch (err) {
      event.returnValue = { ok: false, error: err.message };
    }
  });

  ipcMain.handle('data:export', async (_e, text) => {
    JSON.parse(text);
    const r = await dialog.showSaveDialog(win, {
      title: 'Export QAura data (full backup)',
      defaultPath: path.join(app.getPath('documents'), `qaura-backup-${localDate()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    writeDurable(r.filePath, text);
    const attachmentsCopied = copyAttachments(paths.attachments(), `${r.filePath.replace(/\.json$/i, '')}-attachments`);
    return { path: r.filePath, attachments: attachmentsCopied };
  });

  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import QAura data',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const { text, data } = readJson(r.filePaths[0]);
    // Screenshots exported next to the file come along too (never overwriting existing ones).
    copyAttachments(`${r.filePaths[0].replace(/\.json$/i, '')}-attachments`, paths.attachments());
    return { text, path: r.filePaths[0], counts: countsOf(data) };
  });

  ipcMain.handle('backups:list', () =>
    listBackupFiles().map((f) => {
      let counts = null;
      try { counts = countsOf(readJson(path.join(paths.backups(), f.name)).data); } catch { /* unreadable */ }
      return { ...f, counts };
    }));

  ipcMain.handle('backups:read', (_e, name) => {
    if (typeof name !== 'string' || path.basename(name) !== name || !BACKUP_RE.test(name)) throw new Error('Invalid backup name');
    const { text, data } = readJson(path.join(paths.backups(), name));
    return { text, counts: countsOf(data) };
  });

  ipcMain.handle('backups:snapshot', (_e, kind) => {
    const name = snapshot(['manual', 'pre-import', 'pre-restore'].includes(kind) ? kind : 'manual');
    mirrorNow();
    return name;
  });

  ipcMain.handle('app:info', () => {
    const backups = listBackupFiles();
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      dataDir: paths.dir(),
      dataFile: paths.data(),
      backupsDir: paths.backups(),
      backupCount: backups.length,
      attachments: attachmentStats(),
      attachmentsDir: paths.attachments(),
      latestBackup: backups[0] || null,
      mirrorDir: readConfig().mirrorDir || '',
      mirrorStatus,
      readOnly,
    };
  });

  ipcMain.handle('app:open-path', (_e, which) => {
    const target = which === 'backups' ? paths.backups() : which === 'attachments' ? paths.attachments() : which === 'mirror' ? readConfig().mirrorDir : paths.dir();
    if (!target) return 'No folder set';
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });

  ipcMain.handle('app:set-theme', (_e, theme) => {
    if (!THEMES.includes(theme)) return;
    nativeTheme.themeSource = theme;
    writeConfig({ theme });
    applyTheme();
  });

  ipcMain.handle('app:choose-mirror', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for a second copy of your backups',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = path.resolve(r.filePaths[0]);
    if (dir.toLowerCase().startsWith(path.resolve(paths.dir()).toLowerCase())) {
      throw new Error('Pick a folder outside the app data folder.');
    }
    writeConfig({ mirrorDir: dir });
    mirrorNow();
    return { mirrorDir: dir, mirrorStatus };
  });

  ipcMain.handle('app:clear-mirror', () => {
    writeConfig({ mirrorDir: '' });
    mirrorStatus = null;
    return true;
  });

  // ---------- export / import of notes ----------

  ipcMain.handle('export:file', async (_e, { name, ext, content } = {}) => {
    if (!EXPORT_EXT[ext] || (typeof content !== 'string' && !(content instanceof Uint8Array))) throw new Error('Invalid export');
    const r = await dialog.showSaveDialog(win, {
      title: 'Export',
      defaultPath: path.join(app.getPath('documents'), `${safeName(name)}.${ext}`),
      filters: [{ name: EXPORT_EXT[ext], extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    writeDurable(r.filePath, exportData(content));
    return { path: r.filePath };
  });

  ipcMain.handle('export:pdf', async (_e, { name, html } = {}) => {
    if (typeof html !== 'string') throw new Error('Invalid export');
    const r = await dialog.showSaveDialog(win, {
      title: 'Export as PDF',
      defaultPath: path.join(app.getPath('documents'), `${safeName(name)}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const pdf = await renderPdf(html);
    fs.writeFileSync(r.filePath, pdf);
    return { path: r.filePath };
  });

  // Writes many notes into a new folder, mirroring the folder tree.
  ipcMain.handle('export:folder', async (_e, { name, files } = {}) => {
    if (!Array.isArray(files) || files.some((f) => !EXPORT_EXT[f.ext] || (typeof f.content !== 'string' && !(f.content instanceof Uint8Array)) || !Array.isArray(f.path))) {
      throw new Error('Invalid export');
    }
    const r = await dialog.showOpenDialog(win, { title: 'Choose where to export', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const base = uniquePath(path.join(r.filePaths[0], safeName(name)));
    fs.mkdirSync(base, { recursive: true });
    for (const f of files) {
      const parts = f.path.map(safeName);
      const dir = path.join(base, ...parts.slice(0, -1));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(uniquePath(path.join(dir, `${parts[parts.length - 1]}.${f.ext}`)), exportData(f.content));
    }
    return { path: base, count: files.length };
  });

  ipcMain.handle('import:files', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import Markdown or text files as notes',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Markdown or text', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (r.canceled) return [];
    return r.filePaths.map((file) => {
      const name = path.basename(file);
      if (fs.statSync(file).size > 5 * 1024 * 1024) return { name, error: 'larger than 5 MB' };
      return { name, ext: path.extname(file).slice(1).toLowerCase(), text: fs.readFileSync(file, 'utf8').replace(/^﻿/, '') };
    });
  });

  // ---------- files ----------

  const addPaths = (list) => (Array.isArray(list) ? list : []).map((p) => {
    const name = path.basename(String(p));
    try {
      if (!path.isAbsolute(String(p)) || !fs.statSync(p).isFile()) throw new Error('Not a file');
      if (fs.statSync(p).size > MAX_FILE) throw new Error('Files larger than 100 MB cannot be added.');
      return storeBytes(fs.readFileSync(p), name);
    } catch (err) {
      return { name, error: err.message };
    }
  });

  ipcMain.handle('files:add-paths', (_e, list) => addPaths(list));
  ipcMain.handle('files:add-bytes', (_e, bytes, name) => storeBytes(bytes, name));
  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported files', extensions: [...Object.keys(FILE_TYPES), 'jpeg'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'Office & PDF', extensions: ['pdf', 'docx', 'xlsx', 'csv', 'pptx'] },
        { name: 'Text, logs & API data', extensions: ['txt', 'log', 'json', 'xml', 'har', 'yaml', 'yml', 'sql', 'md'] },
        { name: 'Screen recordings', extensions: ['mp4', 'webm'] },
      ],
    });
    return r.canceled ? [] : addPaths(r.filePaths);
  });

  // Electron 44 clipboard API: read() / write() with ClipboardItem (readImage / writeImage no longer exist).
  ipcMain.handle('files:clipboard-image', async () => {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(t));
      if (type) return storeBytes(Buffer.from(await (await item.getType(type)).arrayBuffer()), `Screenshot.${type === 'image/jpeg' ? 'jpg' : type.slice(6)}`);
    }
    return null;
  });
  ipcMain.handle('files:copy-image', async (_e, blob) => {
    const png = nativeImage.createFromPath(blobFile(blob)).toPNG();
    if (!png.length) throw new Error('This image could not be read.');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    return true;
  });

  ipcMain.handle('files:read-text', (_e, blob) => {
    const file = blobFile(blob);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, MAX_TEXT));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.toString('utf8').replace(/^\uFEFF/, ''), truncated: size > MAX_TEXT, size };
    } finally {
      fs.closeSync(fd);
    }
  });
  ipcMain.handle('files:read-bytes', (_e, blob) => fs.readFileSync(blobFile(blob)));
  ipcMain.handle('files:save-text', (_e, text, name) => storeBytes(Buffer.from(String(text), 'utf8'), name));

  // opts.chooseApp: let Windows ask which app to use (when no editor is installed).
  ipcMain.handle('files:open-app', async (_e, fileId, blob, name, opts) => {
    const kind = FILE_TYPES[normExt(blob)];
    if (['image', 'video', 'pdf'].includes(kind)) {
      const target = viewCopy(blob, name);
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
      return { path: target, watched: false };
    }
    const choose = Boolean(opts && opts.chooseApp);
    const editor = EDITORS[kind] && !choose ? app.qaura.findEditor(kind) : null;
    // Never hand an Office file to whatever Windows has set for it without asking: it may be an online service.
    if (EDITORS[kind] && !editor && !choose) return { needsApp: true, kind };
    const target = openWorkingCopy(fileId, blob, name, editor ? editor.name : choose ? 'another app' : '');
    if (choose) await app.qaura.launch(RUNDLL, ['shell32.dll,OpenAs_RunDLL', target]);
    else if (editor) await app.qaura.launch(editor.path, [target]);
    else {
      const err = await shell.openPath(target); // text and logs: your default text editor
      if (err) throw new Error(err);
    }
    return { path: target, watched: true, app: editor ? editor.name : '' };
  });
  ipcMain.handle('files:take-opened', () => openedFiles.splice(0));
  ipcMain.handle('files:sync-working', () => {
    let ids = [];
    try { ids = fs.readdirSync(paths.working()).filter((n) => n !== 'view'); } catch { return []; }
    const recent = Date.now() - 14 * 24 * 3600 * 1000;
    return ids.map((id) => {
      try {
        const change = importWorkingChange(id);
        // Keep watching documents that may still be open in Word / Excel from before the restart.
        const side = readSidecar(workingDir(id));
        const file = side && path.join(workingDir(id), side.name);
        if (file && fs.existsSync(file) && Math.max(fs.statSync(file).mtimeMs, Date.parse(side.syncedAt) || 0) > recent) watchWorking(id, file);
        return change;
      } catch { return null; }
    }).filter(Boolean);
  });
  ipcMain.handle('files:preview-pdf', (_e, blob, name) => {
    if (normExt(blob) !== 'pdf') throw new Error('Not a PDF');
    openPdfViewer(blob, name);
    return true;
  });
  ipcMain.handle('files:download', async (_e, blob, name) => {
    const file = blobFile(blob);
    const ext = normExt(blob);
    const r = await dialog.showSaveDialog(win, {
      title: 'Download file',
      defaultPath: path.join(app.getPath('downloads'), `${safeName(String(name || 'file').replace(/\.[^.]+$/, ''))}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.copyFileSync(file, r.filePath);
    return { path: r.filePath };
  });

  ipcMain.handle('clipboard:write', async (_e, text) => {
    await clipboard.writeText(String(text));
    return true;
  });

  ipcMain.handle('shell:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    return undefined;
  });
}

// ---------- app lifecycle ----------

const startupFiles = filesFromArgs(process.argv);
if (!app.requestSingleInstanceLock({ files: startupFiles })) {
  // Only one window may write the data file at a time; files opened here go to the running window.
  app.quit();
} else {
  queueOpened(startupFiles);
  app.on('second-instance', (_e, argv, _cwd, data) => {
    queueOpened(data && Array.isArray(data.files) ? data.files : filesFromArgs(argv));
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('local.qaura');
    const { theme } = readConfig();
    nativeTheme.themeSource = THEMES.includes(theme) ? theme : 'dark';
    nativeTheme.on('updated', applyTheme);
    Menu.setApplicationMenu(null);
    protocol.handle('qa-att', serveBlob);
    registerIpc();
    createWindow();
    setInterval(periodicBackup, AUTO_BACKUP_MS);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', () => {
    for (const { file } of watching.values()) fs.unwatchFile(file);
    try {
      dailyBackup();
      if (changedSinceBackup) snapshot('auto');
      mirrorNow();
    } catch (err) {
      console.error('Backup on exit failed', err);
    }
  });
}
