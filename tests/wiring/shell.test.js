import test from 'node:test';
import assert from 'node:assert/strict';
import { browserDouble, globalsFor, until, start } from '../shell/browser-double.js';
import { freshRecord } from '../../app/store.js';
import { DEMO_DATABASE } from '../../app/demo-data.js';
import { SIM_DATABASE } from '../../app/sim-repo.js';
const field = (document, name) => document.querySelectorAll('textarea').find(n => n.dataset.field === name);
const reviewField = document => document.querySelectorAll('textarea').find(n => n.getAttribute('aria-label') === '复盘模块：今日完成');
async function simulation(t) {
  const browser = browserDouble(freshRecord(), { hash: '#sim' }); globalsFor(t, browser.globals);
  const app = await start(); await until(() => !browser.node('owner').disabled);
  t.after(() => app.disposeApp());
  assert.equal(browser.requests.length, 0); assert.equal(browser.node('sync-now').textContent, '从电脑加入');
  browser.node('sync-now').emit('click'); await until(() => app.controller.snapshot().joined && !browser.node('sync-now').disabled);
  return { browser, app };
}
test('DOM 模拟：#sim 共用正式控制器加入，任务复盘统计有电脑数据，电脑按钮真实发布并合并', async t => {
  const { browser: b, app } = await simulation(t);
  assert.deepEqual(b.openedNames, [SIM_DATABASE]); assert.equal(b.node('demo-badge').textContent, '模拟仓库（仅供验收）');
  assert.ok(app.dataSource.snapshot().planner.reviews.length >= 25); assert.ok(app.dataSource.snapshot().records.length > 0); assert.ok(app.dataSource.snapshot().planner.habits.length);
  assert.ok(parseInt(b.node('task-count').textContent, 10) > 0); assert.equal(b.node('sync-now').textContent, '立即同步');
  await app.changePage('review'); assert.ok(b.globals.document.getElementById('review-title').value.includes('慢慢完成')); assert.equal(b.node('setup-guide').open, false);
  b.node('sim-task').emit('click'); await until(() => /模拟电脑已发布/.test(b.node('sim-result').textContent));
  await app.controller.foreground(); assert.match(app.dataSource.snapshot().planner.tasks.find(t => t.id === 'demo-task-0').notes, /电脑写下/);
  b.node('sim-result').textContent = ''; b.node('sim-review').emit('click'); await until(() => /模拟电脑已发布/.test(b.node('sim-result').textContent));
  await app.controller.foreground(); assert.match(app.dataSource.snapshot().planner.reviews.find(r => r.id === 'day:' + app.dataSource.snapshot().today).content, /电脑补充/);
  assert.equal(b.requests.length, 0); assert.match(b.node('sync-summary').textContent, /已加入/);
});
test('DOM 模拟：切页先flush复盘和任务，输入法/存盘拒绝留在原页；后台也flush，断网仍保存', async t => {
  const { browser: b, app } = await simulation(t), doc = b.globals.document;
  await app.changePage('review'); const review = reviewField(doc); review.focus(); review.value = '手机切页保存的虚构复盘'; review.emit('input');
  assert.equal(await app.changePage('tasks'), true); assert.match(app.dataSource.snapshot().planner.reviews.find(r => r.id === 'day:' + app.dataSource.snapshot().today).content, /手机切页保存/);
  const first = doc.querySelectorAll('.task-item').find(n => n.dataset.taskId === 'demo-task-0'); first.querySelector('.task-open').emit('click'); await until(() => Boolean(field(doc, 'notes')));
  const notes = field(doc, 'notes'); notes.focus(); notes.value = '未结束选词'; notes.emit('compositionstart'); notes.emit('input');
  assert.equal(await app.changePage('settings'), false); assert.equal(b.node('page-tasks').hidden, false); assert.match(b.node('offline-ready').textContent, /输入法/);
  notes.emit('compositionend'); assert.equal(await app.changePage('settings'), true); assert.equal(app.dataSource.snapshot().planner.tasks.find(t => t.id === 'demo-task-0').notes, '未结束选词');
  await app.changePage('review'); const current = reviewField(doc); current.focus(); current.emit('compositionstart'); current.value = '还在输入'; current.emit('input');
  assert.equal(await app.changePage('settings'), false); assert.equal(b.node('page-review').hidden, false);
  current.emit('compositionend'); await app.flushViews();
  const change = app.dataSource.change.bind(app.dataSource); app.dataSource.change = () => Promise.reject(new Error('虚构存盘失败'));
  current.value = '存盘失败仍留着'; current.emit('input'); assert.equal(await app.changePage('settings'), false); assert.equal(current.value, '存盘失败仍留着'); assert.match(b.node('offline-ready').textContent, /虚构存盘失败/);
  app.dataSource.change = change; await app.flushViews();
  b.node('sim-network').emit('click'); assert.equal(app.controller.snapshot().offline, true);
  current.value = '后台保存的虚构复盘'; current.emit('input'); doc.hidden = true; doc.emit('visibilitychange');
  await until(() => app.dataSource.snapshot().planner.reviews.some(r => r.content.includes('后台保存的虚构复盘'))); assert.match(b.node('sync-facts').textContent, /离线，已存本机/);
  doc.hidden = false; b.node('sim-network').emit('click'); await app.controller.foreground(); assert.equal(app.controller.snapshot().offline, false);
  current.value = '离开页面前的虚构复盘'; current.emit('input'); b.window.emit('pagehide');
  await until(() => app.dataSource.snapshot().planner.reviews.some(r => r.content.includes('离开页面前的虚构复盘')));
  assert.equal(b.requests.length, 0);
});
test('DOM 模拟：#sim 刷新清自身旧库；#demo 无控制器且含复盘记录，两种库不使用正式名', async t => {
  const { browser: b, app } = await simulation(t); const old = b.record(); await app.disposeApp();
  const reload = browserDouble(old, { hash: '#sim' }); for (const [key, value] of Object.entries(reload.globals)) globalThis[key] = value;
  const second = await start(); await until(() => !reload.node('owner').disabled); t.after(() => second.disposeApp());
  assert.equal(second.controller.snapshot().joined, false); assert.notEqual(reload.record().settings.deviceId, old.settings.deviceId); assert.equal(reload.record().state, null);
  assert.equal(reload.requests.length, 0);
  const demo = browserDouble(freshRecord(), { hash: '#demo' }); for (const [key, value] of Object.entries(demo.globals)) globalThis[key] = value;
  const third = await start(); t.after(() => third.disposeApp()); await until(() => !demo.node('task-quick').disabled);
  assert.equal(third.controller, undefined); assert.deepEqual(demo.openedNames, [DEMO_DATABASE]); assert.notEqual(DEMO_DATABASE, SIM_DATABASE);
  assert.ok(third.dataSource.snapshot().planner.reviews.length); assert.ok(third.dataSource.snapshot().records.length); assert.ok(third.dataSource.snapshot().settings['ReviewModules.day']);
  await third.changePage('review'); assert.ok(demo.globals.document.getElementById('review-title').value.includes('慢慢完成')); assert.equal(demo.requests.length, 0);
});
test('DOM 模拟：未加入的正式页面操作及保存设置，GitHub调用始终为零', async t => {
  const b = browserDouble(); globalsFor(t, b.globals); const app = await start(); await until(() => !b.node('owner').disabled); t.after(() => app.disposeApp());
  await app.changePage('tasks'); await app.changePage('review'); await app.changePage('settings');
  b.globals.document.hidden = true; b.globals.document.emit('visibilitychange'); b.globals.document.hidden = false; b.globals.document.emit('visibilitychange'); b.window.emit('online'); b.window.emit('offline');
  b.node('owner').value = 'fiction'; b.node('repo').value = 'repo'; b.node('token').value = 'fictional-token'; b.node('settings-form').emit('submit');
  await until(() => /设置已保存/.test(b.node('save-result').textContent)); assert.equal(b.requests.length, 0);
});

test('T32 状态弹窗：成功、有冲突都显示同步状态，出错后恢复也重置标题', async t => {
  const { browser: b, app } = await simulation(t);
  b.node('sync-facts').emit('click'); assert.equal(b.node('error-title').textContent, '同步状态');
  b.node('close-error').emit('click');
  app.syncState.setConflicts(1);
  b.node('sync-facts').emit('click'); assert.equal(b.node('error-title').textContent, '同步状态');
  app.syncState.setError({ code: 'auth', message: '虚构令牌失效' });
  b.node('sync-error').emit('click'); assert.equal(b.node('error-title').textContent, '同步出错原因');
  app.syncState.setError(null); app.syncState.setConflicts(0);
  b.node('sync-facts').emit('click'); assert.equal(b.node('error-title').textContent, '同步状态');
});

test('DOM 模拟：正式传输接内存HTTP，警告按软件时区显示并清除；限流显示重试时间而非出错', async t => {
  const { setup } = await import('./helpers.js'); const { githubDouble } = await import('./github-double.js');
  const { createManifest, devicePath, deviceText } = await import('../../sync/pack.js');
  const h = await setup(); await h.p.c.join(); const initial = await h.p.store.read(); await h.p.c.dispose();
  const bridge = githubDouble(h.memory), b = browserDouble(initial); b.globals.fetch = bridge.fetch; globalsFor(t, b.globals);
  const app = await start(); await until(() => !b.node('owner').disabled && !app.controller.snapshot().busy); t.after(() => { app.disposeApp(); h.computer.engine.dispose(); });
  const bad = await createManifest('warning-computer', 1, { 'tasks-00': '1'.repeat(64) }, {}), encode = text => Uint8Array.from(text, c => c.charCodeAt(0));
  await h.memory.put(devicePath('warning-computer'), encode(deviceText('warning-computer'))); await h.memory.put(bad.path, encode(bad.text)); await app.controller.foreground();
  assert.match(b.node('sync-warning').textContent, /设备 warning-computer 的数据从 \d{2}月\d{2}日 \d{2}:\d{2} 起不完整，已使用它上一份完整数据/);
  assert.match(b.node('sync-facts').textContent, /警告/); b.node('sync-facts').emit('click'); assert.equal(b.node('error-dialog').open, true);
  assert.match(b.node('sync-full').textContent, /已存本机\n已上传\n/);
  await h.memory.remove(bad.path); await app.controller.foreground(); assert.equal(b.node('sync-warning').textContent, '');
  bridge.failNext(429, { 'retry-after': '120' }); await app.controller.syncNow();
  assert.match(b.node('sync-facts').textContent, /请求过多，\d{2}:\d{2}后重试/); assert.doesNotMatch(b.node('sync-facts').textContent, /出错/); assert.equal(b.node('sync-error').hidden, true);
  assert.match(b.node('sync-full').textContent, /请求过多，.*后自动重试/);
});

test('DOM 模拟：换仓库必须选处理方式，放弃本机还要再次确认并列出未上传内容', async t => {
  const { setup } = await import('./helpers.js'); const { githubDouble } = await import('./github-double.js'); const { TaskActions } = await import('../../app/task-actions.js');
  const h = await setup(); await h.p.c.join(); const initial = await h.p.store.read(); await h.p.c.dispose();
  const bridge = githubDouble(h.memory), b = browserDouble(initial); b.globals.fetch = bridge.fetch; globalsFor(t, b.globals);
  const app = await start(); await until(() => !b.node('owner').disabled && !app.controller.snapshot().busy); t.after(() => { app.disposeApp(); h.computer.engine.dispose(); });
  await new TaskActions(app.dataSource).patch('t', { notes: '还没上传的虚构内容' });
  const oldId = b.record().settings.deviceId;
  b.node('repo').value = 'different'; b.node('settings-form').emit('submit'); await until(() => b.node('repository-dialog').open);
  assert.equal(b.record().settings.repo, 'repo'); b.node('repository-replace').emit('click'); await until(() => b.node('discard-dialog').open);
  assert.match(b.node('discard-explanation').textContent, /尚未上传的修改/); assert.match(b.node('discard-explanation').textContent, /任务、复盘、习惯、番茄记录/);
  b.node('discard-cancel').emit('click'); await until(() => !b.node('save-settings').disabled); assert.equal(b.record().settings.repo, 'repo'); assert.equal(b.record().settings.deviceId, oldId);
  b.node('settings-form').emit('submit'); await until(() => b.node('repository-dialog').open); b.node('repository-replace').emit('click'); await until(() => b.node('discard-dialog').open);
  b.node('discard-confirm').emit('click'); await until(() => !b.node('save-settings').disabled);
  assert.equal(b.record().settings.repo, 'different'); assert.notEqual(b.record().settings.deviceId, oldId); assert.equal(app.controller.snapshot().joined, true);
  assert.notEqual(app.dataSource.snapshot().planner.tasks[0].notes, '还没上传的虚构内容');
});

test('DOM 模拟：已打开正式页面后改成#demo或#sim，先flush并重载，绝不继续复用正式来源', async t => {
  const b = browserDouble(); globalsFor(t, b.globals); const app = await start(); await until(() => !b.node('owner').disabled); t.after(() => app.disposeApp());
  const originalId = b.record().settings.deviceId;
  b.location.hash = '#demo'; b.window.emit('hashchange'); await until(() => b.location.reloaded === 1);
  assert.equal(b.record().settings.deviceId, originalId); assert.equal(b.record().state, null); assert.equal(b.requests.length, 0);
});

test('T28 DOM 模拟：未读内容先占位，进入复盘加载失败保留任务页，可重试挂载', async t => {
  const { setup } = await import('./helpers.js'); const { StoreError } = await import('../../app/store.js');
  const h = await setup(); await h.p.c.join(); const initial = await h.p.store.read(); await h.p.c.dispose(); h.computer.engine.dispose();
  const b = browserDouble(initial); b.navigator.onLine = false;
  let idle; b.window.requestIdleCallback = fn => { idle = fn; }; globalsFor(t, b.globals);
  const app = await start(); t.after(() => app.disposeApp()); await until(() => !b.node('owner').disabled && !app.controller.snapshot().busy);
  assert.equal(typeof idle, 'function'); assert.equal(app.dataSource.snapshot().loading.reviews, true);
  assert.equal(b.node('task-loading').hidden, false); assert.match(b.node('review-root').textContent, /正在载入/);
  const load = app.dataSource.ensureLoaded.bind(app.dataSource); app.dataSource.ensureLoaded = async () => { throw new StoreError(); };
  assert.equal(await app.changePage('review'), false); assert.equal(b.node('page-tasks').hidden, false); assert.equal(b.node('page-review').hidden, true);
  assert.match(b.node('task-loading').textContent, /尚未载入/); assert.match(b.node('offline-ready').textContent, /尚未切页/);
  app.dataSource.ensureLoaded = load; assert.equal(await app.changePage('review'), true);
  assert.equal(app.dataSource.snapshot().loading.reviews, false); assert.equal(b.node('page-review').hidden, false);
  assert.ok(b.globals.document.getElementById('review-title')); assert.equal(b.requests.length, 0);
});
