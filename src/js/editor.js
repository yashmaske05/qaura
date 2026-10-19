(function () {
  'use strict';

  // Rich-text note editor (WYSIWYG). Stores sanitized HTML plus a plain-text copy for search.
  const QN = window.QN;
  const { h, icon, util, store, ui } = QN;

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* older engines */ }

  const BLOCK_TAGS = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'LI'];
  const BLOCK_LABEL = { P: 'Text', DIV: 'Text', H1: 'Heading 1', H2: 'Heading 2', H3: 'Heading 3', H4: 'Heading 4', H5: 'Heading 5', H6: 'Heading 6', PRE: 'Code block', BLOCKQUOTE: 'Quote', LI: 'List' };
  const COLORS = [['', 'No colour'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['pink', 'Pink'], ['orange', 'Orange']];
  const exec = (cmd, val) => document.execCommand(cmd, false, val);
  const parseTags = (s) => [...new Set(String(s || '').split(/[,;]/).map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];

  // ---------- folders (shared with the Notes view) ----------

  const liveFolders = () => store.state.folders.filter((f) => !f.deletedAt);
  function folderPath(id) {
    const parts = [];
    let f = id && store.find('folders', id);
    for (let guard = 0; f && !f.deletedAt && guard < 30; guard++) {
      parts.unshift(f.name || 'Untitled folder');
      f = f.parentId && store.find('folders', f.parentId);
    }
    return parts.join(' / ');
  }
  function folderTree(parentId, depth, out) {
    for (const f of liveFolders().filter((x) => (x.parentId || '') === parentId).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      out.push({ f, depth });
      folderTree(f.id, depth + 1, out);
    }
    return out;
  }
  function folderMenuItems(currentId, onPick) {
    return [
      { label: 'Unfiled', icon: 'notes', checked: !currentId, onClick: () => onPick('') },
      ...folderTree('', 0, []).map(({ f, depth }) => ({ label: f.name || 'Untitled folder', swatch: f.color || 'folder', indent: depth, checked: f.id === currentId, onClick: () => onPick(f.id) })),
    ];
  }
  QN.folders = { path: folderPath, tree: folderTree, menuItems: folderMenuItems, live: liveFolders, COLORS };

  // ---------- selection helpers ----------

  function selectionIn(root) {
    const sel = window.getSelection();
    return sel.rangeCount && root.contains(sel.anchorNode) ? sel : null;
  }
  function ancestor(root, test) {
    const sel = selectionIn(root);
    if (!sel) return null;
    for (let n = sel.anchorNode; n && n !== root; n = n.parentNode) if (n.nodeType === 1 && test(n)) return n;
    return null;
  }
  const blockOf = (root) => ancestor(root, (n) => BLOCK_TAGS.includes(n.nodeName));
  function rangeFromBlockStart(block) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r;
  }
  function caretToEnd(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function ensureSelection(root) {
    if (selectionIn(root)) return;
    root.focus();
    caretToEnd(root.lastElementChild || root);
  }

  const isEmpty = (el) => !el.textContent && !el.querySelector('br, img');
  function fill(el) {
    if (isEmpty(el)) el.replaceChildren(document.createElement('br'));
    return el;
  }
  function caretAt(node, offset) {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // Build structure directly instead of execCommand list commands, which in Chromium
  // can nest a list inside a paragraph (<p><ul>…) and break Enter-to-leave-list.
  function retag(block, tag) {
    const el = document.createElement(tag);
    while (block.firstChild) el.append(block.firstChild);
    block.replaceWith(fill(el));
    return el;
  }
  function toList(block, tag, checklist) {
    const list = document.createElement(tag);
    const li = document.createElement('li');
    while (block.firstChild) li.append(block.firstChild);
    fill(li);
    if (checklist) {
      list.setAttribute('data-checklist', '');
      li.setAttribute('data-checked', 'false');
    }
    list.append(li);
    block.replaceWith(list);
    const prev = list.previousElementSibling;
    if (prev && prev.nodeName === list.nodeName && prev.hasAttribute('data-checklist') === Boolean(checklist)) {
      prev.append(li);
      list.remove();
    }
    return li;
  }
  function setChecklist(list, on) {
    if (on) {
      list.setAttribute('data-checklist', '');
      for (const li of list.children) if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false');
    } else {
      list.removeAttribute('data-checklist');
      for (const li of list.children) li.removeAttribute('data-checked');
    }
  }

  // Toolbar list buttons: keep the caret where it was.
  function listCommand(root, tag, checklist) {
    const sel = selectionIn(root);
    const list = ancestor(root, (n) => n.nodeName === 'UL' || n.nodeName === 'OL');
    if (list) {
      if (checklist) {
        if (list.nodeName === 'OL') exec('insertUnorderedList');
        const ul = ancestor(root, (n) => n.nodeName === 'UL');
        if (ul) setChecklist(ul, !ul.hasAttribute('data-checklist'));
      } else exec(tag === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
      return;
    }
    const block = blockOf(root);
    if (sel && sel.isCollapsed && block && /^(P|DIV|H1|H2|H3|BLOCKQUOTE)$/.test(block.nodeName)) {
      const saved = [sel.anchorNode, sel.anchorOffset];
      const li = toList(block, tag, checklist);
      if (saved[0] && saved[0].isConnected && li.contains(saved[0])) caretAt(saved[0], saved[1]);
      else caretAt(li, 0);
    } else {
      exec('insertUnorderedList');
      if (checklist) {
        const ul = ancestor(root, (n) => n.nodeName === 'UL');
        if (ul) setChecklist(ul, true);
      }
    }
  }

  // Undo Chromium's occasional <p><ul>…</ul></p> nesting, keeping the caret in place.
  function normalize(root) {
    const bad = root.querySelectorAll('p > ul, p > ol, p > pre, p > blockquote, p > h1, p > h2, p > h3, p > table, p > p');
    if (!bad.length) return;
    const sel = window.getSelection();
    const saved = sel.rangeCount && root.contains(sel.anchorNode) ? [sel.anchorNode, sel.anchorOffset] : null;
    for (const el of bad) {
      const para = el.parentElement;
      if (para && para.nodeName === 'P' && para.isConnected) para.replaceWith(...para.childNodes);
    }
    if (saved && saved[0].isConnected) caretAt(saved[0], saved[1]);
  }

  function toggleInline(root, tag) {
    const existing = ancestor(root, (n) => n.nodeName === tag.toUpperCase());
    if (existing) {
      const parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      existing.remove();
      return true;
    }
    const sel = selectionIn(root);
    if (!sel || sel.isCollapsed) return false;
    const div = document.createElement('div');
    div.append(sel.getRangeAt(0).cloneContents());
    exec('insertHTML', `<${tag}>${tag === 'code' ? QN.html.escape(div.textContent) : div.innerHTML}</${tag}>`);
    return false;
  }

  // Typing "# ", "- ", "1. ", "[] ", "> " or "``` " at the start of a line formats it.
  const SHORTCUTS = [
    [/^#$/, (b) => retag(b, 'h1')],
    [/^##$/, (b) => retag(b, 'h2')],
    [/^###$/, (b) => retag(b, 'h3')],
    [/^[-*]$/, (b) => toList(b, 'ul')],
    [/^1[.)]$/, (b) => toList(b, 'ol')],
    [/^\[ ?\]$/, (b) => {
      if (b.nodeName !== 'LI') return toList(b, 'ul', true);
      setChecklist(b.parentElement, true);
      return b;
    }],
    [/^>$/, (b) => retag(b, 'blockquote')],
    [/^```$/, (b) => retag(b, 'pre')],
  ];

  // Runs on the Space keydown, before the space is typed.
  function markdownShortcut(root) {
    const sel = selectionIn(root);
    const block = blockOf(root);
    if (!sel || !sel.isCollapsed || !block || block.nodeName === 'PRE') return false;
    const prefix = rangeFromBlockStart(block);
    const token = prefix.toString().replace(/\u00a0/g, ' ');
    if (!token || token.includes(' ')) return false;
    const hit = SHORTCUTS.find(([re]) => re.test(token));
    // Inside a list item only "[] " applies (turns the list into a checklist).
    if (!hit || (block.nodeName === 'LI' && !/^\[ ?\]$/.test(token))) return false;
    prefix.deleteContents();
    const target = hit[1](fill(block));
    caretAt(target, 0);
    return true;
  }

  // ---------- shared by the note editor and the document editor ----------

  // Keys: Markdown-style shortcuts, code blocks, list indenting, link / highlight / inline code.
  function editingKeys(body, syncBody, addLink) {
    return (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === ' ' && !mod && !e.altKey && markdownShortcut(body)) {
        e.preventDefault();
        syncBody();
        return;
      }
      const block = blockOf(body);
      if (e.key === 'Enter' && block && block.nodeName === 'PRE') {
        e.preventDefault();
        if (mod) {
          const p = h('p', null, h('br'));
          block.after(p);
          caretToEnd(p);
          syncBody();
        } else exec('insertLineBreak');
        return;
      }
      if (e.key === 'Tab' && !mod) {
        if (ancestor(body, (x) => x.nodeName === 'LI')) {
          e.preventDefault();
          exec(e.shiftKey ? 'outdent' : 'indent');
        } else if (!e.shiftKey) {
          e.preventDefault();
          exec('insertText', '    ');
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); addLink(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); toggleInline(body, 'mark'); syncBody(); return; }
      if (mod && e.key === 'e') { e.preventDefault(); toggleInline(body, 'code'); syncBody(); }
    };
  }

  // Paste: keep structure, drop styles. Plain text stays plain.
  function pasteRich(e, body, clean) {
    e.preventDefault();
    const data = e.clipboardData;
    const htmlData = data.getData('text/html');
    const text = data.getData('text/plain');
    if (blockOf(body) && blockOf(body).nodeName === 'PRE') exec('insertText', text);
    else if (htmlData) exec('insertHTML', clean(htmlData.replace(/<!--[\s\S]*?-->/g, '')));
    else if (text.includes('\n')) exec('insertHTML', QN.html.fromText(text));
    else exec('insertText', text);
  }

  // Ctrl+K or the toolbar: link the selection (or insert the address) to a web page.
  async function promptLink(body, syncBody, intro) {
    const sel = selectionIn(body);
    const range = sel ? sel.getRangeAt(0).cloneRange() : null;
    const values = await ui.form('Add link', [{ name: 'url', label: 'Web address', placeholder: 'https://…' }], { submitLabel: 'Add link', intro });
    if (!values || !values.url) return;
    const url = /^[a-z]+:/i.test(values.url) ? values.url : `https://${values.url}`;
    body.focus();
    if (range) {
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
    } else ensureSelection(body);
    if (window.getSelection().isCollapsed) exec('insertHTML', `<a href="${QN.html.escape(url)}">${QN.html.escape(url)}</a>&nbsp;`);
    else exec('createLink', url);
    syncBody();
  }

  // Paragraph style menu and bold / italic / underline / strike buttons, kept in step with the selection.
  function formatControls(body, syncBody) {
    const tb = (ic, label, fn, cls) => h('button', {
      type: 'button',
      class: `icon-btn ${cls || ''}`,
      title: label,
      'aria-label': label,
      onMouseDown: (e) => e.preventDefault(),
      onClick: () => { ensureSelection(body); fn(); syncBody(); },
    }, icon(ic));

    const blockBtn = h('button', {
      type: 'button',
      class: 'btn ghost sm block-btn',
      title: 'Paragraph style',
      onMouseDown: (e) => e.preventDefault(),
      onClick: () => {
        ensureSelection(body);
        ui.menu(blockBtn, [['<p>', 'Text', 'P'], ['<h1>', 'Heading 1', 'H1'], ['<h2>', 'Heading 2', 'H2'], ['<h3>', 'Heading 3', 'H3'], ['<pre>', 'Code block', 'PRE'], ['<blockquote>', 'Quote', 'BLOCKQUOTE']]
          .map(([tag, label, name]) => ({ label, hint: name === 'H1' ? '# ' : name === 'H2' ? '## ' : name === 'PRE' ? '``` ' : name === 'BLOCKQUOTE' ? '> ' : '', checked: (blockOf(body) || {}).nodeName === name, onClick: () => { exec('formatBlock', tag); syncBody(); } })));
      },
    }, h('span', { class: 'block-label' }, 'Text'), icon('chevDown'));

    const fmtButtons = {
      bold: tb('bold', 'Bold (Ctrl+B)', () => exec('bold')),
      italic: tb('italic', 'Italic (Ctrl+I)', () => exec('italic')),
      underline: tb('underline', 'Underline (Ctrl+U)', () => exec('underline')),
      strikeThrough: tb('strike', 'Strikethrough', () => exec('strikeThrough')),
    };

    // Reflect the current formatting in the toolbar.
    const onSelection = () => {
      if (!body.isConnected) { document.removeEventListener('selectionchange', onSelection); return; }
      if (!selectionIn(body)) return;
      for (const [cmd, btn] of Object.entries(fmtButtons)) {
        let on = false;
        try { on = document.queryCommandState(cmd); } catch { /* ignore */ }
        btn.classList.toggle('on', on);
      }
      const b = blockOf(body);
      blockBtn.querySelector('.block-label').textContent = BLOCK_LABEL[b ? b.nodeName : 'P'] || 'Text';
    };
    document.addEventListener('selectionchange', onSelection);
    return { tb, blockBtn, fmtButtons };
  }

  // ---------- the editor ----------

  function create(n, opts = {}) {
    const body = h('div', {
      class: 'rt-editor',
      contenteditable: 'true',
      spellcheck: 'true',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': 'Note text',
      'data-placeholder': 'Start writing…  Tip: "# " heading, "- " list, "[] " checklist, "``` " code, "[[" link a note',
    });
    body.innerHTML = QN.html.sanitize(n.html) || '<p><br></p>';

    const footer = h('div', { class: 'editor-foot' });
    const updateFooter = () => {
      const words = util.words(n.text);
      footer.replaceChildren(
        h('span', null, util.plural(words, 'word')),
        h('span', null, `${(n.text || '').length.toLocaleString()} characters`),
        h('span', null, `${Math.max(1, Math.round(words / 200))} min read`),
        h('span', null, `Created ${util.fmtDateTime(n.createdAt)}`),
        h('span', null, `Edited ${util.relTime(n.updatedAt)}`));
    };

    // Remember when the note was last opened (for "Recently viewed"). Not an edit.
    n.viewedAt = util.now();
    store.commit();

    const touch = () => {
      n.updatedAt = util.now();
      store.commit();
      updateFooter();
      if (opts.onChange) opts.onChange(n);
    };
    const syncBody = () => {
      // Keep a paragraph after a trailing code block / quote so there is always a way out.
      const last = body.lastElementChild;
      normalize(body);
      if (last && /^(PRE|BLOCKQUOTE|HR|TABLE)$/.test(last.nodeName)) body.append(h('p', null, h('br')));
      n.html = QN.html.sanitize(body.innerHTML);
      n.text = QN.html.toText(n.html);
      touch();
    };

    body.addEventListener('input', (e) => {
      if (e.inputType === 'insertText' && e.data === '[') {
        const b = blockOf(body);
        if (b && b.nodeName !== 'PRE' && rangeFromBlockStart(b).toString().endsWith('[[')) setTimeout(() => openNotePicker(true), 0);
      }
      if (e.inputType === 'insertParagraph') {
        const li = ancestor(body, (x) => x.nodeName === 'LI');
        if (li && li.parentElement && li.parentElement.hasAttribute('data-checklist')) li.setAttribute('data-checked', 'false');
      }
      if (!body.firstChild) body.innerHTML = '<p><br></p>';
      syncBody();
    });

    body.addEventListener('keydown', editingKeys(body, syncBody, () => addLink()));

    // Checklist boxes: click in the box area to tick / untick.
    body.addEventListener('mousedown', (e) => {
      const li = e.target.closest && e.target.closest('ul[data-checklist] > li');
      if (!li || !body.contains(li)) return;
      if (e.clientX - li.getBoundingClientRect().left > 24) return;
      e.preventDefault();
      li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
      syncBody();
    });
    body.addEventListener('click', (e) => {
      const noteLink = e.target.closest && e.target.closest('a[data-note]');
      if (noteLink && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        openNoteLink(noteLink.getAttribute('data-note'));
        return;
      }
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        window.api.openExternal(a.getAttribute('href'));
      }
    });

    // Paste: screenshots / files become attachments; everything else keeps structure, drops styles.
    body.addEventListener('paste', (e) => {
      if (QN.files.handlePaste(e, n)) return;
      pasteRich(e, body, QN.html.sanitize);
    });
    body.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      QN.files.add(n, e.dataTransfer.files);
    });
    body.addEventListener('blur', () => {
      if (!String(n.title || '').trim() && String(n.text || '').trim()) {
        n.title = util.autoTitle(n.text);
        title.value = n.title;
        touch();
      }
      renderRelated();
    });

    function openNoteLink(id) {
      const target = store.find('notes', id);
      if (!target || target.deletedAt) ui.toast('That note is in Trash or no longer exists', { type: 'error' });
      else QN.app.go('notes', { select: id });
    }

    // "[[" or the toolbar button: pick a note (or create one) and insert a link to it.
    function openNotePicker(fromBrackets) {
      ensureSelection(body);
      const caret = window.getSelection().getRangeAt(0).cloneRange();
      let rect = caret.getBoundingClientRect();
      if (!rect || (!rect.top && !rect.left)) rect = (blockOf(body) || body).getBoundingClientRect();
      const insertNoteLink = (target) => {
        body.focus();
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(caret);
        const r = caret.cloneRange();
        if (fromBrackets && r.startContainer.nodeType === 3 && r.startOffset >= 2 && r.startContainer.data.slice(r.startOffset - 2, r.startOffset) === '[[') {
          r.setStart(r.startContainer, r.startOffset - 2);
          r.deleteContents();
        }
        const a = h('a', { href: `#note:${target.id}`, 'data-note': target.id }, QN.noteTitle(target));
        r.insertNode(a);
        const space = document.createTextNode('\u00a0');
        a.after(space);
        caretAt(space, 1);
        syncBody();
        renderRelated();
      };
      ui.picker({
        x: rect.left,
        y: rect.bottom + 6,
        placeholder: 'Link to a note… (type to search)',
        items: (q) => {
          const words = q.toLowerCase().split(/\s+/).filter(Boolean);
          const list = store.live('notes')
            .filter((x) => x.id !== n.id && !x.archived && words.every((w) => QN.noteTitle(x).toLowerCase().includes(w)))
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
            .slice(0, 8)
            .map((x) => ({ label: QN.noteTitle(x), hint: QN.folders.path(x.folderId), icon: 'notes', onPick: () => insertNoteLink(x) }));
          if (q.trim()) list.push({ label: `Create "${q.trim()}" and link it`, icon: 'plus', onPick: () => insertNoteLink(store.add('notes', QN.make.note({ title: q.trim(), folderId: n.folderId }))) });
          return list;
        },
        onCancel: () => {
          body.focus();
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(caret);
        },
      });
    }

    // Backlinks, outgoing links and tickets mentioned in this note.
    const relatedEl = h('div', { class: 'related' });
    function renderRelated() {
      const backlinks = store.live('notes').filter((x) => x.id !== n.id && String(x.html || '').includes(`data-note="${n.id}"`));
      const outIds = [...new Set([...String(n.html || '').matchAll(/data-note="([^"]+)"/g)].map((m) => m[1]))];
      const outgoing = outIds.map((i) => store.find('notes', i)).filter((x) => x && !x.deletedAt);
      const tickets = QN.tickets.find(`${n.title}\n${n.text}`).map((t) => {
        const r = QN.tickets.related(t);
        r.notes = r.notes.filter((x) => x.id !== n.id);
        return [t, QN.tickets.count(r)];
      }).filter(([, c]) => c > 0);
      const chip = (x) => h('button', { type: 'button', class: 'rel-chip', onClick: () => QN.app.go('notes', { select: x.id }) }, icon('notes'), QN.noteTitle(x));
      const rows = [];
      if (outgoing.length) rows.push(h('div', { class: 'rel-row' }, h('span', { class: 'rel-label' }, 'Links to'), outgoing.map(chip)));
      if (backlinks.length) rows.push(h('div', { class: 'rel-row' }, h('span', { class: 'rel-label' }, 'Linked from'), backlinks.map(chip)));
      if (tickets.length) {
        rows.push(h('div', { class: 'rel-row' }, h('span', { class: 'rel-label' }, 'Tickets'), tickets.map(([t, c]) => h('button', {
          type: 'button', class: 'rel-chip ticket', title: 'Open the ticket hub', onClick: () => QN.tickets.openHub(t),
        }, icon('link'), h('span', { class: 'mono' }, t), h('span', { class: 'rel-count' }, `${c} related`)))));
      }
      relatedEl.replaceChildren(...rows);
      relatedEl.hidden = !rows.length;
    }

    // ---------- toolbar ----------

    const addLink = () => promptLink(body, syncBody, 'Ctrl+click a link in a note to open it in your browser.');
    const { tb, blockBtn, fmtButtons } = formatControls(body, syncBody);

    const starBtn = h('button', {
      type: 'button',
      class: `icon-btn star-btn${n.starred ? ' on' : ''}`,
      title: n.starred ? 'Remove from Favorites' : 'Add to Favorites',
      'aria-pressed': n.starred ? 'true' : 'false',
      onClick: () => {
        n.starred = !n.starred;
        starBtn.classList.toggle('on', n.starred);
        starBtn.setAttribute('aria-pressed', n.starred ? 'true' : 'false');
        starBtn.title = n.starred ? 'Remove from Favorites' : 'Add to Favorites';
        touch();
      },
    }, icon('star'));

    const colorBtn = h('button', {
      type: 'button',
      class: 'icon-btn',
      title: 'Card colour',
      onClick: () => ui.menu(colorBtn, COLORS.map(([c, label]) => ({ label, swatch: c, checked: (n.color || '') === c, onClick: () => { n.color = c; if (c) el.setAttribute('data-color', c); else el.removeAttribute('data-color'); touch(); } })), { alignRight: true }),
    }, icon('palette'));

    const folderChip = h('button', { type: 'button', class: 'folder-chip', title: 'Move to folder' });
    const renderFolderChip = () => folderChip.replaceChildren(icon('folder'), h('span', null, folderPath(n.folderId) || 'Unfiled'), icon('chevDown'));
    renderFolderChip();
    folderChip.addEventListener('click', () => ui.menu(folderChip, folderMenuItems(n.folderId, (id) => { n.folderId = id; renderFolderChip(); touch(); })));

    const moreBtn = h('button', {
      type: 'button',
      class: 'icon-btn',
      title: 'More',
      onClick: () => ui.menu(moreBtn, [
        opts.onDuplicate ? { label: 'Duplicate', icon: 'duplicate', onClick: () => opts.onDuplicate(n) } : null,
        opts.onArchive ? { label: n.archived ? 'Restore from Archive' : 'Archive', icon: 'archive', hint: 'hide, keep', onClick: () => opts.onArchive(n) } : null,
        { label: 'Copy as plain text', icon: 'copy', hint: 'Jira, Teams, email', onClick: () => ui.copy(`${n.title ? `${n.title}\n\n` : ''}${QN.html.toText(n.html)}`, 'Note') },
        { label: 'Copy as Markdown', icon: 'copy', onClick: () => ui.copy(QN.exporter.asMarkdown(n), 'Markdown') },
        { label: 'Save as template', icon: 'template', onClick: saveAsTemplate },
        { header: 'Export' },
        ...QN.exporter.formatMenuItems((fmt) => QN.exporter.exportNote(n, fmt)),
        { separator: true },
        { label: 'Move to Trash', icon: 'trash', danger: true, onClick: () => opts.onDelete && opts.onDelete(n) },
      ], { alignRight: true }),
    }, icon('more'));

    async function saveAsTemplate() {
      const values = await ui.form('Save as template', [{ name: 'name', label: 'Template name', value: n.title || 'My template' }], { submitLabel: 'Save template', intro: 'New notes can start from this template (New ▾ in Notes).' });
      if (!values || !values.name) return;
      store.add('noteTemplates', QN.make.noteTemplate({ name: values.name, html: n.html }));
      ui.toast('Template saved');
    }

    const toolbar = h('div', { class: 'editor-toolbar rt-toolbar' },
      blockBtn,
      h('div', { class: 'tb-group' }, fmtButtons.bold, fmtButtons.italic, fmtButtons.underline, fmtButtons.strikeThrough,
        tb('highlight', 'Highlight (Ctrl+Shift+H)', () => toggleInline(body, 'mark')),
        tb('code', 'Inline code (Ctrl+E)', () => toggleInline(body, 'code'))),
      h('div', { class: 'tb-group' },
        tb('list', 'Bullet list', () => listCommand(body, 'ul')),
        tb('listOrdered', 'Numbered list', () => listCommand(body, 'ol')),
        tb('checklist', 'Checklist', () => listCommand(body, 'ul', true)),
        tb('quote', 'Quote', () => exec('formatBlock', (blockOf(body) || {}).nodeName === 'BLOCKQUOTE' ? '<p>' : '<blockquote>')),
        tb('codeBlock', 'Code block (Ctrl+Enter leaves it)', () => exec('formatBlock', (blockOf(body) || {}).nodeName === 'PRE' ? '<p>' : '<pre>')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Web link (Ctrl+K)', 'aria-label': 'Web link', onMouseDown: (e) => e.preventDefault(), onClick: addLink }, icon('link')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Link to another note (type [[)', 'aria-label': 'Link to note', onMouseDown: (e) => e.preventDefault(), onClick: () => openNotePicker(false) }, icon('notes')),
        tb('minus', 'Divider', () => exec('insertHorizontalRule')),
        tb('eraser', 'Clear formatting', () => { exec('removeFormat'); exec('formatBlock', '<p>'); })),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'icon-btn zen-btn', title: 'Distraction-free mode (Ctrl+Shift+F)', 'aria-label': 'Distraction-free mode', onClick: () => QN.app.toggleZen() }, icon('zen')),
      starBtn, colorBtn, moreBtn,
      opts.onClose ? h('button', { type: 'button', class: 'icon-btn', title: 'Close (Esc)', onClick: opts.onClose }, icon('x')) : null);

    const title = h('input', {
      class: 'note-title',
      value: n.title,
      placeholder: 'Untitled',
      'aria-label': 'Note title',
      spellcheck: 'true',
      onInput: (e) => { n.title = e.target.value; touch(); },
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); body.focus(); caretToEnd(body.firstElementChild || body); } },
    });
    const tags = h('input', {
      class: 'note-tags',
      value: (n.tags || []).map((t) => `#${t}`).join(', '),
      placeholder: 'Add tags, e.g. #regression, #release-2.4',
      'aria-label': 'Tags',
      onChange: (e) => { n.tags = parseTags(e.target.value); e.target.value = n.tags.map((t) => `#${t}`).join(', '); touch(); },
    });

    updateFooter();
    renderRelated();
    const archivedBanner = n.archived ? h('div', { class: 'archived-banner' }, icon('archive'), h('span', null, 'This note is archived. It is hidden from your notes and search (find it with is:archived).'),
      opts.onArchive ? h('button', { type: 'button', class: 'btn sm', onClick: () => opts.onArchive(n) }, icon('undo'), 'Restore') : null) : null;
    const el = h('div', { class: 'editor note-editor', 'data-color': n.color || null },
      toolbar,
      h('div', { class: 'editor-scroll' },
        archivedBanner,
        h('div', { class: 'editor-head' }, title, h('div', { class: 'editor-meta' }, folderChip, tags)),
        h('div', { class: 'editor-surface' }, body, relatedEl, QN.files.panel(n, { label: 'Attachments', compact: true, dropTitle: 'Attach files to this note' }))),
      footer);

    return {
      el,
      focusTitle: () => title.focus(),
      focusBody: () => { body.focus(); caretToEnd(body.lastElementChild || body); },
    };
  }

  // ---------- Word documents edited in QAura ----------

  // The same editing engine as notes, without the note-only parts (title, tags, note links).
  // Pictures stay inside the document (as embedded images), so they are saved back into the .docx.
  function docEditor(opts) {
    const body = h('div', {
      class: 'rt-view docx-preview doc-editable',
      contenteditable: 'true',
      spellcheck: 'true',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': opts.label || 'Document',
    });
    body.innerHTML = QN.html.sanitizeDoc(opts.html) || '<p><br></p>';
    const syncBody = () => {
      normalize(body);
      if (!body.firstChild) body.innerHTML = '<p><br></p>';
      opts.onChange();
    };
    const addLink = () => promptLink(body, syncBody, 'Ctrl+click a link to open it in your browser.');

    const readAsDataUrl = (file) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    async function insertPictures(files) {
      let n = 0;
      for (const file of files) {
        if (!file || !/^image\/(png|jpeg|gif|bmp|webp)$/.test(file.type)) continue;
        const url = await readAsDataUrl(file);
        ensureSelection(body);
        exec('insertHTML', `<img src="${QN.html.escape(url)}" alt="">`);
        n += 1;
      }
      if (n) syncBody();
      else if (files.length) ui.toast('Only pictures (PNG, JPG, GIF, BMP, WebP) can be added to a document', { type: 'error' });
    }

    body.addEventListener('input', syncBody);
    body.addEventListener('keydown', editingKeys(body, syncBody, addLink));
    body.addEventListener('paste', (e) => {
      const data = e.clipboardData;
      const pictures = data && ![...data.types].includes('text/html') && ![...data.types].includes('text/plain')
        ? [...data.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()) : [];
      if (pictures.length) {
        e.preventDefault();
        insertPictures(pictures);
        return;
      }
      pasteRich(e, body, QN.html.sanitizeDoc);
      syncBody();
    });
    body.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = document.caretPositionFromPoint && document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos && body.contains(pos.offsetNode)) caretAt(pos.offsetNode, pos.offset);
      insertPictures([...e.dataTransfer.files]);
    });
    body.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        window.api.openExternal(a.getAttribute('href'));
      }
    });

    const { tb, blockBtn, fmtButtons } = formatControls(body, syncBody);
    const picInput = h('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/gif,image/bmp,image/webp',
      multiple: true,
      hidden: true,
      onChange: (e) => { insertPictures([...e.target.files]); e.target.value = ''; },
    });
    const btn = (ic, label, onClick) => h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onMouseDown: (e) => e.preventDefault(), onClick }, icon(ic));
    const tableHtml = `<table><tbody><tr>${'<th><br></th>'.repeat(3)}</tr>${`<tr>${'<td><br></td>'.repeat(3)}</tr>`.repeat(2)}</tbody></table><p><br></p>`;
    const toolbar = h('div', { class: 'editor-toolbar rt-toolbar doc-toolbar' },
      blockBtn,
      h('div', { class: 'tb-group' }, fmtButtons.bold, fmtButtons.italic, fmtButtons.underline, fmtButtons.strikeThrough,
        tb('highlight', 'Highlight (Ctrl+Shift+H)', () => toggleInline(body, 'mark'))),
      h('div', { class: 'tb-group' },
        tb('list', 'Bullet list', () => listCommand(body, 'ul')),
        tb('listOrdered', 'Numbered list', () => listCommand(body, 'ol')),
        tb('quote', 'Quote', () => exec('formatBlock', (blockOf(body) || {}).nodeName === 'BLOCKQUOTE' ? '<p>' : '<blockquote>')),
        tb('codeBlock', 'Code block (Ctrl+Enter leaves it)', () => exec('formatBlock', (blockOf(body) || {}).nodeName === 'PRE' ? '<p>' : '<pre>')),
        btn('link', 'Web link (Ctrl+K)', addLink),
        btn('image', 'Insert picture (or paste / drop one)', () => picInput.click()),
        tb('table', 'Insert table', () => exec('insertHTML', tableHtml)),
        tb('minus', 'Divider', () => exec('insertHorizontalRule')),
        tb('eraser', 'Clear formatting', () => { exec('removeFormat'); exec('formatBlock', '<p>'); })),
      picInput);

    return {
      toolbar,
      body,
      getHtml: () => QN.html.sanitizeDoc(body.innerHTML),
      focus: () => { body.focus(); caretToEnd(body.lastElementChild || body); },
    };
  }

  QN.editor = { create, docEditor };
})();
