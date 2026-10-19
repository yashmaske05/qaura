(function () {
  'use strict';

  const QN = window.QN;
  const { h, icon } = QN;
  const stack = [];

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stack.length) {
      e.preventDefault();
      e.stopPropagation();
      stack[stack.length - 1].close(undefined);
    }
  }, true);

  function toast(message, opts = {}) {
    const root = document.getElementById('toasts');
    const el = h('div', { class: `toast ${opts.type || ''}`, role: 'status' },
      icon(opts.type === 'error' ? 'alert' : 'check', 'toast-icon'),
      h('span', { class: 'toast-text' }, message));
    let timer;
    const close = () => {
      clearTimeout(timer);
      el.classList.remove('show');
      setTimeout(() => el.remove(), 200);
    };
    if (opts.action) {
      el.append(h('button', { type: 'button', class: 'toast-action', onClick: () => { close(); opts.action.fn(); } }, opts.action.label));
    }
    // Keep at most three on screen.
    while (root.children.length >= 3) root.firstElementChild.remove();
    root.append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    timer = setTimeout(close, opts.timeout || (opts.action ? 6000 : 2800));
    return close;
  }

  // Generic dialog. Resolves with the clicked action's value, or undefined on Esc / outside click.
  function modal({ title, body, actions = [], className = '' }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      let closed = false;
      const entry = {};
      const close = (value) => {
        if (closed) return;
        closed = true;
        stack.splice(stack.indexOf(entry), 1);
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 160);
        if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus();
        resolve(value);
      };
      entry.close = close;
      const submit = actions.find((a) => a.submit);
      const buttons = actions.map((a) => h('button', {
        type: a.submit ? 'submit' : 'button',
        class: `btn ${a.kind || ''}`,
        onClick: a.submit ? null : () => close(a.value),
      }, a.label));
      const form = h('form', {
        class: `modal ${className}`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        onSubmit: (e) => {
          e.preventDefault();
          if (submit) close(submit.collect ? submit.collect() : submit.value);
        },
      }, h('h2', { class: 'modal-title' }, title), h('div', { class: 'modal-body' }, body), h('div', { class: 'modal-actions' }, buttons));
      const overlay = h('div', { class: 'overlay', onMouseDown: (e) => { if (e.target === overlay) close(undefined); } }, form);
      stack.push(entry);
      document.getElementById('overlay-root').append(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));
      const first = form.querySelector('.modal-body input, .modal-body select, .modal-body textarea') || buttons[buttons.length - 1];
      setTimeout(() => first && first.focus(), 0);
    });
  }

  function confirm(title, message, opts = {}) {
    return modal({
      title,
      body: h('p', { class: 'modal-text' }, message),
      actions: [
        { label: 'Cancel', value: false, kind: 'ghost' },
        { label: opts.confirmLabel || 'Confirm', kind: opts.danger ? 'danger-solid' : 'primary', submit: true, value: true },
      ],
    }).then((v) => v === true);
  }

  function alert(title, message) {
    return modal({ title, body: h('p', { class: 'modal-text' }, message), actions: [{ label: 'OK', kind: 'primary', submit: true, value: true }] });
  }

  // Small form dialog. Resolves with { name: value } or null.
  function form(title, fields, opts = {}) {
    const inputs = {};
    const body = h('div', { class: 'form-fields' },
      opts.intro ? h('p', { class: 'modal-text' }, opts.intro) : null,
      fields.map((f) => {
        const input = f.options
          ? select(f.options, f.value)
          : h('input', { value: f.value || '', placeholder: f.placeholder || '', class: f.mono ? 'mono' : null, list: f.list || null });
        inputs[f.name] = input;
        return field(f.label, input);
      }));
    return modal({
      title,
      body,
      actions: [
        { label: 'Cancel', value: null, kind: 'ghost' },
        { label: opts.submitLabel || 'Save', kind: 'primary', submit: true, collect: () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])) },
      ],
    }).then((v) => v || null);
  }

  function seg(options, value, onChange, cls) {
    return h('div', { class: `seg ${cls || ''}`, role: 'tablist' }, options.map(([v, label, ic]) =>
      h('button', {
        type: 'button',
        role: 'tab',
        class: v === value ? 'on' : null,
        'aria-selected': v === value ? 'true' : 'false',
        title: label,
        onClick: () => { if (v !== value) onChange(v); },
      }, ic ? icon(ic) : null, h('span', { class: 'seg-label' }, label))));
  }

  function select(options, value, onChange, attrs) {
    return h('select', { ...(attrs || {}), value, onChange: onChange ? (e) => onChange(e.target.value) : null },
      options.map(([v, label]) => h('option', { value: v }, label)));
  }

  function field(label, control, cls) {
    return h('label', { class: `field ${cls || ''}` }, h('span', { class: 'field-label' }, label), control);
  }

  function empty(ic, title, text, action) {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, icon(ic)),
      h('div', { class: 'empty-title' }, title),
      text ? h('div', { class: 'empty-text' }, text) : null,
      action || null);
  }

  function progress(fraction, cls) {
    const pct = Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100);
    return h('div', { class: `bar ${cls || ''}` }, h('div', { class: 'bar-fill', style: { width: `${pct}%` } }));
  }

  // Stacked bar for test-run results.
  function stackBar(parts) {
    const total = parts.reduce((n, p) => n + p.value, 0) || 1;
    return h('div', { class: 'bar stack' }, parts.filter((p) => p.value).map((p) =>
      h('div', { class: `bar-seg ${p.cls}`, style: { width: `${(p.value / total) * 100}%` }, title: `${p.label}: ${p.value}` })));
  }

  function ring(fraction, label) {
    const r = 26;
    const c = 2 * Math.PI * r;
    const off = c * (1 - Math.max(0, Math.min(1, fraction || 0)));
    const t = document.createElement('template');
    t.innerHTML = `<div class="ring"><svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><circle cx="32" cy="32" r="${r}" class="ring-track"/><circle cx="32" cy="32" r="${r}" class="ring-fill" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg></div>`;
    const el = t.content.firstChild;
    el.append(h('div', { class: 'ring-label' }, label));
    return el;
  }

  const pill = (cls, text) => h('span', { class: `pill ${cls}` }, text);

  async function copy(text, what) {
    try {
      await window.api.copy(text);
      toast(`${what || 'Text'} copied to clipboard`);
    } catch (err) {
      toast(`Could not copy: ${err.message}`, { type: 'error' });
    }
  }

  // Popup menu anchored to a button. Items don't steal focus, so editor selections survive.
  let openMenu = null;
  function closeMenu() {
    if (openMenu) openMenu.close();
  }
  function menu(anchor, items, opts = {}) {
    if (openMenu && openMenu.anchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();
    const el = h('div', { class: `menu ${opts.className || ''}`, role: 'menu' });
    for (const it of items) {
      if (!it) continue;
      if (it.separator) { el.append(h('div', { class: 'menu-sep' })); continue; }
      if (it.header) { el.append(h('div', { class: 'menu-header' }, it.header)); continue; }
      el.append(h('button', {
        type: 'button',
        role: 'menuitem',
        class: `menu-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`,
        style: it.indent ? { paddingLeft: `${10 + it.indent * 16}px` } : null,
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => { closeMenu(); if (it.onClick) it.onClick(); },
      },
      it.swatch != null ? h('span', { class: `swatch c-${it.swatch || 'none'}` }) : it.icon ? icon(it.icon) : h('span', { class: 'menu-icon-space' }),
      h('span', { class: 'menu-label' }, it.label),
      it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null,
      it.checked ? icon('check', 'menu-check') : null,
      it.onRemove ? h('span', {
        class: 'menu-remove',
        title: 'Remove',
        role: 'button',
        onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); },
        onClick: (e) => { e.stopPropagation(); closeMenu(); it.onRemove(); },
      }, icon('x')) : null));
    }
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(opts.alignRight ? r.right - el.offsetWidth : r.left, window.innerWidth - el.offsetWidth - 8));
    let top = r.bottom + 4;
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 4);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
    const entry = {
      close: () => {
        el.remove();
        document.removeEventListener('mousedown', onDown, true);
        stack.splice(stack.indexOf(entry), 1);
        openMenu = null;
      },
    };
    openMenu = { anchor, close: entry.close };
    stack.push(entry);
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  }

  // Side panel that slides in from the right (used to edit notes from Grid / Board).
  function drawer(content, opts = {}) {
    const entry = {};
    let closed = false;
    const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': opts.label || 'Editor' }, content);
    const overlay = h('div', { class: 'drawer-overlay', onMouseDown: (e) => { if (e.target === overlay) close(); } }, panel);
    function close() {
      if (closed) return;
      closed = true;
      stack.splice(stack.indexOf(entry), 1);
      overlay.classList.remove('show');
      overlay.classList.add('closing');
      overlay.inert = true; // nothing in a closing panel can keep focus or take clicks
      setTimeout(() => overlay.remove(), 200);
      if (opts.onClose) opts.onClose();
    }
    entry.close = close;
    stack.push(entry);
    document.getElementById('overlay-root').append(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    return { close, panel };
  }

  // Large window in the middle of the app (used to view files). Esc or a click outside closes it.
  function viewer(content, opts = {}) {
    const entry = {};
    let closed = false;
    const panel = h('div', { class: `viewer${opts.maximized ? ' max' : ''}`, role: 'dialog', 'aria-label': opts.label || 'Viewer' }, content);
    const overlay = h('div', { class: 'viewer-overlay', onMouseDown: (e) => { if (e.target === overlay) close(); } }, panel);
    function close() {
      if (closed) return;
      closed = true;
      stack.splice(stack.indexOf(entry), 1);
      overlay.classList.remove('show');
      overlay.classList.add('closing');
      overlay.inert = true;
      setTimeout(() => overlay.remove(), 200);
      if (opts.onClose) opts.onClose();
    }
    entry.close = close;
    stack.push(entry);
    document.getElementById('overlay-root').append(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    return { close, panel, setMaximized: (on) => panel.classList.toggle('max', Boolean(on)) };
  }

  // Small search-and-pick popup at a screen position (used for [[ note links).
  function picker({ x, y, placeholder, items, onCancel }) {
    const entry = {};
    let results = [];
    let active = 0;
    let done = false;
    const input = h('input', { class: 'picker-input', placeholder: placeholder || 'Search…', spellcheck: 'false', 'aria-label': placeholder || 'Search' });
    const list = h('div', { class: 'picker-list', role: 'listbox' });
    const panel = h('div', { class: 'picker', role: 'dialog' }, input, list);
    const onDown = (e) => { if (!panel.contains(e.target)) close(true); };
    function close(cancelled) {
      if (done) return;
      done = true;
      stack.splice(stack.indexOf(entry), 1);
      panel.remove();
      document.removeEventListener('mousedown', onDown, true);
      if (cancelled && onCancel) onCancel();
    }
    entry.close = () => close(true);
    const pick = (i) => {
      const r = results[i];
      close(false);
      if (r) r.onPick();
    };
    const render = () => {
      results = items(input.value);
      active = Math.min(active, Math.max(0, results.length - 1));
      list.replaceChildren(...(results.length ? results.map((r, i) => h('div', {
        class: `picker-item${i === active ? ' active' : ''}`,
        role: 'option',
        onMouseDown: (e) => { e.preventDefault(); pick(i); },
        onMouseMove: () => { if (active !== i) { active = i; render(); } },
      }, icon(r.icon || 'notes'), h('span', { class: 'palette-label' }, r.label), r.hint ? h('span', { class: 'palette-hint' }, r.hint) : null))
        : [h('div', { class: 'palette-empty' }, 'Type to search your notes')]));
    };
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
    });
    document.body.append(panel);
    render();
    panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${y + panel.offsetHeight > window.innerHeight - 8 ? Math.max(8, y - panel.offsetHeight - 30) : y}px`;
    stack.push(entry);
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    input.focus();
  }

  // ---------- Calendar popover + date field ----------

  const { util } = QN;
  const nextWeekday = (dow) => {
    let d = util.addDays(util.today(), 1);
    while (util.parseDate(d).getDay() !== dow) d = util.addDays(d, 1);
    return d;
  };
  const QUICK = {
    today: () => ['Today', util.today()],
    tomorrow: () => ['Tomorrow', util.addDays(util.today(), 1)],
    yesterday: () => ['Yesterday', util.addDays(util.today(), -1)],
    nextMonday: () => ['Next Monday', nextWeekday(1)],
    nextWeek: () => ['In 1 week', util.addDays(util.today(), 7)],
  };

  // opts: { value, onPick(dateStr | ''), allowClear, quick: ['today', 'tomorrow', ...], alignRight }
  function calendar(anchor, opts) {
    closeMenu();
    const today = util.today();
    let focusDate = opts.value || today;
    const view = util.parseDate(focusDate);
    view.setDate(1);
    let done = false;
    let viaKeyboard = false;
    const entry = {};
    const panel = h('div', { class: 'cal', role: 'dialog', 'aria-label': 'Choose a date' });
    const onDown = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
    function close() {
      if (done) return;
      done = true;
      stack.splice(stack.indexOf(entry), 1);
      panel.remove();
      document.removeEventListener('mousedown', onDown, true);
      if (viaKeyboard && anchor.isConnected) anchor.focus();
    }
    entry.close = () => { viaKeyboard = true; close(); };
    const pick = (d) => { close(); opts.onPick(d); };
    const shiftMonth = (n) => { view.setMonth(view.getMonth() + n); render(); };

    function render() {
      const y = view.getFullYear();
      const m = view.getMonth();
      const start = new Date(y, m, 1 - ((new Date(y, m, 1).getDay() + 6) % 7)); // weeks start on Monday
      if (util.toDateStr(new Date(y, m, 1)) > focusDate || util.toDateStr(new Date(y, m + 1, 0)) < focusDate) focusDate = util.toDateStr(new Date(y, m, Math.min(util.parseDate(focusDate).getDate(), new Date(y, m + 1, 0).getDate())));
      const days = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const ds = util.toDateStr(d);
        days.push(h('button', {
          type: 'button',
          class: `cal-day${d.getMonth() !== m ? ' out' : ''}${ds === today ? ' today' : ''}${ds === opts.value ? ' sel' : ''}${d.getDay() === 0 || d.getDay() === 6 ? ' wknd' : ''}`,
          'data-date': ds,
          tabindex: ds === focusDate ? '0' : '-1',
          'aria-label': util.fmtDate(ds, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
          'aria-pressed': ds === opts.value ? 'true' : 'false',
          onClick: () => pick(ds),
        }, String(d.getDate())));
      }
      const quick = (opts.quick || ['today', 'tomorrow', 'nextMonday', 'nextWeek']).map((k) => QUICK[k]());
      panel.replaceChildren(
        h('div', { class: 'cal-head' },
          h('div', { class: 'cal-title' }, view.toLocaleDateString(undefined, { month: 'long' }), h('span', { class: 'cal-year' }, String(y))),
          h('div', { class: 'cal-nav' },
            h('button', { type: 'button', class: 'icon-btn sm', title: 'Previous month', 'aria-label': 'Previous month', onClick: () => shiftMonth(-1) }, icon('chevL')),
            h('button', { type: 'button', class: 'cal-today-btn', title: 'Show this month', onClick: () => { const t = util.parseDate(today); view.setFullYear(t.getFullYear(), t.getMonth(), 1); focusDate = today; render(); } }, 'Today'),
            h('button', { type: 'button', class: 'icon-btn sm', title: 'Next month', 'aria-label': 'Next month', onClick: () => shiftMonth(1) }, icon('chevR')))),
        h('div', { class: 'cal-week' }, ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => h('span', null, d))),
        h('div', { class: 'cal-grid', role: 'grid' }, days),
        h('div', { class: 'cal-foot' },
          quick.map(([label, ds]) => h('button', { type: 'button', class: `cal-chip${ds === opts.value ? ' on' : ''}`, title: util.fmtDate(ds), onClick: () => pick(ds) }, label)),
          opts.allowClear && opts.value ? h('button', { type: 'button', class: 'cal-chip clear', onClick: () => pick('') }, icon('x'), 'Clear') : null));
    }

    panel.addEventListener('keydown', (e) => {
      const cell = e.target.closest && e.target.closest('.cal-day');
      if (!cell) return;
      const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (move || e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        if (move) focusDate = util.addDays(cell.dataset.date, move);
        else {
          const d = util.parseDate(cell.dataset.date);
          d.setMonth(d.getMonth() + (e.key === 'PageUp' ? -1 : 1));
          focusDate = util.toDateStr(d);
        }
        const f = util.parseDate(focusDate);
        view.setFullYear(f.getFullYear(), f.getMonth(), 1);
        render();
        const next = panel.querySelector(`.cal-day[data-date="${focusDate}"]`);
        if (next) next.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        viaKeyboard = true;
      }
    });

    render();
    document.body.append(panel);
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(opts.alignRight ? r.right - panel.offsetWidth : r.left, window.innerWidth - panel.offsetWidth - 8));
    let top = r.bottom + 6;
    if (top + panel.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - panel.offsetHeight - 6);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    stack.push(entry);
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    const cell = panel.querySelector('.cal-day[tabindex="0"]');
    if (cell) cell.focus({ preventScroll: true });
  }

  // A form field that opens the calendar. opts: { value, onChange, allowClear, placeholder, quick }
  function dateField(opts) {
    let value = opts.value || '';
    const btn = h('button', { type: 'button', class: 'date-field' });
    const paint = () => {
      btn.dataset.value = value;
      const rel = value ? util.relDay(value) : '';
      const special = ['Today', 'Tomorrow', 'Yesterday'].includes(rel);
      const sameYear = value && value.slice(0, 4) === util.today().slice(0, 4);
      btn.title = value ? util.fmtDate(value, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
      btn.replaceChildren(
        icon('calendar'),
        value
          ? h('span', { class: 'df-value' },
            special ? h('strong', null, rel) : null,
            special ? ' · ' : null,
            util.fmtDate(value, special ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' }))
          : h('span', { class: 'df-placeholder' }, opts.placeholder || 'Pick a date'),
        icon('chevDown', 'df-chev'));
    };
    paint();
    btn.addEventListener('click', () => calendar(btn, {
      value,
      allowClear: opts.allowClear,
      quick: opts.quick,
      onPick: (d) => {
        value = d;
        paint();
        opts.onChange(d);
      },
    }));
    return btn;
  }

  // ---------- Code box with live syntax colours ----------

  function highlightCode(code, language) {
    if (window.hljs && language && language !== 'plaintext' && hljs.getLanguage(language)) {
      try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch { /* plain */ }
    }
    return QN.html.escape(code);
  }

  // opts: { value, placeholder, onInput(value), language: string | (text) => string, className }
  function codeArea(opts) {
    const code = h('code', { class: 'hljs' });
    const pre = h('pre', { class: 'code-hl', 'aria-hidden': 'true' }, code);
    const lang = () => (typeof opts.language === 'function' ? opts.language(area.value) : opts.language);
    const paint = () => { code.innerHTML = `${highlightCode(area.value, lang())}\n`; };
    const area = h('textarea', {
      class: 'code-input',
      value: opts.value || '',
      placeholder: opts.placeholder || '',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': opts.label || 'Code',
      onInput: () => { paint(); opts.onInput(area.value); },
      onScroll: () => { pre.scrollTop = area.scrollTop; pre.scrollLeft = area.scrollLeft; },
      onKeyDown: (e) => {
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey) {
          e.preventDefault();
          document.execCommand('insertText', false, '  ');
        }
      },
    });
    paint();
    // Replace all text but keep Ctrl+Z working.
    const setValue = (v) => {
      area.focus();
      area.select();
      if (!document.execCommand('insertText', false, v)) {
        area.value = v;
        area.dispatchEvent(new Event('input'));
      }
    };
    return { el: h('div', { class: `code-editor ${opts.className || ''}` }, pre, area), area, setValue };
  }

  // Full-size image preview.
  function lightbox(src, caption) {
    const entry = {};
    const overlay = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': caption || 'Image', onMouseDown: () => entry.close() },
      h('img', { src, alt: caption || '' }),
      caption ? h('div', { class: 'lightbox-cap' }, caption, h('span', { class: 'muted' }, '  ·  click or Esc to close')) : null);
    entry.close = () => {
      stack.splice(stack.indexOf(entry), 1);
      overlay.remove();
    };
    stack.push(entry);
    document.getElementById('overlay-root').append(overlay);
  }

  function closeAll() {
    while (stack.length) stack[stack.length - 1].close(undefined);
  }

  QN.ui = { toast, modal, confirm, alert, form, seg, select, field, empty, progress, stackBar, ring, pill, copy, menu, drawer, viewer, picker, calendar, dateField, codeArea, highlightCode, lightbox, closeAll, hasModal: () => stack.length > 0 };
})();
