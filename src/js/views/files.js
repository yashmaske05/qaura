(function () {
  'use strict';

  // Files library: every file in QAura, whether or not it is attached to something.
  const QN = window.QN;
  const { h, icon, util, store, ui } = QN;

  let root = null;
  let gridEl = null;
  let countEl = null;
  let searchEl = null;
  let query = '';
  let kind = '';
  let sort = 'updated';

  const SORTS = [['updated', 'Recently updated'], ['name', 'Name A–Z'], ['size', 'Largest first']];

  function filtered() {
    const by = {
      updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => (QN.files.latest(b).size || 0) - (QN.files.latest(a).size || 0),
    }[sort];
    return store.live('files')
      .filter((f) => (!kind || QN.files.kindOf(f) === kind) && util.matches(`${f.name} ${QN.files.KIND[QN.files.kindOf(f)].label} ${QN.files.extOf(QN.files.latest(f).blob)}`, query))
      .sort(by);
  }

  function paintGrid() {
    if (!gridEl) return;
    const files = filtered();
    const total = store.live('files');
    countEl.textContent = `${util.plural(files.length, 'file')} · ${QN.files.fmtSize(total.reduce((n, f) => n + f.versions.reduce((m, v) => m + (v.size || 0), 0), 0))} stored`;
    if (!files.length) {
      gridEl.replaceChildren(total.length
        ? ui.empty('search', 'No files match', 'Try a different search or type.')
        : ui.empty('paperclip', 'No files yet', 'Add PDFs, Word and Excel files, CSV, logs, JSON, screenshots and screen recordings. Drop them here or paste a screenshot with Ctrl+V.',
          h('div', { class: 'empty-actions' }, h('button', { type: 'button', class: 'btn primary', onClick: () => QN.files.add(null, 'pick') }, icon('upload'), 'Add files…'))));
      return;
    }
    gridEl.replaceChildren(h('div', { class: 'files-grid library' }, files.map((f) => {
      const t = QN.files.tile(f);
      const uses = QN.files.usedIn(f.id);
      t.append(h('div', { class: `file-uses${uses.length ? '' : ' none'}` }, uses.length ? `Used in ${util.plural(uses.length, 'item')}` : 'Not attached'));
      return t;
    })));
  }

  function render() {
    if (!root) return;
    searchEl = h('input', {
      class: 'search-input',
      type: 'search',
      placeholder: 'Search files',
      value: query,
      'aria-label': 'Search files',
      onInput: (e) => { query = e.target.value; paintGrid(); },
    });
    countEl = h('span', { class: 'notes-count' });
    gridEl = h('div', { class: 'files-library-body' });
    const sortBtn = h('button', { type: 'button', class: 'btn ghost sm', title: 'Sort files' }, icon('sort'), h('span', { class: 'btn-label' }, SORTS.find((s) => s[0] === sort)[1]));
    sortBtn.addEventListener('click', () => ui.menu(sortBtn, SORTS.map(([v, l]) => ({ label: l, checked: sort === v, onClick: () => { sort = v; render(); } })), { alignRight: true }));
    const view = h('div', { class: 'files-view' },
      h('header', { class: 'notes-head' },
        h('div', { class: 'scope-title' }, icon('paperclip'), h('h2', null, 'Files')),
        countEl,
        h('div', { class: 'spacer' }),
        h('div', { class: 'search-wrap notes-search' }, icon('search'), searchEl),
        ui.select(QN.files.KIND_FILTERS, kind, (v) => { kind = v; paintGrid(); }, { class: 'sm kind-filter', 'aria-label': 'File type' }),
        sortBtn,
        h('button', { type: 'button', class: 'btn ghost sm', onClick: () => QN.files.add(null, 'clipboard') }, icon('copy'), h('span', { class: 'btn-label' }, 'Paste image')),
        h('button', { type: 'button', class: 'btn primary sm', onClick: () => QN.files.add(null, 'pick') }, icon('upload'), 'Add files')),
      h('p', { class: 'board-hint files-hint' }, 'Drop files anywhere here · Ctrl+V pastes a screenshot · click a file to preview, edit, see versions or download'),
      gridEl);
    view.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); view.classList.add('dropping'); } });
    view.addEventListener('dragleave', (e) => { if (!view.contains(e.relatedTarget)) view.classList.remove('dropping'); });
    view.addEventListener('drop', (e) => {
      view.classList.remove('dropping');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      QN.files.add(null, e.dataTransfer.files);
    });
    root.replaceChildren(view);
    paintGrid();
  }

  const onFilesEvent = () => paintGrid();
  const onPaste = (e) => {
    if (!root || QN.palette.isOpen() || ui.hasModal()) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) return;
    QN.files.handlePaste(e, null);
  };

  QN.views = QN.views || {};
  QN.views.files = {
    mount(el, params = {}) {
      root = el;
      document.addEventListener('qn:files', onFilesEvent);
      document.addEventListener('paste', onPaste);
      render();
      if (params.select) QN.files.openDetail(params.select);
      if (params.add) QN.files.add(null, 'pick');
    },
    unmount() {
      document.removeEventListener('qn:files', onFilesEvent);
      document.removeEventListener('paste', onPaste);
      root = null;
      gridEl = null;
    },
    refresh: () => render(),
    onNew: () => QN.files.add(null, 'pick'),
    focusSearch() { if (searchEl) searchEl.focus(); },
  };
})();
