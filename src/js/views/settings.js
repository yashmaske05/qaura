(function () {
  'use strict';

  const QN = window.QN;
  const { h, icon, util, store, ui } = QN;

  const KIND_LABEL = { tasks: 'Task', notes: 'Note', bugs: 'Bug', checklists: 'Checklist', runs: 'Test run', folders: 'Folder', snippets: 'Snippet', noteTemplates: 'Template', files: 'File' };
  const COUNT_LABEL = [['tasks', 'task'], ['notes', 'note'], ['folders', 'folder'], ['bugs', 'bug'], ['snippets', 'snippet'], ['files', 'file']];
  const BACKUP_LABEL = { daily: 'Daily', launch: 'On launch', auto: 'Automatic', manual: 'Manual', safety: 'Safety copy', 'pre-import': 'Before import', 'pre-restore': 'Before restore' };
  const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

  let root = null;
  let info = null;
  let backups = null;
  let showBackups = false;

  const titleOf = (c, x) => (['runs', 'checklists', 'folders', 'noteTemplates', 'files'].includes(c) ? x.name : x.title) || 'Untitled';
  const countText = (counts) => (counts ? COUNT_LABEL.filter(([k]) => counts[k]).map(([k, w]) => util.plural(counts[k], w)).join(' · ') || 'empty' : 'unreadable');
  const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  async function refreshInfo() {
    info = await window.api.info();
    if (showBackups) backups = await window.api.listBackups();
    render();
  }

  async function restoreBackup(b) {
    const ok = await ui.confirm('Restore this backup?',
      `Your current data will be replaced with the backup from ${new Date(b.mtime).toLocaleString()} (${countText(b.counts)}). A copy of your current data is saved first, so you can undo this from the backup list.`,
      { confirmLabel: 'Restore backup' });
    if (!ok) return;
    try {
      await store.flush();
      const { text } = await window.api.readBackup(b.name);
      await window.api.snapshot('pre-restore');
      store.replaceAll(JSON.parse(text));
      await store.flush();
      QN.app.applyTheme();
      ui.toast('Backup restored');
      refreshInfo();
    } catch (err) {
      ui.alert('Restore failed', `Nothing was changed. ${err.message}`);
    }
  }

  async function importData() {
    try {
      const res = await window.api.importData();
      if (!res) return;
      const ok = await ui.confirm('Replace your data with this file?',
        `${res.path}\n\nIt contains ${countText(res.counts)}. Your current data is backed up first, so you can restore it from the backup list.`,
        { confirmLabel: 'Import and replace', danger: true });
      if (!ok) return;
      await store.flush();
      await window.api.snapshot('pre-import');
      store.replaceAll(JSON.parse(res.text));
      await store.flush();
      QN.app.applyTheme();
      ui.toast('Data imported');
      refreshInfo();
    } catch (err) {
      ui.alert('Import failed', `Nothing was changed. ${err.message}`);
    }
  }

  async function chooseMirror() {
    try {
      const res = await window.api.chooseMirror();
      if (!res) return;
      ui.toast(res.mirrorStatus && res.mirrorStatus.ok ? 'Second copy saved to that folder' : 'Folder set, but the copy failed (see below)', { type: res.mirrorStatus && res.mirrorStatus.ok ? '' : 'error' });
      refreshInfo();
    } catch (err) {
      ui.alert('Could not use that folder', err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }

  function render() {
    if (!root) return;
    const s = store.state.settings;
    const trashed = store.trashed();

    const section = (id, ic, title, sub, ...body) => h('section', { class: 'card settings-card', id: `settings-${id}` },
      h('header', { class: 'card-head' }, icon(ic), h('h2', null, title)),
      sub ? h('p', { class: 'muted small card-sub' }, sub) : null,
      ...body);

    const mirror = info && info.mirrorDir
      ? h('div', { class: 'setting-row' },
        h('div', { class: 'setting-text' },
          h('div', { class: 'setting-title' }, 'Second backup copy'),
          h('div', { class: 'mono small path' }, `${info.mirrorDir}\\QAura Backups`),
          info.mirrorStatus ? h('div', { class: `small ${info.mirrorStatus.ok ? 'ok-text' : 'err-text'}` },
            info.mirrorStatus.ok ? `Last copied ${util.relTime(new Date(info.mirrorStatus.at).toISOString())}` : `Last copy failed: ${info.mirrorStatus.error}`) : null),
        h('button', { type: 'button', class: 'btn sm', onClick: () => window.api.openPath('mirror') }, icon('folder'), 'Open'),
        h('button', { type: 'button', class: 'btn ghost sm', onClick: chooseMirror }, 'Change'),
        h('button', { type: 'button', class: 'btn ghost sm', onClick: async () => { await window.api.clearMirror(); refreshInfo(); } }, 'Stop'))
      : h('div', { class: 'setting-row callout' },
        icon('alert', 'callout-icon'),
        h('div', { class: 'setting-text' },
          h('div', { class: 'setting-title' }, 'Recommended: keep a second copy'),
          h('div', { class: 'muted small' }, 'Everything is saved on this laptop. Pick a OneDrive or network folder and the app copies your latest data and daily backups there, so nothing is lost if this laptop fails. Check that your company allows work notes in that folder.')),
        h('button', { type: 'button', class: 'btn primary sm', onClick: chooseMirror }, icon('folder'), 'Choose folder'));

    root.replaceChildren(h('div', { class: 'view view-narrow settings' },
      h('header', { class: 'view-head' }, h('div', { class: 'view-title' }, h('h1', null, 'Settings'))),

      section('safety', 'shield', 'Data safety', 'Every change is saved to disk within half a second. The previous version is kept too, and backups are taken on launch, every 30 minutes while you work, and once a day (last 90 days kept).',
        info ? h('div', { class: 'safety-grid' },
          h('div', { class: 'setting-row' },
            h('div', { class: 'setting-text' },
              h('div', { class: 'setting-title' }, 'Your data file'),
              h('div', { class: 'mono small path' }, info.dataFile)),
            h('button', { type: 'button', class: 'btn sm', onClick: () => window.api.openPath('data') }, icon('folder'), 'Open folder')),
          h('div', { class: 'setting-row' },
            h('div', { class: 'setting-text' },
              h('div', { class: 'setting-title' }, `Stored files (incl. versions): ${info.attachments ? info.attachments.count : 0}${info.attachments && info.attachments.bytes ? ` (${fmtSize(info.attachments.bytes)})` : ''}`),
              h('div', { class: 'muted small' }, 'Screenshots, PDFs, Office files, logs and recordings are kept as separate files that are never changed or deleted (each edit is a new version). Included in the second backup copy and in full exports.')),
            h('button', { type: 'button', class: 'btn sm', onClick: () => window.api.openPath('attachments') }, icon('folder'), 'Open folder')),
          h('div', { class: 'setting-row' },
            h('div', { class: 'setting-text' },
              h('div', { class: 'setting-title' }, `Backups: ${info.backupCount}`),
              h('div', { class: 'muted small' }, info.latestBackup ? `Latest: ${new Date(info.latestBackup.mtime).toLocaleString()}` : 'The first backup is taken after your first change.')),
            h('button', { type: 'button', class: 'btn sm', onClick: () => QN.app.backupNow().then(refreshInfo) }, icon('shield'), 'Back up now'),
            h('button', { type: 'button', class: 'btn ghost sm', onClick: async () => { showBackups = !showBackups; if (showBackups) backups = await window.api.listBackups(); render(); } }, showBackups ? 'Hide list' : 'Show & restore')),
          showBackups ? backupList() : null,
          mirror,
          h('div', { class: 'setting-row' },
            h('div', { class: 'setting-text' },
              h('div', { class: 'setting-title' }, 'Export / import'),
              h('div', { class: 'muted small' }, 'Save everything to a single file (e.g. before a laptop change), or load such a file.')),
            h('button', { type: 'button', class: 'btn sm', onClick: () => QN.app.exportData() }, icon('download'), 'Export'),
            h('button', { type: 'button', class: 'btn ghost sm', onClick: importData }, icon('upload'), 'Import')))
          : h('div', { class: 'muted small' }, 'Loading…')),

      section('appearance', 'moon', 'Appearance', null,
        h('div', { class: 'setting-row' },
          h('div', { class: 'setting-text' }, h('div', { class: 'setting-title' }, 'Theme')),
          ui.seg([['dark', 'Dark'], ['light', 'Light'], ['system', 'Match Windows']], s.theme, (v) => { s.theme = v; store.commit(); QN.app.applyTheme(); render(); }))),

      section('week', 'calendar', 'Working days', 'Used by Standup to decide what "yesterday" means. On Monday it covers Friday through Sunday.',
        h('div', { class: 'day-toggles' }, DAYS.map(([d, label]) => h('button', {
          type: 'button',
          class: `day-toggle${s.workdays.includes(d) ? ' on' : ''}`,
          'aria-pressed': s.workdays.includes(d) ? 'true' : 'false',
          onClick: () => {
            const set = new Set(s.workdays);
            if (set.has(d)) set.delete(d); else set.add(d);
            if (!set.size) return;
            s.workdays = [...set].sort();
            store.commit();
            render();
          },
        }, label)))),

      section('trash', 'trash', `Trash (${trashed.length})`, 'Deleted items stay here until you remove them for good.',
        trashed.length
          ? h('div', null,
            h('ul', { class: 'trash-list' }, trashed.slice(0, 100).map(({ c, item }) => h('li', null,
              h('span', { class: 'pill gray' }, KIND_LABEL[c]),
              h('span', { class: 'trash-title' }, titleOf(c, item), item.trashedWith ? h('span', { class: 'muted small' }, ' (with its folder)') : null),
              h('span', { class: 'muted small' }, `deleted ${util.relTime(item.deletedAt)}`),
              h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { store.restore(item); render(); ui.toast(`${KIND_LABEL[c]} restored`); } }, icon('undo'), 'Restore'),
              h('button', {
                type: 'button',
                class: 'icon-btn danger',
                title: 'Delete forever',
                onClick: async () => {
                  if (await ui.confirm('Delete forever?', `"${titleOf(c, item)}" will be removed permanently. Older backups still contain it.`, { confirmLabel: 'Delete forever', danger: true })) {
                    store.purge(c, item.id);
                    render();
                  }
                },
              }, icon('x'))))),
            h('div', { class: 'row-actions' }, h('div', { class: 'spacer' }),
              h('button', {
                type: 'button',
                class: 'btn ghost sm danger',
                onClick: async () => {
                  if (await ui.confirm('Empty Trash?', `${util.plural(trashed.length, 'item')} will be removed permanently. A safety backup is taken first.`, { confirmLabel: 'Empty Trash', danger: true })) {
                    await store.flush();
                    await window.api.snapshot('manual');
                    for (const { c, item } of trashed) store.purge(c, item.id);
                    render();
                    ui.toast('Trash emptied');
                  }
                },
              }, icon('trash'), 'Empty Trash')))
          : h('div', { class: 'muted small' }, 'Trash is empty.')),

      section('keys', 'bolt', 'Keyboard shortcuts', null,
        h('div', { class: 'shortcuts' }, [
          ['Ctrl K', 'Search everything / run a command'],
          ['Ctrl N', 'New item in the current section'],
          ['Ctrl 1 … 7', 'Home, Tasks, Notes, Bugs, Snippets, Standup, Files'],
          ['Ctrl ,', 'Settings'],
          ['Ctrl F', 'Search in Notes / Bugs / Snippets'],
          ['Ctrl S', 'Save now (it also saves automatically)'],
          ['Ctrl B / I / U', 'Bold / italic / underline in notes'],
          ['Ctrl E', 'Inline code in notes'],
          ['Ctrl Shift H', 'Highlight in notes'],
          ['Ctrl K (in a note)', 'Add a link'],
          ['# - [] 1. > ```', 'Type at line start + space to format'],
          ['Ctrl Enter', 'Leave a code block'],
          ['[[', 'Link to another note (Ctrl+click a link to open it)'],
          ['Ctrl Shift F', 'Distraction-free mode (Esc to leave)'],
          ['tag: type: is: in:', 'Search operators, e.g. is:open updated:last-7-days'],
          ['Ctrl + / Ctrl − / Ctrl 0', 'Zoom in / out / reset'],
        ].map(([k, d]) => h('div', { class: 'shortcut' }, h('kbd', null, k), h('span', null, d))))),

      info ? h('p', { class: 'muted small about' }, `QAura ${info.version} · the QA workspace · Electron ${info.electron}`) : null));
  }

  function backupList() {
    if (!backups) return h('div', { class: 'muted small' }, 'Loading…');
    if (!backups.length) return h('div', { class: 'muted small' }, 'No backups yet.');
    return h('ul', { class: 'backup-list' }, backups.slice(0, 60).map((b) => h('li', null,
      h('span', { class: 'pill gray' }, BACKUP_LABEL[b.kind] || b.kind),
      h('div', { class: 'backup-text' },
        h('div', null, new Date(b.mtime).toLocaleString()),
        h('div', { class: 'muted small' }, `${countText(b.counts)} · ${fmtSize(b.size)}`)),
      h('button', { type: 'button', class: 'btn ghost sm', disabled: !b.counts, onClick: () => restoreBackup(b) }, icon('undo'), 'Restore'))));
  }

  QN.views = QN.views || {};
  QN.views.settings = {
    mount(el, params = {}) {
      root = el;
      render();
      refreshInfo().then(() => {
        if (params.section) {
          const target = document.getElementById(`settings-${params.section}`);
          if (target) target.scrollIntoView({ block: 'start' });
        }
      });
    },
    unmount() { root = null; },
    refresh: () => render(),
  };
})();
