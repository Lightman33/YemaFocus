import test from 'node:test';
import assert from 'node:assert/strict';
import { browserDouble, globalsFor, start, until } from '../shell/browser-double.js';
import { freshRecord } from '../../app/store.js';

for (const [hash, prefix] of [['#focus', ''], ['#sim/focus', 'sim/']]) {
  test(hash + ' 直达，首次同步前不能开始', async t => {
    const b = browserDouble(freshRecord(), { hash });
    globalsFor(t, b.globals);
    const app = await start(); t.after(() => app.disposeApp());
    await until(() => !b.node('clear-data').disabled);
    assert.equal(b.node('page-focus').hidden, false);
    assert.equal(b.node('focus-start').disabled, true);
    assert.match(b.node('focus-gate').textContent, /第一次同步/);
    assert.deepEqual(b.tabs.map(tab => tab.dataset.page), ['tasks', 'habits', 'focus', 'review', 'settings']);
    assert.equal(b.tabs[2].getAttribute('href'), '#' + prefix + 'focus');
    assert.equal(b.tabs[2].getAttribute('aria-current'), 'page');
    b.node('main').scrollTop = 120;
    await app.changePage('settings');
    b.location.hash = '#' + prefix + 'focus'; b.window.emit('hashchange');
    await app.changePage('focus');
    assert.equal(b.node('main').scrollTop, 120);
    assert.equal(b.requests.length, 0);
  });
}

test('示例模式今日数据、后台到点、前台铃声和标题', async t => {
  const b = browserDouble(freshRecord(), { hash: '#demo/focus' });
  globalsFor(t, b.globals);
  const clock = Date.now; let now = Date.parse('2026-11-03T04:00:00Z'), sounds = 0;
  Date.now = () => now; t.after(() => { Date.now = clock; });
  b.window.AudioContext = class {
    state = 'running'; currentTime = 1;
    async resume() {}
    createOscillator() { return { frequency: {}, connect() {}, start() { sounds++; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  };
  const app = await start(); t.after(() => app.disposeApp());
  await until(() => !b.node('clear-data').disabled);
  assert.equal(b.node('page-focus').hidden, false);
  assert.equal(b.node('focus-time').textContent, '25:00');
  assert.match(b.node('focus-clock').textContent, /锁屏或切到别的应用时不会响铃，回来会自动记上/);
  assert.ok(parseInt(b.node('focus-count').textContent, 10) >= 2);
  const before = app.dataSource.snapshot().records.length;
  b.node('focus-work-minutes').value = '1'; b.node('focus-break-minutes').value = '1';
  b.node('focus-preferences').emit('submit');
  await until(() => b.node('focus-time').textContent === '01:00');
  b.node('focus-item').value = '虚构手机记录';
  b.node('focus-start').emit('click'); await until(() => !b.node('focus-pause').hidden);
  b.globals.document.hidden = true; b.globals.document.emit('visibilitychange');
  now += 5 * 60000;
  b.globals.document.hidden = false; b.globals.document.emit('visibilitychange');
  await until(() => b.node('focus-message').textContent === '专注完成');
  assert.match(b.globals.document.title, /^专注完成/);
  assert.equal(sounds, 0);
  assert.equal(app.dataSource.snapshot().records.length, before + 1);
  const row = app.dataSource.snapshot().records.find(r => r.columns[4] === '虚构手机记录');
  assert.deepEqual(row.columns.slice(1, 4), ['2026-11-03 12:00:00', '2026-11-03 12:01:00', '1']);
  b.node('focus-rest').emit('click'); await until(() => b.node('focus-phase').textContent === '休息中');
  await app.changePage('tasks');
  now += 60000;
  await until(() => !b.node('focus-completion').hidden);
  assert.equal(sounds, 1);
  assert.match(b.globals.document.title, /^休息完成 · 任务/);
  b.node('focus-completion').emit('click'); await app.changePage('focus');
  assert.equal(b.node('focus-completion').hidden, true);
  assert.equal(b.requests.length, 0);
});
