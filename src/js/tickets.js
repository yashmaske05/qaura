(function () {
  'use strict';

  // Ticket hub: everything that mentions a ticket ID (ABC-123) across notes, tasks, bugs, runs and snippets.
  const QN = window.QN;
  const { h, icon, util, store, defs, ui } = QN;

  const RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
  const find = (text) => [...new Set(String(text || '').match(RE) || [])];

  function related(ticket) {
    const has = (...parts) => parts.some((s) => String(s || '').includes(ticket));
    return {
      bugs: store.live('bugs').filter((b) => b.ticket === ticket || has(b.title, b.notes, b.steps, b.actual)),
      tasks: store.live('tasks').filter((t) => t.ticket === ticket || has(t.title, t.notes, t.blocker)),
      notes: store.live('notes').filter((n) => has(n.title, n.text)),
      snippets: store.live('snippets').filter((s) => has(s.title, s.description, s.code)),
    };
  }
  const count = (r) => Object.values(r).reduce((n, arr) => n + arr.length, 0);

  function rows(r) {
    const go = (view, params) => () => QN.app.go(view, params);
    return [
      ['Bugs', 'bug', r.bugs.map((b) => ({ label: b.title || 'Untitled bug', hint: defs.label(defs.bugStatus, b.status), pill: `bs-${b.status}`, go: go('bugs', { select: b.id }) }))],
      ['Tasks', 'tasks', r.tasks.map((t) => ({ label: t.title, hint: `${defs.label(defs.taskStatus, t.status)} · ${util.relDay(t.date)}`, pill: `ts-${t.status}`, go: go('tasks', { focus: t.id }) }))],
      ['Notes', 'notes', r.notes.map((n) => ({ label: QN.noteTitle(n), hint: QN.folders.path(n.folderId) || util.relTime(n.updatedAt), go: go('notes', { select: n.id }) }))],
      ['Snippets', 'snippet', r.snippets.map((s) => ({ label: s.title || 'Untitled snippet', hint: s.language, go: go('snippets', { select: s.id }) }))],
    ].filter(([, , items]) => items.length);
  }

  function summary(ticket, r) {
    const lines = [`${ticket}`];
    for (const [title, , items] of rows(r)) {
      lines.push('', `${title}:`);
      for (const it of items) lines.push(`- ${it.label} (${it.hint})`);
    }
    return lines.join('\n');
  }

  function openHub(ticket) {
    const r = related(ticket);
    const n = count(r);
    const sections = rows(r);
    let ref;
    const content = h('div', { class: 'hub' },
      h('header', { class: 'hub-head' },
        h('div', { class: 'hub-title' }, icon('link'), h('span', { class: 'mono' }, ticket)),
        h('span', { class: 'muted' }, util.plural(n, 'linked item')),
        h('div', { class: 'spacer' }),
        n ? h('button', { type: 'button', class: 'btn sm', onClick: () => ui.copy(summary(ticket, r), 'Ticket summary') }, icon('copy'), 'Copy summary') : null,
        h('button', { type: 'button', class: 'icon-btn', title: 'Close (Esc)', onClick: () => ref.close() }, icon('x'))),
      n
        ? h('div', { class: 'hub-body' }, sections.map(([title, ic, items]) => h('section', { class: 'hub-section' },
          h('h3', null, icon(ic), title, h('span', { class: 'group-count' }, items.length)),
          h('ul', { class: 'mini-list' }, items.map((it) => h('li', null,
            h('button', { type: 'button', class: 'mini-link', onClick: it.go }, it.label),
            it.pill ? ui.pill(it.pill, it.hint) : h('span', { class: 'mini-time' }, it.hint)))))))
        : ui.empty('link', `Nothing mentions ${ticket} yet`, 'Add the ticket ID to a task, bug, note or snippet and it appears here.'));
    ref = ui.drawer(content, { label: `Ticket ${ticket}` });
  }

  QN.tickets = { find, related, count, openHub, RE };
})();
