'use strict';

// Renders the app icon with a hidden Electron window and writes build/icon.png + build/icon.ico.
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
app.setPath('userData', path.join(require('os').tmpdir(), 'qaura-icon'));
const outDir = path.join(__dirname, '..', 'build');

const html = `<!doctype html><html><body style="margin:0;background:transparent"><script>
function draw(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const s = size / 256;
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x * s, y * s, w * s, h * s, r * s); };
  // Background tile with the app's violet -> cyan gradient.
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#7c5cff'); grad.addColorStop(0.55, '#4f8bff'); grad.addColorStop(1, '#22d3ee');
  rr(8, 8, 240, 240, 60); g.fillStyle = grad; g.fill();
  // Soft highlight.
  const hl = g.createLinearGradient(0, 0, 0, size);
  hl.addColorStop(0, 'rgba(255,255,255,0.22)'); hl.addColorStop(0.5, 'rgba(255,255,255,0)');
  rr(8, 8, 240, 240, 60); g.fillStyle = hl; g.fill();
  // Note page.
  rr(62, 50, 132, 160, 22); g.fillStyle = 'rgba(255,255,255,0.96)'; g.fill();
  // Lines on the page.
  g.fillStyle = 'rgba(79, 70, 229, 0.35)';
  if (size >= 32) { rr(84, 82, 88, 12, 6); g.fill(); rr(84, 108, 64, 12, 6); g.fill(); }
  // Check mark.
  g.strokeStyle = '#10b981'; g.lineWidth = Math.max(2, 20 * s); g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(92 * s, 160 * s); g.lineTo(116 * s, 182 * s); g.lineTo(166 * s, 132 * s); g.stroke();
  return c.toDataURL('image/png');
}
window.icons = ${JSON.stringify(SIZES)}.map((n) => [n, draw(n)]);
</script></body></html>`;

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(([size, png], i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map(([, png]) => png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const icons = await win.webContents.executeJavaScript('window.icons');
  const entries = icons.map(([size, url]) => [size, Buffer.from(url.split(',')[1], 'base64')]);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.png'), entries.find(([n]) => n === 256)[1]);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(entries));
  console.log(`Wrote ${path.join(outDir, 'icon.png')} and icon.ico`);
  app.quit();
});
