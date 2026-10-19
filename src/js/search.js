(function () {
  'use strict';

  // One search engine for Ctrl+K and the Notes search box.
  // Plain words must all match. Operators narrow it down:
  //   tag:playwright  #playwright   type:bug | type:test-case   is:favorite | is:pinned | is:archived | is:open | is:done
  //   in:"Release 2.4"   updated:last-7-days   created:today | yesterday | this-week | this-month | 2026-10 | >2026-10-01
  //   status:blocked   color:yellow
  const QN = window.QN;
  const { h, util, store, defs } = QN;

  const OP_RE = /(^|\s)(tag|type|is|in|updated|created|status|colou?r):("[^"]*"|\S*)/gi;
  const norm = (s) => String(s || '').toLowerCase().replace(/[-_\s]+/g, ' ').trim();

  function datePredicate(v) {
    const t = util.today();
    const since = (d) => (x) => x >= d && x <= t;
    if (v === 'today') return (x) => x === t;
    if (v === 'yesterday') return (x) => x === util.addDays(t, -1);
    if (v === 'this-week' || v === 'week') {
      const dow = (util.parseDate(t).getDay() + 6) % 7;
      return since(util.addDays(t, -dow));
    }
    if (v === 'this-month' || v === 'month') return since(`${t.slice(0, 7)}-01`);
    let m = v.match(/^last-(\d+)-days?$/) || v.match(/^(\d+)d$/);
    if (m) return since(util.addDays(t, -(Number(m[1]) - 1)));
    m = v.match(/^([<>]=?)?(\d{4}-\d{2}(?:-\d{2})?)$/);
    if (m) {
      const d = m[2];
      if (!m[1]) return (x) => x.startsWith(d);
      if (m[1] === '>') return (x) => x > d;
      if (m[1] === '>=') return (x) => x >= d;
      if (m[1] === '<') return (x) => x < d;
      return (x) => x <= d;
    }
    return null; // unknown (or still being typed): ignore rather than hide everything
  }

  function parse(q) {
    const p = { raw: String(q || ''), tags: [], types: [], is: [], in: [], status: [], color: [], updated: null, created: null };
    let rest = p.raw.replace(OP_RE, (_all, sp, key, val) => {
      const v = val.replace(/^"|"$/g, '').toLowerCase();
      if (!v) return sp;
      const k = key.toLowerCase();
      if (k === 'tag') p.tags.push(v.replace(/^#/, ''));
      else if (k === 'type') p.types.push(v);
      else if (k === 'is') p.is.push(v);
      else if (k === 'in') p.in.push(norm(v));
      else if (k === 'status') p.status.push(v);
      else if (k === 'color' || k === 'colour') p.color.push(v);
      else p[k] = datePredicate(v);
      return ' ';
    });
    rest = rest.replace(/(^|\s)#([\w-]+)/g, (_a, sp, t) => { p.tags.push(t.toLowerCase()); return ' '; });
    p.words = rest.toLowerCase().split(/\s+/).filter(Boolean);
    p.hasFilters = Boolean(p.tags.length || p.types.length || p.is.length || p.in.length || p.status.length || p.color.length || p.updated || p.created);
    p.empty = !p.words.length && !p.hasFilters;
    return p;
  }

  const noteTitle = (n) => n.title || util.autoTitle(n.text) || 'Untitled';

  // Normalised view of every searchable thing.
  function docOf(kind, x) {
    switch (kind) {
      case 'note': return {
        kind, item: x, title: noteTitle(x), body: x.text, tags: x.tags || [], folder: QN.folders.path(x.folderId), type: x.daily ? 'daily' : (x.type || 'note'),
        starred: x.starred, archived: x.archived, color: x.color, open: /(^|\n)\s*- \[ \]/.test(x.text || ''), done: false, status: '',
      };
      case 'task': return {
        kind, item: x, title: x.title, body: `${x.ticket} ${x.notes} ${x.blocker}`, tags: [], folder: '', type: 'task',
        status: `${x.status} ${defs.label(defs.taskStatus, x.status)}`.toLowerCase(), open: x.status !== 'done', done: x.status === 'done',
      };
      case 'bug': return {
        kind, item: x, title: `${x.ticket ? `${x.ticket} · ` : ''}${x.title || 'Untitled bug'}`, body: `${x.module} ${x.env} ${x.build} ${x.steps} ${x.expected} ${x.actual} ${x.apiRequest || ''} ${x.apiResponse || ''} ${x.notes}`, tags: [], folder: '', type: 'bug',
        status: `${x.status} ${defs.label(defs.bugStatus, x.status)} ${x.severity}`.toLowerCase(), open: defs.bugActive.includes(x.status), done: ['verified', 'closed'].includes(x.status),
      };
      case 'snippet': return {
        kind, item: x, title: x.title || 'Untitled snippet', body: `${x.description}\n${x.code}`, tags: x.tags || [], folder: '', type: `snippet ${x.language}`, starred: x.starred, status: '',
      };
      case 'run': return {
        kind, item: x, title: `${x.name}${x.ticket ? ` · ${x.ticket}` : ''}`, body: `${x.build} ${x.env} ${x.items.map((i) => `${i.text} ${i.note}`).join(' ')}`, tags: [], folder: '', type: 'run',
        status: x.completedAt ? 'done complete' : 'open in progress', open: !x.completedAt, done: Boolean(x.completedAt),
      };
      case 'checklist': return { kind, item: x, title: x.name || 'Untitled checklist', body: `${x.description}\n${x.body}`, tags: [], folder: '', type: 'checklist template', status: '' };
      case 'folder': return { kind, item: x, title: QN.folders.path(x.id), body: '', tags: [], folder: QN.folders.path(x.id), type: 'folder', status: '' };
      case 'file': return { kind, item: x, title: x.name, body: '', tags: [], folder: '', type: `file ${QN.files.kindOf(x)} ${QN.files.extOf(QN.files.latest(x).blob)}`, status: '' };
      default: return null;
    }
  }

  function matches(d, p) {
    if (d.archived && !p.is.includes('archived')) return false;
    if (p.is.includes('archived') && !d.archived) return false;
    const hay = `${d.title}\n${d.body}\n${d.tags.join(' ')}\n${d.folder}`.toLowerCase();
    if (!p.words.every((w) => hay.includes(w))) return false;
    if (p.tags.length && !p.tags.every((t) => d.tags.some((x) => x.startsWith(t)))) return false;
    if (p.types.length && !p.types.some((t) => d.kind === t || d.kind.startsWith(t) || d.type.split(' ').some((x) => x === t || x.startsWith(t)))) return false;
    for (const flag of p.is) {
      if (['favorite', 'favourite', 'starred', 'pinned', 'star', 'fav'].includes(flag) && !d.starred) return false;
      if (['open', 'todo'].includes(flag) && !d.open) return false;
      if (flag === 'done' && !d.done) return false;
    }
    if (p.in.length && !p.in.every((f) => norm(d.folder).includes(f))) return false;
    if (p.status.length && !p.status.some((s) => d.status.includes(s))) return false;
    if (p.color.length && !p.color.includes(d.color || 'none')) return false;
    if (p.updated && !p.updated(util.dateOf(d.item.updatedAt))) return false;
    if (p.created && !p.created(util.dateOf(d.item.createdAt))) return false;
    return true;
  }

  function score(d, p) {
    const t = d.title.toLowerCase();
    let s = 0;
    if (p.words.length && p.words.every((w) => t.includes(w))) s += 4;
    if (p.words.some((w) => t.startsWith(w))) s += 1;
    if (d.starred) s += 0.5;
    return s;
  }

  const KINDS = { note: 'notes', task: 'tasks', bug: 'bugs', snippet: 'snippets', folder: 'folders', file: 'files' };

  function searchAll(q, limit) {
    const p = typeof q === 'string' ? parse(q) : q;
    if (p.empty) return [];
    const out = [];
    for (const [kind, c] of Object.entries(KINDS)) {
      for (const x of store.live(c)) {
        const d = docOf(kind, x);
        if (d && matches(d, p)) out.push(d);
      }
    }
    return out
      .sort((a, b) => score(b, p) - score(a, p) || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)))
      .slice(0, limit || 60);
  }

  // Text with every search word wrapped in <mark> (built as DOM nodes, never as HTML).
  function highlight(text, words) {
    const s = String(text || '');
    const ws = (words || []).filter(Boolean);
    if (!ws.length) return [s];
    const re = new RegExp(ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'gi');
    const out = [];
    let last = 0;
    s.replace(re, (m, i) => {
      if (i > last) out.push(s.slice(last, i));
      out.push(h('mark', { class: 'hit' }, m));
      last = i + m.length;
      return m;
    });
    if (last < s.length) out.push(s.slice(last));
    return out;
  }

  // A short slice of the body around the first match.
  function preview(text, words, len) {
    // Drop heading / list / checkbox markers so previews read like prose.
    const flat = String(text || '').replace(/^\s*(#+\s|- \[[ xX]\]\s|[-*+]\s|\d+[.)]\s|>\s?|```\s*)/gm, '').replace(/\s+/g, ' ').trim();
    const max = len || 110;
    if (!flat) return '';
    const lower = flat.toLowerCase();
    const at = (words || []).map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (at === undefined || at < max * 0.6) return flat.length > max ? `${flat.slice(0, max)}…` : flat;
    const start = Math.max(0, at - Math.floor(max * 0.35));
    return `…${flat.slice(start, start + max)}${start + max < flat.length ? '…' : ''}`;
  }

  QN.search = { parse, docOf, matches, searchAll, highlight, preview, noteTitle };
  QN.noteTitle = noteTitle;
})();
