import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    assert.deepEqual(b.tabs.map(tab => tab.dataset.page), ['tasks', 'habits', 'focus', 'goals', 'review', 'settings']);
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
  assert.doesNotMatch(b.node('focus-clock').textContent, /锁屏或切到别的应用时不会响铃/);
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
  // v3.0：在专注页看过后离开，别的页面顶上不再挂着提示
  await app.changePage('habits');
  assert.equal(b.node('focus-completion').hidden, true);
  assert.doesNotMatch(b.globals.document.title, /休息完成/);
  await app.changePage('tasks');
  assert.equal(b.node('focus-completion').hidden, true);
  assert.equal(b.requests.length, 0);
});

test('T46-12 专注标题与其他三页同字号，iPhone 设置和锁屏提示默认收起', async () => {
  const b = browserDouble(freshRecord(), { hash: '#demo/focus' });
  const guide = b.node('focus-iphone-guide');
  assert.equal(guide.parentNode, b.node('page-focus'));
  assert.equal(b.node('page-focus').children.at(-1), guide);
  assert.equal(guide.getAttribute('open'), null);
  assert.equal(guide.querySelector('summary').textContent, 'iPhone 防打扰设置');
  const points = guide.querySelectorAll('li').map(node => node.textContent);
  assert.equal(points.length, 4);
  for (const [line, expected] of [/专注模式.*静音通知/, /屏幕时间.*限制/, /无法自动开启专注模式/, /锁屏.*不会响铃/].entries()) {
    assert.match(points[line], expected);
  }
  const css = await readFile(new URL('../../app/focus.css', import.meta.url), 'utf8');
  assert.match(css, /#page-focus > h1\s*\{[^}]*font-size:\s*1\.25rem/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*\.focus-clock, \.focus-today\s*\{[^}]*padding:\s*16px/);
});
