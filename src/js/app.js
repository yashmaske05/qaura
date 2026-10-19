(function () {
  'use strict';

  const QN = window.QN;
  const { h, icon, util, store, make, ui } = QN;

  const NAV = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'tasks', label: 'Tasks', icon: 'tasks' },
    { id: 'notes', label: 'Notes', icon: 'notes' },
    { id: 'bugs', label: 'Bugs', icon: 'bug' },
    { id: 'snippets', label: 'Snippets', icon: 'snippet' },
    { id: 'standup', label: 'Standup', icon: 'standup' },
    { id: 'files', label: 'Files', icon: 'paperclip' },
  ];

  const main = document.getElementById('main');
  const sidebar = document.getElementById('sidebar');
  let currentId = null;
  let renderedDay = util.today();
  let enterTimer = null;

  function badges() {
    const today = util.today();
    return {
      tasks: store.live('tasks').filter((t) => t.date === today && t.status !== 'done').length,
      bugs: store.live('bugs').filter(QN.bugs.isActive).length,
    };
  }

  function renderSidebar() {
    const b = badges();
    const item = (n) => h('button', {
      type: 'button',
      class: `nav-item${n.id === currentId ? ' active' : ''}`,
      'aria-current': n.id === currentId ? 'page' : null,
      onClick: () => QN.app.go(n.id),
    }, icon(n.icon), h('span', null, n.label), b[n.id] ? h('span', { class: 'nav-badge' }, b[n.id]) : null);
    sidebar.replaceChildren(
      h('div', { class: 'nav-group' }, NAV.map(item)),
      h('div', { class: 'spacer' }),
      h('div', { class: 'nav-group' }, item({ id: 'settings', label: 'Settings', icon: 'settings' })),
      saveStatus());
  }

  function saveStatus() {
    const map = {
      saved: ['ok', 'All changes saved'],
      pending: ['busy', 'Saving…'],
      saving: ['busy', 'Saving…'],
      error: ['err', 'Not saved, retrying…'],
      readonly: ['err', 'Read-only (data protected)'],
    };
    const [cls, text] = map[store.status] || map.saved;
    return h('button', {
      type: 'button',
      class: `save-status ${cls}`,
      title: store.status === 'error' ? store.lastError : 'Open data safety settings',
      onClick: () => QN.app.go('settings', { section: 'safety' }),
    }, h('span', { class: 'dot' }), text);
  }

  function applyTheme() {
    const theme = store.state.settings.theme || 'dark';
    window.api.setTheme(theme);
  }

  async function backupNow() {
    await store.flush();
    const name = await window.api.snapshot('manual');
    ui.toast(name ? 'Backup saved' : 'Nothing to back up yet');
  }

  async function exportData() {
    await store.flush();
    try {
      const res = await window.api.exportData(JSON.stringify(store.state, null, 2));
      if (res) ui.toast(`Exported to ${res.path}`, { timeout: 5000 });
    } catch (err) {
      ui.alert('Export failed', err.message);
    }
  }

  // Distraction-free: hide everything except the note you are writing.
  function toggleZen(force) {
    const on = force === undefined ? !document.body.classList.contains('zen') : force;
    document.body.classList.toggle('zen', on);
    let pill = document.getElementById('zen-exit');
    if (on && !pill) {
      pill = h('button', { type: 'button', id: 'zen-exit', class: 'zen-exit', onClick: () => toggleZen(false) }, icon('zen'), 'Exit focus mode', h('kbd', null, 'Esc'));
      document.body.append(pill);
    } else if (!on && pill) pill.remove();
  }

  function toggleTheme() {
    const s = store.state.settings;
    const darkNow = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    s.theme = darkNow ? 'light' : 'dark';
    store.commit();
    applyTheme();
    if (currentId === 'settings') QN.app.refresh();
  }

  function seed() {
    const s = store.state.settings;
    if (s.seeded) return;
    s.seeded = true;
    store.commit();
  }

  QN.app = {
    go(id, params) {
      const view = QN.views[id];
      if (!view) return;
      ui.closeAll();
      const prev = QN.views[currentId];
      if (prev && prev.unmount) prev.unmount();
      currentId = id;
      renderedDay = util.today();
      main.replaceChildren();
      main.scrollTop = 0;
      main.dataset.view = id;
      // Animate only when switching sections, not on every re-render.
      main.classList.add('entering');
      clearTimeout(enterTimer);
      enterTimer = setTimeout(() => main.classList.remove('entering'), 300);
      view.mount(main, params || {});
      renderSidebar();
    },
    refresh() {
      const view = QN.views[currentId];
      if (view && view.refresh) view.refresh();
      renderSidebar();
    },
    current: () => currentId,
    applyTheme,
    toggleTheme,
    toggleZen,
    backupNow,
    exportData,
  };

  // ---------- keyboard ----------

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'k' && !(e.target && e.target.closest && e.target.closest('.rt-editor'))) {
      e.preventDefault();
      QN.palette.open();
      return;
    }
    if (mod && e.shiftKey && key === 'f') {
      e.preventDefault();
      toggleZen();
      return;
    }
    if (e.key === 'Escape' && document.body.classList.contains('zen') && !ui.hasModal() && !QN.palette.isOpen()) {
      toggleZen(false);
      return;
    }
    if (mod && key === 's') {
      e.preventDefault();
      store.flush().then((ok) => ui.toast(ok ? 'All changes saved' : 'Could not save, see Settings', { type: ok ? '' : 'error' }));
      return;
    }
    if (ui.hasModal() || QN.palette.isOpen()) return;
    const view = QN.views[currentId];
    if (mod && /^[1-7]$/.test(e.key)) {
      e.preventDefault();
      QN.app.go(NAV[Number(e.key) - 1].id);
    } else if (mod && e.key === ',') {
      e.preventDefault();
      QN.app.go('settings');
    } else if (mod && key === 'n' && !e.shiftKey) {
      e.preventDefault();
      if (view && view.onNew) view.onNew();
    } else if (mod && key === 'f' && view && view.focusSearch) {
      e.preventDefault();
      view.focusSearch();
    }
  });

  // ---------- startup ----------

  async function init() {
    document.getElementById('cmdk-trigger').append(icon('search'), h('span', null, 'Search or run a command…'), h('kbd', null, 'Ctrl K'));
    document.getElementById('cmdk-trigger').addEventListener('click', () => QN.palette.open());

    // If a core component failed to load, never save: a broken sanitizer could damage notes.
    const missing = [['marked', window.marked], ['DOMPurify', window.DOMPurify]].filter(([, lib]) => !lib).map(([name]) => name);
    if (missing.length) {
      store.readOnly = true;
      store.setStatus('readonly');
    }

    let res = {};
    try {
      res = await store.load();
    } catch (err) {
      res = { error: `Could not load your data: ${err.message}. Nothing was overwritten.` };
      store.readOnly = true;
      store.setStatus('readonly');
    }
    applyTheme();
    if (!store.readOnly) seed();

    store.on(renderSidebar);
    document.addEventListener('qn:save-status', () => {
      const old = sidebar.querySelector('.save-status');
      if (old) old.replaceWith(saveStatus());
    });

    QN.focus.init(document.getElementById('titlebar-tools'));
    QN.app.go('home');
    // Picks up saves made in Word/Excel (even while QAura was closed) and files opened from File Explorer.
    if (!store.readOnly) QN.files.init();
    document.body.classList.add('ready');

    if (res.notice) ui.toast(res.notice, { timeout: 9000 });
    if (res.warning) ui.alert('Your data was recovered', res.warning);
    if (res.error) ui.alert('Read-only mode', res.error);
    if (missing.length) ui.alert('Read-only mode', `A required part of the app (${missing.join(', ')}) failed to load, so saving is turned off to protect your data. Nothing has been changed. Please reinstall or rebuild the app.`);
  }

  // Save synchronously as the window closes, so the last keystrokes are never lost.
  window.addEventListener('beforeunload', () => store.flushSync());

  // If the app stays open past midnight, refresh "today" when you come back to it.
  window.addEventListener('focus', () => {
    if (util.today() !== renderedDay && currentId && !ui.hasModal()) {
      renderedDay = util.today();
      QN.app.refresh();
    }
  });

  init();
})();
