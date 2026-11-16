import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, config } from './helpers.js';
import { TaskActions } from '../../app/task-actions.js';
import { ReviewActions } from '../../app/review-actions.js';
import { Period, ReviewText } from '../../app/review-model.js';
import { canonical, unitKey } from '../../sync/canonical.js';
import { TransportError } from '../../transport/transport.js';
import { createManifest, devicePath, deviceText } from '../../sync/pack.js';
const period = Period.of('day', '2026-11-13');
const encode = text => Uint8Array.from(text, c => c.charCodeAt(0));
const patch = (p, fields, now) => new TaskActions(p.source, { now }).patch('t', fields);

test('默认关闭：保存、切前后台、网络事件、立即同步均不创建传输或调用；测试连接必须主动', async t => {
  const h = await setup({ empty: true }), { p } = h; t.after(() => p.c.dispose());
  await p.c.saveConfiguration(config());
  await p.c.foreground(); await p.c.networkChanged(); await p.c.syncNow();
  p.visible(false); await p.c.foreground(); p.visible(true);
  assert.equal(p.made(), 0); assert.equal(h.calls.length, 0);
  await assert.rejects(patch(p, { title: '拒绝修改' }, h.clock.now), /第一次同步/);
  assert.equal((await p.c.testConnection()).ok, true); assert.equal(p.made(), 1);
});
test('空仓库保持未加入，明确提示先电脑发布', async t => {
  const { p } = await setup({ empty: true }); t.after(() => p.c.dispose());
  assert.equal((await p.c.join()).joined, false); assert.match(p.c.snapshot().message, /请先在电脑上开启同步并发布一次/);
  assert.notEqual((await p.store.read()).settings.joined, true);
});
test('中途下载断网不留半份数据；重试完整加入任务与复盘', async t => {
  const h = await setup(), { p } = h; t.after(() => { p.c.dispose(); h.computer.engine.dispose(); });
  h.memory.injectFault({ type: 'offline', operation: 'get' });
  assert.equal((await p.c.join()).ok, false);
  assert.notEqual((await p.store.read()).settings.joined, true); assert.equal((p.source.snapshot().planner.tasks || []).length, 0);
  assert.equal((await p.c.join()).joined, true);
  assert.equal(p.source.snapshot().joined, true); assert.equal(p.source.snapshot().planner.tasks[0].title, '电脑上的虚构任务');
  assert.equal(p.source.snapshot().planner.reviews[0].title, '电脑上的虚构复盘');
});
test('手机改任务和复盘先存本机，60秒合并发布，电脑读取相同结果；并发触发只一轮', async t => {
  const h = await setup(), { p } = h; t.after(() => { p.c.dispose(); h.computer.engine.dispose(); }); await p.c.join();
  const before = h.writes().length;
  await patch(p, { notes: '手机虚构备注' }, h.clock.now);
  await new ReviewActions(p.source, { now: h.clock.now }).save(period, { modules: [['今日完成', '手机虚构复盘']] });
  assert.equal(h.writes().length, before); assert.ok(p.c.snapshot().pending > 0);
  await h.clock.tick(59999); assert.equal(h.writes().length, before);
  await h.clock.tick(1); assert.equal(p.c.snapshot().pending, 0);
  await h.computer.engine.syncNow();
  await h.computerSource.refresh(); const remote = h.computerSource.snapshot().planner;
  assert.equal(remote.tasks[0].notes, '手机虚构备注'); assert.match(remote.reviews[0].content, /手机虚构复盘/);
  const count = h.calls.length; await Promise.all([p.c.foreground(), p.c.foreground(), p.c.syncNow()]);
  assert.equal(h.calls.length - count, 5, '只运行一轮：登记目录和两台设备的清单');
});
test('后台定时不发请求，恢复前台读取电脑修改；断网仍可存盘并在恢复后补发', async t => {
  const h = await setup(), { p } = h; t.after(() => { p.c.dispose(); h.computer.engine.dispose(); }); await p.c.join();
  await patch(p, { notes: '离线之前的输入' }, h.clock.now); p.visible(false);
  const calls = h.calls.length; await h.clock.tick(60000); assert.equal(h.calls.length, calls);
  p.online(false); p.visible(true); await p.c.networkChanged();
  await patch(p, { notes: '断网照常记录' }, h.clock.now); assert.equal(p.c.snapshot().offline, true);
  assert.equal(p.source.snapshot().planner.tasks[0].notes, '断网照常记录');
  p.online(true); await p.c.networkChanged(); assert.equal(p.c.snapshot().pending, 0);
  await h.computer.engine.syncNow(); await h.computerSource.refresh();
  assert.equal(h.computerSource.snapshot().planner.tasks[0].notes, '断网照常记录');
  h.clock.advance(); await h.computerSource.change('电脑改复盘', x => { x.reviews[0].title = '电脑更新总结'; }); await h.computer.engine.syncNow();
  p.visible(false); const count = h.calls.length; await p.c.foreground(); assert.equal(h.calls.length, count);
  p.visible(true); await p.c.foreground(); assert.equal(p.source.snapshot().planner.reviews[0].title, '电脑更新总结');
});
test('停机错误持续显示，仍可编辑存盘；前台/网络事件不重试，手动重试后补发并消失', async t => {
  const h = await setup(), { p } = h; t.after(() => { p.c.dispose(); h.computer.engine.dispose(); }); await p.c.join(); h.clock.advance();
  const original = h.transport.list; let fail = true;
  h.transport.list = (...args) => { if (fail) throw new TransportError('directory_limit', '目录超限，已停止同步'); return original(...args); };
  await p.c.syncNow(); assert.equal(p.c.snapshot().error.code, 'directory_limit');
  await patch(p, { notes: '停机期间存本机' }, h.clock.now);
  fail = false; const calls = h.calls.length; await p.c.foreground(); await p.c.networkChanged(); await h.clock.tick(60000);
  assert.equal(h.calls.length, calls); assert.match(p.c.snapshot().error.message, /目录超限/);
  assert.equal((await p.c.syncNow()).ok, true); assert.equal(p.c.snapshot().error, null); assert.equal(p.c.snapshot().pending, 0);
});
test('限流是等待状态，按retryAt自动重试；坏清单details显示并在完整轮清除', async t => {
  const h = await setup(), { p } = h; t.after(() => { p.c.dispose(); h.computer.engine.dispose(); }); await p.c.join();
  const retryAt = h.clock.now() + 90000; h.memory.injectFault({ type: 'ratelimit', operation: 'list', retryAt }); await p.c.syncNow();
  assert.equal(p.c.snapshot().error, null); assert.equal(p.c.snapshot().retryAt, retryAt);
  const count = h.calls.length; await h.clock.tick(89999); assert.equal(h.calls.length, count); await h.clock.tick(1); assert.equal(p.c.snapshot().retryAt, null);
  const bad = await createManifest('damaged-computer', 1, { 'tasks-00': '1'.repeat(64) }, {});
  await h.memory.put(devicePath('damaged-computer'), encode(deviceText('damaged-computer'))); await h.memory.put(bad.path, encode(bad.text));
  await p.c.syncNow(); assert.equal(p.c.snapshot().details[0].device, 'damaged-computer'); const since = p.c.snapshot().details[0].since;
  await p.c.syncNow(); assert.equal(p.c.snapshot().details[0].since, since);
  await h.memory.remove(bad.path); await p.c.syncNow(); assert.deepEqual(p.c.snapshot().details, []);
});
test('设置有joined但状态丢失/损坏均换新设备号并回到未加入，不请求仓库', async t => {
  const h = await setup({ empty: true }); t.after(() => h.p.c.dispose());
  for (const state of [null, { format: 'yema-engine-local', joined: true, invalid: true }]) {
    const initial = { state, settings: { ...config().settings, joined: true, deviceId: 'lost-identity' }, pendingSnapshots: [], token: 'fictional-token' };
    const p = await h.phone(initial); t.after(() => p.c.dispose());
    assert.notEqual(p.c.snapshot().deviceId, 'lost-identity'); assert.equal(p.c.snapshot().joined, false); assert.match(p.c.snapshot().message, /重新.*从电脑加入/);
    assert.equal(h.calls.length, 0);
  }
});
test('换仓库需明确两种选择及二次清除确认；换令牌和大小写不换身份，搬家完整发布', async t => {
  const h = await setup(), { p } = h; t.after(() => { p.c.dispose(); h.computer.engine.dispose(); }); await p.c.join();
  const id = p.c.snapshot().deviceId;
  await p.c.saveConfiguration({ ...config(), settings: { ...config().settings, owner: 'FICTION', repo: 'REPO' } }); assert.equal(p.c.snapshot().deviceId, id);
  await p.c.saveConfiguration(config('repo', 'another-fictional-token')); assert.equal(p.c.snapshot().deviceId, id);
  await patch(p, { notes: '尚未上传的虚构备注' }, h.clock.now);
  const original = canonical(await p.store.read());
  assert.equal((await p.c.saveConfiguration(config('new-repo'))).needsChoice, true);
  assert.equal((await p.c.saveConfiguration(config('new-repo'), { choice: 'replace' })).needsDiscard, true);
  assert.equal(canonical(await p.store.read()), original, '确认之前不写配置不清数据');
  const moved = await p.c.saveConfiguration(config('new-repo'), { choice: 'move' });
  assert.equal(moved.moved, true); assert.notEqual(p.c.snapshot().deviceId, id); assert.equal(p.source.snapshot().planner.tasks[0].notes, '尚未上传的虚构备注');
  const local = (await p.store.read()).state; assert.equal(local.repositoryId, 'fiction/new-repo'); assert.equal(local.published, null); assert.deepEqual(local.merged, {});
  await p.c.syncNow(); assert.ok((await p.store.read()).state.published);
  await p.c.saveConfiguration(config('different'), { choice: 'replace', confirmDiscard: true });
  assert.equal(p.c.snapshot().joined, false); assert.equal((await p.store.read()).state, null); assert.equal((p.source.snapshot().planner.tasks || []).length, 0);
});
test('清除本机数据销毁引擎、换设备号，旧定时器不再访问仓库', async t => {
  const h = await setup(), { p } = h; t.after(() => { p.c.dispose(); h.computer.engine.dispose(); }); await p.c.join();
  const id = p.c.snapshot().deviceId; await patch(p, { notes: '待清除' }, h.clock.now); await p.c.clear();
  assert.equal(p.c.snapshot().joined, false); assert.notEqual(p.c.snapshot().deviceId, id); assert.equal((await p.store.read()).token, '');
  const calls = h.calls.length; await h.clock.tick(60000); assert.equal(h.calls.length, calls);
});

test('已打开页面的本机状态突然消失，下一轮先换身份并禁用编辑，不沿旧号请求', async t => {
  const h = await setup(), { p } = h; await p.c.join(); t.after(() => { p.c.dispose(); h.computer.engine.dispose(); });
  const id = p.c.snapshot().deviceId, calls = h.calls.length;
  await p.store.update(r => { r.state = null; r.pendingSnapshots = []; });
  const result = await p.c.foreground(); assert.equal(result.code, 'local-reset');
  assert.equal(p.c.snapshot().joined, false); assert.notEqual(p.c.snapshot().deviceId, id); assert.equal(h.calls.length, calls);
  await assert.rejects(patch(p, { notes: '不能继续旧号' }, h.clock.now), /第一次同步/);
});
test('加入已完整落盘但上传中断时，界面仍不解锁；沿同一计划重试成功', async t => {
  const h = await setup(), { p } = h; t.after(() => { p.c.dispose(); h.computer.engine.dispose(); });
  h.memory.injectFault({ type: 'partial', operation: 'put', committed: true });
  const failed = await p.c.join(); assert.equal(failed.ok, false); assert.equal(p.c.snapshot().joined, false);
  assert.equal(p.source.snapshot().joined, false); assert.equal((await p.store.read()).state.joined, true);
  const success = await p.c.join(); assert.equal(success.ok, true); assert.equal(p.source.snapshot().joined, true);
});

test('搬到全空的新仓库时不复用旧确认：全部块真实上传，另一台从新仓库加入内容一致', async t => {
  const { MemoryTransport } = await import('../../transport/memory.js'); const { SyncState } = await import('../../app/syncstate.js');
  const { createEngine } = await import('../../sync/engine.js'); const { createSyncController } = await import('../../app/sync-controller.js');
  const { createDataSource } = await import('../../app/datasource.js'); const { MemoryStore, freshRecord } = await import('../../app/store.js');
  const h = await setup(), { p } = h; await p.c.join(); await patch(p, { notes: '搬家带走的未上传内容' }, h.clock.now); await p.c.dispose();
  const destination = new MemoryTransport({ now: h.clock.now }); let id = 0;
  const c = createSyncController({ store: p.store, syncState: new SyncState(), makeTransport: cfg => cfg.repo === 'destination' ? destination : h.transport,
    makeEngine: createEngine, now: h.clock.now, timers: h.clock.timers, newDeviceId: () => 'moved-' + (++id), isVisible: () => true, isOnline: () => true, dataSource: p.source });
  await c.init(); t.after(() => { c.dispose(); h.computer.engine.dispose(); });
  await c.saveConfiguration(config('destination'), { choice: 'move' }); assert.equal((await c.syncNow()).ok, true);
  const store = new MemoryStore({ ...freshRecord(), ...config('destination'), settings: { ...config('destination').settings, deviceId: 'new-reader' } });
  const other = createSyncController({ store, syncState: new SyncState(), makeTransport: () => destination, makeEngine: createEngine, now: h.clock.now, timers: h.clock.timers, newDeviceId: () => 'reader-new', isVisible: () => true, isOnline: () => true });
  await other.init(); const source = await createDataSource({ store, now: h.clock.now }); other.setDataSource(source); t.after(() => other.dispose());
  assert.equal((await other.join()).joined, true); assert.equal(source.snapshot().planner.tasks[0].notes, '搬家带走的未上传内容');
  assert.equal(canonical(source.snapshot().planner), canonical(p.source.snapshot().planner));
});

test('长上传期间继续编辑且定时到点，完成后仍安排下一批自动发布', async t => {
  const h = await setup(), { p } = h; await p.c.join(); t.after(() => { p.c.dispose(); h.computer.engine.dispose(); });
  h.clock.advance(); await patch(p, { notes: '第一批冻结内容' }, h.clock.now);
  const original = h.transport.put; let release, entered;
  const paused = new Promise(resolve => { entered = resolve; }); let first = true;
  h.transport.put = async (...args) => {
    if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return original(...args);
  };
  const round = p.c.syncNow(); await paused;
  await patch(p, { notes: '上传中继续输入的第二批' }, h.clock.now);
  const elapsed = h.clock.tick(60000); await Promise.resolve(); release(); await Promise.all([elapsed, round]);
  assert.ok(p.c.snapshot().pending > 0); await h.clock.tick(60000); assert.equal(p.c.snapshot().pending, 0);
  await h.computer.engine.syncNow(); await h.computerSource.refresh(); assert.equal(h.computerSource.snapshot().planner.tasks[0].notes, '上传中继续输入的第二批');
});

test('未加入记录自身损坏也先换号恢复；零创建传输层、零网络调用', async t => {
  const h = await setup({ empty: true }); t.after(() => h.p.c.dispose());
  const p = await h.phone({ state: { format: 'yema-engine-local', state: { broken: true } }, settings: { ...config().settings, deviceId: 'broken-before-join' }, token: 'fictional-token', pendingSnapshots: [] });
  t.after(() => p.c.dispose()); assert.equal(p.c.snapshot().joined, false); assert.notEqual(p.c.snapshot().deviceId, 'broken-before-join'); assert.equal(p.made(), 0); assert.equal(h.calls.length, 0);
});
test('正式加入先核对私有仓库，公开仓库拒绝加入且不读取或上传协议文件', async t => {
  const h = await setup({ empty: true }), { p } = h; t.after(() => p.c.dispose());
  h.transport.test = async () => ({ ok: false, code: 'public_repo', message: '同步数据需要私有仓库' });
  assert.equal((await p.c.join()).code, 'public_repo'); assert.equal(p.c.snapshot().joined, false); assert.equal(h.calls.length, 0);
});

test('T28 整个控制器无变化同步只动小元数据，来源复用业务投影，零业务桶读写', async () => {
  const h = await setup(); await h.p.c.join();
  await h.p.c.syncNow(); // 建好确认与缓存，再检查真正的无变化一轮。
  const planner = h.p.source.cache.planner, state = h.p.source.record.state;
  h.p.store.resetStats(); h.clock.advance(); const result = await h.p.c.syncNow();
  assert.equal(result.ok, true); assert.equal(h.p.store.stats.bucketReads + h.p.store.stats.bucketWrites, 0);
  assert.equal(h.p.source.record.state, state); assert.equal(h.p.source.cache.planner, planner);
  await h.p.c.dispose(); h.computer.engine.dispose();
});
