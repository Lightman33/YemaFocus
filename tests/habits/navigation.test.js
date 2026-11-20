import test from 'node:test';
import assert from 'node:assert/strict';
import { browserDouble, globalsFor, until, start } from '../shell/browser-double.js';
import { freshRecord } from '../../app/store.js';
import { Navigation } from '../../app/navigation.js';
const habitRow = (b, id = 'demo-read') => b.node('habits-root').querySelectorAll('.habit-item').find(n => n.getAttribute('data-habit-id') === id);

test('导航模型：五页分别记住位置，习惯可直达', () => {
  const navigation = new Navigation('habits'); assert.equal(navigation.current, 'habits');
  for (const [page, scroll] of [['review', 130], ['settings', 240], ['tasks', 350], ['habits', 460]]) navigation.move(page, scroll);
  assert.equal(navigation.move('review', 130).scrollTop, 240); assert.equal(navigation.move('settings', 240).scrollTop, 350);
  assert.equal(navigation.move('tasks', 350).scrollTop, 460); assert.equal(navigation.move('habits', 460).scrollTop, 130);
});
for (const [hash, label] of [['#habits', '正式未加入'], ['#demo/habits', '示例'], ['#sim/habits', '模拟未加入']]) {
  test('模拟 DOM：' + label + '直达习惯页；五标签顺序、切换、返回及滚动恢复', async t => {
    const b = browserDouble(freshRecord(), { hash }); globalsFor(t, b.globals);
    const app = await start(); t.after(() => app.disposeApp()); await until(() => !b.node('clear-data').disabled);
    assert.equal(b.node('page-habits').hidden, false); assert.equal(b.node('page-tasks').hidden, true);
    assert.deepEqual(b.tabs.map(tab => tab.dataset.page), ['tasks', 'habits', 'focus', 'review', 'settings']);
    const prefix = hash.startsWith('#demo') ? 'demo/' : hash.startsWith('#sim') ? 'sim/' : '';
    assert.equal(b.tabs[1].getAttribute('href'), '#' + prefix + 'habits'); assert.equal(b.tabs[1].getAttribute('aria-current'), 'page');
    b.node('main').scrollTop = 137; await app.changePage('review'); b.node('main').scrollTop = 211;
    await app.changePage('settings'); b.node('main').scrollTop = 310;
    // 浏览器返回用 hashchange 驱动，History API 的真实行为仍需浏览器验收。
    b.location.hash = '#' + prefix + 'habits'; b.window.emit('hashchange'); await until(() => !b.node('page-habits').hidden);
    assert.equal(b.node('main').scrollTop, 137); await app.changePage('review'); assert.equal(b.node('main').scrollTop, 211);
    assert.equal(b.requests.length, 0);
    if (prefix !== 'demo/') assert.match(b.node('habits-root').textContent, /第一次同步/);
    else assert.equal(b.node('habits-root').querySelectorAll('.habit-item').length, 4);
  });
}

test('模拟 DOM：#sim/habits 首次加入→离线取消→模拟电脑打卡→冲突选 false；全程无外网请求', async t => {
  const b = browserDouble(freshRecord(), { hash: '#sim/habits' }); globalsFor(t, b.globals);
  const app = await start(); t.after(() => app.disposeApp()); await until(() => !b.node('clear-data').disabled);
  await app.changePage('settings'); b.node('sync-now').emit('click');
  await until(() => app.controller.snapshot().joined && !b.node('sync-now').disabled);
  await app.changePage('habits'); assert.ok(habitRow(b));
  await app.changePage('settings'); b.node('sim-network').emit('click'); await app.changePage('habits');
  const today = app.dataSource.snapshot().today, checked = () => app.dataSource.snapshot().planner.habits.find(h => h.id === 'demo-read').checks.includes(today);
  habitRow(b).querySelector('.habit-today').emit('click'); await until(checked); await app.flushViews();
  habitRow(b).querySelector('.habit-today').emit('click'); await until(() => !checked()); await app.flushViews();
  await app.changePage('settings'); b.node('sim-habit').emit('click'); await until(() => /模拟电脑已发布/.test(b.node('sim-result').textContent));
  b.node('sim-network').emit('click'); await app.controller.syncNow(); await app.changePage('habits');
  await until(() => app.dataSource.snapshot().conflicts.some(c => c.path[0] === 'habit-check'));
  assert.match(habitRow(b).querySelector('.habit-today').className, /has-conflict/);
  const choose = habitRow(b).querySelectorAll('button').find(n => n.textContent === '保留这一份：未打卡（已取消）'); choose.emit('click');
  await until(() => !app.dataSource.snapshot().conflicts.some(c => c.path[0] === 'habit-check')); await app.flushViews();
  assert.equal(checked(), false); assert.equal(b.requests.length, 0);
});

test('模拟 DOM：#demo/habits 感想切页自动保存；输入法和存盘失败时保持原页，返回再显示修改', async t => {
  const b = browserDouble(freshRecord(), { hash: '#demo/habits' }); globalsFor(t, b.globals);
  const app = await start(); t.after(() => app.disposeApp()); await until(() => !b.node('clear-data').disabled);
  habitRow(b).querySelector('.habit-name-button').emit('click');
  const today = app.dataSource.snapshot().today;
  habitRow(b).querySelectorAll('button').find(n => n.getAttribute('aria-label') === '示例阅读，' + today + '，编辑文字感想').emit('click');
  const input = b.globals.document.getElementById('habit-journal-note'); input.emit('compositionstart'); input.value = '示例手机感想'; input.emit('input');
  assert.equal(await app.changePage('tasks'), false); assert.equal(b.node('page-habits').hidden, false);
  input.emit('compositionend');
  const change = app.dataSource.change.bind(app.dataSource); app.dataSource.change = () => Promise.reject(new Error('虚构存盘失败'));
  assert.equal(await app.changePage('tasks'), false); assert.equal(input.value, '示例手机感想'); app.dataSource.change = change;
  assert.equal(await app.changePage('tasks'), true); assert.equal(b.globals.document.querySelector('.habit-journal-dialog').open, false);
  assert.equal(app.dataSource.snapshot().planner.habits.find(h => h.id === 'demo-read').journal[today].note, '示例手机感想');
  await app.changePage('habits'); assert.match(habitRow(b).textContent, /示例手机感想/); assert.equal(b.requests.length, 0);
});
