(function () {
  'use strict';

  // Ctrl+K: search everything (with operators) and run any action from one box.
  const QN = window.QN;
  const { h, icon, util, store, defs } = QN;
  let openEntry = null;
  let lastQuery = '';

  const OPERATORS = [
    ['tag:', 'tag:regression'], ['type:', 'type:bug · type:test-case'], ['is:', 'is:favorite · is:open · is:archived'],
    ['in:', 'in:"Release 2.4"'], ['updated:', 'updated:last-7-days'], ['created:', 'created:this-month'],
  ];

  function actions() {
    const go = (view, params) => () => QN.app.go(view, params);
    return [
      { label: 'New note', icon: 'notes', hint: 'Ctrl+N', run: go('notes', { new: true }) },
      { label: 'New task', icon: 'tasks', run: go('tasks', { new: true }) },
      { label: 'Log a bug', icon: 'bug', run: go('bugs', { new: true }) },
      { label: "Open today's daily note", icon: 'calendar', run: go('notes', { daily: true }) },
      { label: 'New folder', icon: 'folderPlus', run: go('notes', { newFolder: true }) },
      { label: 'New snippet', icon: 'snippet', run: go('snippets', { new: true }) },
      { label: 'Add files…', icon: 'upload', run: go('files', { add: true }) },
      ...QN.noteTemplates.filter((t) => t.id !== 'daily').map((t) => ({ label: `New note from template: ${t.name}`, icon: t.icon, run: go('notes', { template: t.id }) })),
      { label: 'Generate standup summary', icon: 'standup', run: go('standup') },
      { label: 'Favorite notes', icon: 'star', run: go('notes', { scope: 'favorites' }) },
      { label: 'Recently viewed notes', icon: 'history', run: go('notes', { scope: 'recent' }) },
      { label: 'Archived notes', icon: 'archive', run: go('notes', { scope: 'archive' }) },
      { label: 'Go to Home', icon: 'home', hint: 'Ctrl+1', run: go('home') },
      { label: 'Go to Tasks', icon: 'tasks', hint: 'Ctrl+2', run: go('tasks') },
      { label: 'Go to Notes', icon: 'notes', hint: 'Ctrl+3', run: go('notes') },
      { label: 'Go to Bugs', icon: 'bug', hint: 'Ctrl+4', run: go('bugs') },
      { label: 'Go to Snippets', icon: 'snippet', hint: 'Ctrl+5', run: go('snippets') },
      { label: 'Go to Standup', icon: 'standup', hint: 'Ctrl+6', run: go('standup') },
      { label: 'Go to Files', icon: 'paperclip', hint: 'Ctrl+7', run: go('files') },
      { label: 'Settings & backups', icon: 'settings', hint: 'Ctrl+,', run: go('settings') },
      { label: 'Start a focus timer', icon: 'clock', run: () => QN.focus.menu() },
      { label: 'Distraction-free mode', icon: 'zen', hint: 'Ctrl+Shift+F', run: () => QN.app.toggleZen() },
      { label: 'Toggle light / dark theme', icon: 'moon', run: () => QN.app.toggleTheme() },
      { label: 'Back up now', icon: 'shield', run: () => QN.app.backupNow() },
      { label: 'Export all data (backup file)…', icon: 'download', run: () => QN.app.exportData() },
      { label: 'Open Trash', icon: 'trash', run: go('settings', { section: 'trash' }) },
    ];
  }

  const ICON = { note: 'notes', task: 'tasks', bug: 'bug', snippet: 'snippet', file: 'paperclip', folder: 'folder' };

  function resultOf(d) {
    const x = d.item;
    switch (d.kind) {
      case 'note': return { hint: [d.folder || 'Note', util.relTime(x.updatedAt)].join(' · '), run: () => QN.app.go('notes', { select: x.id }) };
      case 'task': return { hint: `Task · ${defs.label(defs.taskStatus, x.status)} · ${util.relDay(x.date)}`, run: () => QN.app.go('tasks', { focus: x.id }) };
      case 'bug': return { hint: `Bug · ${defs.label(defs.bugStatus, x.status)}`, run: () => QN.app.go('bugs', { select: x.id }) };
      case 'snippet': return { hint: `Snippet · ${x.language}`, run: () => QN.app.go('snippets', { select: x.id }) };
      case 'file': return { hint: `File · ${QN.files.KIND[QN.files.kindOf(x)].label} · ${QN.files.fmtSize(QN.files.latest(x).size)}`, run: () => QN.app.go('files', { select: x.id }) };
      default: return { hint: 'Folder', run: () => QN.app.go('notes', { folder: x.id }) };
    }
  }

  function open() {
    if (openEntry) {
      openEntry.close();
      return;
    }
    let results = [];
    let active = 0;
    const input = h('input', { class: 'palette-input', placeholder: 'Search everything… or type a command  (tag: type: is: in: updated:)', 'aria-label': 'Search or run a command', spellcheck: 'false', value: lastQuery });
    const list = h('div', { class: 'palette-list', role: 'listbox' });

    const render = () => {
      const q = input.value.trim();
      lastQuery = input.value;
      const p = QN.search.parse(q);
      const ticket = (q.match(/^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,6}$/) || [])[0];
      const acts = actions().filter((a) => !q || (!p.hasFilters && util.matches(a.label, q)));
      if (ticket) acts.unshift({ label: `Open ticket hub for ${ticket.toUpperCase()}`, icon: 'link', hint: 'everything that mentions it', run: () => QN.tickets.openHub(ticket.toUpperCase()) });
      const found = q ? QN.search.searchAll(p, 40) : [];
      const items = found.map((d) => ({ ...resultOf(d), label: d.title, icon: d.starred ? 'star' : ICON[d.kind], preview: d.kind === 'folder' ? '' : QN.search.preview(d.body, p.words, 120), words: p.words }));
      results = [...items, ...acts];
      active = Math.min(active, Math.max(0, results.length - 1));

      const rows = [];
      const section = (title, arr, offset) => {
        if (!arr.length) return;
        rows.push(h('div', { class: 'palette-section' }, title));
        arr.forEach((r, i) => {
          const idx = offset + i;
          rows.push(h('div', {
            class: `palette-item${idx === active ? ' active' : ''}${r.preview && r.words && r.words.length ? ' has-preview' : ''}`,
            role: 'option',
            'aria-selected': idx === active ? 'true' : 'false',
            onMouseMove: () => { if (active !== idx) { active = idx; render(); } },
            onMouseDown: (e) => { e.preventDefault(); choose(idx); },
          },
          icon(r.icon),
          h('div', { class: 'palette-text' },
            h('span', { class: 'palette-label' }, r.words ? QN.search.highlight(r.label, r.words) : r.label),
            r.preview && r.words && r.words.length ? h('span', { class: 'palette-preview' }, QN.search.highlight(r.preview, r.words)) : null),
          r.hint ? h('span', { class: 'palette-hint' }, r.hint) : null));
        });
      };
      section(found.length ? `Results · ${found.length}${found.length === 40 ? '+' : ''}` : 'Results', items, 0);
      section(q ? 'Actions' : 'Quick actions', acts, items.length);
      if (!results.length) rows.push(h('div', { class: 'palette-empty' }, `No matches for "${q}"`));
      list.replaceChildren(...rows);
      const el = list.querySelector('.palette-item.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    };

    const choose = (idx) => {
      const r = results[idx];
      close();
      if (r) setTimeout(r.run, 0);
    };

    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });

    const tips = h('div', { class: 'palette-tips' }, OPERATORS.map(([op, example]) => h('button', {
      type: 'button',
      class: 'op-chip',
      title: `e.g. ${example}`,
      onMouseDown: (e) => {
        e.preventDefault();
        input.value = `${input.value.trim() ? `${input.value.trim()} ` : ''}${op}`;
        input.focus();
        active = 0;
        render();
      },
    }, op)));

    const panel = h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' },
      h('div', { class: 'palette-search' }, icon('search'), input, h('kbd', null, 'Esc')),
      tips,
      list,
      h('div', { class: 'palette-foot' },
        h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' move'),
        h('span', null, h('kbd', null, 'Enter'), ' open'),
        h('span', { class: 'spacer' }),
        h('span', null, 'Archived notes only with is:archived')));
    const overlay = h('div', { class: 'overlay palette-overlay', onMouseDown: (e) => { if (e.target === overlay) close(); } }, panel);
    const prevFocus = document.activeElement;
    function close() {
      if (!openEntry) return;
      openEntry = null;
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 140);
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus();
    }
    openEntry = { close };
    document.getElementById('overlay-root').append(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    render();
    input.focus();
    input.select(); // keeps the last search, but typing replaces it
  }

  QN.palette = { open, isOpen: () => Boolean(openEntry) };
})();
