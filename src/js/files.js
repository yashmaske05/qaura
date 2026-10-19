(function () {
  'use strict';

  // Files: add, link to bugs / notes / tasks, preview, edit (in QAura or in Word/Excel), versions.
  // Every version is a separate stored file in the main process; nothing is ever overwritten.
  const QN = window.QN;
  const { h, icon, util, store, make, ui } = QN;

  const KIND = {
    image: { label: 'Image', app: 'your image viewer', icon: 'image' },
    video: { label: 'Recording', app: 'your video player', icon: 'video' },
    pdf: { label: 'PDF', app: 'your PDF reader', icon: 'fileDoc' },
    word: { label: 'Word', app: 'Word', icon: 'fileDoc' },
    excel: { label: 'Excel', app: 'Excel', icon: 'table' },
    csv: { label: 'CSV', app: 'Excel', icon: 'table' },
    powerpoint: { label: 'PowerPoint', app: 'PowerPoint', icon: 'slides' },
    text: { label: 'Text', app: 'your text editor', icon: 'fileDoc' },
  };
  const EXT_KIND = {
    png: 'image', jpg: 'image', gif: 'image', webp: 'image', bmp: 'image', mp4: 'video', webm: 'video',
    pdf: 'pdf', docx: 'word', xlsx: 'excel', csv: 'csv', pptx: 'powerpoint',
    txt: 'text', log: 'text', json: 'text', xml: 'text', har: 'text', yaml: 'text', yml: 'text', sql: 'text', md: 'text',
  };
  const HL_LANG = { json: 'json', har: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', sql: 'sql', md: 'markdown' };
  const KIND_FILTERS = [['', 'All types'], ['image', 'Images'], ['video', 'Recordings'], ['pdf', 'PDF'], ['word', 'Word'], ['excel', 'Excel'], ['csv', 'CSV'], ['powerpoint', 'PowerPoint'], ['text', 'Text, logs & data']];

  const extOf = (blob) => String(blob || '').split('.').pop();
  const latest = (f) => (f && f.versions && f.versions[f.versions.length - 1]) || {};
  const kindOf = (f) => EXT_KIND[extOf(latest(f).blob)] || 'text';
  const fileUrl = (blob) => `qa-att://f/${blob}`;
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);
  const cleanErr = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const changed = (fileId) => document.dispatchEvent(new CustomEvent('qn:files', { detail: { fileId } }));
  const liveFile = (id) => {
    const f = id && store.find('files', id);
    return f && !f.deletedAt ? f : null;
  };
  const filesOf = (entity) => (entity.files || []).map(liveFile).filter(Boolean);

  function usedIn(id) {
    const out = [];
    for (const [c, kind] of [['bugs', 'bug'], ['notes', 'note'], ['tasks', 'task']]) {
      for (const x of store.live(c)) if ((x.files || []).includes(id)) out.push({ kind, item: x });
    }
    return out;
  }
  const itemTitle = ({ kind, item }) => (kind === 'note' ? QN.noteTitle(item) : `${item.ticket ? `${item.ticket} · ` : ''}${item.title || 'Untitled'}`);
  const goTo = ({ kind, item }) => (kind === 'bug' ? QN.app.go('bugs', { select: item.id }) : kind === 'note' ? QN.app.go('notes', { select: item.id }) : QN.app.go('tasks', { focus: item.id }));

  function displayName(r) {
    const ext = extOf(r.blob);
    return !r.name || /^(image|screenshot)\.(png|jpe?g|gif|webp|bmp)$/i.test(r.name) ? `Screenshot ${util.fmtDateTime(util.now())}.${ext}` : r.name;
  }

  // ---------- adding ----------

  // Turn store results into file records, skipping exact duplicates already linked here.
  function recordsFrom(results, entity) {
    const made = [];
    const errors = [];
    let skipped = 0;
    for (const r of results || []) {
      if (!r) continue;
      if (r.error) { errors.push(`${r.name}: ${r.error}`); continue; }
      const pool = entity ? filesOf(entity) : store.live('files');
      if (pool.some((f) => latest(f).blob === r.blob)) { skipped += 1; continue; }
      made.push(store.add('files', make.file({ name: displayName(r), versions: [{ blob: r.blob, size: r.size, at: util.now(), source: 'Added' }] })));
    }
    if (errors.length) ui.alert(errors.length === 1 ? 'A file was not added' : 'Some files were not added', errors.join('\n'));
    if (!made.length && skipped) ui.toast(entity ? 'That file is already attached here' : 'That file is already in Files');
    return made;
  }

  function link(entity, files) {
    entity.files = entity.files || [];
    let n = 0;
    for (const f of files) {
      if (!entity.files.includes(f.id)) { entity.files.push(f.id); n += 1; }
    }
    if (n) { entity.updatedAt = util.now(); store.commit(); }
    return n;
  }

  async function fromFileObjects(list) {
    const results = [];
    for (const file of list) {
      const p = window.api.pathForFile(file);
      try {
        if (p) results.push(...(await window.api.addPaths([p])));
        else results.push(await window.api.addBytes(new Uint8Array(await file.arrayBuffer()), file.name || `Screenshot.${(file.type.split('/')[1] || 'png')}`));
      } catch (err) {
        results.push({ name: file.name || 'file', error: cleanErr(err) });
      }
    }
    return results;
  }

  // source: 'pick' | 'clipboard' | FileList / File[]
  async function add(entity, source) {
    let results;
    try {
      if (source === 'pick') results = await window.api.pickFiles();
      else if (source === 'clipboard') {
        const r = await window.api.clipboardImage();
        if (!r) {
          ui.toast('No image on the clipboard. Take one with Win+Shift+S, then try again.', { type: 'error' });
          return [];
        }
        results = [r];
      } else results = await fromFileObjects([...source]);
    } catch (err) {
      ui.toast(cleanErr(err), { type: 'error' });
      return [];
    }
    const made = recordsFrom(results, entity);
    if (entity && made.length) link(entity, made);
    if (made.length) {
      ui.toast(made.length === 1 ? `Added ${made[0].name}` : `Added ${made.length} files`);
      changed();
    }
    return made;
  }

  // Images / files on a paste event (returns true if it handled the paste).
  function handlePaste(e, entity) {
    const data = e.clipboardData;
    if (!data || [...data.types].includes('text/plain')) return false; // text pastes stay text
    const files = [...data.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return false;
    e.preventDefault();
    add(entity, files);
    return true;
  }

  function unlink(entity, f) {
    const i = (entity.files || []).indexOf(f.id);
    if (i < 0) return;
    entity.files.splice(i, 1);
    entity.updatedAt = util.now();
    store.commit();
    changed(f.id);
    ui.toast(`Removed ${f.name} from this item (still in Files)`, { action: { label: 'Undo', fn: () => { entity.files.splice(i, 0, f.id); store.commit(); changed(f.id); } } });
  }

  function linkExisting(entity, anchor) {
    const r = anchor.getBoundingClientRect();
    ui.picker({
      x: r.left,
      y: r.bottom + 6,
      placeholder: 'Attach a file from Files… (type to search)',
      items: (q) => store.live('files')
        .filter((f) => !(entity.files || []).includes(f.id) && util.matches(f.name, q))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 10)
        .map((f) => ({ label: f.name, hint: `${KIND[kindOf(f)].label} · ${fmtSize(latest(f).size)}`, icon: KIND[kindOf(f)].icon, onPick: () => { link(entity, [f]); changed(f.id); } })),
    });
  }

  function addVersion(f, stored, source) {
    if (latest(f).blob === stored.blob) return false;
    f.versions.push({ blob: stored.blob, size: stored.size, at: util.now(), source });
    f.updatedAt = util.now();
    store.commit();
    changed(f.id);
    return true;
  }

  // ---------- tiles & panel ----------

  function thumb(f) {
    const v = latest(f);
    const k = kindOf(f);
    if (k === 'image') return h('img', { src: fileUrl(v.blob), alt: f.name, loading: 'lazy' });
    if (k === 'video') return h('div', { class: 'thumb-video' }, h('video', { src: `${fileUrl(v.blob)}#t=0.1`, preload: 'metadata', muted: true }), icon('play', 'thumb-play'));
    return h('div', { class: `thumb-doc k-${k}` }, icon(KIND[k].icon), h('span', { class: 'ext-badge' }, extOf(v.blob).toUpperCase()));
  }

  function tile(f, entity) {
    const v = latest(f);
    const k = kindOf(f);
    return h('figure', { class: `file-tile k-${k}`, 'data-id': f.id },
      h('button', { type: 'button', class: 'file-thumb', title: `Open ${f.name}`, onClick: () => openDetail(f.id) }, thumb(f)),
      h('figcaption', null,
        h('span', { class: 'file-name', title: f.name }, f.name),
        h('span', { class: 'file-meta' }, `${KIND[k].label} · ${fmtSize(v.size)}${f.versions.length > 1 ? ` · v${f.versions.length}` : ''}`)),
      entity ? h('button', { type: 'button', class: 'icon-btn sm tile-remove', title: 'Remove from this item (the file stays in Files)', 'aria-label': 'Remove', onClick: () => unlink(entity, f) }, icon('x')) : null);
  }

  // The "Files" section shown in bugs, notes and tasks.
  function panel(entity, opts = {}) {
    const grid = h('div', { class: 'files-grid' });
    const count = h('span', { class: 'muted' });
    const fromLib = h('button', { type: 'button', class: 'btn ghost xs', onClick: () => linkExisting(entity, fromLib) }, icon('paperclip'), 'From Files…');
    const drop = h('div', { class: 'file-drop' },
      icon('paperclip', 'file-drop-icon'),
      h('div', { class: 'file-drop-text' },
        h('strong', null, opts.dropTitle || 'Add files or screenshots'),
        h('span', null, 'Drop files here · Ctrl+V to paste a screenshot · PDF, Word, Excel, CSV, PowerPoint, logs, JSON, images, recordings')),
      h('div', { class: 'file-drop-actions' },
        h('button', { type: 'button', class: 'btn sm', onClick: () => add(entity, 'pick') }, icon('upload'), 'Add files…'),
        h('button', { type: 'button', class: 'btn ghost sm', onClick: () => add(entity, 'clipboard') }, icon('copy'), 'Paste image')));
    const wrap = h('div', { class: `files-panel${opts.compact ? ' compact' : ''}` },
      h('div', { class: 'field-head' }, h('span', { class: 'field-label' }, opts.label || 'Files', count), h('div', { class: 'spacer' }), fromLib),
      grid);
    const paint = () => {
      const files = filesOf(entity);
      grid.replaceChildren(...files.map((f) => tile(f, entity)), drop);
      count.textContent = files.length ? `  ${files.length}` : '';
    };
    const onEvent = () => {
      if (!wrap.isConnected) { document.removeEventListener('qn:files', onEvent); return; }
      paint();
    };
    document.addEventListener('qn:files', onEvent);
    wrap.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); wrap.classList.add('dropping'); } });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('dropping'); });
    wrap.addEventListener('drop', (e) => {
      wrap.classList.remove('dropping');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      add(entity, e.dataTransfer.files);
    });
    paint();
    return wrap;
  }

  // ---------- detail drawer ----------

  function openDetail(id) {
    const f = store.find('files', id);
    if (!f) return;
    let ref;
    let saveDirty = null; // set by in-app editors; called when the drawer closes
    let shownBlob = null; // version currently shown in the preview / editor
    let build = 0;
    let controller = null; // Word / Excel preview: { start(), stop() } to edit right here
    let editing = false;
    const head = h('header', { class: 'file-head' });
    const preview = h('div', { class: 'file-preview' });
    const sections = h('aside', { class: 'file-side' });
    const root = h('div', { class: 'file-detail' }, head, h('div', { class: 'file-main' }, h('div', { class: 'file-stage' }, preview), sections));
    const onEvent = (e) => {
      if (!root.isConnected) { document.removeEventListener('qn:files', onEvent); return; }
      if (!e.detail || !e.detail.fileId || e.detail.fileId === id) render();
    };

    function render() {
      const v = latest(f);
      const k = kindOf(f);
      const name = h('input', {
        class: 'file-title',
        value: f.name,
        title: f.name,
        'aria-label': 'File name',
        onChange: (e) => { const nv = e.target.value.trim(); if (nv) { f.name = nv; f.updatedAt = util.now(); store.commit(); changed(f.id); } else e.target.value = f.name; },
      });
      const editable = ['word', 'excel', 'powerpoint', 'csv', 'text'].includes(k);
      const inQAura = k === 'word' || k === 'excel'; // edited right here: Edit / Done
      const openBtn = inQAura ? h('button', {
        type: 'button',
        class: 'btn primary sm',
        disabled: controller ? null : true,
        title: !controller ? 'Available once the preview has loaded' : editing ? 'Save and go back to the preview' : 'Edit it here; each save becomes a new version (the original is kept)',
        onClick: toggleEditing,
      }, icon(editing ? 'check' : 'edit'), editing ? 'Done' : 'Edit') : h('button', {
        type: 'button',
        class: 'btn primary sm',
        title: editable ? `Saves in ${KIND[k].app} come back here as new versions` : '',
        onClick: () => (k === 'pdf' ? window.api.previewPdf(v.blob, f.name) : openInApp(f)).catch((err) => ui.toast(cleanErr(err), { type: 'error' })),
      }, icon(k === 'pdf' ? 'eye' : editable ? 'edit' : 'external'), k === 'pdf' ? 'Open PDF viewer' : editable ? `Edit in ${KIND[k].app}` : `Open in ${KIND[k].app}`);
      const moreBtn = h('button', { type: 'button', class: 'icon-btn', title: 'More', 'aria-label': 'More' }, icon('more'));
      moreBtn.addEventListener('click', () => ui.menu(moreBtn, [
        k === 'image' ? { label: 'Copy image', icon: 'copy', hint: 'paste into Jira', onClick: () => copyImage(v.blob) } : null,
        k === 'pdf' ? { label: 'Open in your PDF reader', icon: 'external', onClick: () => openInApp(f).catch((err) => ui.toast(cleanErr(err), { type: 'error' })) } : null,
        inQAura ? { label: `Open in ${KIND[k].app}…`, icon: 'external', hint: 'keeps all formatting', onClick: () => openInApp(f).catch((err) => ui.toast(cleanErr(err), { type: 'error' })) } : null,
        k === 'word' ? { label: 'Convert to a note', icon: 'notes', onClick: () => convertToNote(f) } : null,
        { separator: true },
        { label: 'Move file to Trash', icon: 'trash', danger: true, onClick: () => trashFile(f, ref) },
      ], { alignRight: true }));

      const uses = usedIn(f.id);
      const isMax = Boolean(store.state.settings.fileViewerMax);
      const sizeBtn = h('button', {
        type: 'button',
        class: 'icon-btn',
        title: isMax ? 'Restore size' : 'Fill the window',
        'aria-label': isMax ? 'Restore size' : 'Fill the window',
        onClick: () => { store.state.settings.fileViewerMax = !isMax; store.commit(); ref.setMaximized(!isMax); render(); },
      }, icon(isMax ? 'shrink' : 'expand'));
      head.replaceChildren(
        h('div', { class: `thumb-doc mini k-${k}` }, icon(KIND[k].icon)),
        h('div', { class: 'file-head-text' }, name,
          h('div', { class: 'file-meta' }, `${KIND[k].label} · ${extOf(v.blob).toUpperCase()} · ${fmtSize(v.size)} · ${util.plural(f.versions.length, 'version')} · updated ${util.relTime(f.updatedAt)}`)),
        openBtn,
        h('button', { type: 'button', class: 'btn sm', onClick: () => download(v.blob, f.name) }, icon('download'), 'Download'),
        sizeBtn,
        moreBtn,
        h('button', { type: 'button', class: 'icon-btn', title: 'Close (Esc)', onClick: () => ref.close() }, icon('x')));
      sections.replaceChildren(
        h('section', { class: 'file-section' },
          h('h3', null, icon('history'), 'Versions', h('span', { class: 'group-count' }, f.versions.length)),
          h('ul', { class: 'version-list' }, f.versions.map((ver, i) => ({ ver, i })).reverse().map(({ ver, i }) => h('li', { class: i === f.versions.length - 1 ? 'current' : null },
            h('span', { class: 'ver-n' }, `v${i + 1}`),
            h('span', { class: 'ver-src' }, ver.source || 'Saved'),
            h('span', { class: 'muted small' }, `${util.fmtDateTime(ver.at)} · ${fmtSize(ver.size)}`),
            h('span', { class: 'ver-actions' },
              i === f.versions.length - 1 ? ui.pill('green', 'Current') : h('button', {
                type: 'button',
                class: 'btn ghost xs',
                onClick: async () => {
                  if (saveDirty) await saveDirty(); // keep unsaved edits as their own version first
                  addVersion(f, ver, `Restored v${i + 1}`);
                  ui.toast(`Restored v${i + 1} as the current version`);
                },
              }, icon('undo'), 'Restore'),
              h('button', { type: 'button', class: 'btn ghost xs', title: 'Download this version', onClick: () => download(ver.blob, f.name) }, icon('download'))))))),
        h('section', { class: 'file-section' },
          h('h3', null, icon('link'), 'Used in', h('span', { class: 'group-count' }, uses.length)),
          uses.length
            ? h('div', { class: 'rel-row' }, uses.map((u) => h('button', { type: 'button', class: 'rel-chip', onClick: () => goTo(u) }, icon(u.kind === 'bug' ? 'bug' : u.kind === 'note' ? 'notes' : 'tasks'), itemTitle(u))))
            : h('p', { class: 'muted small' }, 'Not attached to a bug, note or task yet. Attach it with "From Files…" in any Files section.')));
      // Keep the preview (and an open editor with its cursor) unless another version became current.
      if (shownBlob === v.blob) return;
      shownBlob = v.blob;
      controller = null;
      editing = false;
      const old = saveDirty;
      saveDirty = null;
      if (old) old(); // never drop unsaved in-app edits
      const mine = ++build;
      const ctx = {
        setDirty: (fn) => { if (mine === build) saveDirty = fn; },
        saved: (blob) => { if (mine === build) shownBlob = blob; }, // the editor already shows this version
        setController: (c) => { if (mine === build) { controller = c; render(); } },
      };
      buildPreview(f, k, v, preview, ctx).catch((err) => preview.replaceChildren(h('div', { class: 'file-error' }, icon('alert'), `Preview not available: ${cleanErr(err)}`)));
    }

    async function toggleEditing() {
      if (!controller) return;
      if (editing) {
        await controller.stop();
        editing = false;
      } else {
        if (!(await controller.start())) return;
        editing = true;
      }
      render();
    }

    ref = ui.viewer(root, {
      label: f.name,
      maximized: store.state.settings.fileViewerMax,
      onClose: () => {
        document.removeEventListener('qn:files', onEvent);
        if (saveDirty) saveDirty();
      },
    });
    document.addEventListener('qn:files', onEvent);
    render();
  }

  async function openInApp(f, opts = {}) {
    const v = latest(f);
    const res = await window.api.openInApp(f.id, v.blob, f.name, opts);
    if (res && res.needsApp) {
      await askForApp(f, res.kind);
      return;
    }
    if (!res || !res.watched) return;
    const where = opts.chooseApp ? 'Pick an app in the Windows window.' : `Opened in ${res.app || KIND[kindOf(f)].app}.`;
    ui.toast(`${where} Each time you save there, QAura keeps a new version.`, { timeout: 6000 });
  }

  // No Word / Excel / PowerPoint (or LibreOffice) on this PC: say so, instead of handing the file
  // to whatever Windows has set for this type.
  async function askForApp(f, kind) {
    const app = { word: 'Microsoft Word', excel: 'Microsoft Excel', csv: 'Microsoft Excel', powerpoint: 'Microsoft PowerPoint' }[kind];
    const choice = await ui.modal({
      title: `${app} isn't installed on this PC`,
      body: h('p', { class: 'modal-text' },
        `QAura opens "${f.name}" straight in ${app} or LibreOffice, so every save there comes back here as a new version. Neither was found on this PC.${kind === 'csv' ? ' You can also edit it right here in QAura.' : ''}\n\n`
        + 'You can pick another app in the Windows window instead. Choose one that works offline: an online app (such as ChatGPT) would send this file off your PC.'),
      actions: [
        { label: 'Cancel', kind: 'ghost', value: null },
        { label: 'Download a copy', value: 'download' },
        { label: 'Choose another app…', kind: 'primary', submit: true, value: 'choose' },
      ],
    });
    if (choice === 'download') download(latest(f).blob, f.name);
    if (choice === 'choose') await openInApp(f, { chooseApp: true });
  }

  async function download(blob, name) {
    try {
      const r = await window.api.downloadFile(blob, name);
      if (r) ui.toast(`Saved to ${r.path}`, { timeout: 5000 });
    } catch (err) {
      ui.toast(cleanErr(err), { type: 'error' });
    }
  }

  async function copyImage(blob) {
    try {
      await window.api.copyImage(blob);
      ui.toast('Image copied. Paste it into the ticket with Ctrl+V');
    } catch (err) {
      ui.toast(cleanErr(err), { type: 'error' });
    }
  }

  async function trashFile(f, ref) {
    const uses = usedIn(f.id);
    const ok = await ui.confirm(`Move "${f.name}" to Trash?`,
      `${uses.length ? `It is attached to ${util.plural(uses.length, 'item')}; it will be hidden there too. ` : ''}You can restore it from Settings → Trash. The stored file and its versions are kept.`,
      { confirmLabel: 'Move to Trash', danger: true });
    if (!ok) return;
    store.trash(f);
    if (ref) ref.close();
    changed(f.id);
    ui.toast('File moved to Trash', { action: { label: 'Undo', fn: () => { store.restore(f); changed(f.id); } } });
  }

  async function bytesOf(blob) {
    // Over IPC: the page (file://) is not allowed to fetch() from the qa-att: scheme.
    const u8 = await window.api.readBytes(blob);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  async function convertToNote(f) {
    const res = await mammoth.convertToHtml({ arrayBuffer: await bytesOf(latest(f).blob) });
    const n = store.add('notes', make.note({ title: f.name.replace(/\.[^.]+$/, ''), html: QN.html.sanitize(res.value), files: [f.id] }));
    ui.toast('Converted to a note (images and complex layout are not carried over)', { action: { label: 'Open', fn: () => QN.app.go('notes', { select: n.id }) } });
  }

  // ---------- previews ----------

  // ctx: in-app editors register their save with the drawer (so closing it never drops edits)
  // and report what they saved (so the drawer keeps the editor instead of reloading it).
  async function buildPreview(f, k, v, el, ctx) {
    const bar = (text, ...right) => h('div', { class: 'stage-bar' }, h('span', { class: 'stage-hint' }, icon('eye'), text), h('div', { class: 'spacer' }), ...right);
    el.className = `file-preview k-${k}`;
    if (k === 'image') {
      el.replaceChildren(h('button', { type: 'button', class: 'preview-img', title: 'View full size', onClick: () => ui.lightbox(fileUrl(v.blob), f.name) }, h('img', { src: fileUrl(v.blob), alt: f.name })));
      return;
    }
    if (k === 'video') {
      el.replaceChildren(h('video', { class: 'preview-video', src: fileUrl(v.blob), controls: true, preload: 'metadata' }));
      return;
    }
    if (k === 'pdf') {
      el.replaceChildren(h('div', { class: 'preview-card' }, icon('fileDoc', 'preview-card-icon'),
        h('strong', null, 'PDF document'),
        h('span', { class: 'muted' }, 'Opens in a viewer window with zoom, search and print. Works offline.'),
        h('button', { type: 'button', class: 'btn primary sm', onClick: () => window.api.previewPdf(v.blob, f.name) }, icon('eye'), 'Open PDF viewer')));
      return;
    }
    if (k === 'powerpoint') {
      el.replaceChildren(h('div', { class: 'preview-card' }, icon('slides', 'preview-card-icon'),
        h('strong', null, 'PowerPoint presentation'),
        h('span', { class: 'muted' }, 'A preview is not available. Open it in PowerPoint to view or edit; each save comes back here as a new version.'),
        h('button', { type: 'button', class: 'btn primary sm', onClick: () => openInApp(f).catch((err) => ui.toast(cleanErr(err), { type: 'error' })) }, icon('edit'), 'Edit in PowerPoint')));
      return;
    }
    el.replaceChildren(h('div', { class: 'muted small' }, 'Loading preview…'));
    if (k === 'word') {
      const bytes = await bytesOf(v.blob);
      const extras = wordExtras(zipNames(new Uint8Array(bytes)));
      const res = await mammoth.convertToHtml({ arrayBuffer: bytes });
      wordView(f, el, QN.html.sanitizeDoc(res.value), extras, ctx, bar);
      return;
    }
    if (k === 'excel') {
      const bytes = await bytesOf(v.blob);
      const extras = excelExtras(zipNames(new Uint8Array(bytes)));
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(bytes);
      } catch {
        el.replaceChildren(h('div', { class: 'file-error' }, icon('alert'),
          "QAura can't read this workbook. It probably contains parts made by another tool that QAura's Excel reader does not support (for example some charts or comments). Use Download, or \"Open in Excel…\" in the ⋯ menu."));
        return;
      }
      excelView(f, el, wb, extras, ctx, bar);
      return;
    }
    if (k === 'csv') {
      const res = await window.api.readText(v.blob);
      el.replaceChildren(csvEditor(f, res, ctx));
      return;
    }
    const res = await window.api.readText(v.blob);
    el.replaceChildren(textEditor(f, res, ctx));
  }

  function cellText(cell) {
    const val = cell.value;
    if (val == null) return '';
    if (val instanceof Date) return util.fmtDateTime(val.toISOString());
    if (typeof val === 'object') {
      if (val.richText) return val.richText.map((t) => t.text).join('');
      if (val.formula || val.sharedFormula) {
        const r = val.result;
        return r == null ? `=${cell.formula || val.formula || ''}` : typeof r === 'object' ? String(r.error || '') : String(r);
      }
      if ('result' in val) return val.result == null ? '' : String(val.result);
      if (val.text) return String(val.text);
      if (val.error) return String(val.error);
      return '';
    }
    return String(val);
  }

  const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

  function sheetTable(ws) {
    const cols = Math.min(ws.columnCount || 0, 40);
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => { if (n <= 300) rows.push([n, row]); });
    if (!rows.length || !cols) return h('p', { class: 'muted small' }, 'This sheet is empty.');
    return h('table', { class: 'sheet' },
      h('thead', null, h('tr', null, h('th', null, ''), Array.from({ length: cols }, (_, i) => h('th', null, colName(i))))),
      h('tbody', null, rows.map(([n, row]) => h('tr', null, h('th', null, String(n)), Array.from({ length: cols }, (_, i) => h('td', null, cellText(row.getCell(i + 1))))))));
  }

  // Zoom for document, sheet and text previews; remembered per kind while QAura is open.
  const zoomByKind = {};
  function zoomControl(kind, target) {
    let z = zoomByKind[kind] || 1;
    const value = h('button', { type: 'button', class: 'zoom-val', title: 'Back to 100%', onClick: () => { z = 1; apply(); } });
    const apply = () => {
      target.style.zoom = String(z);
      value.textContent = `${Math.round(z * 100)}%`;
      zoomByKind[kind] = z;
    };
    const step = (d) => { z = Math.min(2, Math.max(0.5, Math.round((z + d) * 10) / 10)); apply(); };
    apply();
    return h('div', { class: 'zoom', role: 'group', 'aria-label': 'Zoom' },
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Zoom out', 'aria-label': 'Zoom out', onClick: () => step(-0.1) }, icon('minus')),
      value,
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Zoom in', 'aria-label': 'Zoom in', onClick: () => step(0.1) }, icon('plus')));
  }

  // ---------- Word and Excel: preview, and edit right here ----------

  // Names of the parts inside an Office file (a zip), read from its central directory.
  function zipNames(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let end = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) return [];
    const names = [];
    const dec = new TextDecoder();
    let p = dv.getUint32(end + 16, true);
    for (let i = dv.getUint16(end + 10, true); i > 0 && p + 46 <= u8.length && dv.getUint32(p, true) === 0x02014b50; i--) {
      const n = dv.getUint16(p + 28, true);
      names.push(dec.decode(u8.subarray(p + 46, p + 46 + n)));
      p += 46 + n + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return names;
  }
  const hasPart = (names, re) => names.some((n) => re.test(n));
  const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

  // What versions saved from QAura cannot keep, so we can say so before editing.
  const wordExtras = (names) => [
    hasPart(names, /^word\/(header|footer)\d*\.xml$/) && 'headers or footers',
    hasPart(names, /^word\/comments\.xml$/) && 'comments',
    hasPart(names, /^word\/charts\//) && 'charts',
    hasPart(names, /^word\/diagrams\//) && 'SmartArt',
    hasPart(names, /^word\/embeddings\//) && 'embedded objects',
  ].filter(Boolean);
  const excelExtras = (names) => [
    hasPart(names, /^xl\/charts\//) && 'charts',
    hasPart(names, /^xl\/pivotTables\//) && 'pivot tables',
    hasPart(names, /^xl\/slicers\//) && 'slicers',
  ].filter(Boolean);

  const askBeforeEditing = (what, extras, keeps, app) => (!extras.length ? Promise.resolve(true) : ui.confirm(`Edit this ${what} in QAura?`,
    `It has ${listText(extras)}. Versions saved from QAura keep ${keeps}, but not ${listText(extras)}.\n\nThe original stays as v1, untouched. To keep everything, use "Open in ${app}…" in the ⋯ menu.`,
    { confirmLabel: 'Edit here' }));

  // Word: a page preview; Edit turns the page into an editor and each save builds a new .docx version.
  function wordView(f, el, html, extras, ctx, bar) {
    const page = h('div', { class: 'rt-view docx-preview' });
    let ed = null;
    let eb = null;
    const showPreview = (content) => {
      page.innerHTML = content;
      el.replaceChildren(bar('Preview · click Edit to change it here (each save becomes a new version)', zoomControl('word', page)), h('div', { class: 'docx-desk' }, page));
    };
    showPreview(html);
    ctx.setController({
      async start() {
        if (!(await askBeforeEditing('document', extras, 'the text, headings, lists, tables, links and pictures', 'Word'))) return false;
        ed = QN.editor.docEditor({ html: page.innerHTML, label: f.name, onChange: () => eb.markDirty() });
        eb = editorBar(f, () => QN.office.docxFromHtml(ed.getHtml(), f.name.replace(/\.[^.]+$/, '')), null, ctx);
        ed.body.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); eb.save(); } });
        eb.bar.append(
          h('span', { class: 'stage-hint', title: 'Versions saved here keep the content and pictures. Fonts, colours and page layout are not kept; the original stays as v1.' }, icon('alert'), 'Keeps content and pictures, not fonts or layout'),
          zoomControl('word', ed.body));
        el.replaceChildren(h('div', { class: 'doc-edit-head' }, eb.bar, ed.toolbar), h('div', { class: 'docx-desk' }, ed.body));
        ed.focus();
        return true;
      },
      async stop() {
        await eb.save();
        showPreview(ed.getHtml());
        ed = null;
      },
    });
  }

  // How a cell reads in the edit grid (formulas start with "=").
  function cellEditText(cell) {
    const v = cell.value;
    if (v == null) return '';
    if (v instanceof Date) {
      const iso = v.toISOString();
      return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'object') {
      if (v.formula || v.sharedFormula) return `=${cell.formula || v.formula || ''}`;
      if (v.richText) return v.richText.map((t) => t.text).join('');
      if (v.text != null) return String(v.text);
      if (v.error) return String(v.error);
      return '';
    }
    return String(v);
  }

  // Typed text -> cell value. Text cells stay text (keeps IDs like 00123); "=…" is a formula.
  function cellValueFrom(text, old) {
    const t = text.trim();
    if (!t) return null;
    if (t.startsWith('=') && t.length > 1) return { formula: t.slice(1) };
    if (old instanceof Date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(t);
      if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
    }
    if (old && typeof old === 'object' && old.hyperlink) return { text, hyperlink: old.hyperlink };
    if (typeof old !== 'string') {
      if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) && !/^-?0\d/.test(t)) return Number(t);
      if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
    }
    return text;
  }

  const MAX_EDIT_ROWS = 500;
  const MAX_EDIT_COLS = 40;

  // Excel: a sheet preview; Edit turns the sheet into a grid. Only changed cells are written, so
  // formatting, formulas, merged cells and the other sheets stay as they were.
  function excelView(f, el, wb, extras, ctx, bar) {
    const sheets = wb.worksheets.filter((ws) => ws.state !== 'hidden');
    if (!sheets.length) {
      el.replaceChildren(h('p', { class: 'muted small' }, 'This workbook has no visible sheets.'));
      return;
    }
    let active = 0;
    let editing = false;
    let eb = null;
    const edits = new Map(); // "sheet:row:col" -> { ws, r, c, text }
    const tableBox = h('div', { class: 'sheet-box' });
    const tabs = h('div', { class: 'sheet-tabs' });
    const note = h('p', { class: 'file-hint' }, icon('alert'), `Only the first ${MAX_EDIT_ROWS} rows and ${MAX_EDIT_COLS} columns can be edited here; the rest is kept as it is.`);
    const zoom = zoomControl('excel', tableBox);

    function editGrid(ws) {
      const rows = Math.min(Math.max(ws.rowCount, 1) + 20, MAX_EDIT_ROWS);
      const cols = Math.min(Math.max(ws.columnCount, 1) + 5, MAX_EDIT_COLS);
      return h('table', { class: 'sheet editable' },
        h('thead', null, h('tr', null, h('th', null, ''), Array.from({ length: cols }, (_, i) => h('th', null, colName(i))))),
        h('tbody', null, Array.from({ length: rows }, (_, ri) => h('tr', null, h('th', null, String(ri + 1)),
          Array.from({ length: cols }, (_, ci) => {
            const r = ri + 1;
            const c = ci + 1;
            const key = `${ws.id}:${r}:${c}`;
            const cell = ws.findCell(r, c);
            const covered = cell && cell.isMerged && cell.master !== cell;
            return h('td', null, h('input', {
              value: edits.has(key) ? edits.get(key).text : cell ? cellEditText(cell) : '',
              readonly: covered ? true : null,
              title: covered ? 'Part of a merged cell: edit its first cell' : null,
              'aria-label': `Row ${r}, column ${c}`,
              onInput: (e) => { edits.set(key, { ws, r, c, text: e.target.value }); eb.markDirty(); },
            }));
          })))));
    }
    const paint = () => {
      const ws = sheets[active];
      note.hidden = !(editing && (ws.rowCount > MAX_EDIT_ROWS || ws.columnCount > MAX_EDIT_COLS));
      tableBox.replaceChildren(editing ? editGrid(ws) : sheetTable(ws));
      tabs.replaceChildren(...sheets.map((s, i) => h('button', { type: 'button', class: `sheet-tab${i === active ? ' on' : ''}`, onClick: () => { active = i; paint(); } }, s.name)));
    };
    const layout = () => {
      el.replaceChildren(editing ? eb.bar : bar('Preview (first 300 rows) · click Edit to change cells here', zoom), note, tableBox, tabs);
      paint();
    };
    function applyEdits() {
      for (const { ws, r, c, text } of edits.values()) {
        const existing = ws.findCell(r, c);
        if ((existing ? cellEditText(existing) : '') === text) continue;
        const cell = ws.getCell(r, c);
        cell.value = cellValueFrom(text, cell.value);
      }
      edits.clear();
      wb.calcProperties.fullCalcOnLoad = true; // Excel recalculates the formulas when it opens the file
    }
    layout();
    ctx.setController({
      async start() {
        if (!(await askBeforeEditing('workbook', extras, 'cell values, formulas, formatting and all sheets', 'Excel'))) return false;
        eb = editorBar(f, async () => { applyEdits(); return new Uint8Array(await wb.xlsx.writeBuffer()); }, null, ctx);
        eb.bar.append(h('span', { class: 'stage-hint', title: 'Formulas are recalculated when the file is opened in Excel.' }, icon('alert'), 'Start with = for a formula'), zoom);
        editing = true;
        layout();
        return true;
      },
      async stop() {
        await eb.save();
        editing = false;
        layout();
      },
    });
  }

  // ---------- in-app editors (text / CSV) ----------

  // A renamed file may have lost its extension; versions are always stored under the real one.
  const storedName = (f) => {
    const ext = extOf(latest(f).blob);
    return f.name.toLowerCase().endsWith(`.${ext}`) ? f.name : `${f.name}.${ext}`;
  };

  // getContent returns the new text, or the new file bytes (Word / Excel), possibly as a promise.
  function editorBar(f, getContent, extra, ctx) {
    let dirty = false;
    const status = h('span', { class: 'muted small' }, 'Saved');
    const save = async () => {
      if (!dirty) return;
      dirty = false;
      try {
        const content = await getContent();
        const stored = typeof content === 'string' ? await window.api.saveText(content, storedName(f)) : await window.api.addBytes(content, storedName(f));
        if (ctx) ctx.saved(stored.blob);
        if (addVersion(f, stored, 'Edited in QAura')) ui.toast(`Saved as v${f.versions.length}`);
        if (!dirty) { btn.disabled = true; status.textContent = 'Saved'; }
      } catch (err) {
        dirty = true;
        ui.toast(cleanErr(err), { type: 'error' });
      }
    };
    const btn = h('button', { type: 'button', class: 'btn primary sm', disabled: true, onClick: save }, icon('check'), 'Save new version');
    const markDirty = () => { dirty = true; btn.disabled = false; status.textContent = 'Unsaved changes (saved automatically when you close)'; };
    if (ctx) ctx.setDirty(save);
    return { bar: h('div', { class: 'editor-bar stage-bar' }, btn, extra || null, h('div', { class: 'spacer' }), status), markDirty, save };
  }

  function textEditor(f, res, ctx) {
    const ext = extOf(latest(f).blob);
    let box;
    const fmtBtn = ['json', 'har'].includes(ext) ? h('button', {
      type: 'button',
      class: 'btn ghost sm',
      onClick: () => { try { box.setValue(JSON.stringify(JSON.parse(box.area.value), null, 2)); } catch { ui.toast('This is not valid JSON', { type: 'error' }); } },
    }, icon('code'), 'Format JSON') : null;
    const eb = editorBar(f, () => box.area.value, fmtBtn, ctx);
    box = ui.codeArea({ value: res.text, language: HL_LANG[ext] || 'plaintext', className: 'tall', label: f.name, onInput: () => eb.markDirty() });
    box.area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); eb.save(); } });
    if (res.truncated) {
      box.area.readOnly = true;
      return h('div', { class: 'stage-fill' }, h('p', { class: 'file-hint' }, icon('alert'), 'This file is larger than 5 MB, so it is shown read-only (first 5 MB). Edit it in your text editor instead.'), box.el);
    }
    eb.bar.append(zoomControl('text', box.el));
    return h('div', { class: 'stage-fill' }, eb.bar, box.el);
  }

  // Minimal RFC 4180 CSV parser / writer (handles quotes, commas and line breaks in cells).
  function parseCsv(text) {
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return { rows, delim };
  }
  const csvCell = (v, delim) => (/["\r\n]/.test(v) || v.includes(delim) ? `"${v.replace(/"/g, '""')}"` : v);
  const toCsv = (rows, delim) => rows.map((r) => r.map((v) => csvCell(String(v ?? ''), delim)).join(delim)).join('\r\n');

  function csvEditor(f, res, ctx) {
    const { rows, delim } = parseCsv(res.text);
    if (!rows.length) rows.push(['']);
    const width = () => Math.max(1, ...rows.map((r) => r.length));
    const tooBig = res.truncated || rows.length > 2000 || width() > 60;
    const eb = editorBar(f, () => toCsv(rows, delim), null, ctx);
    let focus = { r: 0, c: 0 };
    const tableBox = h('div', { class: 'sheet-box' });
    const paint = () => {
      const cols = width();
      for (const r of rows) while (r.length < cols) r.push('');
      tableBox.replaceChildren(h('table', { class: 'sheet editable' },
        h('tbody', null, rows.slice(0, tooBig ? 500 : rows.length).map((r, ri) => h('tr', null,
          h('th', null, String(ri + 1)),
          r.map((v, ci) => h('td', null, h('input', {
            value: v,
            readonly: tooBig ? true : null,
            'aria-label': `Row ${ri + 1}, column ${ci + 1}`,
            onFocus: () => { focus = { r: ri, c: ci }; },
            onInput: (e) => { rows[ri][ci] = e.target.value; eb.markDirty(); },
          }))))))));
    };
    const act = (label, ic, fn) => h('button', { type: 'button', class: 'btn ghost xs', disabled: tooBig ? true : null, onClick: () => { fn(); eb.markDirty(); paint(); } }, icon(ic), label);
    paint();
    eb.bar.append(zoomControl('csv', tableBox));
    return h('div', { class: 'stage-fill' },
      tooBig ? h('p', { class: 'file-hint' }, icon('alert'), 'Large file: showing the first 500 rows read-only. Use "Edit in Excel" to change it.') : null,
      eb.bar,
      h('div', { class: 'grid-actions' },
        act('Row', 'plus', () => rows.splice(focus.r + 1, 0, Array(width()).fill(''))),
        act('Column', 'plus', () => rows.forEach((r) => r.splice(focus.c + 1, 0, ''))),
        act('Delete row', 'trash', () => { if (rows.length > 1) rows.splice(focus.r, 1); }),
        act('Delete column', 'trash', () => { if (width() > 1) rows.forEach((r) => r.splice(focus.c, 1)); })),
      tableBox);
  }

  // ---------- versions saved in Word / Excel / … ----------

  function applyChange(change) {
    const f = store.find('files', change.fileId);
    if (!f) return;
    if (addVersion(f, change, `Edited in ${change.appName || KIND[kindOf(f)].app.replace(/^your /, '')}`)) {
      ui.toast(`New version of ${f.name} saved (v${f.versions.length})`);
    }
  }

  // Files opened from File Explorer ("Open with > QAura"). A copy goes into Files; the original is never changed.
  async function openFromExplorer() {
    let results;
    try {
      const paths = await window.api.takeOpenedFiles();
      if (!paths.length) return;
      results = await window.api.addPaths(paths);
    } catch (err) {
      ui.toast(cleanErr(err), { type: 'error' });
      return;
    }
    const opened = [];
    const errors = [];
    for (const r of results) {
      if (r.error) { errors.push(`${r.name}: ${r.error}`); continue; }
      // Already in Files with the same content (now or as an earlier version): open that one, with its history.
      const live = store.live('files');
      const f = live.find((x) => latest(x).blob === r.blob)
        || live.find((x) => x.versions.some((v) => v.blob === r.blob))
        || store.add('files', make.file({ name: r.name, versions: [{ blob: r.blob, size: r.size, at: util.now(), source: 'Opened from File Explorer' }] }));
      if (!opened.includes(f)) opened.push(f);
    }
    if (errors.length) ui.alert(errors.length === 1 ? 'A file could not be opened' : 'Some files could not be opened', errors.join('\n'));
    if (!opened.length) return;
    changed();
    const target = opened.length === 1 ? { select: opened[0].id } : {};
    const label = opened.length === 1 ? opened[0].name : `${opened.length} files`;
    // Never pull you out of a dialog or panel you are working in.
    if (ui.hasModal()) ui.toast(`${label} added to Files`, { timeout: 8000, action: { label: 'Open', fn: () => QN.app.go('files', target) } });
    else {
      QN.app.go('files', target);
      if (opened.length > 1) ui.toast(`Opened ${label} in Files`);
    }
  }

  async function init() {
    window.api.onFileChanged(applyChange);
    window.api.onFilesOpened(openFromExplorer);
    openFromExplorer();
    try {
      for (const change of await window.api.syncWorking()) applyChange(change);
    } catch (err) {
      console.error('Could not check edited files', err);
    }
  }

  QN.files = { KIND, KIND_FILTERS, EXT_KIND, latest, kindOf, extOf, fileUrl, fmtSize, usedIn, add, link, unlink, panel, tile, openDetail, handlePaste, bytesOf, copyImage, download, init, parseCsv, toCsv, liveFile, filesOf };
})();
