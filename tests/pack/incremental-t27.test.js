import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { canonical, unitKey } from '../../sync/canonical.js';
import { emptyState } from '../../sync/merge.js';
import { updateUnit, deleteUnit } from '../../sync/edit.js';
import * as pack from '../../sync/pack.js';
test('T27 至少 200 组随机序列：有hint和无hint状态规范文本逐字节一致', async () => {
  let seed = 0x271113;
  const next = max => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
  for (let group = 0; group < 200; group++) {
    const h = harness(), a = await h.device('a', emptyState()), b = await h.device('a', emptyState());
    for (let step = 0; step < 6; step++) {
      const key = unitKey(next(2) ? 'task-content' : 'task-status', 'task-' + next(12)), old = a.engine.getState();
      const changed = next(5) ? updateUnit(old, key, 'a', { text: '虚构' + next(100), done: Boolean(next(2)) }, { updatedAt: step }) : deleteUnit(old, key, 'a', { updatedAt: step });
      await a.engine.commit(changed, [key]); await b.engine.commit(changed);
      assert.equal(canonical(a.engine.getState()), canonical(b.engine.getState()), group + '/' + step);
    }
    a.engine.dispose(); b.engine.dispose();
  }
});
test('T27 hint漏报明确拒绝且本机不变，含新增、修改与物理移除；输入与getState副本隔离', async () => {
  const h = harness(), a = await h.device('a', emptyState());
  const key = unitKey('task-content', 't'), other = unitKey('task-status', 't');
  let next = updateUnit(emptyState(), key, 'a', '虚构'); next = updateUnit(next, other, 'a', true);
  await assert.rejects(a.engine.commit(next, [key]), e => e.code === 'hint');
  assert.equal(canonical(a.engine.getState()), canonical(emptyState()));
  await a.engine.commit(next, [key, other]);
  const saved = canonical(a.engine.getState());
  const removed = a.engine.getState(); delete removed.units[other];
  await assert.rejects(a.engine.commit(removed, []), e => e.code === 'hint');
  const copy = a.engine.getState(); copy.units[key].versions[0].value = '不能改内部';
  assert.equal(canonical(a.engine.getState()), saved);
  next = updateUnit(a.engine.getState(), key, 'a', '调用时内容');
  const promise = a.engine.commit(next, [key]); next.units[key].versions[0].value = '排队后被改';
  await promise; assert.equal(a.engine.getState().units[key].versions[0].value, '调用时内容');
});
test('T27 坏清单警告details通过返回值传出，since保持首次发现时间，修复后清空', async () => {
  const h = harness(), a = await h.device('a', emptyState());
  const m = await pack.createManifest('dead', 1, { 'tasks-00': 'a'.repeat(64) });
  const bytes = text => Uint8Array.from(text, c => c.charCodeAt(0));
  await h.memory.put(pack.devicePath('dead'), bytes(pack.deviceText('dead'))); await h.memory.put(m.path, bytes(m.text));
  const first = await a.engine.syncNow(); assert.equal(first.ok, true);
  assert.deepEqual(first.details, [{ device: 'dead', since: h.clock.value }]);
  h.clock.advance(); assert.deepEqual((await a.engine.syncNow()).details, first.details);
  await h.memory.remove(m.path);
  assert.deepEqual((await a.engine.syncNow()).details, []);
});
test('T27 可写输入重复使用也重新检查，commit只读返回值不泄漏可写内部', async () => {
  const h = harness(), a = await h.device('a', emptyState()), key = unitKey('task-content', 't');
  const input = updateUnit(emptyState(), key, 'a', '初稿');
  const result = await a.engine.commit(input, [key]);
  assert.throws(() => { result.units[key].versions[0].value = '不应成功'; }, TypeError);
  const v = input.units[key].versions[0]; v.vv.a = 2; v.sources[0].vv.a = 2; v.value = '继续编辑同一副本';
  await a.engine.commit(input, [key]); assert.equal(a.engine.getState().units[key].versions[0].value, '继续编辑同一副本');
});
test('T27 外部浅冻结单元不当作引擎只读缓存；重放回调漏报仍拒绝', async () => {
  const h = harness(), a = await h.device('a', emptyState()), key = unitKey('task-content', 't');
  const input = updateUnit(emptyState(), key, 'a', '外部浅冻结'); Object.freeze(input.units[key]);
  await a.engine.commit(input, [key]);
  const v = input.units[key].versions[0]; v.vv.a = 2; v.sources[0].vv.a = 2; v.value = '浅冻结里继续修改';
  await a.engine.commit(input, [key]); assert.equal(a.engine.getState().units[key].versions[0].value, v.value);
  const before = canonical(a.engine.getState());
  await assert.rejects(a.engine.commit(a.engine.getState(), [], { rebase(state, metadata) {
    return metadata ? { state: updateUnit(state, key, 'a', '漏报'), keys: [] } : { state, keys: [] };
  } }), e => e.code === 'hint');
  assert.equal(canonical(a.engine.getState()), before);
});
test('T27 跨页面记录头部异常或非空archives明确拒绝，不能在增量保存时丢引用', async () => {
  for (const corrupt of [state => { state.archives.unknown = { keep: '不能丢弃' }; }, state => { state.schema = 2; }]) {
    const h = harness(), a = await h.device('a', emptyState()), next = updateUnit(emptyState(), unitKey('task-content', 't'), 'a', '正常编辑');
    await a.store.update(r => { corrupt(r.state.state); r.state.generation++; });
    const saved = JSON.stringify(await a.store.read());
    await assert.rejects(a.engine.commit(next), e => e.code === 'local');
    assert.equal(JSON.stringify(await a.store.read()), saved);
  }
});

test('T28 分批载入后可编辑任务；补载不丢复盘，完整getState仍需等待；同步无变化不写桶', async () => {
  const { plannerToState, stateToPlanner } = await import('../../sync/convert.js');
  const { createEngine } = await import('../../sync/engine.js');
  const { SyncState } = await import('../../app/syncstate.js');
  const h = harness(), data = plannerToState({ tasks: [{ id: 't', title: '虚构任务', done: false }], reviews: [{ id: 'day:2026-11-13', title: '虚构复盘', content: '保留虚构正文' }] }, 'computer', 1);
  const a = await h.device('a', data); await a.engine.syncNow(); a.engine.dispose();
  const engine = createEngine({ store: a.store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/repo' });
  a.store.resetStats(); const early = await engine.loadTasks();
  assert.equal(Object.keys(early.units).some(k => JSON.parse(k)[0].startsWith('review')), false);
  assert.equal(a.store.calls.some(c => c.operation === 'read' && c.key.startsWith('bucket:reviews-')), false);
  assert.throws(() => engine.getState(), e => e.code === 'loading');
  const key = unitKey('task-status', 't'), edit = updateUnit({ schema: 1, units: { [key]: early.units[key] }, archives: {} }, key, 'a', { done: true }, { updatedAt: 2 });
  a.store.resetStats(); await engine.commitUnits(edit, [key]);
  assert.equal(a.store.stats.bucketReads, 0); assert.equal(a.store.stats.bucketWrites, 1);
  await engine.ensureLoaded(); const full = stateToPlanner(engine.getState());
  assert.equal(full.tasks[0].done, true); assert.equal(full.reviews[0].content, '保留虚构正文');
  h.clock.advance(); assert.equal((await engine.syncNow()).ok, true);
  a.store.resetStats(); h.clock.advance(); assert.equal((await engine.syncNow()).ok, true);
  assert.equal(a.store.stats.bucketReads + a.store.stats.bucketWrites, 0); engine.dispose();
});

test('T28 未载入桶拒绝直接编辑，不得用半桶覆盖已存复盘', async () => {
  const { plannerToState } = await import('../../sync/convert.js');
  const { createEngine } = await import('../../sync/engine.js');
  const { SyncState } = await import('../../app/syncstate.js');
  const h = harness(), state = plannerToState({ tasks: [], reviews: [{ id: 'day:2026-11-13', content: '虚构原文' }, { id: 'day:2026-11-14', content: '同桶另一篇虚构复盘' }] }, 'computer', 1);
  const a = await h.device('a', state); a.engine.dispose();
  const engine = createEngine({ store: a.store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/repo' });
  await engine.loadTasks(); const before = await a.store.read(); a.store.resetStats();
  const key = unitKey('review-title', 'day:2026-11-13'), edited = updateUnit(emptyState(), key, 'a', '虚构新标题', { updatedAt: 2 });
  await assert.rejects(engine.commitUnits(edited, [key]), e => e.code === 'loading');
  assert.equal(a.store.stats.bucketWrites, 0); assert.deepEqual(await a.store.read(), before);
  await engine.ensureLoaded(); await engine.commitUnits(edited, [key]);
  assert.ok(engine.getState().units[unitKey('entity', 'reviews', 'day:2026-11-14')]); engine.dispose();
});

test('T28 分批载入后rebind也完整保留未读业务，并返回普通完整副本', async () => {
  const { plannerToState, stateToPlanner } = await import('../../sync/convert.js');
  const { createEngine } = await import('../../sync/engine.js'); const { SyncState } = await import('../../app/syncstate.js');
  const h = harness(), state = plannerToState({ tasks: [], reviews: [{ id: 'day:2026-11-13', content: '虚构保留复盘' }] }, 'computer', 1), a = await h.device('a', state); a.engine.dispose();
  const engine = createEngine({ store: a.store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/repo' });
  await engine.loadTasks(); const rebound = await engine.rebind('fiction/repo', 'a-new');
  assert.equal(stateToPlanner(rebound).reviews[0].content, '虚构保留复盘');
  rebound.units = {}; assert.ok(Object.keys(engine.getState().units).length); engine.dispose();
});

test('T28 读取冻结计划遇另一页元数据变动，重读重试原字节，不误报身份或丢计划', async () => {
  const h = harness(), a = await h.device('a', updateUnit(emptyState(), unitKey('task-content', 't'), 'a', '虚构计划', { updatedAt: 1 }));
  h.memory.injectFault({ type: 'offline', operation: 'put' }); assert.equal((await a.engine.syncNow()).ok, false);
  const plan = (await a.store.read()).pendingSnapshots[0], original = a.store.readPending.bind(a.store);
  let changed = false;
  a.store.readPending = async expected => {
    if (!changed) { changed = true; await a.store.updateMetadata(r => { r.settings.otherPage = '虚构设置'; }); }
    return original(expected);
  };
  assert.equal((await a.engine.syncNow()).ok, true); assert.equal(changed, true);
  const saved = await a.store.read(); assert.equal(saved.pendingSnapshots.length, 0); assert.equal(saved.settings.otherPage, '虚构设置');
  assert.equal(saved.state.sequence, pack.parseManifestPath(plan.manifest.path).sequence);
  assert.equal(String.fromCharCode(...await h.memory.get(plan.manifest.path)), plan.manifest.text); a.engine.dispose();
});
