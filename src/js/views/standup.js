(function () {
  'use strict';

  const QN = window.QN;
  const { h, icon, util, store, make, defs, ui } = QN;

  let root = null;
  let date = null;
  let since = null;
  let draft = null; // keeps manual edits while you move around the app

  const workdays = () => store.state.settings.workdays;

  // Everything from `since` up to (not including) `day` counts as "yesterday".
  function collect(day, from) {
    const inRange = (iso) => {
      const d = util.dateOf(iso);
      return d >= from && d < day;
    };
    const tasks = store.live('tasks');
    const bugs = store.live('bugs');
    const tag = (ticket) => (ticket ? ` (${ticket})` : '');

    const done = tasks.filter((t) => t.status === 'done' && t.completedAt && inRange(t.completedAt));
    const logged = bugs.filter((b) => inRange(b.createdAt));
    const moved = bugs.flatMap((b) => (b.history || [])
      .filter((x) => inRange(x.at) && ['verified', 'closed', 'reopened', 'rejected'].includes(x.to))
      .map((x) => ({ b, to: x.to })));

    const todayTasks = tasks
      .filter((t) => t.status !== 'done' && t.status !== 'blocked' && (t.date === day || t.status === 'doing'))
      .sort(QN.tasks.sortTasks);
    const retest = bugs.filter((b) => b.status === 'retest');
    const blocked = tasks.filter((t) => t.status === 'blocked');

    const yesterday = [
      ...done.map((t) => `Completed: ${t.title}${tag(t.ticket)}`),
      ...logged.map((b) => `Logged bug${b.ticket ? ` ${b.ticket}` : ''}: ${b.title || 'Untitled'}`),
      ...moved.map(({ b, to }) => `${defs.label(defs.bugStatus, to)}${b.ticket ? ` ${b.ticket}` : ''}: ${b.title || 'Untitled'}`),
    ];
    const today = [
      ...todayTasks.map((t) => `${t.status === 'doing' ? 'Continue: ' : ''}${t.title}${tag(t.ticket)}`),
      ...retest.map((b) => `Retest${b.ticket ? ` ${b.ticket}` : ''}: ${b.title || 'Untitled'}`),
    ];
    const blockers = blocked.map((t) => `${t.title}${tag(t.ticket)}${t.blocker ? ` (blocked by: ${t.blocker})` : ''}`);
    return { yesterday, today, blockers, counts: { done: done.length, bugs: logged.length + moved.length, today: today.length, blockers: blockers.length } };
  }

  function generate(day, from) {
    const s = collect(day, from);
    const fromLabel = from === util.addDays(day, -1) ? 'Yesterday' : `Since ${util.fmtDate(from, { weekday: 'short', day: 'numeric', month: 'short' })}`;
    const list = (arr, emptyText) => (arr.length ? arr.map((x) => `- ${x}`) : [`- ${emptyText}`]);
    return {
      text: [
        `${fromLabel}:`, ...list(s.yesterday, 'Nothing recorded'), '',
        `Today${day === util.today() ? '' : ` (${util.fmtDate(day, { weekday: 'short', day: 'numeric', month: 'short' })})`}:`, ...list(s.today, 'Nothing planned yet'), '',
        'Blockers:', ...list(s.blockers, 'None'),
      ].join('\n'),
      counts: s.counts,
    };
  }

  function render() {
    if (!root) return;
    if (!date) date = util.today();
    if (!since) since = util.prevWorkday(date, workdays());
    const gen = generate(date, since);
    const key = `${date}|${since}`;
    if (!draft || draft.key !== key) draft = { key, text: gen.text, edited: false };

    const area = h('textarea', {
      class: 'standup-text',
      rows: 18,
      value: draft.text,
      spellcheck: 'true',
      'aria-label': 'Standup text',
      onInput: (e) => { draft.text = e.target.value; draft.edited = true; },
    });
    const regenerate = () => { draft = null; render(); };
    const c = gen.counts;

    root.replaceChildren(h('div', { class: 'view view-narrow' },
      h('header', { class: 'view-head' },
        h('div', { class: 'view-title' }, h('h1', null, 'Standup')),
        h('p', { class: 'view-sub' }, 'Built automatically from your tasks and bugs. Edit anything, then copy it into your standup.')),
      h('div', { class: 'card standup-controls' },
        ui.field('Standup for', ui.dateField({ value: date, quick: ['today', 'tomorrow', 'yesterday'], onChange: (v) => { if (v) { date = v; since = util.prevWorkday(date, workdays()); draft = null; render(); } } })),
        ui.field('"Yesterday" covers since', ui.dateField({ value: since, quick: ['yesterday', 'today'], onChange: (v) => { if (v) { since = v; draft = null; render(); } } })),
        h('div', { class: 'standup-counts' },
          ui.pill('green', `${c.done} done`), ui.pill('violet', `${c.bugs} bug updates`), ui.pill('gray', `${c.today} for today`), ui.pill(c.blockers ? 'red' : 'gray', `${c.blockers} blockers`))),
      h('div', { class: 'card standup-card' },
        area,
        h('div', { class: 'row-actions' },
          draft.edited ? h('span', { class: 'muted small' }, 'Edited by you. Regenerate to start over.') : h('span', { class: 'muted small' }, `Covers ${util.fmtDate(since)} to ${util.fmtDate(util.addDays(date, -1))}`),
          h('div', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn ghost sm', onClick: regenerate }, icon('undo'), 'Regenerate'),
          h('button', {
            type: 'button',
            class: 'btn sm',
            onClick: () => {
              const n = store.add('notes', make.note({ title: `Standup · ${util.fmtDate(date)}`, html: QN.html.fromText(draft.text), tags: ['standup'] }));
              ui.toast('Saved to Notes', { action: { label: 'Open', fn: () => QN.app.go('notes', { select: n.id }) } });
            },
          }, icon('notes'), 'Save as note'),
          h('button', { type: 'button', class: 'btn primary sm', onClick: () => ui.copy(draft.text, 'Standup') }, icon('copy'), 'Copy'))),
      h('p', { class: 'muted small hint' },
        'Yesterday = tasks you completed and bugs you logged or verified. Today = tasks planned for the day, tasks in progress, and bugs ready for retest. Blockers = tasks marked Blocked. Working days are set in Settings.')));
  }

  QN.standup = { generate };

  QN.views = QN.views || {};
  QN.views.standup = {
    mount(el) {
      root = el;
      // Fresh dates each visit, but keep your edits if nothing changed.
      const today = util.today();
      if (date !== today) { date = today; since = util.prevWorkday(today, workdays()); }
      render();
    },
    unmount() { root = null; },
    refresh: () => render(),
  };
})();
