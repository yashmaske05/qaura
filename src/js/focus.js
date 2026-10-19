(function () {
  'use strict';

  // Focus timer in the title bar. The end time is saved, so it survives restarting the app.
  const QN = window.QN;
  const { h, icon, store, ui } = QN;
  let btn = null;
  let timer = null;

  const state = () => store.state.settings.focus || null;

  function start(minutes) {
    store.state.settings.focus = { end: Date.now() + minutes * 60000, minutes };
    store.commit();
    tick();
    ui.toast(`Focus timer started: ${minutes} min`);
  }

  function stop() {
    store.state.settings.focus = null;
    store.commit();
    tick();
  }

  function finished(f) {
    stop();
    try { new Notification('Focus session complete', { body: `${f.minutes} minutes done. Time for a short break.` }); } catch { /* notifications unavailable */ }
    ui.toast(`Focus session complete (${f.minutes} min). Take a short break.`, { timeout: 8000 });
  }

  function tick() {
    clearTimeout(timer);
    const f = state();
    if (!btn) return;
    if (!f) {
      btn.classList.remove('running');
      btn.replaceChildren(icon('clock'), h('span', null, 'Focus'));
      btn.title = 'Start a focus timer';
      return;
    }
    const left = f.end - Date.now();
    if (left <= 0) {
      finished(f);
      return;
    }
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    const pct = Math.round((1 - left / (f.minutes * 60000)) * 100);
    btn.classList.add('running');
    btn.style.setProperty('--focus-pct', `${pct}%`);
    btn.replaceChildren(icon('clock'), h('span', { class: 'focus-time' }, `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`));
    btn.title = `Focus session: ${f.minutes} min. Click to stop.`;
    timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 10);
  }

  function openMenu() {
    const f = state();
    ui.menu(btn, [
      { header: 'Focus timer' },
      ...[15, 25, 45, 60].map((m) => ({ label: `${m} minutes`, icon: 'clock', hint: m === 25 ? 'classic' : '', onClick: () => start(m) })),
      f ? { separator: true } : null,
      f ? { label: 'Stop timer', icon: 'x', danger: true, onClick: stop } : null,
    ], { alignRight: true });
  }

  function init(container) {
    btn = h('button', { type: 'button', class: 'focus-btn', onClick: openMenu });
    container.append(btn);
    const f = state();
    // A session that ended long ago while the app was closed is cleared quietly.
    if (f && f.end < Date.now() - 60000) {
      store.state.settings.focus = null;
      store.commit();
    }
    tick();
  }

  QN.focus = { init, start, stop, menu: () => btn && openMenu() };
})();
