(function () {
  'use strict';

  // Rich-text helpers. Notes are stored as HTML restricted to this small allow-list,
  // so pasted styles, scripts or tracking junk never end up in your data.
  const QN = window.QN;

  const ALLOWED_TAGS = ['p', 'br', 'div', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'mark', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'a', 'hr', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
  const ALLOWED_ATTR = ['href', 'data-checked', 'data-checklist', 'data-note', 'colspan', 'rowspan'];
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR', 'TABLE']);

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function sanitize(html) {
    if (!window.DOMPurify) return escapeHtml(html || '');
    return DOMPurify.sanitize(String(html || ''), { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
  }

  // Word documents edited in QAura: the same subset plus deeper headings, super/subscript and
  // pictures. Pictures must be embedded (data: URLs); anything pointing elsewhere is dropped, so
  // an edited document never loads anything from the internet.
  const DOC_TAGS = [...ALLOWED_TAGS, 'h4', 'h5', 'h6', 'sup', 'sub', 'img'];
  const DOC_ATTR = [...ALLOWED_ATTR, 'src', 'alt'];
  function sanitizeDoc(html) {
    if (!window.DOMPurify) return escapeHtml(html || '');
    const t = document.createElement('template');
    t.innerHTML = DOMPurify.sanitize(String(html || ''), { ALLOWED_TAGS: DOC_TAGS, ALLOWED_ATTR: DOC_ATTR, ALLOW_DATA_ATTR: false });
    for (const img of t.content.querySelectorAll('img')) {
      if (!/^data:image\/(png|jpeg|gif|bmp|webp);base64,[a-z0-9+/=\s]+$/i.test(img.getAttribute('src') || '')) img.remove();
    }
    return t.innerHTML;
  }

  function parse(html) {
    const t = document.createElement('template');
    t.innerHTML = sanitize(html);
    return t.content;
  }

  // Markdown (old notes, pasted text) -> rich text, keeping "- [ ]" items as checklists.
  function fromMarkdown(md) {
    if (!window.marked) return fromText(md);
    const t = document.createElement('template');
    t.innerHTML = sanitizeLoose(marked.parse(String(md || ''), { gfm: true, breaks: true }));
    for (const box of t.content.querySelectorAll('li > input[type="checkbox"]')) {
      const li = box.parentElement;
      li.setAttribute('data-checked', box.checked ? 'true' : 'false');
      if (li.parentElement) li.parentElement.setAttribute('data-checklist', '');
      box.remove();
    }
    const div = document.createElement('div');
    div.append(t.content);
    return sanitize(div.innerHTML);
  }

  // Only used inside fromMarkdown: keeps the checkbox inputs long enough to convert them.
  function sanitizeLoose(html) {
    if (!window.DOMPurify) return escapeHtml(html || '');
    return DOMPurify.sanitize(html, { ALLOWED_TAGS: [...ALLOWED_TAGS, 'input'], ALLOWED_ATTR: [...ALLOWED_ATTR, 'type', 'checked'] });
  }

  function fromText(text) {
    const lines = String(text || '').split(/\r?\n/);
    return lines.map((l) => (l.trim() ? `<p>${escapeHtml(l)}</p>` : '<p><br></p>')).join('');
  }

  // Rich text -> plain text with Markdown-style list markers (pastes cleanly into Jira, Teams, email).
  // With { markdown: true } it also keeps bold/italic/code/links and fences code blocks.
  function toText(html, opts) {
    const md = Boolean(opts && opts.markdown);
    const root = parse(html);
    const lines = [];
    let buf = '';
    const gap = () => { if (md && lines.length && lines[lines.length - 1] !== '') lines.push(''); };
    const flush = (indent) => {
      if (buf.trim()) { lines.push(indent + buf.trim()); gap(); }
      buf = '';
    };
    const wrapMd = (inner, mark) => {
      const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
      return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
    };

    const inline = (el) => {
      let s = '';
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { s += n.nodeValue; continue; }
        if (n.nodeType !== 1 || n.nodeName === 'UL' || n.nodeName === 'OL') continue;
        if (n.nodeName === 'BR') { s += '\n'; continue; }
        if (BLOCK.has(n.nodeName)) { s += `\n${inline(n)}`; continue; }
        const inner = inline(n);
        if (!md) { s += inner; continue; }
        switch (n.nodeName) {
          case 'B': case 'STRONG': s += wrapMd(inner, '**'); break;
          case 'I': case 'EM': s += wrapMd(inner, '_'); break;
          case 'S': case 'STRIKE': case 'DEL': s += wrapMd(inner, '~~'); break;
          case 'CODE': s += `\`${n.textContent}\``; break;
          case 'A': s += n.getAttribute('data-note') ? `[[${inner}]]` : `[${inner}](${n.getAttribute('href') || ''})`; break;
          default: s += inner;
        }
      }
      return s;
    };

    const list = (ul, indent) => {
      const check = ul.hasAttribute('data-checklist');
      let i = 1;
      for (const li of ul.children) {
        if (li.nodeName !== 'LI') continue;
        const marker = check ? (li.getAttribute('data-checked') === 'true' ? '- [x] ' : '- [ ] ') : ul.nodeName === 'OL' ? `${i++}. ` : '- ';
        lines.push(indent + marker + inline(li).trim().replace(/\n+/g, ' '));
        for (const sub of li.children) if (sub.nodeName === 'UL' || sub.nodeName === 'OL') list(sub, `${indent}  `);
      }
    };

    const blocks = (parent, indent) => {
      for (const n of parent.childNodes) {
        if (n.nodeType === 3) { buf += n.nodeValue; continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.nodeName;
        if (!BLOCK.has(tag)) {
          if (tag === 'BR') flush(indent);
          else buf += inline(n);
          continue;
        }
        flush(indent);
        if (/^H[1-3]$/.test(tag)) {
          if (lines.length && lines[lines.length - 1] !== '') lines.push('');
          lines.push(`${indent}${'#'.repeat(Number(tag[1]))} ${inline(n).trim()}`);
          gap();
        } else if (tag === 'UL' || tag === 'OL') { list(n, indent); gap(); }
        else if (tag === 'PRE') {
          const code = inline(n).replace(/\n$/, '').split('\n').map((l) => indent + l);
          if (md) lines.push(`${indent}\`\`\``, ...code, `${indent}\`\`\``);
          else lines.push(...code);
          gap();
        } else if (tag === 'BLOCKQUOTE') {
          const start = lines.length;
          blocks(n, '');
          flush('');
          while (lines.length > start && lines[lines.length - 1] === '') lines.pop();
          for (let i = start; i < lines.length; i++) lines[i] = `${indent}> ${lines[i]}`.trimEnd();
          gap();
        } else if (tag === 'HR') { lines.push(`${indent}---`); gap(); }
        else if (tag === 'TABLE') {
          const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim().replace(/\|/g, '\\|')));
          rows.forEach((r, i) => {
            lines.push(indent + (md ? `| ${r.join(' | ')} |` : r.join(' | ')));
            if (md && i === 0) lines.push(`${indent}|${r.map(() => ' --- ').join('|')}|`);
          });
          gap();
        } else if ([...n.children].some((c) => BLOCK.has(c.nodeName))) {
          blocks(n, indent);
          flush(indent);
        } else {
          const text = inline(n);
          lines.push(...(text.trim() ? text.split('\n').map((l) => indent + l.trimEnd()) : ['']));
          gap();
        }
      }
    };

    blocks(root, '');
    flush('');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const toMarkdown = (html) => toText(html, { markdown: true });

  // Standalone, print-friendly HTML document (used for HTML and PDF export).
  const DOC_CSS = `
    @page { size: A4; margin: 16mm 15mm; }
    * { box-sizing: border-box; }
    body { font: 11pt/1.6 "Segoe UI", system-ui, -apple-system, sans-serif; color: #1b1f27; margin: 0; padding: 32px; background: #fff; }
    article { max-width: 780px; margin: 0 auto; }
    article + article { page-break-before: always; break-before: page; margin-top: 48px; }
    .doc-title { font-size: 22pt; margin: 0 0 4px; }
    .doc-meta { color: #6b7280; font-size: 9.5pt; margin: 0 0 18px; padding-bottom: 10px; border-bottom: 1px solid #e5e7eb; }
    h1 { font-size: 17pt; margin: 18px 0 6px; } h2 { font-size: 14pt; margin: 16px 0 6px; } h3 { font-size: 12pt; margin: 14px 0 4px; color: #4c3fd1; }
    p { margin: 0 0 6px; }
    ul, ol { margin: 0 0 8px; padding-left: 22px; }
    ul[data-checklist] { list-style: none; padding-left: 2px; }
    ul[data-checklist] > li { position: relative; padding-left: 24px; }
    ul[data-checklist] > li::before { content: ""; position: absolute; left: 0; top: 4px; width: 12px; height: 12px; border: 1.5px solid #9ca3af; border-radius: 3px; }
    ul[data-checklist] > li[data-checked="true"] { color: #6b7280; text-decoration: line-through; }
    ul[data-checklist] > li[data-checked="true"]::before { background: #6c4cff; border-color: #6c4cff; }
    ul[data-checklist] > li[data-checked="true"]::after { content: ""; position: absolute; left: 4px; top: 5px; width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
    mark { background: #fde68a; padding: 0 2px; }
    code { font-family: "Cascadia Code", Consolas, monospace; font-size: 9.5pt; background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
    pre { font-family: "Cascadia Code", Consolas, monospace; font-size: 9.5pt; background: #f6f7f9; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; }
    blockquote { margin: 0 0 8px; padding: 2px 12px; border-left: 3px solid #6c4cff; color: #4b5563; }
    a { color: #4c3fd1; }
    hr { border: 0; border-top: 1px solid #e5e7eb; margin: 14px 0; }
    table { border-collapse: collapse; margin: 0 0 8px; } td, th { border: 1px solid #d1d5db; padding: 4px 8px; }`;

  function toDocument(title, notes) {
    const articles = notes.map((n) => `<article><h1 class="doc-title">${escapeHtml(n.title || 'Untitled')}</h1>${n.meta ? `<p class="doc-meta">${escapeHtml(n.meta)}</p>` : ''}${sanitize(n.html)}</article>`).join('\n');
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escapeHtml(title)}</title><style>${DOC_CSS}</style></head><body>\n${articles}\n</body></html>`;
  }

  // Print-ready page around already-escaped report HTML (bug reports); images must be data: URLs.
  function docShell(title, inner) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escapeHtml(title)}</title><style>${DOC_CSS}
    table.facts { width: 100%; margin: 10px 0 18px; } table.facts th { width: 150px; text-align: left; background: #eef0f4; font-weight: 600; }
    figure { margin: 10px 0 18px; page-break-inside: avoid; } figure img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 6px; }
    figcaption { color: #6b7280; font-size: 9pt; margin-top: 4px; }</style></head><body>
${inner}
</body></html>`;
  }

  QN.html = { sanitize, sanitizeDoc, parse, fromMarkdown, fromText, toText, toMarkdown, toDocument, docShell, escape: escapeHtml };
})();
