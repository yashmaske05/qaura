(function () {
  'use strict';

  const QN = window.QN;
  const { util } = QN;

  const COLLECTIONS = ['tasks', 'notes', 'bugs', 'checklists', 'runs', 'folders', 'snippets', 'noteTemplates', 'files'];
  const SAVE_DELAY_MS = 400; // save after a short pause in typing…
  const MAX_WAIT_MS = 2000; // …but never later than this while changes keep coming

  function defaults() {
    return {
      schema: 1,
      tasks: [],
      notes: [],
      bugs: [],
      checklists: [],
      runs: [],
      folders: [],
      snippets: [],
      noteTemplates: [],
      files: [],
      settings: {
        theme: 'dark', workdays: [1, 2, 3, 4, 5], seeded: false, seededSnippets: false,
        // Remembered places and filters
        notesView: 'list', foldersCollapsed: false, expandedFolders: [], notesScope: 'all', lastNoteId: '', notesSort: 'updated',
        noteFilters: { color: '', type: '', date: '', open: false },
        bugFilters: { status: 'active', severity: '' }, snippetLang: '', tasksMode: 'day', checklistsTab: 'runs', focus: null,
        fileViewerMax: false,
      },
    };
  }

  // Fill in anything missing, but never drop data we don't recognise.
  function normalize(raw) {
    const d = defaults();
    if (!raw || typeof raw !== 'object') return d;
    for (const key of Object.keys(raw)) {
      if (!(key in d)) d[key] = raw[key];
    }
    for (const c of COLLECTIONS) {
      d[c] = Array.isArray(raw[c])
        ? raw[c].filter((x) => x && typeof x === 'object').map((x) => (x.id ? x : { ...x, id: util.uid() }))
        : [];
    }
    if (raw.settings && typeof raw.settings === 'object') Object.assign(d.settings, raw.settings);
    return d;
  }

  // Older notes were Markdown with a "pinned" flag. Convert them to rich text and a star,
  // keeping the original Markdown inside the note (mdSource) so nothing is ever lost.
  function migrate(d) {
    let changed = false;
    for (const n of d.notes) {
      if (typeof n.html !== 'string') {
        const md = typeof n.body === 'string' ? n.body : '';
        n.html = md ? QN.html.fromMarkdown(md) : '';
        if (md) n.mdSource = md;
        delete n.body;
        changed = true;
      }
      if (typeof n.text !== 'string') {
        n.text = QN.html.toText(n.html);
        changed = true;
      }
      if ('pinned' in n) {
        n.starred = Boolean(n.starred || n.pinned);
        delete n.pinned;
        changed = true;
      }
    }
    // Bug screenshots used to live in bug.attachments; they become shared file records.
    for (const b of d.bugs) {
      if (!Array.isArray(b.attachments)) continue;
      b.files = Array.isArray(b.files) ? b.files : [];
      for (const a of b.attachments) {
        if (!a || !a.id) continue;
        const f = make.file({
          name: a.name || 'Screenshot',
          versions: [{ blob: a.id, size: a.size || 0, at: a.addedAt || b.createdAt || util.now(), source: 'Added' }],
          createdAt: a.addedAt || b.createdAt || util.now(),
        });
        d.files.push(f);
        b.files.push(f.id);
      }
      delete b.attachments;
      changed = true;
    }
    return changed;
  }

  const listeners = new Set();
  let dirty = false;
  let firstDirtyAt = 0;
  let timer = null;
  let retryTimer = null;
  let saving = null;

  const store = {
    COLLECTIONS,
    state: defaults(),
    readOnly: false,
    status: 'saved', // saved | pending | saving | error | readonly
    lastError: '',
    lastSavedAt: null,

    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      for (const fn of listeners) {
        try { fn(); } catch (err) { console.error(err); }
      }
    },
    setStatus(s) {
      store.status = s;
      document.dispatchEvent(new CustomEvent('qn:save-status'));
    },

    async load() {
      const res = (await window.api.load()) || {};
      store.state = normalize(res.data);
      if (res.error) {
        store.readOnly = true;
        store.setStatus('readonly');
      } else if (migrate(store.state)) {
        store.commit();
      }
      return res;
    },

    commit() {
      if (store.readOnly) return;
      if (!dirty) firstDirtyAt = Date.now();
      dirty = true;
      store.setStatus('pending');
      clearTimeout(timer);
      timer = setTimeout(() => store.flush(), Date.now() - firstDirtyAt >= MAX_WAIT_MS ? 0 : SAVE_DELAY_MS);
      store.emit();
    },

    async flush() {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      if (store.readOnly) return false;
      if (saving) await saving;
      if (!dirty) return true;
      dirty = false;
      store.setStatus('saving');
      const text = JSON.stringify(store.state, null, 2);
      saving = window.api.save(text).then(
        () => {
          store.lastSavedAt = Date.now();
          store.setStatus(dirty ? 'pending' : 'saved');
          return true;
        },
        (err) => {
          dirty = true;
          store.lastError = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
          store.setStatus('error');
          retryTimer = setTimeout(() => store.flush(), 3000);
          return false;
        },
      ).finally(() => { saving = null; });
      return saving;
    },

    // Used while the window closes: blocks until the data is on disk.
    flushSync() {
      if (!dirty || store.readOnly) return;
      clearTimeout(timer);
      const res = window.api.saveSync(JSON.stringify(store.state, null, 2));
      if (res && res.ok) dirty = false;
    },

    hasUnsaved: () => dirty || Boolean(saving),

    replaceAll(raw) {
      store.state = normalize(raw);
      migrate(store.state);
      store.commit();
    },

    live: (c) => store.state[c].filter((x) => !x.deletedAt),
    find: (c, id) => store.state[c].find((x) => x.id === id),

    add(c, item) {
      store.state[c].push(item);
      store.commit();
      return item;
    },
    touch(item, patch) {
      Object.assign(item, patch || {});
      item.updatedAt = util.now();
      store.commit();
    },
    // Deleting only moves things to Trash; Settings > Trash can bring them back.
    trash(item) {
      item.deletedAt = util.now();
      store.commit();
    },
    restore(item) {
      delete item.deletedAt;
      delete item.trashedWith;
      // Restoring a folder brings back everything that was deleted with it.
      if (store.state.folders.includes(item)) {
        for (const c of ['folders', 'notes']) {
          for (const x of store.state[c]) {
            if (x.trashedWith === item.id) { delete x.deletedAt; delete x.trashedWith; }
          }
        }
        const parent = item.parentId && store.find('folders', item.parentId);
        if (item.parentId && (!parent || parent.deletedAt)) item.parentId = '';
      }
      // A note whose folder is still in Trash goes to Unfiled so it stays visible.
      if (store.state.notes.includes(item) && item.folderId) {
        const f = store.find('folders', item.folderId);
        if (!f || f.deletedAt) item.folderId = '';
      }
      store.commit();
    },
    // Folder delete = folder + subfolders + their notes go to Trash together.
    trashFolder(folder) {
      const ids = new Set([folder.id, ...store.descendants(folder.id)]);
      const now = util.now();
      for (const f of store.state.folders) {
        if (ids.has(f.id) && !f.deletedAt) { f.deletedAt = now; if (f !== folder) f.trashedWith = folder.id; }
      }
      for (const n of store.state.notes) {
        if (ids.has(n.folderId) && !n.deletedAt) { n.deletedAt = now; n.trashedWith = folder.id; }
      }
      store.commit();
    },
    descendants(id) {
      const out = [];
      const walk = (pid) => {
        for (const f of store.state.folders) if (f.parentId === pid && !out.includes(f.id)) { out.push(f.id); walk(f.id); }
      };
      walk(id);
      return out;
    },
    purge(c, id) {
      const arr = store.state[c];
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) arr.splice(i, 1);
      store.commit();
    },
    trashed() {
      return COLLECTIONS.flatMap((c) => store.state[c].filter((x) => x.deletedAt).map((item) => ({ c, item })))
        .sort((a, b) => String(b.item.deletedAt).localeCompare(String(a.item.deletedAt)));
    },
  };

  const stampNew = (props) => {
    const n = util.now();
    return { id: util.uid(), createdAt: n, updatedAt: n, ...props };
  };

  const make = {
    task: (p) => stampNew({ title: '', notes: '', priority: 'medium', status: 'todo', date: util.today(), due: '', ticket: '', blocker: '', carried: 0, completedAt: null, ...p }),
    note: (p) => {
      const n = stampNew({ title: '', html: '', text: '', tags: [], starred: false, archived: false, type: 'note', daily: '', folderId: '', color: '', board: null, grid: null, viewedAt: null, ...p });
      if (!n.text && n.html) n.text = QN.html.toText(n.html);
      return n;
    },
    folder: (p) => stampNew({ name: '', parentId: '', color: '', ...p }),
    snippet: (p) => stampNew({ title: '', language: 'plaintext', code: '', description: '', tags: [], starred: false, ...p }),
    noteTemplate: (p) => stampNew({ name: '', html: '', ...p }),
    file: (p) => stampNew({ name: '', versions: [], ...p }),
    bug: (p) => stampNew({ title: '', ticket: '', url: '', module: '', env: '', build: '', severity: 'major', priority: 'medium', status: 'draft', steps: '', expected: '', actual: '', apiRequest: '', apiResponse: '', files: [], notes: '', history: [], ...p }),
  };

  const defs = {
    priority: [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']],
    taskStatus: [['todo', 'To do'], ['doing', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']],
    severity: [['critical', 'Critical'], ['major', 'Major'], ['minor', 'Minor'], ['trivial', 'Trivial']],
    bugStatus: [['draft', 'Draft'], ['reported', 'Reported'], ['retest', 'Ready for retest'], ['reopened', 'Reopened'], ['verified', 'Verified'], ['closed', 'Closed'], ['rejected', 'Rejected'], ['deferred', 'Deferred']],
    bugActive: ['draft', 'reported', 'retest', 'reopened'],
    label(list, v) {
      const found = list.find((x) => x[0] === v);
      return found ? found[1] : v;
    },
  };

  QN.store = store;
  QN.make = make;
  QN.defs = defs;
})();
