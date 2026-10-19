(function () {
  'use strict';

  // Code snippets: SQL, API calls, payloads, scripts. {{placeholders}} are filled in when copying.
  const QN = window.QN;
  const { h, icon, util, store, make, ui } = QN;

  const LANGS = [
    ['plaintext', 'Plain text'], ['sql', 'SQL'], ['json', 'JSON'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'],
    ['python', 'Python'], ['java', 'Java'], ['csharp', 'C#'], ['bash', 'Bash / shell'], ['powershell', 'PowerShell'],
    ['http', 'HTTP request'], ['xml', 'XML / HTML'], ['css', 'CSS'], ['yaml', 'YAML'], ['gherkin', 'Gherkin (BDD)'],
    ['dockerfile', 'Dockerfile'], ['groovy', 'Groovy'], ['kotlin', 'Kotlin'], ['go', 'Go'], ['ruby', 'Ruby'], ['php', 'PHP'],
    ['graphql', 'GraphQL'], ['ini', 'INI / properties'], ['diff', 'Diff'], ['markdown', 'Markdown'],
  ];
  const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

  let root = null;
  let listEl = null;
  let editorEl = null;
  let searchEl = null;
  let selectedId = null;
  let query = '';
  let langFilter = null; // remembered

  const langLabel = (v) => (LANGS.find((l) => l[0] === v) || [v, v])[1];

  function highlight(code, language) {
    if (window.hljs && language !== 'plaintext' && hljs.getLanguage(language)) {
      try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch { /* fall back */ }
    }
    return QN.html.escape(code);
  }

  function filtered() {
    return store.live('snippets')
      .filter((s) => (!langFilter || s.language === langFilter) && util.matches(`${s.title} ${s.description} ${s.code} ${(s.tags || []).join(' ')} ${langLabel(s.language)}`, query))
      .sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function select(id) {
    selectedId = id;
    renderList();
    renderEditor();
  }

  function newSnippet() {
    const s = store.add('snippets', make.snippet({ language: langFilter || 'sql' }));
    query = '';
    if (searchEl) searchEl.value = '';
    select(s.id);
    const t = root && root.querySelector('.snippet-title');
    if (t) t.focus();
  }

  function removeSnippet(s) {
    store.trash(s);
    if (selectedId === s.id) selectedId = null;
    renderList();
    renderEditor();
    ui.toast('Snippet moved to Trash', { action: { label: 'Undo', fn: () => { store.restore(s); select(s.id); } } });
  }

  // Copy, asking for {{placeholder}} values first when the snippet has any.
  async function copySnippet(s) {
    const names = [...new Set([...s.code.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
    if (!names.length) {
      ui.copy(s.code, 'Snippet');
      return;
    }
    s.lastValues = s.lastValues || {};
    const values = await ui.form(`Fill in: ${s.title || 'snippet'}`, names.map((n) => ({ name: n, label: n, value: s.lastValues[n] || '', mono: true })), { submitLabel: 'Copy', intro: 'Values replace the {{placeholders}} in the copied text. The snippet itself stays unchanged.' });
    if (!values) return;
    s.lastValues = values;
    store.commit();
    ui.copy(s.code.replace(PLACEHOLDER_RE, (m, n) => (values[n] !== undefined ? values[n] : m)), 'Snippet');
  }

  function seed() {
    const st = store.state.settings;
    if (st.seededSnippets) return;
    st.seededSnippets = true;
    if (!store.state.snippets.length) {
      store.state.snippets.push(
        make.snippet({ title: 'Example: find a user by email', language: 'sql', description: 'Edit or delete this example. {{email}} is asked for when you copy.', code: "SELECT id, email, status, created_at\nFROM users\nWHERE email = '{{email}}'\nORDER BY created_at DESC;", tags: ['db'] }),
        make.snippet({ title: 'Example: API health check', language: 'bash', description: 'curl with a placeholder for the environment URL.', code: 'curl -s -o /dev/null -w "%{http_code}\\n" {{baseUrl}}/health', tags: ['api'] }),
      );
    }
    store.commit();
  }

  // ---------- layout ----------

  function render() {
    if (!root) return;
    searchEl = h('input', {
      class: 'search-input',
      type: 'search',
      placeholder: 'Search snippets and code',
      value: query,
      'aria-label': 'Search snippets',
      onInput: (e) => { query = e.target.value; renderList(); },
      onKeyDown: (e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); query = ''; e.target.value = ''; renderList(); } },
    });
    listEl = h('div', { class: 'list', role: 'list' });
    editorEl = h('section', { class: 'editor-pane' });
    const usedLangs = [...new Set(store.live('snippets').map((s) => s.language))];
    root.replaceChildren(h('div', { class: 'split' },
      h('aside', { class: 'list-pane' },
        h('div', { class: 'list-head' },
          h('div', { class: 'list-title' }, h('h1', null, 'Snippets'),
            h('div', { class: 'list-actions' }, h('button', { type: 'button', class: 'btn primary sm', title: 'New snippet (Ctrl+N)', onClick: newSnippet }, icon('plus'), 'New'))),
          h('div', { class: 'search-wrap' }, icon('search'), searchEl),
          h('div', { class: 'filter-row' },
            ui.select([['', 'All languages'], ...LANGS.filter((l) => usedLangs.includes(l[0]))], langFilter, (v) => { langFilter = v; store.state.settings.snippetLang = v; store.commit(); renderList(); }, { class: 'sm', 'aria-label': 'Language filter' }))),
        listEl),
      editorEl));
    renderList();
    renderEditor();
  }

  function renderList() {
    if (!listEl) return;
    const items = filtered();
    if (!items.length) {
      listEl.replaceChildren(h('div', { class: 'list-empty' }, store.live('snippets').length ? 'No snippets match.' : 'No snippets yet. Save SQL, API calls, payloads and scripts you reuse.'));
      return;
    }
    listEl.replaceChildren(...items.map((s) => h('button', {
      type: 'button',
      class: `list-item${s.id === selectedId ? ' active' : ''}`,
      role: 'listitem',
      'data-id': s.id,
      onClick: () => select(s.id),
    },
    h('div', { class: 'li-top' },
      s.starred ? icon('star', 'li-star') : null,
      h('span', { class: 'li-title' }, s.title || 'Untitled snippet'),
      h('span', { class: 'lang-chip' }, langLabel(s.language))),
    h('div', { class: 'li-snippet mono' }, util.snippet(s.code.replace(/\s+/g, ' '), 80) || 'Empty'))));
  }

  const refreshListSoon = util.debounce(() => renderList(), 250);

  // ---------- editor ----------

  function renderEditor() {
    if (!editorEl) return;
    const s = selectedId && store.find('snippets', selectedId);
    if (!s || s.deletedAt) {
      editorEl.replaceChildren(ui.empty('snippet', 'Reusable code, one click away',
        'Save SQL queries, curl / API calls, JSON payloads, test data and scripts. Use {{name}} placeholders to be asked for values when you copy.',
        h('div', { class: 'empty-actions' }, h('button', { type: 'button', class: 'btn primary', onClick: newSnippet }, icon('plus'), 'New snippet'))));
      return;
    }
    const touch = () => { s.updatedAt = util.now(); store.commit(); refreshListSoon(); };

    const pre = h('pre', { class: 'code-hl', 'aria-hidden': 'true' });
    const code = h('code', { class: 'hljs' });
    pre.append(code);
    const paint = () => { code.innerHTML = `${highlight(s.code, s.language)}\n`; };
    const area = h('textarea', {
      class: 'code-input',
      value: s.code,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Code',
      placeholder: 'Paste or type code…',
      onInput: (e) => { s.code = e.target.value; paint(); touch(); placeholdersEl.replaceChildren(...placeholderChips()); },
      onScroll: () => { pre.scrollTop = area.scrollTop; pre.scrollLeft = area.scrollLeft; },
      onKeyDown: (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          if (!e.shiftKey) document.execCommand('insertText', false, '  ');
        }
      },
    });
    paint();
    const placeholderChips = () => {
      const names = [...new Set([...s.code.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
      return names.length ? [h('span', { class: 'muted small' }, 'Asks for:'), ...names.map((n) => h('span', { class: 'chip mono' }, `{{${n}}}`))] : [];
    };
    const placeholdersEl = h('div', { class: 'placeholder-row' }, placeholderChips());

    const starBtn = h('button', {
      type: 'button',
      class: `icon-btn star-btn${s.starred ? ' on' : ''}`,
      title: s.starred ? 'Remove from Favorites' : 'Add to Favorites',
      onClick: () => { s.starred = !s.starred; starBtn.classList.toggle('on', s.starred); touch(); },
    }, icon('star'));

    editorEl.replaceChildren(h('div', { class: 'editor form-editor' },
      h('div', { class: 'editor-toolbar' },
        h('div', { class: 'tb-meta' }, icon('snippet'), `Edited ${util.relTime(s.updatedAt)}`),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn primary sm', onClick: () => copySnippet(s) }, icon('copy'), 'Copy'),
        h('button', { type: 'button', class: 'btn ghost sm', title: 'Copy without filling placeholders', onClick: () => ui.copy(s.code, 'Snippet') }, 'Copy raw'),
        starBtn,
        h('button', { type: 'button', class: 'icon-btn danger', title: 'Move to Trash', onClick: () => removeSnippet(s) }, icon('trash'))),
      h('div', { class: 'form-body' },
        h('input', { class: 'snippet-title note-title', value: s.title, placeholder: 'Snippet name, e.g. Reset test user password', 'aria-label': 'Snippet name', onInput: (e) => { s.title = e.target.value; touch(); } }),
        h('div', { class: 'field-grid three' },
          ui.field('Language', ui.select(LANGS, s.language, (v) => { s.language = v; paint(); touch(); })),
          ui.field('Tags', h('input', {
            value: (s.tags || []).map((t) => `#${t}`).join(', '),
            placeholder: '#db, #api',
            onChange: (e) => { s.tags = [...new Set(e.target.value.split(/[,;]/).map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))]; e.target.value = s.tags.map((t) => `#${t}`).join(', '); touch(); },
          })),
          ui.field('Description', h('input', { value: s.description, placeholder: 'When to use it', onInput: (e) => { s.description = e.target.value; touch(); } }))),
        h('div', { class: 'code-editor' }, pre, area),
        placeholdersEl,
        h('p', { class: 'muted small' }, 'Tip: write {{name}} anywhere in the code (e.g. {{email}}, {{baseUrl}}) and Copy asks for the values.'))));
  }

  QN.views = QN.views || {};
  QN.views.snippets = {
    mount(el, params = {}) {
      root = el;
      if (langFilter === null) langFilter = store.state.settings.snippetLang || '';
      seed();
      if (params.select) { selectedId = params.select; query = ''; langFilter = ''; }
      render();
      if (params.new) newSnippet();
    },
    unmount() { root = null; listEl = null; editorEl = null; searchEl = null; refreshListSoon.cancel(); },
    refresh: () => render(),
    onNew: newSnippet,
    focusSearch() { if (searchEl) searchEl.focus(); },
  };
})();
