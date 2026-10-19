(function () {
  'use strict';

  // Quick capture: one line of text becomes a task, bug or note.
  //   "Retest login ABC-123 !high @tomorrow"   -> high-priority task for tomorrow, ticket ABC-123
  //   "bug: Save button disabled on Safari"    -> draft bug
  //   "note: idea for regression suite"        -> note
  const QN = window.QN;
  const { h, util, store, make, defs } = QN;

  function parse(input, defaultKind) {
    let text = String(input || '').trim();
    let kind = defaultKind || 'task';
    const prefix = text.match(/^(bug|b|note|n|task|t)\s*:\s*/i);
    if (prefix) {
      const k = prefix[1].toLowerCase()[0];
      kind = k === 'b' ? 'bug' : k === 'n' ? 'note' : 'task';
      text = text.slice(prefix[0].length);
    }

    let priority = 'medium';
    let date = null;
    text = text.replace(/(^|\s)!(high|h|1|medium|med|m|2|low|l|3)(?=\s|$)/i, (_all, sp, p) => {
      const v = p.toLowerCase();
      priority = /^(high|h|1)$/.test(v) ? 'high' : /^(low|l|3)$/.test(v) ? 'low' : 'medium';
      return sp;
    });
    text = text.replace(/(^|\s)@(today|tomorrow|tmrw|\d{4}-\d{2}-\d{2})(?=\s|$)/i, (_all, sp, d) => {
      const v = d.toLowerCase();
      date = v === 'today' ? util.today() : util.isDateStr(v) ? v : util.addDays(util.today(), 1);
      return sp;
    });

    const t = text.match(util.TICKET_RE);
    const ticket = t ? t[1] : '';
    let title = text.replace(/\s+/g, ' ').trim();
    if (ticket && kind !== 'note') {
      title = title.replace(ticket, '').replace(/\s+/g, ' ').replace(/^[\s:–-]+|[\s:–-]+$/g, '').trim() || ticket;
    }
    return { kind, title, priority, date, ticket };
  }

  // Little chips that show how the text will be understood, before pressing Enter.
  function chips(p) {
    if (!p.title) return [];
    const out = [h('span', { class: `chip kind-${p.kind}` }, p.kind === 'bug' ? 'Bug (draft)' : p.kind === 'note' ? 'Note' : 'Task')];
    if (p.kind !== 'note' && p.priority !== 'medium') out.push(h('span', { class: `chip prio-chip ${p.priority}` }, defs.label(defs.priority, p.priority)));
    if (p.ticket && p.kind !== 'note') out.push(h('span', { class: 'chip mono' }, p.ticket));
    if (p.kind === 'task') out.push(h('span', { class: 'chip' }, util.relDay(p.date || util.today())));
    return out;
  }

  function create(p) {
    if (p.kind === 'bug') {
      return { kind: 'bug', item: store.add('bugs', make.bug({ title: p.title, ticket: p.ticket, priority: p.priority })) };
    }
    if (p.kind === 'note') {
      return { kind: 'note', item: store.add('notes', make.note({ title: p.title })) };
    }
    return { kind: 'task', item: store.add('tasks', make.task({ title: p.title, priority: p.priority, ticket: p.ticket, date: p.date || util.today() })) };
  }

  // Create + toast with a shortcut to open what was created.
  function captureAndAnnounce(p) {
    const { kind, item } = create(p);
    const where = { task: `Task added for ${util.relDay(item.date || util.today()).toLowerCase()}`, bug: 'Draft bug logged', note: 'Note created' }[kind];
    QN.ui.toast(where, {
      action: {
        label: 'Open',
        fn: () => {
          if (kind === 'task') QN.app.go('tasks', { date: item.date, focus: item.id });
          else if (kind === 'bug') QN.app.go('bugs', { select: item.id });
          else QN.app.go('notes', { select: item.id });
        },
      },
    });
    return { kind, item };
  }

  QN.capture = { parse, chips, create, captureAndAnnounce };
})();
