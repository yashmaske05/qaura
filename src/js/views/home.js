(function () {
  'use strict';

  const QN = window.QN;
  const { h, icon, util, store, defs, ui } = QN;

  let root = null;

  function greeting() {
    const hr = new Date().getHours();
    return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  }

  function render() {
    if (!root) return;
    const today = util.today();
    const tasks = store.live('tasks');
    const todays = tasks.filter((t) => t.date === today);
    const doneToday = todays.filter((t) => t.status === 'done').length;
    const openToday = todays.filter((t) => t.status !== 'done').sort(QN.tasks.sortTasks);
    const doing = tasks.filter((t) => t.status === 'doing');
    const blocked = tasks.filter((t) => t.status === 'blocked');
    const stale = QN.tasks.staleTasks();
    const bugs = store.live('bugs');
    const activeBugs = bugs.filter(QN.bugs.isActive);
    const retest = bugs.filter((b) => b.status === 'retest');
    // Favorites first, then the most recently edited.
    const notes = store.live('notes').filter((n) => !n.archived).sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

    root.replaceChildren(h('div', { class: 'view home' },
      h('section', { class: 'hero' },
        h('div', { class: 'hero-text' },
          h('p', { class: 'eyebrow' }, util.fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
          h('h1', { class: 'hero-title' }, greeting()),
          h('p', { class: 'hero-sub' }, todays.length
            ? `${util.plural(openToday.length, 'task')} left today${blocked.length ? `, ${blocked.length} blocked` : ''}${retest.length ? `, ${util.plural(retest.length, 'bug')} waiting for retest` : ''}.`
            : 'Nothing planned yet. Capture your first task below.')),
        ui.ring(todays.length ? doneToday / todays.length : 0, todays.length ? `${doneToday}/${todays.length}` : '0')),
      captureBox(),
      h('div', { class: 'stat-grid' },
        stat('tasks', 'Today', `${doneToday}/${todays.length}`, 'tasks done', () => QN.app.go('tasks', { mode: 'day', date: today })),
        stat('play', 'In progress', doing.length, doing.length === 1 ? 'task' : 'tasks', () => QN.app.go('tasks', { mode: 'open' })),
        stat('flag', 'Blocked', blocked.length, blocked.length ? 'needs attention' : 'all clear', () => QN.app.go('tasks', { mode: 'open' }), blocked.length ? 'warn' : ''),
        stat('bug', 'Active bugs', activeBugs.length, retest.length ? `${retest.length} ready for retest` : 'tracked', () => QN.app.go('bugs'))),
      h('div', { class: 'home-grid' },
        card('Focus for today', 'tasks', () => QN.app.go('tasks'), openToday.length
          ? h('ul', { class: 'mini-list' }, openToday.slice(0, 7).map((t) => h('li', { class: `mini-task p-${t.priority}` },
            h('input', { type: 'checkbox', class: 'check sm', 'aria-label': `Mark "${t.title}" done`, onChange: () => { QN.tasks.setStatus(t, 'done'); render(); ui.toast('Nice, task done', { action: { label: 'Undo', fn: () => { QN.tasks.setStatus(t, 'todo'); render(); } } }); } }),
            h('button', { type: 'button', class: 'mini-link', onClick: () => QN.app.go('tasks', { focus: t.id }) }, t.title),
            t.ticket ? h('span', { class: 'chip mono' }, t.ticket) : null,
            t.status !== 'todo' ? ui.pill(`ts-${t.status}`, defs.label(defs.taskStatus, t.status)) : null)))
          : h('div', { class: 'mini-empty' }, todays.length ? 'Everything for today is done.' : 'No tasks for today yet.')),
        card('Needs attention', 'alert', null, attentionList(stale, blocked, retest)),
        card('Favorites & recent notes', 'star', () => QN.app.go('notes', { scope: notes.some((n) => n.starred) ? 'favorites' : 'all' }), h('div', { class: 'card-stack' },
          notes.length ? h('ul', { class: 'mini-list' }, notes.slice(0, 6).map((n) => h('li', null,
            n.starred ? icon('star', 'li-star') : icon('notes', 'muted-icon'),
            h('button', { type: 'button', class: 'mini-link', onClick: () => QN.app.go('notes', { select: n.id }) }, QN.noteTitle(n)),
            h('span', { class: 'mini-time' }, util.relTime(n.updatedAt))))) : h('div', { class: 'mini-empty' }, 'No notes yet.'),
          h('button', { type: 'button', class: 'btn ghost sm card-cta', onClick: () => QN.app.go('notes', { daily: true }) }, icon('calendar'), "Open today's daily note"))),
        card('Recent bugs', 'bug', () => QN.app.go('bugs'), activeBugs.length
          ? h('ul', { class: 'mini-list' }, activeBugs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 5).map((b) => h('li', null,
            h('span', { class: `sev-dot ${b.severity}` }),
            h('button', { type: 'button', class: 'mini-link', onClick: () => QN.app.go('bugs', { select: b.id }) }, b.title || 'Untitled bug'),
            ui.pill(`bs-${b.status}`, defs.label(defs.bugStatus, b.status)))))
          : h('div', { class: 'mini-empty' }, 'No active bugs.')))));
  }

  function captureBox() {
    const chips = h('div', { class: 'capture-chips' });
    const input = h('input', {
      id: 'home-capture',
      class: 'capture-input',
      placeholder: 'Capture anything…',
      autocomplete: 'off',
      spellcheck: 'true',
      'aria-label': 'Quick capture',
      onInput: () => chips.replaceChildren(...QN.capture.chips(QN.capture.parse(input.value, 'task'))),
    });
    return h('form', {
      class: 'capture',
      onSubmit: (e) => {
        e.preventDefault();
        const p = QN.capture.parse(input.value, 'task');
        if (!p.title) return;
        QN.capture.captureAndAnnounce(p);
        render();
        const next = document.getElementById('home-capture');
        if (next) next.focus();
      },
    },
    h('div', { class: 'capture-box' }, icon('bolt', 'capture-icon'), input, chips, h('kbd', null, 'Enter')),
    h('div', { class: 'capture-hints' },
      h('span', null, h('code', null, 'bug:'), ' logs a bug'),
      h('span', null, h('code', null, 'note:'), ' makes a note'),
      h('span', null, h('code', null, '!high'), ' priority'),
      h('span', null, h('code', null, '@tomorrow'), ' plan ahead'),
      h('span', null, h('code', null, 'ABC-123'), ' links a ticket'),
      h('span', null, h('kbd', null, 'Ctrl K'), ' search everything')));
  }

  function stat(ic, label, value, sub, onClick, cls) {
    return h('button', { type: 'button', class: `stat ${cls || ''}`, onClick },
      h('div', { class: 'stat-top' }, icon(ic), h('span', null, label)),
      h('div', { class: 'stat-value' }, String(value)),
      h('div', { class: 'stat-sub' }, sub));
  }

  function card(title, ic, onOpen, body) {
    return h('section', { class: 'card home-card' },
      h('header', { class: 'card-head' }, icon(ic), h('h2', null, title), h('div', { class: 'spacer' }),
        onOpen ? h('button', { type: 'button', class: 'icon-btn', title: `Open ${title}`, onClick: onOpen }, icon('arrowRight')) : null),
      body);
  }

  function attentionList(stale, blocked, retest) {
    const items = [];
    if (stale.length) {
      items.push(h('li', { class: 'attn' }, icon('clock', 'attn-icon amber'),
        h('span', { class: 'attn-text' }, `${util.plural(stale.length, 'unfinished task')} from earlier days`),
        h('button', { type: 'button', class: 'btn primary sm', onClick: () => { QN.tasks.carryOver(stale); render(); ui.toast(`Moved ${util.plural(stale.length, 'task')} to today`); } }, 'Move to today')));
    }
    for (const t of blocked.slice(0, 3)) {
      items.push(h('li', { class: 'attn' }, icon('flag', 'attn-icon red'),
        h('button', { type: 'button', class: 'mini-link attn-text', onClick: () => QN.app.go('tasks', { focus: t.id }) }, `Blocked: ${t.title}`, t.blocker ? h('span', { class: 'muted' }, ` (${t.blocker})`) : null)));
    }
    for (const b of retest.slice(0, 3)) {
      items.push(h('li', { class: 'attn' }, icon('bug', 'attn-icon violet'),
        h('button', { type: 'button', class: 'mini-link attn-text', onClick: () => QN.app.go('bugs', { select: b.id }) }, `Retest${b.ticket ? ` ${b.ticket}` : ''}: ${b.title || 'Untitled'}`)));
    }
    return items.length ? h('ul', { class: 'mini-list' }, items) : h('div', { class: 'mini-empty' }, 'Nothing needs attention right now.');
  }

  QN.views = QN.views || {};
  QN.views.home = {
    mount(el) {
      root = el;
      render();
      const input = document.getElementById('home-capture');
      if (input) input.focus();
    },
    unmount() { root = null; },
    refresh: () => render(),
    onNew() {
      const input = document.getElementById('home-capture');
      if (input) input.focus();
    },
  };
})();
