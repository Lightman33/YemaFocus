import test from 'node:test';
import assert from 'node:assert/strict';
import { freshRecord } from '../../app/store.js';

import { browserDouble, globalsFor, until, start } from './browser-double.js';

test('DOM 模拟：首次进设置、保存、刷新重载、页面切换/返回、离线和清除确认', async t => {
  const app = browserDouble();
  globalsFor(t, app.globals);
  await start();
  await until(() => !app.node('owner').disabled);
  assert.equal(app.location.hash, '#settings');
  assert.equal(app.node('setup-guide').hidden, false);
  assert.equal(app.requests.length, 0, '启动不得自动连接 GitHub');
  assert.match(app.node('device-id').textContent, /^phone-[a-f0-9]{32}$/);
  app.node('owner').value = 'fictional-owner';
  app.node('repo').value = 'fictional-data';
  app.node('token').value = 'fake-test-token';
  app.node('device-name').value = '虚构手机';
  app.node('settings-form').emit('input');
  app.node('settings-form').emit('submit');
  await until(() => /设置已保存/.test(app.node('save-result').textContent));
  assert.equal(app.record().settings.deviceName, '虚构手机');
  assert.equal(app.record().token, 'fake-test-token');
  app.node('toggle-token').emit('click');
  assert.equal(app.node('token').type, 'text');
  app.globals.document.hidden = true;
  app.globals.document.emit('visibilitychange');
  assert.equal(app.node('token').type, 'password');
  app.node('main').scrollTop = 220;
  app.location.hash = '#tasks'; app.window.emit('hashchange'); await until(() => !app.node('page-tasks').hidden);
  assert.equal(app.node('page-tasks').hidden, false);
  app.node('main').scrollTop = 40;
  app.location.hash = '#review'; app.window.emit('hashchange'); await until(() => !app.node('page-review').hidden);
  app.location.hash = '#settings'; app.window.emit('hashchange'); await until(() => !app.node('page-settings').hidden);
  assert.equal(app.node('main').scrollTop, 220);
  app.navigator.onLine = false; app.window.emit('offline');
  assert.equal(app.node('network-status').textContent, '离线');
  app.skip.emit('click');
  assert.equal(app.node('main').focused, true);
  assert.equal(app.location.hash, '#settings');

  // 重新加载应用实例，用同一份虚构持久化结果；不是浏览器刷新实测。
  const refreshed = browserDouble(app.record());
  for (const [key, value] of Object.entries(refreshed.globals)) globalThis[key] = value;
  await start();
  await until(() => !refreshed.node('owner').disabled);
  assert.equal(refreshed.node('token').value, 'fake-test-token');
  assert.equal(refreshed.node('device-id').textContent, app.record().settings.deviceId);
  refreshed.node('clear-data').emit('click');
  assert.equal(refreshed.node('clear-dialog').open, true);
  assert.equal(refreshed.record().token, 'fake-test-token');
  refreshed.node('cancel-clear').emit('click');
  assert.equal(refreshed.node('clear-dialog').open, false);
  refreshed.node('clear-data').emit('click');
  refreshed.node('confirm-clear').emit('click');
  await until(() => refreshed.location.reloaded === 1);
  assert.equal(refreshed.record().state, null); assert.equal(refreshed.record().token, ''); assert.notEqual(refreshed.record().settings.deviceId, app.record().settings.deviceId);
  assert.equal(refreshed.requests.length, 0);
});

test('DOM 模拟：主动测试只读；空仓库不能加入，错误可点开', async t => {
  const app = browserDouble({ ...freshRecord(), settings: { owner: 'fictional', repo: 'data', deviceName: '虚构手机', deviceId: 'fictional-device' }, token: 'fake-test-token' });
  globalsFor(t, app.globals);
  await start();
  await until(() => !app.node('test-connection').disabled);
  app.node('test-connection').emit('click');
  await until(() => /连接成功/.test(app.node('connection-result').textContent));
  app.node('sync-now').emit('click');
  await until(() => /请先在电脑上开启同步并发布一次/.test(app.node('connection-result').textContent));
  assert.match(app.node('sync-facts').textContent, /未加入/);
  assert.ok(app.requests.every(request => request.options.method === 'GET'));
  app.setStatus(401);
  app.node('test-connection').emit('click');
  await until(() => !app.node('sync-error').hidden);
  assert.match(app.node('connection-result').textContent, /令牌无效/);
  app.node('sync-error').emit('click');
  assert.equal(app.node('error-dialog').open, true);
  assert.equal(app.node('error-title').textContent, '同步出错原因');
  assert.ok(!app.node('error-detail').textContent.includes('fake-test-token'));
  app.node('close-error').emit('click');
  assert.equal(app.node('error-dialog').open, false);
});

test('DOM 模拟：IndexedDB 不可用时禁用保存并明确告知，绝不伪存', async t => {
  const app = browserDouble(freshRecord(), { noStorage: true });
  globalsFor(t, app.globals);
  await start();
  await until(() => !app.node('storage-error').hidden);
  assert.match(app.node('storage-error').textContent, /这个浏览器模式下无法保存数据/);
  assert.equal(app.node('save-settings').disabled, true);
  assert.equal(app.node('clear-data').disabled, true);
  assert.equal(app.requests.length, 0);
});

test('DOM 模拟：新版本提示等待点击，更新前要求先保存设置', async t => {
  const app = browserDouble(freshRecord(), { serviceWorker: true });
  globalsFor(t, app.globals);
  await start();
  await until(() => !app.node('owner').disabled && !app.node('update-app').hidden);
  app.node('settings-form').emit('input');
  app.node('update-app').emit('click');
  assert.match(app.node('save-result').textContent, /先保存/);
  assert.equal(app.messages.length, 0);
  app.node('owner').value = 'fictional'; app.node('repo').value = 'data'; app.node('token').value = 'fake-test-token';
  app.node('settings-form').emit('submit');
  await until(() => /已保存/.test(app.node('save-result').textContent));
  app.node('update-app').emit('click');
  await until(() => app.messages.length === 1);
  assert.deepEqual(app.messages, [{ type: 'ACTIVATE_UPDATE' }]);
  app.navigator.serviceWorker.emit('controllerchange');
  assert.equal(app.location.reloaded, 1);
});

test('DOM 模拟：#demo 使用独立库、显示虚构数据，导航保持示例模式且禁止连接仓库', async t => {
  const app = browserDouble(freshRecord(), { hash: '#demo' }); globalsFor(t, app.globals);
  await start(); await until(() => !app.node('task-quick').disabled);
  assert.deepEqual(app.openedNames, ['yema-mobile-v29-demo']);
  assert.equal(app.node('demo-badge').hidden, false); assert.equal(app.node('page-tasks').hidden, false);
  assert.ok(parseInt(app.node('task-count').textContent, 10) >= 40); assert.equal(app.requests.length, 0);
  assert.equal(app.tabs[0].getAttribute('href'), '#demo/tasks');
  app.location.hash = '#demo/settings'; app.window.emit('hashchange'); await until(() => !app.node('page-settings').hidden); assert.equal(app.node('page-settings').hidden, false);
  app.node('test-connection').emit('click'); await until(() => /示例模式/.test(app.node('connection-result').textContent));
  assert.equal(app.requests.length, 0);
  app.location.hash = '#demo/tasks'; app.window.emit('hashchange'); await until(() => !app.node('page-tasks').hidden); assert.equal(app.node('page-tasks').hidden, false);
});
