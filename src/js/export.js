(function () {
  'use strict';

  // Export notes as Markdown / text / HTML / PDF, and import .md / .txt files as notes.
  const QN = window.QN;
  const { util, store, make, ui } = QN;

  const FORMATS = [['docx', 'Word (.docx)'], ['pdf', 'PDF (.pdf)'], ['md', 'Markdown (.md)'], ['txt', 'Plain text (.txt)'], ['html', 'Web page (.html)']];
  const cleanErr = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  const meta = (n) => [
    QN.folders.path(n.folderId),
    (n.tags || []).map((t) => `#${t}`).join(' '),
    `Updated ${util.fmtDateTime(n.updatedAt)}`,
  ].filter(Boolean).join(' · ');

  const asMarkdown = (n) => `# ${QN.noteTitle(n)}\n\n${(n.tags || []).length ? `${n.tags.map((t) => `#${t}`).join(' ')}\n\n` : ''}${QN.html.toMarkdown(n.html)}\n`;
  const asText = (n) => {
    const title = QN.noteTitle(n);
    return `${title}\n${'='.repeat(Math.min(title.length, 60))}\n\n${QN.html.toText(n.html)}\n`;
  };
  const asHtml = (notes, title) => QN.html.toDocument(title, notes.map((n) => ({ title: QN.noteTitle(n), meta: meta(n), html: n.html })));
  const content = async (n, fmt) => (fmt === 'docx' ? QN.office.noteDocx(n) : fmt === 'md' ? asMarkdown(n) : fmt === 'txt' ? asText(n) : asHtml([n], QN.noteTitle(n)));

  async function exportNote(n, fmt) {
    const name = QN.noteTitle(n);
    try {
      const res = fmt === 'pdf'
        ? await window.api.exportPdf({ name, html: asHtml([n], name) })
        : await window.api.exportFile({ name, ext: fmt, content: await content(n, fmt) });
      if (res) ui.toast(`Exported to ${res.path}`, { timeout: 5000 });
    } catch (err) {
      ui.alert('Export failed', cleanErr(err));
    }
  }

  // Folder names between rootId (exclusive) and the note's folder, for mirroring the tree on disk.
  function relPath(folderId, rootId) {
    const parts = [];
    let f = folderId && store.find('folders', folderId);
    for (let guard = 0; f && f.id !== rootId && guard < 30; guard++) {
      parts.unshift(f.name || 'Untitled folder');
      f = f.parentId && store.find('folders', f.parentId);
    }
    return parts;
  }

  async function exportNotes(title, notes, fmt, rootId) {
    if (!notes.length) {
      ui.toast('There are no notes to export here');
      return;
    }
    try {
      let res;
      if (fmt === 'pdf') res = await window.api.exportPdf({ name: title, html: asHtml(notes, title) });
      else {
        const files = [];
        for (const n of notes) files.push({ path: [...relPath(n.folderId, rootId), QN.noteTitle(n)], ext: fmt, content: await content(n, fmt) });
        res = await window.api.exportFolder({ name: title, files });
      }
      if (res) ui.toast(`Exported ${util.plural(notes.length, 'note')} to ${res.path}`, { timeout: 6000 });
    } catch (err) {
      ui.alert('Export failed', cleanErr(err));
    }
  }

  function formatMenuItems(onPick) {
    return FORMATS.map(([fmt, label]) => ({ label, icon: fmt === 'docx' || fmt === 'pdf' ? 'fileDoc' : 'notes', onClick: () => onPick(fmt) }));
  }

  async function importFiles(folderId) {
    let files;
    try {
      files = await window.api.importFiles();
    } catch (err) {
      ui.alert('Import failed', cleanErr(err));
      return [];
    }
    const created = [];
    const failed = [];
    for (const f of files || []) {
      if (f.error) { failed.push(`${f.name} (${f.error})`); continue; }
      let title = f.name.replace(/\.(md|markdown|txt)$/i, '');
      let text = f.text;
      if (f.ext !== 'txt') {
        const m = text.match(/^\s*#\s+(.+)\r?\n/);
        if (m) { title = m[1].trim(); text = text.slice(m[0].length); }
      }
      const html = f.ext === 'txt' ? QN.html.fromText(text) : QN.html.fromMarkdown(text);
      created.push(store.add('notes', make.note({ title, html, folderId: folderId || '' })));
    }
    if (created.length) ui.toast(`Imported ${util.plural(created.length, 'note')}`);
    if (failed.length) ui.alert('Some files were skipped', failed.join('\n'));
    return created;
  }

  QN.exporter = { FORMATS, exportNote, exportNotes, importFiles, formatMenuItems, asMarkdown, asText };
})();
