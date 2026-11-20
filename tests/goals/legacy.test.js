import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { harness, record } from '../pack/helpers.js';
import { stateToPlanner } from '../../app/goal-sync.js';
import { createDataSource } from '../../app/datasource.js';
import { GoalActions } from '../../app/goals-actions.js';
import { TaskActions } from '../../app/task-actions.js';
import { decodeLegacy, unitKey } from '../../sync/canonical.js';
import { SyncState } from '../../app/syncstate.js';
import { unitInfo } from '../../sync/merge.js';

const fixture = JSON.parse(await readFile(new URL('../../../sync-spec/interop/t42-goals.json', import.meta.url)));
const legacyRoot = process.env.T42_LEGACY_ROOT;
const legacy = path => import(legacyRoot ? pathToFileURL(resolve(legacyRoot, path)).href : '../../' + path);

// 可以指向联调版 3 的只读代码副本。默认以仍保持原格式的共享引擎、旧投影重跑。
test('旧版接收九宫格后改动同一任务的旧字段，再发布原样保留九宫格单元', async () => {
  const h = harness();
  const [{ createEngine }, legacyConvert, legacyPack, { MemoryStore }] = await Promise.all([
    legacy('sync/engine.js'), legacy('sync/convert.js'), legacy('sync/pack.js'), legacy('app/store.js')
  ]);
  const { goals, goalYears, tasks } = fixture.planner;
  const oldPlanner = { tasks: tasks.map(({ goalId, ...task }) => task) };
  const store = new MemoryStore(record('desktop-old', legacyConvert.plannerToState(oldPlanner, 'desktop-old')));
  const desktop = createEngine({ store, syncState: new SyncState(), transport: h.transport, repositoryId: 'fiction/repo', now: h.clock.now, timers: h.clock.timers });
  await desktop.load();
  assert.equal((await desktop.syncNow()).ok, true);
  const writer = await h.device('mobile-goals');
  assert.equal((await writer.engine.join()).ok, true);
  await writer.store.updateMetadata(row => { row.settings.joined = true; });
  const source = await createDataSource({ store: writer.store, now: h.clock.now });
  source.attachEngine(writer.engine);
  await source.change('手机保存示例目标和年度领域', planner => { planner.goals = [...goals, { ...goals[0], id: 'deleted-example' }]; planner.goalYears = goalYears; });
  await new GoalActions(source).remove('deleted-example');
  await new TaskActions(source).setGoal(tasks[0].id, tasks[0].goalId);
  h.clock.advance();
  assert.equal((await writer.engine.syncNow()).ok, true);
  const state = writer.engine.getState();
  const keys = fixture.units.map(({ path, value }) => {
    const key = unitKey(...path);
    assert.deepEqual(decodeLegacy(unitInfo(state.units[key]).preferred.value), value);
    return key;
  });
  const deleted = unitKey('goal', 'deleted-example');
  assert.equal(unitInfo(state.units[deleted]).preferred.deleted, true);
  keys.push(deleted);
  const expected = Object.fromEntries(keys.map(key => [key, state.units[key]]));

  assert.equal((await desktop.syncNow()).ok, true);
  const oldState = desktop.getState();
  const before = legacyConvert.stateToPlanner(oldState);
  assert.ok(!('goalId' in before.tasks[0]) && !('goals' in before) && !('goalYears' in before));
  for (const key of keys) {
    assert.equal(legacyPack.bucketOf(key), 'other');
    assert.deepEqual(oldState.units[key], expected[key]);
    assert.equal(unitInfo(oldState.units[key]).conflict, false);
  }

  const after = { ...before, tasks: before.tasks.map(task => ({ ...task, title: '旧电脑改了任务标题' })) };
  await desktop.commit(legacyConvert.applyPlannerChanges(oldState, before, after, 'desktop-old', h.clock.now()));
  h.clock.advance();
  assert.equal((await desktop.syncNow()).ok, true);
  // 新设备没有手机的本机数据，只能由旧端的已发布清单恢复这几项。
  const paths = h.writes().filter(call => call.method === 'put' && /\/manifests\/mobile-goals\//.test(call.path)).map(call => call.path);
  assert.ok(paths.length);
  for (const path of paths) await h.memory.remove(path);
  const reader = await h.device('fresh-reader');
  assert.equal((await reader.engine.join()).ok, true);
  const published = reader.engine.getState();
  const restored = stateToPlanner(published);
  assert.equal(restored.tasks[0].title, '旧电脑改了任务标题');
  assert.equal(restored.tasks[0].goalId, tasks[0].goalId);
  assert.deepEqual(restored.goalYears, goalYears);
  assert.equal(restored.goals.length, goals.length);
  for (const key of keys) {
    assert.deepEqual(published.units[key], expected[key]);
    assert.equal(unitInfo(published.units[key]).conflict, false);
  }
});

test('联调版旧引擎接收、编辑并再次发布长期宫格、永久锁、拆解关系和墓碑', async () => {
  const { planner } = JSON.parse(await readFile(new URL('../../../sync-spec/interop/t44-plans.json', import.meta.url)));
  const { plannerToState } = await import('../../app/goal-sync.js');
  const [{ createEngine }, legacyConvert, legacyPack, { MemoryStore }] = await Promise.all([
    legacy('sync/engine.js'), legacy('sync/convert.js'), legacy('sync/pack.js'), legacy('app/store.js')
  ]);
  const h = harness(), oldId = 'desktop-v29', writerId = 'mobile-v30-plans';
  const taskId = 't44-series-original';
  const store = new MemoryStore(record(oldId, legacyConvert.plannerToState({ tasks: [{ id: taskId, title: '虚构旧任务' }] }, oldId)));
  const desktop = createEngine({ store, syncState: new SyncState(), transport: h.transport, repositoryId: 'fiction/repo', now: h.clock.now, timers: h.clock.timers });
  await desktop.load();
  assert.equal((await desktop.syncNow()).ok, true);

  const writer = await h.device(writerId);
  assert.equal((await writer.engine.join()).ok, true);
  await writer.store.updateMetadata(row => { row.settings.joined = true; });
  const source = await createDataSource({ store: writer.store, now: h.clock.now, tasksFirst: true });
  source.attachEngine(writer.engine);
  await source.change('手机写入虚构长期宫格', p => {
    p.goals = planner.goals;
    p.goalYears = planner.goalYears;
    p.goalPlans = planner.goalPlans;
    p.goalPlanLocks = planner.goalPlanLocks;
  });
  const actions = new GoalActions(source, { id: () => 't44-deleted-goal' });
  await actions.save(2025, 0, { span: 10, title: '要删掉的虚构目标' });
  await actions.remove('t44-deleted-goal');
  await actions.rename(2023, 0, '旧起始时段', source.snapshot().editToken, 5);
  await actions.changeStart(5, 2023, 2022, 2026, source.snapshot().editToken);
  await new TaskActions(source).setGoal(taskId, 't44-annual');
  h.clock.advance();
  assert.equal((await writer.engine.syncNow()).ok, true);
  const state = writer.engine.getState();
  const keys = Object.keys(plannerToState(planner, 'fixture').units).filter(key => JSON.parse(key)[0].startsWith('goal'));
  keys.push(unitKey('goal', 't44-deleted-goal'), unitKey('goal-plan', '5:2023'), unitKey('goal-plan', '5:2022'), unitKey('task-goal', taskId));
  for (const key of [unitKey('goal', 't44-deleted-goal'), unitKey('goal-plan', '5:2023')]) assert.equal(unitInfo(state.units[key]).preferred.deleted, true);
  for (const key of keys) assert.ok(state.units[key], key);

  assert.equal((await desktop.syncNow()).ok, true);
  const checkUnits = received => {
    for (const key of keys) {
      assert.equal(legacyPack.bucketOf(key), 'other');
      assert.deepEqual(received.units[key], state.units[key], key);
      assert.equal(unitInfo(received.units[key]).conflict, false);
    }
  };
  const oldState = desktop.getState();
  checkUnits(oldState);
  const before = legacyConvert.stateToPlanner(oldState);
  for (const field of ['goals', 'goalYears', 'goalPlans', 'goalPlanLocks']) assert.equal(Object.hasOwn(before, field), false);
  assert.equal(Object.hasOwn(before.tasks[0], 'goalId'), false);
  const after = { ...before, tasks: before.tasks.map(task => ({ ...task, title: '旧版修改虚构标题' })) };
  await desktop.commit(legacyConvert.applyPlannerChanges(oldState, before, after, oldId, h.clock.now()));
  h.clock.advance();
  assert.equal((await desktop.syncNow()).ok, true);

  for (const write of h.writes().filter(call => call.method === 'put' && call.path.includes('/manifests/' + writerId + '/'))) {
    await h.memory.remove(write.path);
  }
  assert.ok(h.writes().some(call => call.method === 'put' && call.path.includes('/manifests/' + oldId + '/')));
  const reader = await h.device('fresh-t44-reader');
  assert.equal((await reader.engine.join()).ok, true);
  checkUnits(reader.engine.getState());
  const restored = stateToPlanner(reader.engine.getState());
  assert.equal(restored.tasks[0].title, '旧版修改虚构标题');
  assert.equal(restored.tasks[0].goalId, 't44-annual');
  assert.deepEqual(restored.goals, planner.goals);
  assert.deepEqual(restored.goalPlanLocks, planner.goalPlanLocks);
  assert.equal(restored.goalPlans.find(plan => plan.span === 5 && plan.year === 2026).vision, planner.goalPlans[1].vision);
});
