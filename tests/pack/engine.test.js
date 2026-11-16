import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, clone, unitKey as K } from '../../sync/canonical.js';
import { emptyState, unitInfo } from '../../sync/merge.js';
import { createUnit, updateUnit, deleteUnit } from '../../sync/edit.js';
import * as pack from '../../sync/pack.js';
import { createEngine } from '../../sync/engine.js';
import { harness, record } from './helpers.js';

const T = K('task-content', 't1'), U = K('task-content', 't2');
function seed() {
  let state = createUnit(emptyState(), T, 'a', { title: '虚构任务甲' });
  return createUnit(state, U, 'a', { title: '虚构任务乙' });
}
const edit = (d, key, text) => updateUnit(d.engine.getState(), key, d.id, { title: text });
const state = d => canonical(d.engine.getState());
const value = (d, key = T) => unitInfo(d.engine.getState().units[key]).preferred.value;
async function pair() {
  const h = harness(), a = await h.device('a', seed());
  assert.equal((await a.engine.syncNow()).ok, true);
  const b = await h.device('b'); assert.equal((await b.engine.join()).joined, true);
  return { ...h, a, b };
}
async function manifestEntries(h, id) { return h.memory.list(pack.ROOT + '/manifests/' + id); }
const encode = text => Uint8Array.from(text, c => c.charCodeAt(0));
async function install(h, device, sequence, content, seen = {}) {
  const chunks = await Promise.all(Object.values(pack.splitState(content)).map(pack.createChunk));
  for (const a of chunks) await h.memory.put(a.path, encode(a.text));
  const m = await pack.createManifest(device, sequence, Object.fromEntries(chunks.map(a => [a.chunk.bucket, a.hash])), seen);
  await h.memory.put(pack.devicePath(device), encode(pack.deviceText(device)));
  await h.memory.put(m.path, encode(m.text));
  return { m, chunks };
}

test('空仓库不加入；未加载/未加入不能编辑；独立副本不改引擎', async () => {
  const h = harness(), b = await h.device('b');
  assert.equal(b.engine.isJoined(), false);
  const result = await b.engine.join();
  assert.equal(result.joined, false); assert.match(result.message, /电脑/);
  await assert.rejects(b.engine.commit(seed()), /第一次同步/);
  const copy = b.engine.getState(); copy.units.evil = true;
  assert.deepEqual(b.engine.getState(), emptyState());
  assert.equal(h.writes().length, 0);
  const invalid = record('x', seed()); invalid.state.joined = false;
  await assert.rejects(h.device('x', null, invalid), /手机旧库/);
});
test('甲发布、乙加入、乙改甲得到；状态确认只认对方seen', async () => {
  const h = await pair();
  assert.equal(state(h.a), state(h.b));
  assert.equal(h.a.syncState.snapshot().peerMerged, false);
  await h.a.engine.syncNow();
  assert.equal(h.a.syncState.snapshot().peerMerged, true);
  h.clock.advance();
  await h.b.engine.commit(edit(h.b, T, '乙修改虚构标题'));
  const revision = h.b.syncState.snapshot().localRevision;
  assert.equal(h.b.syncState.snapshot().uploaded, false);
  assert.equal((await h.b.engine.syncNow()).ok, true);
  assert.equal(h.b.syncState.snapshot().uploadedRevision, revision);
  assert.equal((await h.a.engine.syncNow()).ok, true);
  assert.equal(state(h.a), state(h.b));
  assert.equal(value(h.a).title, '乙修改虚构标题');
  await h.b.engine.syncNow();
  assert.equal(h.b.syncState.snapshot().peerMerged, true);
});
test('无变化不写、不为seen相互追逐；哈希相同块共用且不重复上传', async () => {
  const h = await pair();
  const chunkWrites = h.calls.filter(c => c.method === 'put' && c.path.includes('/chunks/'));
  assert.equal(chunkWrites.length, 2); // 乙同内容直接复用甲的两个桶。
  h.clock.advance(); await h.a.engine.syncNow();
  const before = h.writes().length;
  for (let i = 0; i < 10; i++) { await h.b.engine.syncNow(); await h.a.engine.syncNow(); }
  assert.equal(h.writes().length, before);
});
test('两边同时改不同任务保留；同一单元冲突在三台设备完全一致', async () => {
  const h = await pair(); h.clock.advance();
  await h.a.engine.commit(edit(h.a, T, '甲分开改'));
  await h.b.engine.commit(edit(h.b, U, '乙分开改'));
  await h.a.engine.syncNow(); await h.b.engine.syncNow(); h.clock.advance(); await h.a.engine.syncNow();
  assert.equal(state(h.a), state(h.b));
  assert.equal(value(h.a, U).title, '乙分开改');
  h.clock.advance();
  const oldA = h.a.engine.getState(), oldB = h.b.engine.getState();
  await h.a.engine.commit(updateUnit(oldA, T, 'a', { title: '并发甲' }));
  await h.b.engine.commit(updateUnit(oldB, T, 'b', { title: '并发乙' }));
  await h.a.engine.syncNow(); await h.b.engine.syncNow(); h.clock.advance(); await h.a.engine.syncNow();
  const c = await h.device('c'); await c.engine.join();
  assert.equal(state(h.a), state(h.b)); assert.equal(state(h.a), state(c));
  assert.equal(unitInfo(h.a.engine.getState().units[T]).alternatives.length, 2);
  assert.equal(h.a.syncState.snapshot().conflicts, 1);
});
test('一分钟内20次commit只一次发布；最短间隔；一次改任务最多两个块', async () => {
  const h = await pair();
  let notifications = 0; h.a.engine.subscribe(() => notifications++);
  const before = h.calls.length;
  for (let i = 0; i < 20; i++) {
    await h.a.engine.commit(edit(h.a, T, '连续编辑' + i));
    await h.clock.tick(2000);
  }
  assert.equal(h.calls.slice(before).filter(c => c.method === 'put').length, 0);
  await h.clock.tick(20000);
  const written = h.calls.slice(before).filter(c => c.method === 'put');
  assert.equal(written.filter(c => c.path.includes('/manifests/')).length, 1);
  assert.ok(written.filter(c => c.path.includes('/chunks/')).length <= 2);
  assert.equal(notifications, 0);
  await h.a.engine.commit(edit(h.a, T, '又修改'));
  const count = h.writes().length;
  await h.a.engine.syncNow(); assert.equal(h.writes().length, count);
  await h.clock.tick(60000);
  assert.ok(h.writes().length > count);
});
test('旧编辑在远端到达后commit仍保留另一任务和同单元新分支；订阅独立副本', async () => {
  const h = await pair(); h.clock.advance();
  const stale = h.a.engine.getState();
  let notices = 0;
  const unsubscribe = h.a.engine.subscribe(s => { notices++; s.units = {}; });
  await h.b.engine.commit(edit(h.b, U, '远端另一任务'));
  await h.b.engine.syncNow(); await h.a.engine.syncNow();
  assert.equal(notices, 1);
  await h.a.engine.commit(updateUnit(stale, T, 'a', { title: '旧编辑' }));
  assert.equal(value(h.a, U).title, '远端另一任务');
  const old = h.a.engine.getState();
  h.clock.advance(); await h.a.engine.syncNow(); await h.b.engine.syncNow();
  h.clock.advance(); await h.b.engine.commit(edit(h.b, T, '远端同任务'));
  await h.b.engine.syncNow(); await h.a.engine.syncNow();
  await h.a.engine.commit(updateUnit(old, T, 'a', { title: '旧同单元编辑' }));
  assert.equal(unitInfo(h.a.engine.getState().units[T]).alternatives.length, 2);
  unsubscribe();
});
test('存储失败commit不变也不发布；远端合并存储失败不半存；保留设置及token', async () => {
  const h = await pair(); h.clock.advance();
  const before = state(h.a), writes = h.writes().length;
  h.a.store.failNextWrite();
  await assert.rejects(h.a.engine.commit(edit(h.a, T, '不能保存')), /本机保存失败/);
  assert.equal(state(h.a), before); assert.equal(h.writes().length, writes);
  assert.equal((await h.a.store.read()).settings.extra, '不能覆盖');
  assert.equal((await h.a.store.read()).token, 'fiction-token');
  await h.b.engine.commit(edit(h.b, T, '远端待保存')); await h.b.engine.syncNow();
  // 第一轮mutate读最新也使用事务；失败应完整退出。
  h.a.store.failNextWrite();
  const bad = await h.a.engine.syncNow(); assert.equal(bad.ok, false); assert.equal(state(h.a), before);
  assert.equal((await h.a.engine.syncNow()).ok, true);
  assert.equal(value(h.a).title, '远端待保存');
});
test('自己发布过的内容修复本机回退；新设备号持久化且不复用旧计数', async () => {
  const h = await pair(), old = await h.b.store.read(); h.clock.advance();
  await h.b.engine.commit(edit(h.b, T, '乙已发布最新')); await h.b.engine.syncNow();
  await h.b.store.write(old); h.b.engine.dispose();
  const restored = await h.device('b', null, await h.b.store.read());
  assert.equal((await restored.engine.syncNow()).ok, true);
  assert.equal(value(restored).title, '乙已发布最新');
  const saved = await restored.store.read();
  assert.ok(saved.state.sequence >= 2);
  await assert.rejects(restored.engine.resetDevice('b'), /全新/);
  await restored.engine.resetDevice('b-new');
  assert.equal(value(restored).title, '乙已发布最新');
  assert.equal((await restored.store.read()).settings.deviceId, 'b-new');
  assert.equal((await restored.engine.syncNow()).ok, true);
});
test('同因果版本不同取值：整轮不改变本机，不删除远端，无自动重试', async () => {
  const h = await pair(); h.clock.advance();
  const broken = clone(h.a.engine.getState());
  broken.units[T].versions[0].value.title = '损坏但同版本';
  await install(h, 'evil', 1, broken);
  const before = state(h.a), writes = h.writes().length;
  const result = await h.a.engine.syncNow();
  assert.equal(result.ok, false); assert.match(result.message, /同一因果版本/);
  assert.equal(state(h.a), before); assert.equal(h.writes().length, writes);
  assert.match(h.a.syncState.snapshot().error.message, /同一因果版本/);
  const requests = h.calls.length; await h.clock.tick(6000000);
  assert.equal(h.calls.length, requests);
});

for (const fault of [
  { type: 'offline', operation: 'list' }, { type: 'timeout', operation: 'get' },
  { type: 'partial', operation: 'put', committed: false }, { type: 'partial', operation: 'put', committed: true },
  { type: 'ratelimit', operation: 'put' }, { type: 'corrupt', operation: 'get' }
]) test('故障恢复不丢本机且最终一致：' + JSON.stringify(fault), async () => {
  const h = await pair(); h.clock.advance();
  await h.b.engine.commit(edit(h.b, T, '断线前已存本机'));
  const before = state(h.b);
  h.memory.injectFault({ ...fault, retryAt: h.clock.now() + 90000 });
  const failed = await h.b.engine.syncNow();
  assert.equal(failed.ok, fault.type === 'corrupt');
  if (fault.type === 'corrupt') assert.ok(failed.warning);
  assert.equal(state(h.b), before);
  if (fault.type === 'ratelimit') {
    const count = h.calls.length;
    await h.b.engine.syncNow(); await h.clock.tick(89999);
    assert.equal(h.calls.length, count);
    await h.clock.tick(1);
  } else h.clock.advance(90001);
  assert.equal((await h.b.engine.syncNow()).ok, true);
  h.clock.advance(); await h.a.engine.syncNow();
  assert.equal(state(h.a), state(h.b));
  if (fault.type === 'partial') {
    const puts = h.calls.filter(c => c.method === 'put' && c.path.includes('/chunks/'));
    const repeated = puts.map(c => c.path);
    assert.ok(new Set(repeated).size < repeated.length);
  }
});

test('清单缺块回退上一份；无回退则不加入；恢复后读回，不把缺块当删除', async () => {
  const h = await pair(); h.clock.advance();
  const next = updateUnit(h.a.engine.getState(), T, 'a', { title: '最新缺块的标题' });
  const { m, chunks } = await install(h, 'a', 2, next);
  const changed = chunks.find(a => a.chunk.bucket === pack.bucketOf(T));
  await h.memory.remove(changed.path);
  const before = state(h.b), writes = h.writes().length;
  const r = await h.b.engine.syncNow();
  assert.equal(r.ok, true); assert.match(r.warning, /缺失/);
  assert.equal(state(h.b), before); assert.equal(h.writes().length, writes);
  await h.memory.put(changed.path, encode(changed.text));
  assert.equal((await h.b.engine.syncNow()).ok, true);
  assert.equal(value(h.b).title, '最新缺块的标题');
  const h2 = harness();
  await h2.memory.put(pack.devicePath('a'), encode(pack.deviceText('a')));
  await h2.memory.put(m.path, encode(m.text));
  const c = await h2.device('c');
  assert.equal((await c.engine.join()).ok, true); assert.equal(c.engine.isJoined(), false);
  assert.deepEqual(c.engine.getState(), emptyState());
});
test('清单哈希/块哈希损坏均回退，下一轮恢复读最新', async () => {
  for (const target of ['manifest', 'chunk']) {
    const h = await pair(); h.clock.advance();
    const next = updateUnit(h.a.engine.getState(), T, 'a', { title: '最新完整标题' });
    const { m, chunks } = await install(h, 'a', 2, next);
    const artifact = target === 'manifest' ? m : chunks.find(c => c.chunk.bucket === pack.bucketOf(T));
    const original = h.transport.get;
    let injected = false;
    h.transport.get = async path => {
      if (!injected && path === artifact.path) { injected = true; h.memory.injectFault({ type: 'corrupt', operation: 'get' }); }
      return original(path);
    };
    const before = state(h.b), r = await h.b.engine.syncNow();
    assert.ok(r.warning); assert.equal(state(h.b), before);
    assert.equal((await h.b.engine.syncNow()).ok, true);
    assert.equal(value(h.b).title, '最新完整标题');
  }
});
test('相同设备序号两份不同清单：不选择、不开写、不保存合并结果', async () => {
  const h = await pair();
  await install(h, 'a', 1, updateUnit(h.a.engine.getState(), T, 'a', { title: '序号误复用' }));
  const before = state(h.b), writes = h.writes().length;
  const r = await h.b.engine.syncNow();
  assert.equal(r.code, 'identity'); assert.equal(state(h.b), before); assert.equal(h.writes().length, writes);
});
test('单飞；网络期间commit不被发布确认冲掉；只上报发布对应revision', async () => {
  const h = await pair(); h.clock.advance();
  await h.a.engine.commit(edit(h.a, T, '正在上传'));
  const put = h.transport.put;
  let release, reached;
  const reachedPromise = new Promise(r => { reached = r; });
  let paused = false;
  h.transport.put = async (...args) => {
    if (!paused && args[0].includes('/chunks/')) {
      paused = true; reached(); await new Promise(r => { release = r; });
    }
    return put(...args);
  };
  const round = h.a.engine.syncNow();
  assert.equal(h.a.engine.syncNow(), round);
  await reachedPromise;
  await h.a.engine.commit(edit(h.a, U, '上传途中又编辑'));
  const latest = state(h.a); release(); assert.equal((await round).ok, true);
  assert.equal(state(h.a), latest); assert.equal(h.a.syncState.snapshot().uploaded, false);
  h.clock.advance(); await h.a.engine.syncNow(); await h.b.engine.syncNow();
  assert.equal(state(h.a), state(h.b));
});
test('100轮编辑同步：自己目录最多3清单，单轮请求有界；块不删、无碰撞', async t => {
  const h = await pair();
  let maxRequests = 0;
  for (let i = 0; i < 100; i++) {
    h.clock.advance();
    await h.a.engine.commit(edit(h.a, T, '第' + i + '轮虚构编辑'));
    const before = h.calls.length;
    assert.equal((await h.a.engine.syncNow()).ok, true);
    maxRequests = Math.max(maxRequests, h.calls.length - before);
    await h.b.engine.syncNow();
    assert.ok((await manifestEntries(h, 'a')).length <= 3);
    assert.ok((await manifestEntries(h, 'b')).length <= 3);
    assert.equal(state(h.a), state(h.b));
  }
  assert.ok(maxRequests <= 24, '单轮transport请求上限: ' + maxRequests);
  assert.ok(h.calls.length <= 5000, '100轮总请求: ' + h.calls.length);
  t.diagnostic('100轮：甲单轮transport请求最大' + maxRequests + '；两设备总transport请求' + h.calls.length + '；put/remove调用' + h.writes().length);
  assert.ok(h.calls.filter(c => c.method === 'remove').every(c => c.path.includes('/manifests/')));
});
test('达到1000项拒绝截断清单，不写不删', async () => {
  const h = await pair(), before = state(h.a), writes = h.writes().length;
  const list = h.transport.list;
  h.transport.list = async path => path === pack.ROOT + '/manifests/a' ? Array.from({ length: 1000 }, (_, i) => ({ name: 'unknown-' + i })) : list(path);
  assert.equal((await h.a.engine.syncNow()).code, 'directory_limit');
  assert.equal(state(h.a), before); assert.equal(h.writes().length, writes);
});

test('两设备同时发布完全相同的块：同路径同字节，无碰撞且不覆盖', async () => {
  const h = harness(), a = await h.device('a', seed()), b = await h.device('b', seed());
  const results = await Promise.all([a.engine.syncNow(), b.engine.syncNow()]);
  assert.ok(results.every(r => r.ok)); assert.equal(state(a), state(b));
  const puts = h.calls.filter(c => c.method === 'put' && c.path.includes('/chunks/'));
  assert.equal(new Set(puts.map(c => c.path)).size, 2);
  for (const call of puts) assert.equal((await pack.verifyChunk(call.path, String.fromCharCode(...await h.memory.get(call.path)))).ok, true);
  await a.engine.syncNow(); await b.engine.syncNow();
});

for (const committed of [false, true]) test('清单上传途中失败，刷新后沿原序号字节恢复：committed=' + committed, async () => {
  const h = await pair(); h.clock.advance();
  await h.a.engine.commit(edit(h.a, T, '刷新前已保存'));
  const put = h.transport.put;
  let failedPath;
  h.transport.put = async (path, bytes) => {
    if (!failedPath && path.includes('/manifests/')) {
      failedPath = path; h.memory.injectFault({ type: 'partial', operation: 'put', committed });
    }
    return put(path, bytes);
  };
  assert.equal((await h.a.engine.syncNow()).ok, false);
  const record = await h.a.store.read(), before = state(h.a);
  assert.equal(record.pendingSnapshots[0].manifest.path, failedPath);
  h.a.engine.dispose();
  const restarted = await h.device('a', null, record);
  assert.equal((await restarted.engine.syncNow()).ok, true);
  assert.equal(state(restarted), before);
  assert.equal((await restarted.store.read()).pendingSnapshots.length, 0);
  assert.ok((await manifestEntries(h, 'a')).some(e => failedPath.endsWith('/' + e.name)));
  h.clock.advance(); await h.b.engine.syncNow(); assert.equal(state(h.b), before);
});

test('上传后不再下载确认：后续GET超时不回滚发布确认、不新建第二序号', async () => {
  const h = await pair(); h.clock.advance();
  await h.a.engine.commit(edit(h.a, T, '确认由传输put保证'));
  const put = h.transport.put;
  let path;
  h.transport.put = async (...args) => {
    await put(...args);
    if (!path && args[0].includes('/manifests/')) {
      path = args[0]; h.memory.injectFault({ type: 'timeout', operation: 'get' });
    }
  };
  const before = h.calls.length;
  assert.equal((await h.a.engine.syncNow()).ok, true);
  const calls = h.calls.slice(before), firstPut = calls.findIndex(c => c.method === 'put');
  assert.equal(calls.slice(firstPut).some(c => c.method === 'get'), false);
  const saved = await h.a.store.read(); assert.equal(saved.pendingSnapshots.length, 0);
  const sequence = saved.state.sequence;
  assert.equal(h.a.syncState.snapshot().uploaded, true);
  assert.equal((await h.a.engine.syncNow()).ok, false);
  assert.equal((await h.a.engine.syncNow()).ok, true);
  assert.equal((await h.a.store.read()).state.sequence, sequence);
});

test('发布计划原子存储失败不上传；远端合并事务失败不装半份', async () => {
  const h = await pair(); h.clock.advance();
  await h.a.engine.commit(edit(h.a, T, '准备发布事务'));
  const update = h.a.store.writeTransaction.bind(h.a.store);
  let count = 0;
  h.a.store.writeTransaction = fn => {
    count++;
    // sync的第1次读取事务、第2次合并事务成功；第3次预留计划失败。
    if (count === 3) h.a.store.failNextWrite();
    return update(fn);
  };
  const before = state(h.a), writes = h.writes().length;
  assert.equal((await h.a.engine.syncNow()).ok, false);
  assert.equal(state(h.a), before); assert.equal(h.writes().length, writes);
  assert.equal((await h.a.store.read()).pendingSnapshots.length, 0);
  h.a.store.writeTransaction = update;
  assert.equal((await h.a.engine.syncNow()).ok, true);
  const updateB = h.b.store.writeTransaction.bind(h.b.store); count = 0;
  h.b.store.writeTransaction = fn => { if (++count === 2) h.b.store.failNextWrite(); return updateB(fn); };
  const bBefore = state(h.b);
  assert.equal((await h.b.engine.syncNow()).ok, false); assert.equal(state(h.b), bBefore);
  assert.equal(canonical((await h.b.store.read()).state.state), bBefore);
  h.b.store.writeTransaction = updateB;
  assert.equal((await h.b.engine.syncNow()).ok, true); assert.equal(state(h.b), state(h.a));
});

test('同一浏览器两实例共享原子存储：不覆盖新编辑；同计划双确认幂等', async () => {
  const h = harness(), a = await h.device('a', seed());
  const { SyncState } = await import('../../app/syncstate.js');
  const other = createEngine({ store: a.store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/repo' });
  await other.load();
  await a.engine.commit(edit(a, T, '同页面甲'));
  const bState = updateUnit(other.getState(), U, 'a', { title: '同页面乙另一任务' });
  await other.commit(bState);
  assert.equal(unitInfo(other.getState().units[T]).preferred.value.title, '同页面甲');
  const results = await Promise.all([a.engine.syncNow(), other.syncNow()]);
  assert.ok(results.every(r => r.ok));
  await a.engine.syncNow(); assert.equal(state(a), canonical(other.getState()));
});

test('清理只删自己的旧清单，出错不丢上传；下次恢复清理；保留3份完整', async () => {
  const h = await pair();
  for (let i = 0; i < 3; i++) {
    h.clock.advance(); await h.a.engine.commit(edit(h.a, T, '清理前' + i));
    if (i === 2) h.memory.injectFault({ type: 'partial', operation: 'remove', committed: false });
    await h.a.engine.syncNow();
  }
  assert.equal(h.a.syncState.snapshot().uploaded, true);
  assert.equal((await manifestEntries(h, 'a')).length, 4);
  const before = state(h.a);
  await h.a.engine.syncNow(); assert.equal(state(h.a), before);
  assert.equal((await manifestEntries(h, 'a')).length, 3);
  assert.equal((await manifestEntries(h, 'b')).length, 1);
  assert.ok(h.calls.filter(c => c.method === 'remove').every(c => c.path.includes('/manifests/a/')));
});

test('合并后的墓碑继续保留', async () => {
  const h = await pair(); h.clock.advance();
  const deleted = deleteUnit(h.a.engine.getState(), T, 'a');
  await h.a.engine.commit(deleted); await h.a.engine.syncNow(); await h.b.engine.syncNow();
  assert.equal(unitInfo(h.b.engine.getState().units[T]).preferred.deleted, true);
  assert.equal(state(h.a), state(h.b));
});

test('设备名constructor按自有键处理；不受对象原型干扰', async () => {
  const h = harness(), a = await h.device('constructor', seed());
  await a.engine.syncNow();
  const b = await h.device('b'); assert.equal((await b.engine.join()).ok, true);
  assert.equal((await b.store.read()).state.seen.constructor, 1);
  assert.equal(state(a), state(b));
});

test('只存本机还没建发布计划就关闭：load恢复定时发布', async () => {
  const h = await pair();
  await h.a.engine.commit(edit(h.a, T, '只存本机后关闭'));
  const saved = await h.a.store.read(); assert.equal(saved.pendingSnapshots.length, 0);
  h.a.engine.dispose();
  const a = await h.device('a', null, saved);
  await h.clock.tick(60000);
  assert.equal(a.syncState.snapshot().uploaded, true);
  await h.b.engine.syncNow(); assert.equal(state(a), state(h.b));
});

test('中文错误状态；缺少Web Crypto时存储/上传不被弱哈希代替', async () => {
  const h = await pair(), original = h.transport.list;
  const before = state(h.a), writes = h.writes().length;
  h.transport.list = async () => { throw new Error('Injected English error'); };
  const result = await h.a.engine.syncNow();
  assert.equal(result.ok, false); assert.match(h.a.syncState.snapshot().error.message, /同步出错/);
  assert.equal(state(h.a), before); assert.equal(h.writes().length, writes);
  h.transport.list = original;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    assert.equal((await h.a.engine.syncNow()).ok, false);
    assert.match(h.a.syncState.snapshot().error.message, /同步出错/);
    assert.equal(state(h.a), before); assert.equal(h.writes().length, writes);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});

test('新增任务跨任务桶与总索引桶，最多上传2个块', async () => {
  const h = await pair(); h.clock.advance();
  let next = h.a.engine.getState();
  for (const [key, val] of [[K('entity', 'tasks', 'new-task'), true], [K('task-content', 'new-task'), { id: 'new-task', title: '虚构新任务' }],
    [K('task-status', 'new-task'), { done: false }], [K('layout', 'tasks', 'new-task'), { steps: [] }],
    [K('planner-layout'), { arrays: { tasks: ['t1', 't2', 'new-task'] }, deleted: false }]]) {
    next = Object.hasOwn(next.units, key) ? updateUnit(next, key, 'a', val) : createUnit(next, key, 'a', val);
  }
  await h.a.engine.commit(next);
  const before = h.calls.length;
  assert.equal((await h.a.engine.syncNow()).ok, true);
  assert.equal(h.calls.slice(before).filter(c => c.method === 'put' && c.path.includes('/chunks/')).length, 2);
  await h.b.engine.syncNow(); assert.equal(state(h.a), state(h.b));
});


test('死设备的坏最新清单不阻止另外两台设备100轮发布收敛；警告去重并在补全后消失', async () => {
  for (const hasPrevious of [false, true]) {
    const h = await pair();
    if (hasPrevious) await install(h, 'dead', 1, seed());
    const next = createUnit(seed(), K('task-content', 'dead-only'), 'dead', '死设备虚构数据');
    const { chunks } = await install(h, 'dead', hasPrevious ? 2 : 1, next);
    const missing = chunks.find(c => c.chunk.bucket === pack.bucketOf(K('task-content', 'dead-only')));
    await h.memory.remove(missing.path);
    let firstWarning;
    for (let i = 0; i < 100; i++) {
      h.clock.advance();
      await h.a.engine.commit(edit(h.a, T, '虚构轮次' + i));
      const a = await h.a.engine.syncNow(), b = await h.b.engine.syncNow();
      assert.equal(a.ok, true); assert.equal(b.ok, true);
      assert.equal(state(h.a), state(h.b));
      assert.match(a.warning, /设备 dead 的清单缺失或损坏/);
      if (i === 0) firstWarning = a.warning;
      else assert.equal(a.warning, firstWarning);
      assert.equal(h.a.syncState.snapshot().error.message, firstWarning);
    }
    await h.memory.put(missing.path, encode(missing.text));
    assert.equal((await h.a.engine.syncNow()).warning, null);
    assert.equal(h.a.syncState.snapshot().error, null);
    assert.equal(unitInfo(h.a.engine.getState().units[K('task-content', 'dead-only')]).preferred.value, '死设备虚构数据');
  }
});

test('自己未确认的新清单坏时暂停发布，补全后恢复；别人坏清单被更新取代后警告消失', async () => {
  const h = await pair(); h.clock.advance();
  const next = updateUnit(h.a.engine.getState(), T, 'a', { title: '自己远端更高序号' });
  const { chunks } = await install(h, 'a', 2, next);
  const missing = chunks.find(c => c.chunk.bucket === pack.bucketOf(T));
  await h.memory.remove(missing.path);
  await h.a.engine.commit(edit(h.a, U, '本机尚未发布'));
  const before = h.writes().length;
  assert.ok((await h.a.engine.syncNow()).warning);
  assert.equal(h.writes().length, before);
  await h.memory.put(missing.path, encode(missing.text));
  assert.equal((await h.a.engine.syncNow()).warning, null);
  assert.equal(value(h.a).title, '自己远端更高序号');
  const m = await pack.createManifest('dead', 1, { settings: '0'.repeat(64) }, {});
  await h.memory.put(pack.devicePath('dead'), encode(pack.deviceText('dead')));
  await h.memory.put(m.path, encode(m.text));
  assert.ok((await h.b.engine.syncNow()).warning);
  await install(h, 'dead', 2, seed());
  assert.equal((await h.b.engine.syncNow()).warning, null);
});


test('停机后连续五次commit保留错误且均存本机，主动同步成功才清除并全部发布', async () => {
  const h = await pair(); h.clock.advance();
  const original = h.transport.list;
  h.transport.list = async () => { throw Object.assign(new Error('虚构的配置错误'), { code: 'config' }); };
  assert.equal((await h.a.engine.syncNow()).ok, false);
  const error = h.a.syncState.snapshot().error;
  const keys = [];
  for (let i = 0; i < 5; i++) {
    const key = K('task-content', 'halted-' + i); keys.push(key);
    await h.a.engine.commit(createUnit(h.a.engine.getState(), key, 'a', '停机期间虚构编辑' + i));
    assert.deepEqual(h.a.syncState.snapshot().error, error);
    assert.ok((await h.a.store.read()).state.state.units[key]);
  }
  const before = h.calls.length; await h.clock.tick(600000);
  assert.equal(h.calls.length, before);
  h.transport.list = original;
  assert.equal((await h.a.engine.syncNow()).ok, true);
  assert.equal(h.a.syncState.snapshot().error, null);
  await h.b.engine.syncNow();
  for (const key of keys) assert.ok(h.b.engine.getState().units[key]);
  assert.equal(state(h.a), state(h.b));
});


test('清理遇到conflict不停机，下一轮重看；只清理已确认发布历史，不读旧块', async () => {
  const h = await pair(), remove = h.transport.remove;
  let conflicts = 0;
  h.transport.remove = async path => {
    if (!conflicts++) throw Object.assign(new Error('另一页面先清理了'), { code: 'conflict' });
    return remove(path);
  };
  for (let i = 0; i < 4; i++) {
    h.clock.advance(); await h.a.engine.commit(edit(h.a, T, '虚构清理' + i));
    const before = h.calls.length;
    assert.equal((await h.a.engine.syncNow()).ok, true);
    // 只有当前清单需要读；清理不能再读旧清单或其引用的旧块。
    const gets = h.calls.slice(before).filter(c => c.method === 'get' && c.path.includes('/manifests/a/'));
    assert.ok(gets.length <= 2);
  }
  assert.equal(h.a.syncState.snapshot().error, null);
  assert.ok((await manifestEntries(h, 'a')).length <= 3);
  const before = h.calls.length;
  await h.a.engine.syncNow();
  assert.equal(h.calls.slice(before).filter(c => c.method === 'list' && c.path.endsWith('/manifests/a')).length, 1);
});


test('仓库绑定拒绝换仓库且零远端请求；rebind保留内容换号并全量发布，另一台完整加入', async () => {
  const old = await pair();
  const saved = await old.a.store.read();
  assert.equal(saved.state.repositoryId, 'fiction/repo');
  old.a.engine.dispose();
  const h = harness();
  const { MemoryStore } = await import('../../app/store.js');
  const { SyncState } = await import('../../app/syncstate.js');
  const store = new MemoryStore(saved), syncState = new SyncState();
  const engine = createEngine({ store, syncState, transport: h.transport, now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/new-repo' });
  await assert.rejects(engine.load(), /这台设备的数据属于另一个仓库/);
  assert.equal((await engine.syncNow()).ok, false);
  assert.equal(h.calls.length, 0);
  assert.equal(canonical(await store.read()), canonical(saved));
  await assert.rejects(engine.rebind('fiction/new-repo', 'a'), /全新/);
  await engine.rebind('fiction/new-repo', 'fresh-a');
  assert.equal(canonical(engine.getState()), canonical(old.a.engine.getState()));
  const rebound = (await store.read()).state;
  assert.equal(rebound.published, null); assert.deepEqual(rebound.seen, {});
  assert.equal(rebound.sequence, 0); assert.equal(rebound.device, 'fresh-a');
  assert.equal((await engine.syncNow()).ok, true);
  assert.equal(h.calls.filter(c => c.method === 'put' && c.path.includes('/chunks/')).length, Object.keys(pack.splitState(engine.getState())).length);
  const newcomerStore = new MemoryStore(record('new-phone'));
  const newcomer = createEngine({ store: newcomerStore, syncState: new SyncState(), transport: h.transport, now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/new-repo' });
  await newcomer.load(); assert.equal((await newcomer.join()).joined, true);
  assert.equal(canonical(newcomer.getState()), canonical(engine.getState()));
});

test('旧记录首次绑定持久化，再次load不能换仓库；同仓库换令牌不影响确认', async () => {
  const h = harness(), a = await h.device('a', seed());
  assert.equal((await a.store.read()).state.repositoryId, 'fiction/repo');
  const { SyncState } = await import('../../app/syncstate.js');
  const engine = createEngine({ store: a.store, syncState: new SyncState(), transport: h.transport, now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/other' });
  await assert.rejects(engine.load(), /另一个仓库/);
  assert.equal(h.calls.length, 0);
});


test('设备登记只看合法文件名；稳态无变化5请求、改单任务最多9请求，计划只保存变化块', async t => {
  const h = await pair();
  await h.memory.put(pack.ROOT + '/devices/invalid name.json', encode('不合法文件名被忽略'));
  // 合法名称的正文不再下载或解释。
  const get = h.transport.get;
  h.transport.get = path => {
    assert.ok(!path.includes('/devices/'));
    return get(path);
  };
  let start = h.calls.length;
  await h.a.engine.syncNow();
  assert.equal(h.calls.length - start, 5);
  for (let i = 0; i < 5; i++) {
    h.clock.advance(); await h.a.engine.commit(edit(h.a, T, '预算虚构修改' + i));
    start = h.calls.length;
    assert.equal((await h.a.engine.syncNow()).ok, true);
    const calls = h.calls.slice(start);
    assert.ok(calls.length <= 9, String(calls.length));
    assert.equal(calls.filter(c => c.method === 'put').length, 2);
    assert.equal(calls.filter(c => c.method === 'get' && c.path.includes('/chunks/')).length, 0);
    start = h.calls.length; await h.b.engine.syncNow();
    assert.ok(h.calls.length - start <= 10);
  }
  h.clock.advance(); await h.a.engine.commit(edit(h.a, T, '冻结计划'));
  h.memory.injectFault({ type: 'offline', operation: 'put' });
  await h.a.engine.syncNow();
  const plan = (await h.a.store.read()).pendingSnapshots[0];
  assert.equal(plan.chunks.length, 1);
  assert.equal(Object.keys(JSON.parse(plan.manifest.text).buckets).length, 2);
  t.diagnostic('请求预算：两设备无变化5次transport调用；单任务编辑2次put，稳态含清理最多9次transport调用。');
});

test('仅回退业务state但保留最新合并凭据：重载后即便先commit也不能跳过自愈下载', async () => {
  const h = await pair(), previous = h.b.engine.getState(); h.clock.advance();
  await h.a.engine.commit(edit(h.a, T, '必须恢复的远端内容')); await h.a.engine.syncNow();
  await h.b.engine.syncNow();
  const saved = await h.b.store.read();
  saved.state.state = previous; // 故意只回退内容，保留最新basis/merged/published。
  h.b.engine.dispose();
  const b = await h.device('b', null, saved);
  await b.engine.commit(updateUnit(b.engine.getState(), U, 'b', { title: '回退后本机另一个编辑' }));
  const start = h.calls.length;
  assert.equal((await b.engine.syncNow()).ok, true);
  assert.equal(value(b).title, '必须恢复的远端内容');
  assert.ok(h.calls.slice(start).some(c => c.method === 'get' && c.path.includes('/chunks/')));
  assert.equal(value(b, U).title, '回退后本机另一个编辑');
});

test('合并存盘失败不前进merged凭据，重试仍下载未装入的桶', async () => {
  const h = await pair(); h.clock.advance();
  await h.a.engine.commit(edit(h.a, T, '必须再次读取')); await h.a.engine.syncNow();
  const original = h.b.store.writeTransaction.bind(h.b.store), before = await h.b.store.read();
  let count = 0;
  h.b.store.writeTransaction = fn => { if (++count === 2) h.b.store.failNextWrite(); return original(fn); };
  assert.equal((await h.b.engine.syncNow()).ok, false);
  assert.deepEqual((await h.b.store.read()).state.merged, before.state.merged);
  h.b.store.writeTransaction = original;
  const start = h.calls.length;
  assert.equal((await h.b.engine.syncNow()).ok, true);
  assert.ok(h.calls.slice(start).some(c => c.method === 'get' && c.path.includes('/chunks/')));
  assert.equal(value(h.b).title, '必须再次读取');
});
