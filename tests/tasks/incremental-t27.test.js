import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataSource } from '../../app/datasource.js';
import { TaskActions } from '../../app/task-actions.js';
import { MemoryStore, freshRecord } from '../../app/store.js';
import { plannerToState, stateToPlanner } from '../../sync/convert.js';
import { canonical, encodeLegacy, unitKey } from '../../sync/canonical.js';
import { updateUnit, resolveUnit } from '../../sync/edit.js';
import { merge } from '../../sync/merge.js';
import { harness } from '../pack/helpers.js';
import { createEngine } from '../../sync/engine.js';
import { SyncState } from '../../app/syncstate.js';
const now = () => 1794528000123;
const initial = () => plannerToState({ projects: [{ id: 'p', name: '虚构项目' }], tasks: [{ id: 't', title: '虚构任务', done: false, steps: [] }], reviews: [{ id: 'day:2026-11-13', content: '【甲】\n初始\n【乙】\n保留' }] }, 'computer');
test('T27 320次界面操作后增量快照逐字段等于完整投影，含新建删除撤销步骤放弃恢复和复盘', async () => {
  const store = new MemoryStore({ ...freshRecord(), state: initial(), settings: { joined: true, deviceId: 'phone' } });
  const source = await createDataSource({ store, now }); let id = 0;
  const actions = new TaskActions(source, { now, id: () => 'new-' + ++id });
  for (let i = 0; i < 320; i++) {
    switch (i % 12) {
      case 0: await actions.toggle('t'); break;
      case 1: await actions.patch('t', { notes: '虚构备注' + i, priority: i % 4 }); break;
      case 2: await actions.addSteps('t', '虚构步骤' + i); break;
      case 3: { const s = source.snapshot().planner.tasks.find(t => t.id === 't').steps[0]; await actions.step('t', s.id, 'toggle'); break; }
      case 4: await actions.add('虚构新建'); break;
      case 5: { const row = source.snapshot().planner.tasks.find(t => t.id !== 't'); const receipt = await actions.remove(row.id); await receipt.undo(); break; }
      case 6: if (source.snapshot().planner.tasks.find(t => t.id === 't').done) await actions.toggle('t'); await actions.abandon('t', '虚构条件变了'); break;
      case 7: await actions.restore('t'); break;
      case 8: await source.change('步骤倒序', p => p.tasks.find(t => t.id === 't').steps.reverse()); await source.change('修改复盘', p => { p.reviews[0].content = p.reviews[0].content.replace(/初始\d*/, '初始' + i); }); break;
      case 9: await actions.schedule('t', { date: '2026-11-14' }); break;
      case 10: await actions.patch('t', { project: 'p' }); break;
      case 11: { const receipt = await actions.patch('t', { title: '虚构标题' + i }); await receipt.undo(); break; }
    }
    assert.equal(canonical(encodeLegacy(source.snapshot().planner)), canonical(encodeLegacy(stateToPlanner((await store.read()).state, { allowConflicts: true }))), '界面步骤 ' + i);
  }
});
test('T27 snapshot懒副本隔离、分钟切换、settings与records首选候选和缓存更新', async () => {
  let state = initial(), clock = now();
  const setting = unitKey('setting', 'ReviewModules.day'), key = unitKey('record', '2026-11-13:r');
  state = updateUnit(state, setting, 'computer', '甲|乙');
  const record = { day: '2026-11-13', columns: ['番茄', '2026-11-13 08:00:00', '', '25', '', '完成', '', 't|虚构'] };
  state = merge(updateUnit(state, key, 'a', record), updateUnit(state, key, 'b', { ...record, columns: [...record.columns, '并发'] }));
  const store = new MemoryStore({ ...freshRecord(), state, settings: { joined: true, deviceId: 'phone' } });
  const source = await createDataSource({ store, now: () => clock });
  const snapshot = source.snapshot(); snapshot.planner.tasks[0].title = '不能影响内部'; snapshot.settings['ReviewModules.day'] = '不能影响'; snapshot.records[0].columns[0] = '不能影响';
  assert.equal(source.snapshot().planner.tasks[0].title, '虚构任务'); assert.equal(source.snapshot().settings['ReviewModules.day'], '甲|乙'); assert.equal(source.snapshot().records[0].columns[0], '番茄');
  clock += 86400000; assert.equal(source.snapshot().today, '2026-11-14');
  assert.equal(source.snapshot().records.length, 1);
  await store.update(r => { r.state = resolveUnit(r.state, key, 'computer', null, { updatedAt: 1 }, { deleted: true }); }); await source.refresh();
  assert.equal(source.snapshot().records.length, 0);
});
test('T27 共享真实引擎封套：change调用commit带hint、存盘失败、两页面并行和解决冲突', async () => {
  const h = harness(), a = await h.device('phone', initial());
  await a.store.update(r => { r.settings.joined = true; });
  const b = createEngine({ store: a.store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/repo' }); await b.load();
  const one = await createDataSource({ store: a.store, now }), two = await createDataSource({ store: a.store, now });
  let hints = [], original = a.engine.commitUnits;
  a.engine.commitUnits = (...args) => { hints.push(args[1]); return original(...args); };
  one.attachEngine(a.engine); two.attachEngine(b);
  const actions = new TaskActions(one, { now }), other = new TaskActions(two, { now });
  await Promise.all([actions.patch('t', { title: '本页标题' }), other.patch('t', { notes: '另页备注' })]);
  const saved = (await a.store.read()).state;
  assert.equal(saved.format, 'yema-engine-local'); assert.equal(saved.generation > 0, true);
  const row = stateToPlanner(saved.state).tasks[0]; assert.equal(row.title, '本页标题'); assert.equal(row.notes, '另页备注');
  assert.ok(hints[0].includes(unitKey('task-content', 't')));
  await one.refresh(); const before = canonical(encodeLegacy(one.snapshot().planner)); a.store.failNextWrite();
  await assert.rejects(actions.toggle('t'), /保存失败/); assert.equal(canonical(encodeLegacy(one.snapshot().planner)), before);
  await actions.toggle('t'); assert.equal(one.snapshot().planner.tasks[0].updated, '2026-11-13T00:00:00.123Z');
  const ek = unitKey('task-content', 't'), base = a.engine.getState(), value = base.units[ek].versions[0].value;
  const conflict = merge(updateUnit(base, ek, 'computer', { ...value, notes: '甲' }), updateUnit(base, ek, 'third', { ...value, notes: '乙' }));
  await a.engine.commit(conflict, [ek]); await one.refresh();
  await one.resolve(ek, { type: 'both' }); assert.equal(one.snapshot().conflicts.length, 0);
  assert.match(one.snapshot().planner.tasks[0].notes, /甲\n\n乙|乙\n\n甲/);
  assert.equal((await a.store.read()).state.format, 'yema-engine-local'); a.engine.dispose(); b.dispose();
});
test('T27 根字段null新增删除、集合标记和步骤重排保留原有语义', async () => {
  const store = new MemoryStore({ ...freshRecord(), state: initial(), settings: { joined: true, deviceId: 'phone' } });
  const source = await createDataSource({ store, now });
  for (const mutate of [p => { p.opaque = null; }, p => { delete p.opaque; }, p => { p.habits = []; }, p => { delete p.habits; }, p => { p.tasks[0].steps = [{ id: 'b', text: '乙' }, { id: 'a', text: '甲' }]; }, p => { p.tasks[0].steps.reverse(); }]) {
    await source.change('虚构修改', mutate);
    assert.equal(canonical(encodeLegacy(source.snapshot().planner)), canonical(encodeLegacy(stateToPlanner((await store.read()).state))));
  }
  assert.equal(source.snapshot().planner.tasks[0].steps[0].id, 'a');
});
test('T27 连续自动保存的旧编辑凭据不读取无关实体的正文或版本', async () => {
  const store = new MemoryStore({ ...freshRecord(), state: initial(), settings: { joined: true, deviceId: 'phone' } });
  const source = await createDataSource({ store, now }), actions = new TaskActions(source, { now });
  let receipt = await actions.patch('t', { notes: '第一句' }, { baseToken: source.snapshot().editToken });
  // 不透明凭据中的无关复盘版本设为哨兵：只编辑任务不应再走完整stateToPlanner。
  const observed = source.tokens.get(receipt.editToken), key = unitKey('review-meta', 'day:2026-11-13');
  Object.defineProperty(observed.units[key], 'versions', { enumerable: true, get() { throw new Error('不应全量读取无关复盘'); } });
  receipt = await actions.patch('t', { notes: '第一句，继续输入' }, { baseToken: receipt.editToken });
  await actions.patch('t', { notes: '第一句，继续输入，完成' }, { baseToken: receipt.editToken });
  assert.equal(source.snapshot().planner.tasks[0].notes, '第一句，继续输入，完成');
  assert.equal(source.snapshot().planner.reviews[0].content, '【甲】\n初始\n【乙】\n保留');
});

test('T28 几百单元回归：改一个任务只写相关桶和元数据，桶读写合计不超过3', async () => {
  const h = harness(), planner = { tasks: [], projects: [{ id: 'p', name: '虚构项目' }], reviews: [], habits: [] };
  for (let i = 0; i < 80; i++) planner.tasks.push({ id: 'fiction-' + i, title: '虚构任务' + i, done: false, steps: [] });
  const state = plannerToState(planner, 'computer', 1), a = await h.device('phone', state);
  await a.store.updateMetadata(r => { r.settings.joined = true; });
  const source = await createDataSource({ store: a.store, now }); source.attachEngine(a.engine);
  // 装入最新业务版本，计数只包含这次界面操作。
  await a.engine.load(); await source.refresh(); a.store.resetStats();
  await new TaskActions(source, { now }).toggle('fiction-0');
  assert.ok(a.store.stats.bucketReads + a.store.stats.bucketWrites <= 3, JSON.stringify(a.store.stats));
  assert.equal(a.store.stats.bucketWrites, 1); assert.equal(a.store.stats.metadataWrites, 1);
  assert.equal(a.store.stats.pendingReads + a.store.stats.pendingWrites, 0);
  const { bucketOf } = await import('../../sync/pack.js');
  assert.deepEqual(a.store.calls.filter(c => c.operation === 'write' && c.key.startsWith('bucket:')).map(c => c.key), ['bucket:' + bucketOf(unitKey('task-status', 'fiction-0'))]);
  assert.equal(source.snapshot().planner.tasks.find(t => t.id === 'fiction-0').done, true); a.engine.dispose();
});

test('T28 任务优先：不读取复盘/习惯/记录桶；明确loading，补载后内容完整', async () => {
  const planner = { tasks: [{ id: 't', title: '虚构任务', done: false }], projects: [],
    reviews: [{ id: 'day:2026-11-13', title: '虚构复盘', content: '【收获】\n虚构正文' }], habits: [{ id: 'h', name: '虚构习惯', checks: ['2026-11-13'] }] };
  const state = plannerToState(planner, 'computer', 1), store = new MemoryStore({ ...freshRecord(), state, settings: { deviceId: 'phone', joined: true } });
  await store.initialize(); store.resetStats();
  const source = await createDataSource({ store, now, tasksFirst: true }), first = source.snapshot();
  assert.equal(first.planner.tasks[0].title, '虚构任务'); assert.equal(first.loading.reviews, true); assert.equal(first.loading.habits, true);
  assert.equal(store.calls.some(c => c.operation === 'read' && /^bucket:(reviews-|habits)/.test(c.key)), false);
  const snapshot = await source.ensureLoaded(); assert.equal(snapshot.loading.reviews, false); assert.deepEqual(snapshot.loadingBuckets, []);
  assert.equal(snapshot.planner.reviews[0].content, planner.reviews[0].content); assert.equal(snapshot.planner.habits[0].checks[0], '2026-11-13');
});

test('T28 已提交后附加元数据读取失败不伪报保存失败，下一次仍可保存', async () => {
  const h = harness(), a = await h.device('phone', initial()); await a.store.updateMetadata(r => { r.settings.joined = true; });
  const source = await createDataSource({ store: a.store, now }); source.attachEngine(a.engine);
  const read = a.store.readMetadata.bind(a.store), write = a.store.writeTransaction.bind(a.store);
  let committed = false, failed = false;
  a.store.writeTransaction = async options => { const result = await write(options); committed = true; return result; };
  a.store.readMetadata = async () => { if (committed && !failed) { failed = true; throw new Error('虚构附加读取失败'); } return read(); };
  const actions = new TaskActions(source, { now }); await actions.toggle('t');
  assert.equal(failed, true); assert.equal(source.snapshot().planner.tasks[0].done, true);
  assert.equal(stateToPlanner((await a.store.read()).state.state).tasks[0].done, true);
  await actions.toggle('t'); assert.equal(source.snapshot().planner.tasks[0].done, false); a.engine.dispose();
});
