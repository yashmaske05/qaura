(function () {
  'use strict';

  // Exports: notes -> Word, bugs -> Word / PDF report, bugs & tasks -> Excel / CSV. All offline.
  const QN = window.QN;
  const { util, store, defs, ui } = QN;
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR', 'TABLE']);
  const HEADINGS = ['HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];
  const pictures = new WeakMap(); // <img> -> { bytes, type, width, height }, prepared before building a document
  const cleanErr = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const esc = (s) => QN.html.escape(String(s == null ? '' : s));

  // ---------- rich text (our sanitized subset) -> Word ----------

  function textRun(text, f) {
    return new docx.TextRun({
      text: String(text).replace(/ /g, ' '),
      bold: f.bold,
      italics: f.italics,
      underline: f.underline,
      strike: f.strike,
      superScript: f.superScript,
      subScript: f.subScript,
      highlight: f.highlight,
      color: f.color,
      font: f.code ? 'Consolas' : undefined,
      size: f.code ? 19 : f.size,
      shading: f.code ? { type: docx.ShadingType.CLEAR, fill: 'F1F2F5', color: 'auto' } : undefined,
      style: f.link ? 'Hyperlink' : undefined,
    });
  }

  function runsFrom(node, fmt, out) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue) out.push(textRun(n.nodeValue, fmt)); continue; }
      if (n.nodeType !== 1 || n.nodeName === 'UL' || n.nodeName === 'OL') continue;
      if (n.nodeName === 'BR') { out.push(new docx.TextRun({ text: '', break: 1 })); continue; }
      if (n.nodeName === 'IMG') {
        const p = pictures.get(n);
        if (p) out.push(new docx.ImageRun({ type: p.type, data: p.bytes, transformation: { width: p.width, height: p.height } }));
        continue;
      }
      const f = { ...fmt };
      const tag = n.nodeName;
      if (tag === 'B' || tag === 'STRONG') f.bold = true;
      if (tag === 'I' || tag === 'EM') f.italics = true;
      if (tag === 'U') f.underline = {};
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') f.strike = true;
      if (tag === 'MARK') f.highlight = 'yellow';
      if (tag === 'SUP') f.superScript = true;
      if (tag === 'SUB') f.subScript = true;
      if (tag === 'CODE') f.code = true;
      if (tag === 'A') {
        const href = n.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href)) {
          out.push(new docx.ExternalHyperlink({ link: href, children: runsFrom(n, { ...f, link: true }, []) }));
          continue;
        }
        f.color = '4C3FD1';
        f.underline = {};
      }
      runsFrom(n, f, out);
    }
    return out;
  }

  function preText(el) {
    let s = '';
    for (const n of el.childNodes) s += n.nodeType === 3 ? n.nodeValue : n.nodeName === 'BR' ? '\n' : preText(n);
    return s;
  }

  const box = { style: docx.BorderStyle.SINGLE, size: 4, color: 'E5E7EB', space: 4 };
  function codeBlock(text) {
    const lines = String(text || '').replace(/\n$/, '').split('\n');
    return new docx.Paragraph({
      shading: { type: docx.ShadingType.CLEAR, fill: 'F6F7F9', color: 'auto' },
      border: { top: box, bottom: box, left: box, right: box },
      spacing: { after: 160 },
      children: lines.map((l, i) => new docx.TextRun({ text: l || ' ', font: 'Consolas', size: 18, break: i ? 1 : undefined })),
    });
  }

  function cellContent(cell, ctx) {
    if (![...cell.children].some((c) => BLOCK.has(c.nodeName))) return [new docx.Paragraph({ children: runsFrom(cell, cell.nodeName === 'TH' ? { bold: true } : {}, []) })];
    const blocks = blocksFrom(cell, ctx, []); // e.g. several paragraphs in one cell (Word documents)
    return blocks.length ? blocks : [new docx.Paragraph({})];
  }

  function tableFrom(table, ctx) {
    const rows = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
    return new docx.Table({
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
      rows: rows.map((tr) => new docx.TableRow({
        children: [...tr.children].map((cell) => new docx.TableCell({ children: cellContent(cell, ctx) })),
      })),
    });
  }

  function listFrom(list, level, ctx, out) {
    const ordered = list.nodeName === 'OL';
    const check = list.hasAttribute('data-checklist');
    const instance = ordered ? ++ctx.num : 0;
    for (const li of list.children) {
      if (li.nodeName !== 'LI') continue;
      const runs = runsFrom(li, {}, []);
      if (check) runs.unshift(new docx.TextRun({ text: li.getAttribute('data-checked') === 'true' ? '☑ ' : '☐ ' }));
      const pos = ordered ? { numbering: { reference: 'qa-num', level, instance } } : check ? { indent: { left: 360 * (level + 1) } } : { bullet: { level } };
      out.push(new docx.Paragraph({ children: runs, ...pos }));
      for (const sub of li.children) if (sub.nodeName === 'UL' || sub.nodeName === 'OL') listFrom(sub, Math.min(level + 1, 3), ctx, out);
    }
  }

  function blocksFrom(parent, ctx, out) {
    let inline = [];
    const flush = () => {
      if (inline.length) out.push(new docx.Paragraph({ children: inline }));
      inline = [];
    };
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) inline.push(textRun(n.nodeValue, {})); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.nodeName;
      if (!BLOCK.has(tag)) { runsFrom({ childNodes: [n] }, {}, inline); continue; }
      flush();
      if (/^H[1-6]$/.test(tag)) out.push(new docx.Paragraph({ heading: docx.HeadingLevel[HEADINGS[Number(tag[1]) - 1]], children: runsFrom(n, {}, []) }));
      else if (tag === 'UL' || tag === 'OL') listFrom(n, 0, ctx, out);
      else if (tag === 'PRE') out.push(codeBlock(preText(n)));
      else if (tag === 'BLOCKQUOTE') {
        const groups = [...n.children].some((c) => BLOCK.has(c.nodeName)) ? [...n.children] : [n];
        for (const g of groups) {
          out.push(new docx.Paragraph({
            indent: { left: 480 },
            border: { left: { style: docx.BorderStyle.SINGLE, size: 12, color: '6C4CFF', space: 10 } },
            children: runsFrom(g, { italics: true, color: '4B5563' }, []),
          }));
        }
      } else if (tag === 'HR') out.push(new docx.Paragraph({ border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: 'D1D5DB', space: 1 } } }));
      else if (tag === 'TABLE') out.push(tableFrom(n, ctx));
      else if ([...n.children].some((c) => BLOCK.has(c.nodeName))) blocksFrom(n, ctx, out);
      else out.push(new docx.Paragraph({ children: runsFrom(n, {}, []) }));
    }
    flush();
    return out;
  }

  function makeDoc(title, children) {
    return new docx.Document({
      creator: 'QAura',
      title,
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      numbering: {
        config: [{
          reference: 'qa-num',
          levels: [0, 1, 2, 3].map((l) => ({ level: l, format: docx.LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: docx.AlignmentType.START, style: { paragraph: { indent: { left: 720 + 360 * l, hanging: 360 } } } })),
        }],
      },
      sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children }],
    });
  }
  const docBytes = async (doc) => new Uint8Array(await (await docx.Packer.toBlob(doc)).arrayBuffer());
  const metaLine = (text) => new docx.Paragraph({ spacing: { after: 240 }, children: [new docx.TextRun({ text, color: '6B7280', size: 18 })] });
  const heading = (text, level) => new docx.Paragraph({ heading: level || docx.HeadingLevel.HEADING_2, children: [new docx.TextRun(text)] });

  function fileList(entity) {
    const files = QN.files.filesOf(entity);
    if (!files.length) return [];
    return [heading('Attached files'), ...files.map((f) => new docx.Paragraph({ bullet: { level: 0 }, children: [new docx.TextRun(`${f.name} (${QN.files.KIND[QN.files.kindOf(f)].label}, ${QN.files.fmtSize(QN.files.latest(f).size)})`)] }))];
  }

  async function noteDocx(n) {
    const title = QN.noteTitle(n);
    const meta = [QN.folders.path(n.folderId), (n.tags || []).map((t) => `#${t}`).join(' '), `Updated ${util.fmtDateTime(n.updatedAt)}`].filter(Boolean).join(' · ');
    const children = [new docx.Paragraph({ heading: docx.HeadingLevel.TITLE, children: [new docx.TextRun(title)] }), metaLine(meta)];
    blocksFrom(QN.html.parse(n.html), { num: 0 }, children);
    children.push(...fileList(n));
    return docBytes(makeDoc(title, children));
  }

  // A Word document edited in QAura -> .docx bytes. Embedded pictures are kept (WebP becomes PNG,
  // since Word cannot show WebP) and scaled to fit the page width.
  async function docxFromHtml(html, title) {
    const t = document.createElement('template');
    t.innerHTML = QN.html.sanitizeDoc(html); // not QN.html.parse: the notes subset would drop the pictures
    const frag = t.content;
    for (const img of frag.querySelectorAll('img')) {
      try {
        pictures.set(img, await pictureFrom(img.getAttribute('src')));
      } catch {
        img.replaceWith(document.createTextNode('[picture could not be saved]'));
      }
    }
    return docBytes(makeDoc(title, blocksFrom(frag, { num: 0 }, [])));
  }

  async function pictureFrom(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    let type = (/^data:image\/(png|jpeg|gif|bmp)/i.exec(src) || [])[1];
    let bytes;
    if (type) bytes = Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    else {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      type = 'png';
    }
    const scale = Math.min(1, 620 / img.naturalWidth);
    return { bytes, type: type.toLowerCase() === 'jpeg' ? 'jpg' : type.toLowerCase(), width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) };
  }

  // ---------- bug report (Word / PDF) ----------

  const bugTitle = (b) => `${b.ticket ? `[${b.ticket}] ` : ''}${b.title || 'Untitled bug'}`;
  const bugFacts = (b) => [
    ['Status', defs.label(defs.bugStatus, b.status)], ['Severity', defs.label(defs.severity, b.severity)], ['Priority', defs.label(defs.priority, b.priority)],
    ['Module', b.module], ['Environment', b.env], ['Build', b.build], ['Ticket link', b.url],
    ['Logged', util.fmtDateTime(b.createdAt)], ['Updated', util.fmtDateTime(b.updatedAt)],
  ].filter(([, v]) => v);
  const stepLines = (b) => String(b.steps || '').split(/\r?\n/).map((l) => l.trim().replace(/^(\d+[.)]|[-*])\s+/, '')).filter(Boolean);

  async function imageFor(f) {
    const blob = QN.files.latest(f).blob;
    const img = new Image();
    img.src = QN.files.fileUrl(blob);
    await img.decode();
    let ext = QN.files.extOf(blob);
    let bytes = new Uint8Array(await QN.files.bytesOf(blob));
    if (ext === 'webp') { // Word cannot embed WebP: convert to PNG
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      ext = 'png';
    }
    const scale = Math.min(1, 620 / img.naturalWidth);
    return { bytes, ext, width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) };
  }

  async function bugDocx(b) {
    const files = QN.files.filesOf(b);
    const images = files.filter((f) => QN.files.kindOf(f) === 'image');
    const others = files.filter((f) => QN.files.kindOf(f) !== 'image');
    const cell = (text, bold, fill) => new docx.TableCell({
      width: { size: bold ? 25 : 75, type: docx.WidthType.PERCENTAGE },
      shading: fill ? { type: docx.ShadingType.CLEAR, fill, color: 'auto' } : undefined,
      children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold })] })],
    });
    const children = [
      new docx.Paragraph({ heading: docx.HeadingLevel.TITLE, children: [new docx.TextRun(bugTitle(b))] }),
      new docx.Table({ width: { size: 100, type: docx.WidthType.PERCENTAGE }, rows: bugFacts(b).map(([k, v]) => new docx.TableRow({ children: [cell(k, true, 'EEF0F4'), cell(v)] })) }),
    ];
    const steps = stepLines(b);
    if (steps.length) children.push(heading('Steps to reproduce'), ...steps.map((s) => new docx.Paragraph({ numbering: { reference: 'qa-num', level: 0, instance: 1 }, children: [new docx.TextRun(s)] })));
    for (const [label, value] of [['Expected result', b.expected], ['Actual result', b.actual]]) {
      if (value && value.trim()) children.push(heading(label), ...value.trim().split(/\r?\n/).map((l) => new docx.Paragraph({ children: [new docx.TextRun(l)] })));
    }
    for (const [label, value] of [['API request', b.apiRequest], ['API response', b.apiResponse]]) {
      if (value && value.trim()) children.push(heading(label), codeBlock(value.trim()));
    }
    if (b.notes && b.notes.trim()) children.push(heading('Notes & evidence'), ...b.notes.trim().split(/\r?\n/).map((l) => new docx.Paragraph({ children: [new docx.TextRun(l)] })));
    if (images.length) {
      children.push(heading('Screenshots'));
      for (const f of images) {
        try {
          const im = await imageFor(f);
          children.push(new docx.Paragraph({ children: [new docx.ImageRun({ type: im.ext === 'jpg' ? 'jpg' : im.ext, data: im.bytes, transformation: { width: im.width, height: im.height } })] }));
          children.push(new docx.Paragraph({ spacing: { after: 240 }, children: [new docx.TextRun({ text: f.name, color: '6B7280', size: 18, italics: true })] }));
        } catch {
          children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: `${f.name} (could not be embedded)`, italics: true })] }));
        }
      }
    }
    if (others.length) children.push(heading('Other attached files'), ...others.map((f) => new docx.Paragraph({ bullet: { level: 0 }, children: [new docx.TextRun(`${f.name} (${QN.files.KIND[QN.files.kindOf(f)].label}, ${QN.files.fmtSize(QN.files.latest(f).size)})`)] })));
    return docBytes(makeDoc(bugTitle(b), children));
  }

  const dataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  async function bugHtml(b) {
    const files = QN.files.filesOf(b);
    const images = files.filter((f) => QN.files.kindOf(f) === 'image');
    const others = files.filter((f) => QN.files.kindOf(f) !== 'image');
    let body = `<h1 class="doc-title">${esc(bugTitle(b))}</h1><table class="facts">${bugFacts(b).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
    const steps = stepLines(b);
    if (steps.length) body += `<h2>Steps to reproduce</h2><ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
    for (const [label, value] of [['Expected result', b.expected], ['Actual result', b.actual], ['Notes &amp; evidence', b.notes]]) {
      if (value && value.trim()) body += `<h2>${label}</h2><p>${esc(value.trim()).replace(/\n/g, '<br>')}</p>`;
    }
    for (const [label, value] of [['API request', b.apiRequest], ['API response', b.apiResponse]]) {
      if (value && value.trim()) body += `<h2>${label}</h2><pre>${esc(value.trim())}</pre>`;
    }
    if (images.length) {
      body += '<h2>Screenshots</h2>';
      for (const f of images) {
        const src = await dataUrl(new Blob([await QN.files.bytesOf(QN.files.latest(f).blob)]));
        body += `<figure><img src="${src.replace(/^data:[^;]*;/, `data:image/${QN.files.extOf(QN.files.latest(f).blob).replace('jpg', 'jpeg')};`)}" alt=""><figcaption>${esc(f.name)}</figcaption></figure>`;
      }
    }
    if (others.length) body += `<h2>Other attached files</h2><ul>${others.map((f) => `<li>${esc(f.name)} (${esc(QN.files.KIND[QN.files.kindOf(f)].label)}, ${esc(QN.files.fmtSize(QN.files.latest(f).size))})</li>`).join('')}</ul>`;
    return QN.html.docShell(bugTitle(b), `<article>${body}</article>`);
  }

  // ---------- lists -> Excel / CSV ----------

  const BUG_COLS = [
    ['ticket', 'Ticket', 12], ['title', 'Title', 42], ['status', 'Status', 16], ['severity', 'Severity', 11], ['priority', 'Priority', 10],
    ['module', 'Module', 16], ['env', 'Environment', 13], ['build', 'Build', 12], ['steps', 'Steps to reproduce', 50], ['expected', 'Expected', 36],
    ['actual', 'Actual', 36], ['apiRequest', 'API request', 40], ['apiResponse', 'API response', 40], ['notes', 'Notes', 36],
    ['files', 'Files', 30], ['url', 'Ticket link', 30], ['created', 'Logged', 18], ['updated', 'Updated', 18],
  ];
  const TASK_COLS = [
    ['title', 'Task', 44], ['status', 'Status', 13], ['priority', 'Priority', 10], ['date', 'Planned for', 13], ['due', 'Due', 13],
    ['ticket', 'Ticket', 12], ['blocker', 'Blocked by', 30], ['notes', 'Notes', 40], ['files', 'Files', 30], ['created', 'Created', 18], ['completed', 'Completed', 18],
  ];
  const DATE_TIME = new Set(['created', 'updated', 'completed']);
  const DATE_ONLY = new Set(['date', 'due']);
  const fileNames = (e) => QN.files.filesOf(e).map((f) => f.name).join('; ');

  const bugRow = (b) => ({
    ticket: b.ticket, title: b.title, status: defs.label(defs.bugStatus, b.status), severity: defs.label(defs.severity, b.severity), priority: defs.label(defs.priority, b.priority),
    module: b.module, env: b.env, build: b.build, steps: QN.bugs.numberSteps(b.steps), expected: b.expected, actual: b.actual,
    apiRequest: b.apiRequest, apiResponse: b.apiResponse, notes: b.notes, files: fileNames(b), url: b.url, created: b.createdAt, updated: b.updatedAt,
  });
  const taskRow = (t) => ({
    title: t.title, status: defs.label(defs.taskStatus, t.status), priority: defs.label(defs.priority, t.priority), date: t.date, due: t.due,
    ticket: t.ticket, blocker: t.blocker, notes: t.notes, files: fileNames(t), created: t.createdAt, completed: t.completedAt,
  });

  async function toXlsx(sheetName, cols, rows) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'QAura';
    wb.created = new Date();
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([key, header, width]) => ({ key, header, width }));
    for (const r of rows) {
      const row = { ...r };
      for (const k of DATE_TIME) if (row[k]) row[k] = new Date(row[k]);
      for (const k of DATE_ONLY) if (row[k]) row[k] = util.parseDate(row[k]);
      ws.addRow(row);
    }
    cols.forEach(([key], i) => {
      if (DATE_TIME.has(key)) ws.getColumn(i + 1).numFmt = 'dd-mmm-yyyy hh:mm';
      if (DATE_ONLY.has(key)) ws.getColumn(i + 1).numFmt = 'dd-mmm-yyyy';
    });
    ws.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: 'top', wrapText: true }; });
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C4CFF' } };
    head.alignment = { vertical: 'middle' };
    head.height = 22;
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    return new Uint8Array(await wb.xlsx.writeBuffer());
  }

  function toCsv(cols, rows) {
    const cell = (k, v) => {
      let s = v == null ? '' : DATE_TIME.has(k) && v ? util.fmtDateTime(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop Excel treating cell text as a formula
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return `﻿${[cols.map(([k, label]) => cell('', label)).join(','), ...rows.map((r) => cols.map(([k]) => cell(k, r[k])).join(','))].join('\r\n')}\r\n`;
  }

  // ---------- entry points ----------

  async function save(name, ext, content) {
    const res = await window.api.exportFile({ name, ext, content });
    if (res) ui.toast(`Exported to ${res.path}`, { timeout: 5000 });
  }

  async function run(fn) {
    try {
      await fn();
    } catch (err) {
      ui.alert('Export failed', cleanErr(err));
    }
  }

  const exportBugs = (bugs, fmt, title) => run(async () => {
    if (!bugs.length) { ui.toast('There are no bugs to export here'); return; }
    const rows = bugs.map(bugRow);
    await save(title || 'Bugs', fmt, fmt === 'xlsx' ? await toXlsx('Bugs', BUG_COLS, rows) : toCsv(BUG_COLS, rows));
  });
  const exportTasks = (tasks, fmt, title) => run(async () => {
    if (!tasks.length) { ui.toast('There are no tasks to export here'); return; }
    const rows = tasks.map(taskRow);
    await save(title || 'Tasks', fmt, fmt === 'xlsx' ? await toXlsx('Tasks', TASK_COLS, rows) : toCsv(TASK_COLS, rows));
  });
  const exportBugReport = (b, fmt) => run(async () => {
    const name = bugTitle(b);
    if (fmt === 'pdf') {
      const res = await window.api.exportPdf({ name, html: await bugHtml(b) });
      if (res) ui.toast(`Exported to ${res.path}`, { timeout: 5000 });
    } else await save(name, 'docx', await bugDocx(b));
  });
  const listMenu = (onPick) => [
    { label: 'Excel (.xlsx)', icon: 'table', onClick: () => onPick('xlsx') },
    { label: 'CSV (.csv)', icon: 'table', hint: 'opens in Excel', onClick: () => onPick('csv') },
  ];

  QN.office = { noteDocx, docxFromHtml, bugDocx, bugHtml, toXlsx, toCsv, exportBugs, exportTasks, exportBugReport, listMenu, BUG_COLS, TASK_COLS };
})();
