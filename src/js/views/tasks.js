(function () {
  'use strict';

  const QN = window.QN;
  const { h, icon, util, store, make, defs, ui } = QN;

  const STATUS_ORDER = { doing: 0, blocked: 1, todo: 2, done: 3 };
  const PRIO_ORDER = { high: 0, medium: 1, low: 2 };

  let root = null;
  let viewDate = null; // null = follow today
  let mode = null; // day | open (remembered)
  const expanded = new Set();
  let focusId = null;

  const curDate = () => viewDate || util.today();
  const sortTasks = (a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
    (PRIO_ORDER[a.priority] ?? 9) - (PRIO_ORDER[b.priority] ?? 9) ||
    String(a.createdAt).localeCompare(String(b.createdAt));

  function setMode(v) {
    mode = v;
    if (store.state.settings.tasksMode !== v) {
      store.state.settings.tasksMode = v;
      store.commit();
    }
  }

  function setStatus(t, status) {
    const was = t.status;
    t.status = status;
    if (status === 'done' && was !== 'done') t.completedAt = util.now();
    if (status !== 'done') t.completedAt = null;
    store.touch(t);
  }

  const staleTasks = () => {
    const today = util.today();
    return store.live('tasks').filter((t) => t.status !== 'done' && t.date < today);
  };

  function carryOver(list) {
    const today = util.today();
    for (const t of list) {
      t.date = today;
      t.carried = (t.carried || 0) + 1;
      t.updatedAt = util.now();
    }
    store.commit();
  }

  function removeTask(t) {
    store.trash(t);
    expanded.delete(t.id);
    render();
    ui.toast('Task moved to Trash', { action: { label: 'Undo', fn: () => { store.restore(t); render(); } } });
  }

  // ---------- rendering ----------

  function render() {
    if (!root) return;
    const isToday = curDate() === util.today();
    const view = h('div', { class: 'view view-narrow' },
      h('header', { class: 'view-head' },
        h('div', { class: 'view-title' },
          h('h1', null, 'Tasks'),
          ui.seg([['day', 'Day', 'calendar'], ['open', 'All open', 'list']], mode, (v) => { setMode(v); render(); }),
          h('div', { class: 'spacer' }),
          h('button', {
            type: 'button',
            class: 'btn ghost sm',
            title: 'Export tasks to Excel or CSV',
            onClick: (e) => {
              const shown = mode === 'day' ? store.live('tasks').filter((t) => t.date === curDate()) : store.live('tasks').filter((t) => t.status !== 'done');
              const all = store.live('tasks');
              ui.menu(e.currentTarget, [
                { header: `This view (${util.plural(shown.length, 'task')})` },
                ...QN.office.listMenu((fmt) => QN.office.exportTasks(shown, fmt, mode === 'day' ? `Tasks ${curDate()}` : 'Open tasks')),
                { header: `All tasks (${all.length})` },
                ...QN.office.listMenu((fmt) => QN.office.exportTasks(all, fmt, 'All tasks')),
              ], { alignRight: true });
            },
          }, icon('download'), 'Export')),
        mode === 'day' ? dateNav() : h('p', { class: 'view-sub' }, 'Every unfinished task, grouped by the day it was planned for.')),
      quickAdd(),
      mode === 'day' && isToday ? carryBanner() : null,
      mode === 'day' ? dayList() : openList());
    root.replaceChildren(view);

    if (focusId) {
      const row = root.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
      focusId = null;
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('flash');
      }
    }
  }

  function dateNav() {
    const d = curDate();
    const dayTasks = store.live('tasks').filter((t) => t.date === d);
    const done = dayTasks.filter((t) => t.status === 'done').length;
    return h('div', { class: 'date-nav' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Previous day', 'aria-label': 'Previous day', onClick: () => { viewDate = util.addDays(d, -1); render(); } }, icon('chevL')),
      h('button', {
        type: 'button',
        class: 'date-pick',
        title: 'Pick a date',
        onClick: (e) => ui.calendar(e.currentTarget, {
          value: d,
          quick: ['today', 'tomorrow', 'yesterday', 'nextMonday'],
          onPick: (v) => { viewDate = v === util.today() ? null : v; render(); },
        }),
      },
      icon('calendar'),
      h('span', { class: 'date-rel' }, util.relDay(d)),
      util.relDay(d) !== util.fmtDate(d) ? h('span', { class: 'date-full' }, util.fmtDate(d)) : null,
      icon('chevDown', 'date-chev')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Next day', 'aria-label': 'Next day', onClick: () => { viewDate = util.addDays(d, 1); viewDate = viewDate === util.today() ? null : viewDate; render(); } }, icon('chevR')),
      d !== util.today() ? h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { viewDate = null; render(); } }, 'Back to today') : null,
      h('div', { class: 'spacer' }),
      dayTasks.length ? h('div', { class: 'progress-inline' }, h('span', null, `${done} of ${dayTasks.length} done`), ui.progress(done / dayTasks.length)) : null);
  }

  function quickAdd() {
    const preview = h('div', { class: 'capture-chips' });
    const input = h('input', {
      id: 'task-quick',
      class: 'quick-input',
      placeholder: 'Add a task…  try "Retest ABC-123 !high @tomorrow"',
      autocomplete: 'off',
      'aria-label': 'New task',
      onInput: () => preview.replaceChildren(...QN.capture.chips(withDefaultDate(QN.capture.parse(input.value, 'task')))),
    });
    const withDefaultDate = (p) => ({ ...p, date: p.date || (mode === 'day' ? curDate() : util.today()) });
    return h('form', {
      class: 'quick-add',
      onSubmit: (e) => {
        e.preventDefault();
        const p = withDefaultDate(QN.capture.parse(input.value, 'task'));
        if (!p.title) return;
        if (p.kind === 'task') store.add('tasks', make.task({ title: p.title, priority: p.priority, ticket: p.ticket, date: p.date }));
        else QN.capture.captureAndAnnounce(p);
        render();
        const next = document.getElementById('task-quick');
        if (next) next.focus();
      },
    }, icon('plus', 'quick-icon'), input, preview, h('kbd', { class: 'quick-kbd' }, 'Enter'));
  }

  function carryBanner() {
    const stale = staleTasks();
    if (!stale.length) return null;
    return h('div', { class: 'banner' },
      icon('clock', 'banner-icon'),
      h('div', { class: 'banner-text' },
        h('strong', null, `${util.plural(stale.length, 'unfinished task')} from earlier days`),
        h('div', { class: 'muted small' }, stale.slice(0, 3).map((t) => t.title).join(' · ') + (stale.length > 3 ? ' …' : ''))),
      h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { setMode('open'); render(); } }, 'Review'),
      h('button', { type: 'button', class: 'btn primary sm', onClick: () => { carryOver(stale); render(); ui.toast(`Moved ${util.plural(stale.length, 'task')} to today`); } }, icon('arrowRight'), 'Move all to today'));
  }

  function dayList() {
    const d = curDate();
    const list = store.live('tasks').filter((t) => t.date === d).sort(sortTasks);
    if (!list.length) {
      return ui.empty('tasks', d === util.today() ? 'Nothing planned for today yet' : `Nothing planned for ${util.relDay(d).toLowerCase()}`,
        'Type above and press Enter. Start with "bug:" or "note:" to capture something else.');
    }
    return h('ul', { class: 'task-list' }, list.map((t) => taskRow(t, false)));
  }

  function openList() {
    const today = util.today();
    const list = store.live('tasks').filter((t) => t.status !== 'done')
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || sortTasks(a, b));
    if (!list.length) return ui.empty('tasks', 'All clear', 'No unfinished tasks anywhere.');
    const groups = new Map();
    for (const t of list) {
      if (!groups.has(t.date)) groups.set(t.date, []);
      groups.get(t.date).push(t);
    }
    return h('div', { class: 'task-groups' }, [...groups].map(([date, items]) =>
      h('section', { class: 'task-group' },
        h('h3', { class: 'group-title' }, util.relDay(date),
          date < today ? h('span', { class: 'pill red' }, 'Earlier') : null,
          h('span', { class: 'group-count' }, items.length),
          date < today ? h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { carryOver(items); render(); } }, 'Move to today') : null),
        h('ul', { class: 'task-list' }, items.map((t) => taskRow(t, true))))));
  }

  function taskRow(t, inOpenList) {
    const isOpen = expanded.has(t.id);
    const today = util.today();
    const li = h('li', { class: `task s-${t.status} p-${t.priority}${isOpen ? ' open' : ''}`, 'data-id': t.id });
    const check = h('input', {
      type: 'checkbox',
      class: 'check',
      checked: t.status === 'done',
      'aria-label': 'Mark done',
      title: t.status === 'done' ? 'Mark not done' : 'Mark done',
      onChange: (e) => { setStatus(t, e.target.checked ? 'done' : 'todo'); render(); },
    });
    const title = h('input', {
      class: 'task-title',
      value: t.title,
      'aria-label': 'Task title',
      spellcheck: 'true',
      onChange: (e) => {
        const v = e.target.value.trim();
        if (v) store.touch(t, { title: v });
        else e.target.value = t.title;
      },
      onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    });
    const meta = h('div', { class: 'task-meta' },
      h('span', { class: `pill prio ${t.priority}` }, defs.label(defs.priority, t.priority)),
      t.ticket ? h('span', { class: 'chip mono' }, t.ticket) : null,
      inOpenList && t.date !== today ? h('span', { class: `meta${t.date < today ? ' overdue' : ''}` }, icon('calendar'), util.relDay(t.date)) : null,
      t.due ? h('span', { class: `meta${t.due < today && t.status !== 'done' ? ' overdue' : ''}` }, icon('clock'), `Due ${util.relDay(t.due).toLowerCase()}`) : null,
      t.carried ? h('span', { class: 'meta', title: 'Times carried over to a new day' }, icon('undo'), `Carried ${t.carried}×`) : null,
      t.status === 'blocked' && t.blocker ? h('span', { class: 'meta blocked' }, icon('flag'), t.blocker) : null,
      t.notes && !isOpen ? h('span', { class: 'meta', title: 'Has notes' }, icon('notes')) : null);
    const status = ui.select(defs.taskStatus, t.status, (v) => {
      setStatus(t, v);
      if (v === 'blocked') expanded.add(t.id);
      render();
    }, { class: `status-select s-${t.status}`, 'aria-label': 'Status' });
    const toggle = h('button', {
      type: 'button',
      class: 'icon-btn',
      title: isOpen ? 'Hide details' : 'Details',
      'aria-expanded': isOpen ? 'true' : 'false',
      onClick: () => { if (isOpen) expanded.delete(t.id); else expanded.add(t.id); render(); },
    }, icon(isOpen ? 'chevUp' : 'chevDown'));
    li.append(check, h('div', { class: 'task-main' }, title, meta), status, toggle);
    if (isOpen) li.append(details(t));
    return li;
  }

  function details(t) {
    const blocker = t.status === 'blocked'
      ? ui.field('Blocked by', h('input', {
        value: t.blocker,
        placeholder: 'What is blocking this? (shows in your standup)',
        onChange: (e) => { store.touch(t, { blocker: e.target.value.trim() }); render(); },
        ref: (el) => { if (!t.blocker) setTimeout(() => el.focus(), 0); },
      }), 'wide')
      : null;
    return h('div', { class: 'task-details' },
      h('div', { class: 'field-grid' },
        ui.field('Priority', ui.select(defs.priority, t.priority, (v) => { store.touch(t, { priority: v }); render(); })),
        ui.field('Planned for', ui.dateField({ value: t.date, quick: ['today', 'tomorrow', 'nextMonday', 'nextWeek'], onChange: (v) => { if (v) { store.touch(t, { date: v }); render(); } } })),
        ui.field('Due date', ui.dateField({ value: t.due, allowClear: true, placeholder: 'No due date', onChange: (v) => { store.touch(t, { due: v }); render(); } })),
        ui.field('Ticket', h('div', { class: 'input-with-btn' }, h('input', { class: 'mono', value: t.ticket, placeholder: 'ABC-123', onChange: (e) => { store.touch(t, { ticket: e.target.value.trim() }); render(); } }), h('button', { type: 'button', class: 'icon-btn hub-btn', title: 'Ticket hub: everything that mentions this ticket', 'aria-label': 'Open ticket hub', onClick: () => { const id = String(t.ticket || '').trim(); if (id) QN.tickets.openHub(id); else QN.ui.toast('Add a ticket ID first'); } }, icon('link')))),
        blocker),
      ui.field('Notes', h('textarea', {
        rows: 3,
        value: t.notes,
        placeholder: 'Details, links, test data…',
        onInput: (e) => { t.notes = e.target.value; t.updatedAt = util.now(); store.commit(); },
      }), 'wide'),
      QN.files.panel(t, { label: 'Files', compact: true, dropTitle: 'Attach files to this task' }),
      h('div', { class: 'row-actions' },
        h('span', { class: 'muted small' }, `Created ${util.fmtDateTime(t.createdAt)}${t.completedAt ? ` · Done ${util.fmtDateTime(t.completedAt)}` : ''}`),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn ghost sm danger', onClick: () => removeTask(t) }, icon('trash'), 'Delete')));
  }

  QN.tasks = { setStatus, sortTasks, staleTasks, carryOver };

  QN.views = QN.views || {};
  QN.views.tasks = {
    mount(el, params = {}) {
      root = el;
      if (!mode) mode = store.state.settings.tasksMode || 'day';
      if (params.mode) setMode(params.mode);
      if (params.date) {
        viewDate = params.date === util.today() ? null : params.date;
        setMode('day');
      }
      if (params.focus) {
        focusId = params.focus;
        expanded.add(params.focus);
        const t = store.find('tasks', params.focus);
        if (t) { viewDate = t.date === util.today() ? null : t.date; setMode('day'); }
      }
      render();
      if (params.new) this.onNew();
    },
    unmount() { root = null; },
    refresh: () => render(),
    onNew() {
      const input = document.getElementById('task-quick');
      if (input) input.focus();
    },
  };
})();
