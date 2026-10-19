(function () {
  'use strict';

  const QN = window.QN;
  const { h, icon, util, store, make, defs, ui } = QN;

  const ENVS = ['QA', 'Staging', 'UAT', 'Production', 'Dev'];
  const SEV_ORDER = { critical: 0, major: 1, minor: 2, trivial: 3 };

  let root = null;
  let listEl = null;
  let editorEl = null;
  let searchEl = null;
  let selectedId = null;
  let query = '';
  let statusFilter = 'active';
  let sevFilter = '';
  let initialized = false;
  const saveFilters = () => {
    store.state.settings.bugFilters = { status: statusFilter, severity: sevFilter };
    store.commit();
  };

  const isActive = (b) => defs.bugActive.includes(b.status);

  function filtered() {
    return store.live('bugs')
      .filter((b) => (statusFilter === 'all' || (statusFilter === 'active' ? isActive(b) : b.status === statusFilter)) &&
        (!sevFilter || b.severity === sevFilter) &&
        util.matches(`${b.ticket} ${b.title} ${b.module} ${b.env} ${b.build} ${b.steps} ${b.expected} ${b.actual} ${b.notes}`, query))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function select(id) {
    selectedId = id;
    renderList();
    renderEditor();
  }

  function newBug(props) {
    const b = store.add('bugs', make.bug(props));
    statusFilter = 'active';
    sevFilter = '';
    query = '';
    render();
    select(b.id);
    const t = root && root.querySelector('.bug-title');
    if (t) t.focus();
    return b;
  }

  function setStatus(b, status) {
    if (b.status === status) return;
    b.history = b.history || [];
    b.history.push({ at: util.now(), from: b.status, to: status });
    b.status = status;
    store.touch(b);
  }

  function numberSteps(s) {
    const lines = String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines.some((l) => /^\d+[.)]\s/.test(l))) return lines.join('\n');
    return lines.map((l, i) => `${i + 1}. ${l.replace(/^[-*]\s+/, '')}`).join('\n');
  }

  // Plain-text bug report that pastes cleanly into Jira, Teams, Slack or email.
  function report(b) {
    const lines = [b.ticket ? `[${b.ticket}] ${b.title || 'Untitled bug'}` : (b.title || 'Untitled bug')];
    const where = [['Module', b.module], ['Environment', b.env], ['Build', b.build]].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' | ');
    if (where) lines.push(where);
    lines.push(`Severity: ${defs.label(defs.severity, b.severity)} | Priority: ${defs.label(defs.priority, b.priority)} | Status: ${defs.label(defs.bugStatus, b.status)}`);
    if (b.url) lines.push(`Link: ${b.url}`);
    for (const [label, value] of [['Steps to reproduce', numberSteps(b.steps)], ['Expected result', b.expected], ['Actual result', b.actual], ['API request', b.apiRequest], ['API response', b.apiResponse], ['Notes', b.notes]]) {
      if (value && value.trim()) lines.push('', `${label}:`, value.trim());
    }
    const files = QN.files.filesOf(b);
    if (files.length) lines.push('', `Attached files (${files.length}):`, ...files.map((f) => `- ${f.name}`), '(Screenshots: use "Copy image" in QAura to paste them into the ticket.)');
    return lines.join('\n');
  }

  function removeBug(b) {
    store.trash(b);
    if (selectedId === b.id) selectedId = null;
    renderList();
    renderEditor();
    ui.toast('Bug moved to Trash', { action: { label: 'Undo', fn: () => { store.restore(b); select(b.id); } } });
  }

  function duplicate(b) {
    const copy = make.bug({
      title: `${b.title} (copy)`, url: '', ticket: '', module: b.module, env: b.env, build: b.build,
      severity: b.severity, priority: b.priority, steps: b.steps, expected: b.expected, actual: b.actual, notes: b.notes,
      apiRequest: b.apiRequest || '', apiResponse: b.apiResponse || '', files: [...(b.files || [])],
    });
    store.add('bugs', copy);
    select(copy.id);
    ui.toast('Bug duplicated as a new draft');
  }

  function addRetestTask(b) {
    const t = store.add('tasks', make.task({ title: `Retest: ${b.title || 'bug'}`, ticket: b.ticket, priority: b.severity === 'critical' ? 'high' : b.priority }));
    ui.toast('Retest task added for today', { action: { label: 'Open', fn: () => QN.app.go('tasks', { focus: t.id }) } });
  }

  // ---------- layout ----------

  function render() {
    if (!root) return;
    searchEl = h('input', {
      class: 'search-input',
      type: 'search',
      placeholder: 'Search bugs, tickets, steps',
      value: query,
      'aria-label': 'Search bugs',
      onInput: (e) => { query = e.target.value; renderList(); },
      onKeyDown: (e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); query = ''; e.target.value = ''; renderList(); } },
    });
    listEl = h('div', { class: 'list', role: 'list' });
    editorEl = h('section', { class: 'editor-pane' });
    root.replaceChildren(h('div', { class: 'split' },
      h('aside', { class: 'list-pane' },
        h('div', { class: 'list-head' },
          h('div', { class: 'list-title' }, h('h1', null, 'Bugs'),
            h('div', { class: 'list-actions' },
              h('button', {
                type: 'button',
                class: 'icon-btn',
                title: 'Export these bugs to Excel or CSV',
                'aria-label': 'Export bugs',
                onClick: (e) => ui.menu(e.currentTarget, [{ header: `Export ${util.plural(filtered().length, 'bug')}` }, ...QN.office.listMenu((fmt) => QN.office.exportBugs(filtered(), fmt, 'Bugs'))], { alignRight: true }),
              }, icon('download')),
              h('button', { type: 'button', class: 'btn primary sm', title: 'Log a bug (Ctrl+N)', onClick: () => newBug({}) }, icon('plus'), 'Log bug'))),
          h('div', { class: 'search-wrap' }, icon('search'), searchEl),
          h('div', { class: 'filter-row' },
            ui.select([['active', 'Active'], ['all', 'All statuses'], ...defs.bugStatus], statusFilter, (v) => { statusFilter = v; saveFilters(); renderList(); }, { class: 'sm', 'aria-label': 'Status filter' }),
            ui.select([['', 'Any severity'], ...defs.severity], sevFilter, (v) => { sevFilter = v; saveFilters(); renderList(); }, { class: 'sm', 'aria-label': 'Severity filter' }))),
        listEl),
      editorEl));
    renderList();
    renderEditor();
  }

  function renderList() {
    if (!listEl) return;
    const bugs = filtered();
    if (!bugs.length) {
      const any = store.live('bugs').length;
      listEl.replaceChildren(h('div', { class: 'list-empty' }, any ? 'No bugs match these filters.' : 'No bugs logged yet. Press Ctrl+N to log one.'));
      return;
    }
    listEl.replaceChildren(...bugs.map((b) => h('button', {
      type: 'button',
      class: `list-item${b.id === selectedId ? ' active' : ''}`,
      role: 'listitem',
      'data-id': b.id,
      onClick: () => select(b.id),
    },
    h('div', { class: 'li-top' },
      h('span', { class: `sev-dot ${b.severity}`, title: defs.label(defs.severity, b.severity) }),
      h('span', { class: 'li-title' }, b.title || 'Untitled bug'),
      h('span', { class: 'li-time' }, util.relTime(b.updatedAt))),
    h('div', { class: 'li-meta' },
      b.ticket ? h('span', { class: 'chip mono' }, b.ticket) : null,
      ui.pill(`bs-${b.status}`, defs.label(defs.bugStatus, b.status)),
      b.module ? h('span', { class: 'muted' }, b.module) : null,
      QN.files.filesOf(b).length ? h('span', { class: 'mini-folder', title: 'Attached files' }, icon('paperclip'), String(QN.files.filesOf(b).length)) : null))));
  }

  const refreshListSoon = util.debounce(() => renderList(), 250);

  // ---------- editor ----------

  function datalist(id, values) {
    return h('datalist', { id }, [...new Set(values.filter(Boolean))].map((v) => h('option', { value: v })));
  }

  // Ctrl+V with an image or file anywhere on the Bugs screen attaches it to the open bug.
  function onDocPaste(e) {
    if (!editorEl || !selectedId || QN.palette.isOpen() || ui.hasModal()) return;
    const b = store.find('bugs', selectedId);
    if (b && !b.deletedAt) QN.files.handlePaste(e, b);
  }

  // API request / response: guess the colouring from the content.
  const apiLang = (t) => {
    const s = String(t || '').trim();
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i.test(s) || /^HTTP\/\d/.test(s)) return 'http';
    if (/^</.test(s)) return 'xml';
    return 'json';
  };

  function formatJson(box) {
    const text = box.area.value;
    const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return null; } };
    let out = pretty(text.trim());
    if (out === null) {
      // e.g. "HTTP/1.1 200 OK" or headers first, then a JSON body
      const i = text.search(/[[{]/);
      const body = i > 0 ? pretty(text.slice(i).trim()) : null;
      if (body !== null) out = `${text.slice(0, i).trimEnd()}\n\n${body}`;
    }
    if (out === null) {
      ui.toast('No valid JSON found to format', { type: 'error' });
      return;
    }
    box.setValue(out);
  }

  function renderEditor() {
    if (!editorEl) return;
    const b = selectedId && store.find('bugs', selectedId);
    if (!b || b.deletedAt) {
      editorEl.replaceChildren(ui.empty('bug', 'Select a bug or log a new one',
        'Tip: capture fast from Home with "bug: Save button disabled ABC-123" and fill in the details later.',
        h('div', { class: 'empty-actions' }, h('button', { type: 'button', class: 'btn primary', onClick: () => newBug({}) }, icon('plus'), 'Log a bug'))));
      return;
    }

    const set = (key, value) => {
      b[key] = value;
      b.updatedAt = util.now();
      store.commit();
      refreshListSoon();
    };
    const text = (key, attrs) => h('input', { value: b[key] || '', ...attrs, onInput: (e) => set(key, e.target.value) });
    const area = (key, rows, placeholder) => h('textarea', { rows, value: b[key] || '', placeholder, spellcheck: 'true', onInput: (e) => set(key, e.target.value) });
    const allBugs = store.live('bugs');

    const validUrl = () => /^https?:\/\/\S+/i.test(b.url || '');
    const openBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Open ticket link in browser', disabled: !validUrl(), onClick: () => { if (validUrl()) window.api.openExternal(b.url); } }, icon('external'));
    const urlInput = h('input', { value: b.url || '', placeholder: 'https://…', onInput: (e) => { set('url', e.target.value.trim()); openBtn.disabled = !validUrl(); } });
    const exportBtn = h('button', { type: 'button', class: 'btn ghost sm', title: 'Export this bug as a Word or PDF report' }, icon('download'), 'Export');
    exportBtn.addEventListener('click', () => ui.menu(exportBtn, [
      { header: 'Bug report with screenshots' },
      { label: 'Word (.docx)', icon: 'fileDoc', onClick: () => QN.office.exportBugReport(b, 'docx') },
      { label: 'PDF (.pdf)', icon: 'fileDoc', onClick: () => QN.office.exportBugReport(b, 'pdf') },
    ], { alignRight: true }));
    const actions = h('div', { class: 'editor-actions' },
      h('button', { type: 'button', class: 'btn primary sm', title: 'Copy a formatted bug report', onClick: () => ui.copy(report(b), 'Bug report') }, icon('copy'), 'Copy report'),
      exportBtn,
      h('button', { type: 'button', class: 'btn ghost sm', title: 'Add a retest task for today', onClick: () => addRetestTask(b) }, icon('tasks'), 'Retest task'),
      openBtn,
      h('button', { type: 'button', class: 'icon-btn', title: 'Duplicate as new draft', onClick: () => duplicate(b) }, icon('duplicate')),
      h('button', { type: 'button', class: 'icon-btn danger', title: 'Move to Trash', onClick: () => removeBug(b) }, icon('trash')));

    const statusSel = ui.select(defs.bugStatus, b.status, (v) => { setStatus(b, v); renderList(); renderEditor(); }, { class: `status-select bs-${b.status}`, 'aria-label': 'Status' });
    const sevSel = ui.select(defs.severity, b.severity, (v) => { set('severity', v); sevSel.className = `status-select sev-${v}`; }, { class: `status-select sev-${b.severity}`, 'aria-label': 'Severity' });
    const prioSel = ui.select(defs.priority, b.priority, (v) => set('priority', v), { 'aria-label': 'Priority' });

    const history = (b.history || []).slice(-6).reverse();

    const apiBox = (key, label, placeholder) => {
      const box = ui.codeArea({ value: b[key] || '', placeholder, label, language: apiLang, className: 'compact', onInput: (v) => set(key, v) });
      return h('div', { class: 'field api-field' },
        h('div', { class: 'field-head' },
          h('span', { class: 'field-label' }, label),
          h('div', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn ghost xs', title: 'Pretty-print the JSON', onClick: () => formatJson(box) }, icon('code'), 'Format JSON'),
          h('button', { type: 'button', class: 'btn ghost xs', title: `Copy ${label.toLowerCase()}`, onClick: () => { if (b[key]) ui.copy(b[key], label); } }, icon('copy'), 'Copy')),
        box.el);
    };

    const shotsField = QN.files.panel(b, { label: 'Files & screenshots', dropTitle: 'Add screenshots, logs, PDFs or any work file' });

    // Dropping files anywhere on the bug attaches them.
    const dropHint = (on) => editorEl.classList.toggle('dropping', on);
    editorEl.ondragover = (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dropHint(true); } };
    editorEl.ondragleave = (e) => { if (!editorEl.contains(e.relatedTarget)) dropHint(false); };
    editorEl.ondrop = (e) => {
      dropHint(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      QN.files.add(b, e.dataTransfer.files);
    };

    editorEl.replaceChildren(h('div', { class: 'editor form-editor' },
      h('div', { class: 'editor-toolbar' },
        h('div', { class: 'tb-meta' }, icon('bug'), `Logged ${util.fmtDateTime(b.createdAt)}`, h('span', { class: 'muted' }, ` · edited ${util.relTime(b.updatedAt)}`)),
        h('div', { class: 'spacer' }),
        actions),
      h('div', { class: 'form-body' },
        h('input', { class: 'bug-title note-title', value: b.title, placeholder: 'Short, specific summary of the problem', 'aria-label': 'Bug title', spellcheck: 'true', onInput: (e) => set('title', e.target.value) }),
        h('div', { class: 'field-grid four' },
          ui.field('Status', statusSel),
          ui.field('Severity', sevSel),
          ui.field('Priority', prioSel),
          ui.field('Ticket', h('div', { class: 'input-with-btn' }, text('ticket', { class: 'mono', placeholder: 'ABC-123' }), h('button', { type: 'button', class: 'icon-btn hub-btn', title: 'Ticket hub: everything that mentions this ticket', 'aria-label': 'Open ticket hub', onClick: () => { const id = String(b.ticket || '').trim(); if (id) QN.tickets.openHub(id); else QN.ui.toast('Add a ticket ID first'); } }, icon('link'))))),
        h('div', { class: 'field-grid four' },
          ui.field('Module / area', text('module', { placeholder: 'e.g. Login', list: 'dl-modules' })),
          ui.field('Environment', text('env', { placeholder: 'QA / Staging / UAT', list: 'dl-envs' })),
          ui.field('Build / version', text('build', { placeholder: 'e.g. 2.4.1', class: 'mono' })),
          ui.field('Ticket link', urlInput)),
        datalist('dl-modules', allBugs.map((x) => x.module)),
        datalist('dl-envs', [...ENVS, ...allBugs.map((x) => x.env)]),
        ui.field('Steps to reproduce', area('steps', 6, 'One step per line — they are numbered automatically when you copy the report.\nOpen the login page\nEnter a valid email and a wrong password\nClick Sign in'), 'wide'),
        h('div', { class: 'field-grid two' },
          ui.field('Expected result', area('expected', 4, 'What should happen')),
          ui.field('Actual result', area('actual', 4, 'What actually happens'))),
        shotsField,
        h('div', { class: 'field-grid two api-grid' },
          apiBox('apiRequest', 'API request', 'POST https://api.example.com/v1/patients\nAuthorization: Bearer …\n\n{ "name": "Test" }'),
          apiBox('apiResponse', 'API response', 'HTTP/1.1 500 Internal Server Error\n\n{ "error": "…" }')),
        ui.field('Notes & evidence', area('notes', 3, 'Logs, test data, device / browser, how often it happens…'), 'wide'),
        history.length ? h('div', { class: 'history' },
          h('div', { class: 'field-label' }, 'Status history'),
          h('ul', null, history.map((x) => h('li', null,
            h('span', { class: 'muted' }, util.fmtDateTime(x.at)),
            ui.pill(`bs-${x.from}`, defs.label(defs.bugStatus, x.from)), icon('arrowRight'), ui.pill(`bs-${x.to}`, defs.label(defs.bugStatus, x.to)))))) : null)));
  }

  QN.bugs = { report, isActive, numberSteps };

  QN.views = QN.views || {};
  QN.views.bugs = {
    mount(el, params = {}) {
      root = el;
      if (!initialized) {
        initialized = true;
        const f = store.state.settings.bugFilters || {};
        statusFilter = f.status || 'active';
        sevFilter = f.severity || '';
      }
      if (params.select) {
        selectedId = params.select;
        const b = store.find('bugs', params.select);
        if (b && !isActive(b)) statusFilter = 'all';
        query = '';
      }
      if (params.filter) statusFilter = params.filter;
      document.addEventListener('paste', onDocPaste);
      render();
      if (params.new) newBug({});
    },
    unmount() {
      document.removeEventListener('paste', onDocPaste);
      root = null; listEl = null; editorEl = null; searchEl = null;
      refreshListSoon.cancel();
    },
    refresh: () => render(),
    onNew: () => newBug({}),
    focusSearch() { if (searchEl) searchEl.focus(); },
  };
  // Severity sort exported for Home.
  QN.bugs.sevOrder = SEV_ORDER;
})();
