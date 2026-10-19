(function () {
  'use strict';

  const QN = window.QN;
  const { h, icon, util, store, make, ui } = QN;

  const VIEWS = [['list', 'List', 'list'], ['grid', 'Grid', 'grid'], ['board', 'Board', 'board']];
  const SMART = [
    { id: 'all', label: 'All notes', icon: 'layers' },
    { id: 'favorites', label: 'Favorites', icon: 'star' },
    { id: 'recent', label: 'Recently viewed', icon: 'history' },
    { id: 'daily', label: 'Daily logs', icon: 'calendar' },
    { id: 'unfiled', label: 'Unfiled', icon: 'inbox' },
  ];
  const BOTTOM = [
    { id: 'archive', label: 'Archive', icon: 'archive' },
    { id: 'trash', label: 'Trash', icon: 'trash' },
  ];
  const SORTS = [['updated', 'Recently modified'], ['created', 'Recently created'], ['oldest', 'Oldest first'], ['title', 'Title A–Z'], ['viewed', 'Recently viewed']];
  const DATES = [['', 'Any time'], ['today', 'Edited today'], ['last-7-days', 'Edited in last 7 days'], ['last-30-days', 'Edited in last 30 days']];
  const NOTE_MIME = 'application/x-qn-note';
  const FOLDER_MIME = 'application/x-qn-folder';
  const GRID = { row: 92, gap: 14, maxC: 3, minR: 2, maxR: 7 };
  const CARD = { w: 260, h: 220 };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const OPEN_TODO = /(^|\n)\s*- \[ \]/;

  let root = null;
  let paneEl = null;
  let mainEl = null;
  let bodyEl = null;
  let listEl = null;
  let countEl = null;
  let searchEl = null;
  let filtersOpen = false;
  let initialized = false;
  let sel = 'all';
  let selectedId = null;
  let query = '';
  let tagFilter = '';
  let renaming = null;
  let drawerRef = null;

  const S = () => store.state.settings;
  const view = () => (sel === 'trash' ? 'list' : S().notesView || 'list');
  const filters = () => S().noteFilters || (S().noteFilters = { color: '', type: '', date: '', open: false });
  const liveFolder = (id) => {
    const f = id && store.find('folders', id);
    return f && !f.deletedAt ? f : null;
  };
  const children = (pid) => QN.folders.live().filter((f) => (f.parentId || '') === pid).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const isSmart = (id) => SMART.some((s) => s.id === id) || BOTTOM.some((s) => s.id === id);
  const active = () => store.live('notes').filter((n) => !n.archived);
  const typeOf = (n) => (n.daily ? 'daily' : n.type || 'note');

  function setScope(id) {
    sel = id;
    S().notesScope = id;
    store.commit();
  }
  function setSelected(id) {
    selectedId = id;
    if (S().lastNoteId !== (id || '')) {
      S().lastNoteId = id || '';
      store.commit();
    }
  }

  function scopeNotes() {
    switch (sel) {
      case 'all': return active();
      case 'favorites': return active().filter((n) => n.starred);
      case 'recent': return active().filter((n) => n.viewedAt).sort((a, b) => String(b.viewedAt).localeCompare(String(a.viewedAt))).slice(0, 30);
      case 'daily': return active().filter((n) => n.daily);
      case 'unfiled': return active().filter((n) => !liveFolder(n.folderId));
      case 'archive': return store.live('notes').filter((n) => n.archived);
      case 'trash': return store.state.notes.filter((n) => n.deletedAt).sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
      default: {
        const ids = new Set([sel, ...store.descendants(sel)]);
        return active().filter((n) => ids.has(n.folderId));
      }
    }
  }

  function filtered() {
    const p = QN.search.parse(query);
    const f = filters();
    const datePass = f.date ? QN.search.parse(`updated:${f.date}`).updated : null;
    const list = scopeNotes().filter((n) => {
      if (tagFilter && !(n.tags || []).includes(tagFilter)) return false;
      if (f.color && (n.color || 'none') !== f.color) return false;
      if (f.type && typeOf(n) !== f.type) return false;
      if (datePass && !datePass(util.dateOf(n.updatedAt))) return false;
      if (f.open && !OPEN_TODO.test(n.text || '')) return false;
      if (!p.empty) {
        const d = QN.search.docOf('note', n);
        if (sel === 'archive' || sel === 'trash') d.archived = p.is.includes('archived');
        if (!QN.search.matches(d, p)) return false;
      }
      return true;
    });
    if (sel === 'recent' || sel === 'trash') return list;
    const by = {
      updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
      created: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
      oldest: (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
      title: (a, b) => QN.noteTitle(a).localeCompare(QN.noteTitle(b), undefined, { sensitivity: 'base', numeric: true }),
      viewed: (a, b) => String(b.viewedAt || '').localeCompare(String(a.viewedAt || '')),
    }[S().notesSort] || ((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return list.sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || by(a, b));
  }

  function countIn(folderId) {
    const ids = new Set([folderId, ...store.descendants(folderId)]);
    return active().filter((n) => ids.has(n.folderId)).length;
  }

  const activeFilterCount = () => {
    const f = filters();
    return [f.color, f.type, f.date, f.open, tagFilter].filter(Boolean).length;
  };

  // ---------- actions ----------

  function selectScope(id) {
    setScope(id);
    tagFilter = '';
    renderPane();
    renderMain();
  }

  function showNote(n) {
    if (view() === 'list') {
      setSelected(n.id);
      renderBody();
    } else {
      renderBody();
      openDrawer(n.id);
    }
  }

  function createNote(props) {
    const p = { ...props };
    if (!isSmart(sel) && !('folderId' in p)) p.folderId = sel;
    if (sel === 'favorites') p.starred = true;
    const n = store.add('notes', make.note(p));
    if (query) { query = ''; if (searchEl) searchEl.value = ''; }
    if (['daily', 'archive', 'trash', 'recent'].includes(sel) && !(sel === 'daily' && n.daily)) setScope('all');
    renderPane();
    if (view() === 'list') {
      setSelected(n.id);
      renderMain();
      const t = root && root.querySelector('.notes-split .note-title');
      if (t) t.focus();
    } else {
      renderMain();
      openDrawer(n.id, true);
    }
    return n;
  }

  function fromTemplate(tpl, custom) {
    return createNote({ title: tpl.name, html: tpl.html, tags: tpl.id === 'daily' ? ['daily'] : [], type: custom ? 'custom' : tpl.id });
  }

  function openDaily() {
    const today = util.today();
    const existing = active().find((n) => n.daily === today);
    if (existing) {
      if (!scopeNotes().includes(existing)) setScope('all');
      renderPane();
      renderMain();
      showNote(existing);
      return existing;
    }
    const tpl = QN.noteTemplates.find((t) => t.id === 'daily');
    return createNote({ title: `Daily log · ${util.fmtDate(today)}`, daily: today, tags: ['daily'], html: tpl.html, folderId: '', type: 'daily' });
  }

  function removeNote(n) {
    store.trash(n);
    if (selectedId === n.id) setSelected(null);
    renderPane();
    renderBody();
    ui.toast('Note moved to Trash', { action: { label: 'Undo', fn: () => { store.restore(n); if (root) { renderPane(); showNote(n); } } } });
  }

  function duplicate(n) {
    const copy = store.add('notes', make.note({
      title: `${QN.noteTitle(n)} (copy)`, html: n.html, tags: [...(n.tags || [])], folderId: n.folderId, color: n.color, type: n.type || 'note',
    }));
    if (sel === 'archive' || sel === 'trash' || sel === 'recent') setScope('all');
    renderPane();
    renderMain();
    showNote(copy);
    ui.toast('Note duplicated');
  }

  function toggleArchive(n) {
    n.archived = !n.archived;
    n.archivedAt = n.archived ? util.now() : null;
    store.commit();
    if (drawerRef) drawerRef.close();
    if (selectedId === n.id && !scopeNotes().includes(n)) setSelected(null);
    renderPane();
    renderBody();
    ui.toast(n.archived ? 'Note archived' : 'Note restored from Archive', {
      action: { label: 'Undo', fn: () => { n.archived = !n.archived; store.commit(); if (root) { renderPane(); renderBody(); } } },
    });
  }

  function moveNote(n, folderId) {
    n.folderId = folderId;
    n.updatedAt = util.now();
    store.commit();
    renderPane();
    renderBody();
    ui.toast(`Moved to ${QN.folders.path(folderId) || 'Unfiled'}`);
  }

  function newFolder(parentId) {
    const f = store.add('folders', make.folder({ name: 'New folder', parentId }));
    if (parentId) expand(parentId, true);
    renaming = f.id;
    setScope(f.id);
    renderPane();
    renderMain();
  }

  function expand(id, force) {
    const set = new Set(S().expandedFolders || []);
    if (force === true || (force === undefined && !set.has(id))) set.add(id);
    else set.delete(id);
    S().expandedFolders = [...set];
    store.commit();
  }

  async function deleteFolder(f) {
    const notes = countIn(f.id);
    const subs = store.descendants(f.id).filter((id) => liveFolder(id)).length;
    const what = [notes ? util.plural(notes, 'note') : '', subs ? util.plural(subs, 'subfolder') : ''].filter(Boolean).join(' and ');
    const ok = await ui.confirm(`Delete "${f.name || 'Untitled folder'}"?`,
      `${what ? `The folder and its ${what} move to Trash. ` : 'The folder moves to Trash. '}You can restore everything from Settings → Trash.`,
      { confirmLabel: 'Move to Trash', danger: true });
    if (!ok) return;
    store.trashFolder(f);
    if (!isSmart(sel) && !liveFolder(sel)) setScope('all');
    render();
    ui.toast('Folder moved to Trash', { action: { label: 'Undo', fn: () => { store.restore(f); if (root) render(); } } });
  }

  function exportMenu(anchor, title, notes, rootId) {
    ui.menu(anchor, [{ header: `Export ${util.plural(notes.length, 'note')}` }, ...QN.exporter.formatMenuItems((fmt) => QN.exporter.exportNotes(title, notes, fmt, rootId))], { alignRight: true });
  }

  function folderMenu(anchor, f) {
    ui.menu(anchor, [
      { label: 'New note here', icon: 'plus', onClick: () => { setScope(f.id); createNote({ folderId: f.id }); } },
      { label: 'New subfolder', icon: 'folderPlus', onClick: () => newFolder(f.id) },
      { label: 'Rename', icon: 'edit', hint: 'F2', onClick: () => { renaming = f.id; renderPane(); } },
      { label: 'Export folder…', icon: 'download', onClick: () => {
        const ids = new Set([f.id, ...store.descendants(f.id)]);
        exportMenu(anchor, f.name || 'Folder', active().filter((n) => ids.has(n.folderId)), f.parentId || '');
      } },
      { label: 'Import files here…', icon: 'upload', onClick: async () => { const made = await QN.exporter.importFiles(f.id); if (made.length) { setScope(f.id); render(); } } },
      { header: 'Colour' },
      ...QN.folders.COLORS.map(([c, label]) => ({ label, swatch: c || 'folder', checked: (f.color || '') === c, onClick: () => { f.color = c; f.updatedAt = util.now(); store.commit(); renderPane(); renderMain(); } })),
      { separator: true },
      { label: 'Delete folder', icon: 'trash', danger: true, onClick: () => deleteFolder(f) },
    ]);
  }

  // ---------- drag & drop onto folders, Favorites, Archive, Trash ----------

  function dropTarget(el, target) {
    const smartTarget = ['favorites', 'archive', 'trash'].includes(target);
    el.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (types.includes(NOTE_MIME) || (types.includes(FOLDER_MIME) && !smartTarget)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drop-ok');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-ok'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-ok');
      const noteId = e.dataTransfer.getData(NOTE_MIME);
      const folderId = e.dataTransfer.getData(FOLDER_MIME);
      if (noteId) {
        const n = store.find('notes', noteId);
        if (!n) return;
        if (target === 'favorites') {
          n.starred = true;
          store.commit();
          renderPane();
          renderBody();
          ui.toast('Added to Favorites');
        } else if (target === 'archive') {
          if (!n.archived) toggleArchive(n);
        } else if (target === 'trash') removeNote(n);
        else {
          if (n.archived) n.archived = false;
          moveNote(n, target);
        }
      } else if (folderId) {
        const f = store.find('folders', folderId);
        if (!f || f.parentId === target) return;
        if (target === folderId || store.descendants(folderId).includes(target)) {
          ui.toast("A folder can't go inside itself", { type: 'error' });
          return;
        }
        f.parentId = target;
        f.updatedAt = util.now();
        if (target) expand(target, true);
        store.commit();
        renderPane();
        ui.toast(`Moved folder to ${QN.folders.path(target) || 'top level'}`);
      }
    });
  }

  const dragNote = (el, n) => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      if (el.dataset.resizing) { e.preventDefault(); return; }
      e.dataTransfer.setData(NOTE_MIME, n.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  };

  // ---------- layout ----------

  function render() {
    if (!root) return;
    if (!isSmart(sel) && !liveFolder(sel)) setScope('all');
    paneEl = h('aside', { class: 'folder-pane', 'aria-label': 'Folders' });
    mainEl = h('section', { class: 'notes-main' });
    searchEl = h('input', {
      class: 'search-input',
      type: 'search',
      placeholder: 'Search · try tag: type: is:open updated:today',
      value: query,
      spellcheck: 'false',
      'aria-label': 'Search notes',
      onInput: (e) => { query = e.target.value; renderBody(); },
      onKeyDown: (e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); query = ''; e.target.value = ''; renderBody(); } },
    });
    root.replaceChildren(h('div', { class: `notes-layout${S().foldersCollapsed ? ' collapsed' : ''}` }, paneEl, mainEl));
    renderPane();
    renderMain();
  }

  function paneRow({ id, label, iconEl, count, target, cls }) {
    const row = h('div', {
      class: `pane-row ${cls || ''}${sel === id ? ' active' : ''}`,
      tabindex: '0',
      role: 'button',
      'data-scope': id,
      onClick: () => selectScope(id),
      onKeyDown: (e) => { if (e.key === 'Enter') selectScope(id); },
    }, iconEl, h('span', { class: 'pane-label' }, label), count ? h('span', { class: 'pane-count' }, count) : null);
    if (target !== undefined) dropTarget(row, target);
    return row;
  }

  function renderPane() {
    if (!paneEl) return;
    const notes = active();
    const counts = {
      all: notes.length,
      favorites: notes.filter((n) => n.starred).length,
      daily: notes.filter((n) => n.daily).length,
      unfiled: notes.filter((n) => !liveFolder(n.folderId)).length,
      archive: store.live('notes').filter((n) => n.archived).length,
      trash: store.state.notes.filter((n) => n.deletedAt).length,
    };
    const targets = { all: '', unfiled: '', favorites: 'favorites', archive: 'archive', trash: 'trash' };
    const expanded = new Set(S().expandedFolders || []);
    const rows = [];
    const walk = (pid, depth) => {
      for (const f of children(pid)) {
        const kids = children(f.id).length > 0;
        rows.push(folderRow(f, depth, kids, expanded.has(f.id)));
        if (kids && expanded.has(f.id)) walk(f.id, depth + 1);
      }
    };
    walk('', 0);

    const tagCounts = new Map();
    for (const n of notes) for (const t of n.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    const tags = [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 24);
    const smartRow = (s) => paneRow({ id: s.id, label: s.label, iconEl: icon(s.icon, s.id === 'favorites' ? 'star-ic' : ''), count: counts[s.id], target: targets[s.id] });

    // replaceChildren() would print null as text, so drop empty slots first.
    paneEl.replaceChildren(...[
      h('div', { class: 'pane-head' }, h('h1', null, 'Notes')),
      h('div', { class: 'pane-list' }, SMART.map(smartRow)),
      h('div', { class: 'pane-section' }, h('span', null, 'Folders'),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'New folder', 'aria-label': 'New folder', onClick: () => newFolder('') }, icon('folderPlus'))),
      rows.length
        ? h('div', { class: 'pane-list tree', role: 'tree' }, rows)
        : h('button', { type: 'button', class: 'pane-empty', onClick: () => newFolder('') }, icon('folderPlus'), 'Create a folder for a project, release or topic'),
      tags.length ? h('div', { class: 'pane-section' }, h('span', null, 'Tags')) : null,
      tags.length ? h('div', { class: 'tag-row pane-tags' }, tags.map(([t, c]) => h('button', {
        type: 'button',
        class: `tag${tagFilter === t ? ' on' : ''}`,
        onClick: () => { tagFilter = tagFilter === t ? '' : t; renderPane(); renderMain(); },
      }, `#${t}`, h('span', { class: 'tag-count' }, c)))) : null,
      h('div', { class: 'spacer' }),
      h('div', { class: 'pane-list pane-bottom' }, BOTTOM.map(smartRow)),
    ].filter(Boolean));
  }

  function folderRow(f, depth, hasKids, isOpen) {
    const count = countIn(f.id);
    const isRenaming = renaming === f.id;
    const row = h('div', {
      class: `pane-row folder-row${sel === f.id ? ' active' : ''}`,
      role: 'treeitem',
      tabindex: '0',
      'aria-expanded': hasKids ? String(isOpen) : null,
      'data-folder': f.id,
      style: { paddingLeft: `${6 + depth * 16}px` },
      onClick: () => { if (!isRenaming) selectScope(f.id); },
      onDblClick: () => { renaming = f.id; renderPane(); },
      onKeyDown: (e) => {
        if (isRenaming) return;
        if (e.key === 'Enter') selectScope(f.id);
        else if (e.key === 'F2') { renaming = f.id; renderPane(); }
        else if (e.key === 'ArrowRight' && hasKids && !isOpen) { expand(f.id, true); renderPane(); }
        else if (e.key === 'ArrowLeft' && hasKids && isOpen) { expand(f.id, false); renderPane(); }
      },
    },
    h('button', {
      type: 'button',
      class: `tree-toggle${hasKids ? '' : ' leaf'}`,
      tabindex: '-1',
      'aria-label': isOpen ? 'Collapse' : 'Expand',
      onClick: (e) => { e.stopPropagation(); if (hasKids) { expand(f.id); renderPane(); } },
    }, hasKids ? icon(isOpen ? 'chevDown' : 'chevR') : null),
    h('span', { class: `folder-ic c-${f.color || 'folder'}` }, icon('folder')),
    isRenaming ? renameInput(f) : h('span', { class: 'pane-label' }, f.name || 'Untitled folder'),
    !isRenaming && count ? h('span', { class: 'pane-count' }, count) : null,
    !isRenaming ? h('button', {
      type: 'button',
      class: 'icon-btn sm row-menu',
      title: 'Folder options',
      'aria-label': 'Folder options',
      onClick: (e) => { e.stopPropagation(); folderMenu(e.currentTarget, f); },
    }, icon('more')) : null);

    if (!isRenaming) {
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(FOLDER_MIME, f.id);
        e.dataTransfer.effectAllowed = 'move';
      });
    }
    dropTarget(row, f.id);
    return row;
  }

  function renameInput(f) {
    const input = h('input', {
      class: 'rename-input',
      value: f.name,
      'aria-label': 'Folder name',
      onClick: (e) => e.stopPropagation(),
      onKeyDown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renaming = null; renderPane(); }
      },
      onBlur: () => {
        if (renaming !== f.id) return;
        const v = input.value.trim();
        if (v && v !== f.name) { f.name = v; f.updatedAt = util.now(); store.commit(); }
        renaming = null;
        renderPane();
        renderMain();
      },
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return input;
  }

  function scopeTitle() {
    const smart = [...SMART, ...BOTTOM].find((s) => s.id === sel);
    if (smart) return h('div', { class: 'scope-title' }, icon(smart.icon, smart.id === 'favorites' ? 'star-ic' : ''), h('h2', null, smart.label));
    const f = liveFolder(sel);
    const path = QN.folders.path(f.parentId);
    return h('div', { class: 'scope-title' },
      h('span', { class: `folder-ic c-${f.color || 'folder'}` }, icon('folder')),
      path ? h('span', { class: 'scope-path' }, `${path} /`) : null,
      h('h2', null, f.name || 'Untitled folder'));
  }

  function newButton() {
    const chevron = h('button', { type: 'button', class: 'btn primary sm split-chevron', title: 'New from template', 'aria-label': 'New from template' }, icon('chevDown'));
    chevron.addEventListener('click', () => {
      const mine = store.live('noteTemplates');
      ui.menu(chevron, [
        { label: 'Blank note', icon: 'plus', hint: 'Ctrl+N', onClick: () => createNote({}) },
        { label: "Today's daily log", icon: 'calendar', onClick: openDaily },
        { header: 'QA templates' },
        ...QN.noteTemplates.filter((t) => t.id !== 'daily').map((t) => ({ label: t.name, icon: t.icon, onClick: () => fromTemplate(t) })),
        mine.length ? { header: 'My templates' } : null,
        ...mine.map((t) => ({
          label: t.name || 'Untitled template',
          icon: 'template',
          onClick: () => fromTemplate(t, true),
          onRemove: async () => {
            if (await ui.confirm('Delete template?', `"${t.name}" moves to Trash. Notes made from it are not affected.`, { confirmLabel: 'Delete', danger: true })) store.trash(t);
          },
        })),
        { separator: true },
        { label: 'New folder', icon: 'folderPlus', onClick: () => newFolder(isSmart(sel) ? '' : sel) },
        { label: 'Import .md / .txt files…', icon: 'upload', onClick: async () => {
          const made = await QN.exporter.importFiles(isSmart(sel) ? '' : sel);
          if (made.length) { if (['archive', 'trash', 'favorites', 'recent', 'daily'].includes(sel)) setScope('all'); render(); }
        } },
      ], { alignRight: true });
    });
    return h('div', { class: 'split-btn' },
      h('button', { type: 'button', class: 'btn primary sm', title: 'New note (Ctrl+N)', onClick: () => createNote({}) }, icon('plus'), 'New'),
      chevron);
  }

  function sortButton() {
    const label = (SORTS.find((s) => s[0] === S().notesSort) || SORTS[0])[1];
    const btn = h('button', { type: 'button', class: 'btn ghost sm', title: `Sort notes: ${label}` }, icon('sort'), h('span', { class: 'sort-label' }, label));
    btn.addEventListener('click', () => ui.menu(btn, [
      { header: 'Sort by' },
      ...SORTS.map(([v, l]) => ({ label: l, checked: S().notesSort === v, onClick: () => { S().notesSort = v; store.commit(); renderMain(); } })),
    ], { alignRight: true }));
    return btn;
  }

  function filterBar() {
    const f = filters();
    const set = (k, v) => { f[k] = v; store.commit(); renderMain(); };
    const types = [['', 'Any type'], ['note', 'Plain note'], ['daily', 'Daily log'], ...QN.noteTemplates.filter((t) => t.id !== 'daily').map((t) => [t.id, t.name]), ['custom', 'My templates']];
    return h('div', { class: 'filter-bar' },
      h('div', { class: 'swatch-row', role: 'group', 'aria-label': 'Filter by colour' },
        h('span', { class: 'filter-label' }, 'Colour'),
        ...[['', 'Any'], ['none', 'No colour'], ...QN.folders.COLORS.filter(([c]) => c)].map(([c, label]) => h('button', {
          type: 'button',
          class: `swatch-btn${f.color === c ? ' on' : ''}`,
          title: label,
          'aria-pressed': f.color === c ? 'true' : 'false',
          onClick: () => set('color', c),
        }, c ? h('span', { class: `swatch c-${c}` }) : h('span', { class: 'swatch-any' }, 'Any')))),
      ui.select(types, f.type, (v) => set('type', v), { class: 'sm', 'aria-label': 'Filter by type' }),
      ui.select(DATES, f.date, (v) => set('date', v), { class: 'sm', 'aria-label': 'Filter by date' }),
      h('button', { type: 'button', class: `chip-toggle${f.open ? ' on' : ''}`, 'aria-pressed': f.open ? 'true' : 'false', onClick: () => set('open', !f.open) }, icon('checklist'), 'Has open to-dos'),
      tagFilter ? h('button', { type: 'button', class: 'chip-toggle on', title: 'Clear tag filter', onClick: () => { tagFilter = ''; renderPane(); renderMain(); } }, `#${tagFilter}`, icon('x')) : null,
      h('div', { class: 'spacer' }),
      activeFilterCount() ? h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { Object.assign(f, { color: '', type: '', date: '', open: false }); tagFilter = ''; store.commit(); renderPane(); renderMain(); } }, 'Clear filters') : null);
  }

  function renderMain() {
    if (!mainEl) return;
    const collapsed = S().foldersCollapsed;
    const nFilters = activeFilterCount();
    countEl = h('span', { class: 'notes-count' });
    bodyEl = h('div', { class: `notes-body view-${view()}` });
    const filterBtn = h('button', {
      type: 'button',
      class: `btn ghost sm${filtersOpen || nFilters ? ' on' : ''}`,
      title: 'Filter by colour, type, date, open to-dos',
      onClick: () => { filtersOpen = !filtersOpen; renderMain(); },
    }, icon('filter'), h('span', { class: 'btn-label' }, 'Filter'), nFilters ? h('span', { class: 'nav-badge' }, nFilters) : null);
    const moreBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Export / import', 'aria-label': 'More' }, icon('more'));
    moreBtn.addEventListener('click', () => {
      const notes = filtered();
      const title = sel === 'all' ? 'All notes' : isSmart(sel) ? [...SMART, ...BOTTOM].find((s) => s.id === sel).label : (liveFolder(sel) || {}).name || 'Notes';
      ui.menu(moreBtn, [
        { header: `Export these ${util.plural(notes.length, 'note')}` },
        ...QN.exporter.formatMenuItems((fmt) => QN.exporter.exportNotes(title, notes, fmt, isSmart(sel) ? '' : (liveFolder(sel) || {}).parentId || '')),
        { separator: true },
        { label: 'Import .md / .txt files…', icon: 'upload', onClick: async () => { const made = await QN.exporter.importFiles(isSmart(sel) ? '' : sel); if (made.length) render(); } },
      ], { alignRight: true });
    });
    mainEl.replaceChildren(...[
      h('header', { class: 'notes-head' },
        h('button', {
          type: 'button',
          class: 'icon-btn',
          title: collapsed ? 'Show folders' : 'Hide folders',
          onClick: () => { S().foldersCollapsed = !collapsed; store.commit(); render(); },
        }, icon('sidebar')),
        scopeTitle(),
        countEl,
        h('div', { class: 'spacer' }),
        h('div', { class: 'search-wrap notes-search' }, icon('search'), searchEl),
        filterBtn,
        sel !== 'recent' && sel !== 'trash' ? sortButton() : null,
        sel !== 'trash' ? ui.seg(VIEWS, view(), (v) => { S().notesView = v; store.commit(); renderMain(); }) : null,
        moreBtn,
        sel !== 'trash' ? newButton() : null),
      filtersOpen || nFilters ? filterBar() : null,
      bodyEl,
    ].filter(Boolean));
    renderBody();
  }

  function renderBody() {
    if (!bodyEl) return;
    const notes = filtered();
    countEl.textContent = util.plural(notes.length, 'note');
    if (view() === 'grid') bodyEl.replaceChildren(renderGrid(notes));
    else if (view() === 'board') bodyEl.replaceChildren(renderBoard(notes));
    else bodyEl.replaceChildren(renderList(notes));
  }

  function emptyState() {
    if (query || activeFilterCount()) return ui.empty('search', 'No notes match', 'Try a different search, or clear the filters.');
    const actions = h('div', { class: 'empty-actions' },
      h('button', { type: 'button', class: 'btn primary', onClick: () => createNote({}) }, icon('plus'), 'New note'),
      h('button', { type: 'button', class: 'btn', onClick: openDaily }, icon('calendar'), "Today's daily log"));
    if (sel === 'favorites') return ui.empty('star', 'No favorites yet', 'Star a note to keep it here and on Home.');
    if (sel === 'recent') return ui.empty('history', 'Nothing viewed yet', 'Notes you open show up here, most recent first.');
    if (sel === 'archive') return ui.empty('archive', 'Archive is empty', 'Archive finished notes to hide them without deleting. Find them here or search with is:archived.');
    if (sel === 'trash') return ui.empty('trash', 'Trash is empty', 'Deleted notes wait here until you remove them for good.');
    if (!isSmart(sel)) return ui.empty('folder', 'This folder is empty', 'Create a note here, or drag notes onto the folder on the left.', actions);
    return ui.empty('notes', 'No notes yet', 'Rich text with headings, checklists and code. Start from a QA template with New ▾.', actions);
  }

  // ---------- list view ----------

  const refreshListSoon = util.debounce(() => renderListItems(), 250);

  function editorFor(n) {
    return QN.editor.create(n, {
      onChange: () => refreshListSoon(),
      onDelete: removeNote,
      onDuplicate: duplicate,
      onArchive: toggleArchive,
    });
  }

  function renderList(notes) {
    listEl = h('div', { class: 'list', role: 'list' });
    const editorPane = h('section', { class: 'editor-pane' });
    renderListItems(notes);
    const n = selectedId && store.find('notes', selectedId);
    if (sel === 'trash') editorPane.append(n && n.deletedAt ? trashPreview(n) : emptyState());
    else if (n && !n.deletedAt) editorPane.append(editorFor(n).el);
    else {
      editorPane.append(notes.length
        ? ui.empty('notes', 'Pick a note', 'Or press Ctrl+N for a new one. Type "# " for a heading, "- " for a list, "[] " for a checklist, "[[" to link a note.')
        : emptyState());
    }
    return h('div', { class: 'notes-split' }, h('div', { class: 'list-pane' }, listEl), editorPane);
  }

  function renderListItems(notesArg) {
    if (!listEl) return;
    const notes = notesArg || filtered();
    if (!notes.length) {
      listEl.replaceChildren(h('div', { class: 'list-empty' }, query || activeFilterCount() ? 'No notes match.' : 'Nothing here yet.'));
      return;
    }
    const words = QN.search.parse(query).words;
    const showFolder = isSmart(sel);
    listEl.replaceChildren(...notes.map((n) => {
      const item = h('div', {
        class: `list-item note-item${n.id === selectedId ? ' active' : ''}`,
        role: 'listitem',
        tabindex: '0',
        'data-id': n.id,
        'data-color': n.color || null,
        onClick: () => { setSelected(n.id); renderBody(); },
        onKeyDown: (e) => { if (e.key === 'Enter') { setSelected(n.id); renderBody(); } },
      },
      h('div', { class: 'li-top' },
        n.starred ? icon('star', 'li-star') : null,
        n.archived && sel !== 'archive' ? icon('archive', 'li-archived') : null,
        h('span', { class: 'li-title' }, QN.search.highlight(QN.noteTitle(n), words)),
        h('span', { class: 'li-time' }, sel === 'trash' ? `deleted ${util.relTime(n.deletedAt)}` : util.relTime(n.updatedAt))),
      h('div', { class: 'li-snippet' }, QN.search.highlight(QN.search.preview(n.text, words, 120), words)),
      h('div', { class: 'li-tags' },
        showFolder && liveFolder(n.folderId) ? h('span', { class: 'mini-folder' }, icon('folder'), QN.folders.path(n.folderId)) : null,
        (n.tags || []).slice(0, 3).map((t) => h('span', { class: 'mini-tag' }, `#${t}`))));
      if (sel !== 'trash') dragNote(item, n);
      return item;
    }));
  }

  function trashPreview(n) {
    const content = h('div', { class: 'rt-view trash-view' });
    content.innerHTML = QN.html.sanitize(n.html);
    return h('div', { class: 'editor form-editor' },
      h('div', { class: 'editor-toolbar' },
        h('div', { class: 'tb-meta' }, icon('trash'), `Deleted ${util.fmtDateTime(n.deletedAt)}`),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn primary sm', onClick: () => { store.restore(n); setSelected(null); renderPane(); renderBody(); ui.toast('Note restored'); } }, icon('undo'), 'Restore'),
        h('button', {
          type: 'button',
          class: 'btn ghost sm danger',
          onClick: async () => {
            if (await ui.confirm('Delete forever?', `"${QN.noteTitle(n)}" will be removed permanently. Older backups still contain it.`, { confirmLabel: 'Delete forever', danger: true })) {
              store.purge('notes', n.id);
              setSelected(null);
              renderPane();
              renderBody();
            }
          },
        }, icon('trash'), 'Delete forever')),
      h('div', { class: 'form-body' }, h('h1', { class: 'note-title static' }, QN.noteTitle(n)), content));
  }

  // ---------- grid view ----------

  function cardHead(n) {
    return h('header', { class: 'card-top' },
      h('span', { class: 'card-title' }, QN.noteTitle(n)),
      h('button', {
        type: 'button',
        class: `icon-btn sm star-btn${n.starred ? ' on' : ''}`,
        title: n.starred ? 'Remove from Favorites' : 'Add to Favorites',
        onClick: (e) => { e.stopPropagation(); n.starred = !n.starred; store.commit(); renderPane(); renderBody(); },
      }, icon('star')));
  }

  function cardBody(n) {
    const div = h('div', { class: 'card-content rt-view' });
    div.innerHTML = QN.html.sanitize(n.html);
    return div;
  }

  function cardFoot(n) {
    return h('footer', { class: 'card-foot' },
      isSmart(sel) && liveFolder(n.folderId) ? h('span', { class: 'mini-folder' }, icon('folder'), liveFolder(n.folderId).name) : null,
      (n.tags || []).slice(0, 2).map((t) => h('span', { class: 'mini-tag' }, `#${t}`)),
      h('span', { class: 'spacer' }),
      h('span', { class: 'li-time' }, util.relTime(n.updatedAt)));
  }

  function renderGrid(notes) {
    if (!notes.length) return emptyState();
    const grid = h('div', { class: 'note-grid' });
    for (const n of notes) {
      const g = n.grid || { c: 1, r: 3 };
      const handle = h('div', { class: 'resize-handle', title: 'Drag to resize' });
      const card = h('article', {
        class: 'note-card',
        'data-color': n.color || null,
        'data-id': n.id,
        style: { gridColumn: `span ${g.c}`, gridRow: `span ${g.r}` },
        onClick: (e) => { if (!e.target.closest('button, .resize-handle')) openDrawer(n.id); },
      }, cardHead(n), cardBody(n), cardFoot(n), handle);
      dragNote(card, n);
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        card.dataset.resizing = '1';
        const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const colW = (grid.clientWidth - GRID.gap * (cols - 1)) / cols;
        const start = { x: e.clientX, y: e.clientY, w: card.offsetWidth, h: card.offsetHeight };
        let c = g.c;
        let r = g.r;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          c = clamp(Math.round((start.w + ev.clientX - start.x + GRID.gap) / (colW + GRID.gap)), 1, Math.min(GRID.maxC, cols));
          r = clamp(Math.round((start.h + ev.clientY - start.y + GRID.gap) / (GRID.row + GRID.gap)), GRID.minR, GRID.maxR);
          card.style.gridColumn = `span ${c}`;
          card.style.gridRow = `span ${r}`;
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          delete card.dataset.resizing;
          n.grid = { c, r };
          store.commit();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
      grid.append(card);
    }
    return h('div', { class: 'board-scroll' },
      h('p', { class: 'board-hint' }, 'Click a card to edit · drag the corner to resize · drag a card onto a folder to move it'),
      grid);
  }

  // ---------- board (canvas) view ----------

  function renderBoard(notes) {
    if (!notes.length) return emptyState();
    const canvas = h('div', { class: 'canvas' });
    const wrap = h('div', { class: 'canvas-wrap' }, canvas);
    const placed = notes.filter((n) => n.board);
    let topZ = Math.max(1, ...placed.map((n) => n.board.z || 1));
    let nextY = placed.length ? Math.max(...placed.map((n) => n.board.y + n.board.h)) + 32 : 32;
    let col = 0;
    const perRow = 4;

    const grow = () => {
      let w = 0;
      let hh = 0;
      for (const c of canvas.children) {
        w = Math.max(w, c.offsetLeft + c.offsetWidth);
        hh = Math.max(hh, c.offsetTop + c.offsetHeight);
      }
      canvas.style.width = `${w + 600}px`;
      canvas.style.height = `${hh + 400}px`;
    };

    for (const n of notes) {
      let b;
      if (n.board) b = { ...n.board };
      else {
        b = { x: 32 + col * (CARD.w + 24), y: nextY, w: CARD.w, h: CARD.h, z: 1 };
        col += 1;
        if (col === perRow) { col = 0; nextY += CARD.h + 24; }
      }
      const handle = h('div', { class: 'resize-handle', title: 'Drag to resize' });
      const card = h('article', {
        class: 'sticky',
        'data-color': n.color || null,
        'data-id': n.id,
        style: { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, zIndex: String(b.z || 1) },
        onDblClick: (e) => { if (!e.target.closest('button, .resize-handle')) openDrawer(n.id); },
      },
      h('header', { class: 'sticky-head' },
        n.starred ? icon('star', 'sticky-star') : null,
        h('span', { class: 'sticky-title' }, QN.noteTitle(n)),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Open', 'aria-label': 'Open note', onClick: () => openDrawer(n.id) }, icon('expand'))),
      cardBody(n),
      handle);

      card.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button, .resize-handle')) return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY, bx: b.x, by: b.y };
        b.z = ++topZ;
        card.style.zIndex = String(b.z);
        card.setPointerCapture(e.pointerId);
        let moved = false;
        const move = (ev) => {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          card.classList.add('dragging');
          b.x = Math.max(0, Math.round(start.bx + dx));
          b.y = Math.max(0, Math.round(start.by + dy));
          card.style.left = `${b.x}px`;
          card.style.top = `${b.y}px`;
        };
        const up = () => {
          card.removeEventListener('pointermove', move);
          card.removeEventListener('pointerup', up);
          card.classList.remove('dragging');
          if (moved || n.board) {
            n.board = { ...b };
            store.commit();
            grow();
          }
        };
        card.addEventListener('pointermove', move);
        card.addEventListener('pointerup', up);
      });

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const start = { x: e.clientX, y: e.clientY, w: b.w, h: b.h };
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          b.w = clamp(Math.round(start.w + ev.clientX - start.x), 180, 900);
          b.h = clamp(Math.round(start.h + ev.clientY - start.y), 120, 900);
          card.style.width = `${b.w}px`;
          card.style.height = `${b.h}px`;
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          n.board = { ...b };
          store.commit();
          grow();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
      canvas.append(card);
    }
    requestAnimationFrame(grow);

    const tidy = () => {
      const before = notes.map((n) => [n, n.board]);
      for (const n of notes) n.board = null;
      store.commit();
      renderBody();
      ui.toast('Cards arranged', { action: { label: 'Undo', fn: () => { for (const [n, b] of before) n.board = b; store.commit(); renderBody(); } } });
    };

    return h('div', { class: 'board-view' },
      h('div', { class: 'board-bar' },
        h('button', { type: 'button', class: 'btn sm', onClick: () => createNote({ color: 'yellow', board: null }) }, icon('plus'), 'Add sticky'),
        h('button', { type: 'button', class: 'btn ghost sm', onClick: tidy }, icon('grid'), 'Tidy up'),
        h('span', { class: 'board-hint' }, 'Drag cards to arrange · drag the corner to resize · double-click to edit')),
      wrap);
  }

  // ---------- side-panel editor for Grid / Board ----------

  function openDrawer(id, focusTitle) {
    const n = store.find('notes', id);
    if (!n || n.deletedAt) return;
    if (drawerRef) drawerRef.close();
    const ed = QN.editor.create(n, {
      onDelete: (note) => { if (drawerRef) drawerRef.close(); removeNote(note); },
      onDuplicate: (note) => { if (drawerRef) drawerRef.close(); duplicate(note); },
      onArchive: toggleArchive,
      onClose: () => { if (drawerRef) drawerRef.close(); },
    });
    drawerRef = ui.drawer(ed.el, {
      label: 'Edit note',
      onClose: () => {
        drawerRef = null;
        if (root) { renderPane(); renderBody(); }
      },
    });
    setTimeout(() => (focusTitle || !n.title ? ed.focusTitle() : ed.focusBody()), 60);
  }

  QN.views = QN.views || {};
  QN.views.notes = {
    mount(el, params = {}) {
      root = el;
      if (!initialized) {
        initialized = true;
        sel = S().notesScope || 'all';
        selectedId = S().lastNoteId || null;
      }
      if (params.folder) setScope(params.folder);
      if (params.scope) setScope(params.scope);
      if (params.select) {
        const n = store.find('notes', params.select);
        if (n) {
          query = '';
          tagFilter = '';
          if (!scopeNotes().includes(n)) setScope(n.deletedAt ? 'trash' : n.archived ? 'archive' : 'all');
          if (view() === 'list') setSelected(n.id);
        }
      }
      if (params.query !== undefined) query = params.query;
      render();
      if (params.select && view() !== 'list') openDrawer(params.select);
      if (params.new) createNote({});
      if (params.daily) openDaily();
      if (params.template) {
        const tpl = QN.noteTemplates.find((t) => t.id === params.template);
        if (tpl) fromTemplate(tpl);
      }
      if (params.newFolder) newFolder('');
    },
    unmount() {
      root = null;
      paneEl = null;
      mainEl = null;
      bodyEl = null;
      listEl = null;
      refreshListSoon.cancel();
    },
    refresh: () => render(),
    onNew: () => createNote({}),
    focusSearch() { if (searchEl) searchEl.focus(); },
    openDaily,
  };
})();
