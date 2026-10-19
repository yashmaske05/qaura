(function () {
  'use strict';

  const QN = (window.QN = window.QN || {});
  const pad = (n) => String(n).padStart(2, '0');

  // Dates are stored as local "YYYY-MM-DD" strings so "today" never shifts with time zones.
  const util = {
    uid() {
      if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    },
    now: () => new Date().toISOString(),
    toDateStr: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    today: () => util.toDateStr(new Date()),
    isDateStr: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || ''),
    parseDate(s) {
      const [y, m, d] = String(s).split('-').map(Number);
      return new Date(y, (m || 1) - 1, d || 1);
    },
    addDays(s, n) {
      const d = util.parseDate(s);
      d.setDate(d.getDate() + n);
      return util.toDateStr(d);
    },
    dateOf: (iso) => (iso ? util.toDateStr(new Date(iso)) : ''),
    prevWorkday(s, workdays) {
      const days = workdays && workdays.length ? workdays : [1, 2, 3, 4, 5];
      let d = util.addDays(s, -1);
      for (let i = 0; i < 7; i++) {
        if (days.includes(util.parseDate(d).getDay())) return d;
        d = util.addDays(d, -1);
      }
      return util.addDays(s, -1);
    },
    fmtDate(s, opts) {
      if (!util.isDateStr(s)) return '';
      return util.parseDate(s).toLocaleDateString(undefined, opts || { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    },
    fmtShort: (s) => util.fmtDate(s, { day: 'numeric', month: 'short' }),
    fmtDateTime(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
    relTime(iso) {
      if (!iso) return '';
      const secs = (Date.now() - new Date(iso).getTime()) / 1000;
      if (secs < 45) return 'just now';
      if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
      if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
      if (secs < 86400 * 7) return `${Math.round(secs / 86400)} d ago`;
      return util.fmtShort(util.dateOf(iso));
    },
    relDay(s) {
      const t = util.today();
      if (s === t) return 'Today';
      if (s === util.addDays(t, 1)) return 'Tomorrow';
      if (s === util.addDays(t, -1)) return 'Yesterday';
      return util.fmtDate(s);
    },
    debounce(fn, ms) {
      let timer;
      const d = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
      };
      d.cancel = () => clearTimeout(timer);
      return d;
    },
    TICKET_RE: /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/,
    words: (s) => (String(s || '').match(/\S+/g) || []).length,
    plural: (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`,
    // Every search word must appear somewhere in the text.
    matches(text, query) {
      const hay = String(text || '').toLowerCase();
      return String(query || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
    },
    // Title from the first line of text, without list / heading markers.
    autoTitle(text) {
      const line = String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*(#+\s|- \[[ xX]\]\s|[-*+]\s|\d+[.)]\s|>\s?)/, '').trim()).find(Boolean);
      if (!line) return '';
      return line.length > 60 ? `${line.slice(0, 60).replace(/\s+\S*$/, '')}…` : line;
    },
    snippet(s, n = 110) {
      const flat = String(s || '').replace(/[#>*_`~\-[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
      return flat.length > n ? `${flat.slice(0, n)}…` : flat;
    },
  };

  // Tiny DOM builder. User text always goes in as text nodes, never as HTML.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    let value;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'value') value = v;
        else if (k === 'checked') el.checked = Boolean(v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style') Object.assign(el.style, v);
        else if (k === 'ref') v(el);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    if (value !== undefined) el.value = value;
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    tasks: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m8 12 3 3 5-6"/>',
    notes: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    bug: '<rect x="8" y="7" width="8" height="13" rx="4"/><path d="M12 11v9"/><path d="M8 12H4"/><path d="M20 12h-4"/><path d="m8 17-3 2"/><path d="m16 17 3 2"/><path d="M9.5 7.5 7.5 4.5"/><path d="m14.5 7.5 2-3"/>',
    checklist: '<path d="m3 7 2 2 4-4"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    standup: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01"/><path d="M12 12h.01"/><path d="M15.5 12h.01"/>',
    settings: '<path d="M4 6h9"/><path d="M19 6h1"/><circle cx="16" cy="6" r="2.5"/><path d="M4 12h2"/><path d="M12 12h8"/><circle cx="9" cy="12" r="2.5"/><path d="M4 18h11"/><circle cx="18" cy="18" r="2.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="m6 7 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    duplicate: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/><path d="M14.5 11.5v6"/><path d="M11.5 14.5h6"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    chevDown: '<path d="m6 9 6 6 6-6"/>',
    chevUp: '<path d="m18 15-6-6-6 6"/>',
    pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    external: '<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M3 10h18"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z"/>',
    moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>',
    download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
    italic: '<path d="M14 5h-4"/><path d="M14 19h-4"/><path d="M14 5 10 19"/>',
    heading: '<path d="M6 5v14"/><path d="M18 5v14"/><path d="M6 12h12"/>',
    list: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4.5 6h.01"/><path d="M4.5 12h.01"/><path d="M4.5 18h.01"/>',
    code: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/>',
    sparkle: '<path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="m5.6 5.6 2.1 2.1"/><path d="m16.3 16.3 2.1 2.1"/><path d="m5.6 18.4 2.1-2.1"/><path d="m16.3 7.7 2.1-2.1"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.5 1.6-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    template: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/><path d="M9 21V9"/>',
    underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M5 20h14"/>',
    strike: '<path d="M16 7c-.6-1.8-2.2-3-4.3-3C9.3 4 7.5 5.4 7.5 7.3c0 1.4.9 2.3 2.4 2.9"/><path d="M4 12h16"/><path d="M8 17c.6 1.8 2.3 3 4.4 3 2.5 0 4.3-1.4 4.3-3.4 0-.8-.3-1.5-.8-2"/>',
    highlight: '<path d="m9 11-5 5v4h4l5-5"/><path d="m12.5 14.5 7-7-4-4-7 7"/>',
    listOrdered: '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 4h1v5"/><path d="M4 9h2"/><path d="M6 19H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    quote: '<path d="M6 7h4v6c0 2.2-1.6 4-4 4"/><path d="M14 7h4v6c0 2.2-1.6 4-4 4"/>',
    codeBlock: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m9.5 10-2 2 2 2"/><path d="m14.5 10 2 2-2 2"/>',
    minus: '<path d="M4 12h16"/>',
    eraser: '<path d="m7 20-4-4 10-10 7 7-7 7"/><path d="M7 20h13"/><path d="m8.5 10.5 6 6"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    board: '<rect x="3" y="3" width="18" height="18" rx="3"/><rect x="6.5" y="6.5" width="5" height="5" rx="1"/><rect x="12.5" y="11" width="5" height="6" rx="1"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v6"/><path d="M9 13.5h6"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
    snippet: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m13.5 5-3 14"/>',
    inbox: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M5.5 5h13l2.5 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5.5-5.5L5 21"/>',
    paperclip: '<path d="m20.5 11.5-8.4 8.4a5.5 5.5 0 0 1-7.8-7.8l8.4-8.4a3.7 3.7 0 0 1 5.2 5.2l-8.4 8.4a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/>',
    video: '<rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="m16 10.5 5.5-3v9l-5.5-3"/>',
    fileDoc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18"/><path d="M3 15h18"/><path d="M9 4v16"/>',
    slides: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4"/><path d="M8 21h8"/><path d="m10 8.5 4 2-4 2z"/>',
    sort: '<path d="M7 4v16"/><path d="m4 17 3 3 3-3"/><path d="M13 6h8"/><path d="M13 12h6"/><path d="M13 18h3"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>',
    zen: '<path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M15 4h4a1 1 0 0 1 1 1v4"/><path d="M20 15v4a1 1 0 0 1-1 1h-4"/><path d="M9 20H5a1 1 0 0 1-1-1v-4"/>',
    expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
    shrink: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>',
  };

  function icon(name, cls) {
    const t = document.createElement('template');
    t.innerHTML = `<svg class="icon ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
    return t.content.firstChild;
  }

  // Markdown is always sanitized before it reaches the page.
  function markdown(src) {
    const text = String(src || '');
    if (!window.marked || !window.DOMPurify) {
      const pre = document.createElement('pre');
      pre.textContent = text;
      return pre.outerHTML;
    }
    return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
  }

  QN.util = util;
  QN.h = h;
  QN.append = append;
  QN.icon = icon;
  QN.markdown = markdown;
})();
