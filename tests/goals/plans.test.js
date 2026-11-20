import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDataSource, conflictList } from '../../app/datasource.js';
import { plannerToState, stateToPlanner } from '../../app/goal-sync.js';
import { GoalActions } from '../../app/goals-actions.js';
import { TaskActions } from '../../app/task-actions.js';
import { defaultGoalStart, shiftGoalPeriod } from '../../app/goal-periods.js';
import { childGoals, goalsInDomain, legalGoalParent, longGoalPomoStats, parentGoal, parentGroups, planLocked, planNames, savedPlanStarts } from '../../app/goals-model.js';
import { freshRecord, MemoryStore } from '../../app/store.js';
import { decodeLegacy, unitKey as key } from '../../sync/canonical.js';
import { merge, unitInfo } from '../../sync/merge.js';
import { bucketOf, joinChunks, splitState } from '../../sync/pack.js';
import { harness } from '../pack/helpers.js';

const vector = JSON.parse(await readFile(new URL('../../../sync-spec/interop/t44-plans.json', import.meta.url)));
const NOW = Date.parse('2026-11-20T04:00:00Z');
const goal = (planner, id) => planner.goals?.find(row => row.id === id);
const seed = () => plannerToState(vector.planner, 'seed');
const plannerOf = fixture => fixture.source.snapshot().planner;

async function fixture(deviceId = 'phone', state = seed(), joined = true) {
  const store = new MemoryStore({ ...freshRecord(), state, settings: { joined, deviceId } });
  const source = await createDataSource({ store, now: () => NOW });
  let number = 0;
  return { store, source, actions: new GoalActions(source, { id: () => deviceId + '-' + ++number }), state: async () => (await store.read()).state };
}

test('共用向量的长期目标、年度目标、宫格、锁与任务关联按旧格式分块往返', () => {
  const state = seed();
  for (const sample of vector.units) {
    const id = key(...sample.path);
    assert.equal(bucketOf(id), 'other');
    assert.deepEqual(decodeLegacy(unitInfo(state.units[id]).preferred.value), sample.value);
  }
  const projected = stateToPlanner(joinChunks(Object.values(splitState(state))));
  for (const collection of Object.keys(vector.planner)) assert.deepEqual(projected[collection], vector.planner[collection], collection);
  assert.ok(!state.units[key('root', 'goalPlans')] && !state.units[key('root', 'goalPlanLocks')]);
  assert.equal(goalsInDomain(projected, 2026, 0)[0].id, 't44-annual-total');
  assert.equal(goalsInDomain(projected, 2026, 0, 5)[0].id, 't44-five');
});

test('默认软件年份、按跨度整段翻页、明年之后一段及有效年份边界', () => {
  for (const span of [3, 5, 10]) {
    assert.equal(defaultGoalStart(span, 2026), 2026);
    assert.equal(shiftGoalPeriod(2026, span, -1, 2026), 2026 - span);
    assert.equal(shiftGoalPeriod(2026, span, 1, 2026), 2026 + span);
    assert.equal(shiftGoalPeriod(2026 + span, span, 1, 2026), null);
    assert.equal(shiftGoalPeriod(2027, span, 1, 2026), 2027 + span);
    assert.equal(shiftGoalPeriod(1, span, -1, 2026), null);
    assert.equal(defaultGoalStart(span, 9999), 10000 - span);
  }
  assert.equal(shiftGoalPeriod(2026, 1, 1, 2026), 2027);
  assert.equal(shiftGoalPeriod(2027, 1, 1, 2026), null);
});

test('空宫格可调整时段，名称随宫格移动，愿景或目标曾存在即永久固定', async () => {
  const f = await fixture();
  const { actions } = f;
  assert.equal(planNames(plannerOf(f), 3, 2026)[0], '星图·学习');
  assert.equal(planLocked(plannerOf(f), 3, 2026), false);
  assert.throws(() => actions.changeStart(3, 2026, 2027, 2026), /已有宫格/);
  assert.throws(() => actions.changeStart(3, 2026, 2031, 2026), /有效/);
  await actions.rename(2026, 0, '  虚构阅读领域 ', f.source.snapshot().editToken, 3);
  await actions.changeStart(3, 2026, 2021, 2026, f.source.snapshot().editToken);
  assert.equal(planNames(plannerOf(f), 3, 2021)[0], '虚构阅读领域');
  assert.deepEqual(savedPlanStarts(plannerOf(f), 3), [2021, 2027]);
  assert.equal(unitInfo((await f.state()).units[key('goal-plan', '3:2026')]).preferred.deleted, true);

  const opened = f.source.snapshot().editToken;
  await actions.saveVision(3, 2021, '  虚构愿景  ', opened);
  assert.throws(() => actions.changeStart(3, 2021, 2020, 2026, opened), /固定/);
  await actions.saveVision(3, 2021, '');
  assert.equal(planLocked(stateToPlanner(await f.state()), 3, 2021), true);

  await actions.save(2024, 2, { title: '临时虚构目标', span: 3 });
  await actions.remove('phone-1');
  assert.equal(planLocked(stateToPlanner(await f.state()), 3, 2024), true);
  assert.throws(() => actions.changeStart(3, 2024, 2023, 2026), /固定/);

  const readOnly = await fixture('read-only', seed(), false);
  await assert.rejects(readOnly.actions.saveVision(5, 2026, '未连接不落盘'), /第一次同步/);
});

test('共用关系向量，候选只含完整覆盖的更长期目标，悬空引用保留且不参与拆解', async () => {
  const f = await fixture();
  const p = plannerOf(f);
  for (const [child, parent, expected] of vector.relations) {
    assert.equal(legalGoalParent(goal(p, child), goal(p, parent)), expected, child + ' → ' + parent);
  }
  assert.deepEqual(parentGroups(p, goal(p, 't44-annual')).map(group => group.label), ['3 年', '5 年', '10 年']);
  assert.equal(parentGoal(p, goal(p, 't44-outside')), null);
  await assert.rejects(async () => f.actions.save(2025, 0, { span: 10, title: '自成环', id: 't44-ten', parentId: 't44-three' }), /上级目标/);
  await f.actions.save(2027, 0, { span: 3, title: '学会画三类星图', id: 't44-three', parentId: 't44-other' });
  assert.equal(parentGoal(plannerOf(f), goal(plannerOf(f), 't44-three')).id, 't44-other');
  await f.actions.remove('t44-other');
  assert.equal(goal(plannerOf(f), 't44-three').parentId, 't44-other');
  assert.equal(parentGoal(plannerOf(f), goal(plannerOf(f), 't44-three')), null);
  await f.actions.save(2027, 0, { span: 3, title: '学会画三类星图', id: 't44-three', parentId: '' });
  assert.equal(goal(plannerOf(f), 't44-three').parentId, undefined);
  await assert.rejects(new TaskActions(f.source).setGoal('t44-independent-task', 't44-ten'), /年度目标/);
});

test('共用统计向量，按软件年份累计多层年度任务，同系列、同记录编号只计一次', () => {
  const p = stateToPlanner(seed());
  for (const [id, expected] of Object.entries(vector.expectedStats)) {
    assert.deepEqual(longGoalPomoStats(p, goal(p, id), vector.records), expected, id);
  }
  for (const [id, expected] of Object.entries(vector.expectedChildren)) {
    assert.deepEqual(childGoals(p, goal(p, id)).map(row => row.id), expected, id);
  }
});

test('空宫格两端各加一条目标共同锁定时段，移动与另一端添加目标时原时段的目标和锁仍在', async () => {
  const blank = plannerToState({ goalYears: vector.planner.goalYears }, 'seed');
  const a = await fixture('a', blank), b = await fixture('b', blank);
  await a.actions.save(2026, 0, { span: 5, title: '甲写虚构目标' });
  await b.actions.save(2026, 0, { span: 5, title: '乙写虚构目标' });
  const equalLocks = merge(await a.state(), await b.state());
  assert.deepEqual(conflictList(equalLocks), []);
  assert.deepEqual(stateToPlanner(equalLocks).goals.map(row => row.id), ['a-1', 'b-1']);

  const c = await fixture('c', blank);
  await c.actions.rename(2026, 0, '虚构已改名领域', c.source.snapshot().editToken, 5);
  const d = await fixture('d', await c.state());
  await c.actions.changeStart(5, 2026, 2025, 2026, c.source.snapshot().editToken);
  await d.actions.save(2026, 0, { span: 5, title: '原时段的虚构目标' });
  const projected = stateToPlanner(merge(await c.state(), await d.state()));
  assert.equal(goal(projected, 'd-1').year, 2026);
  assert.equal(planLocked(projected, 5, 2026), true);
  assert.equal(planNames(projected, 5, 2025)[0], '虚构已改名领域');
  assert.deepEqual(savedPlanStarts(projected, 5), [2025, 2026]);
});

test('两台设备改不同长期目标可同步，同一条长期目标提示冲突并可解决', async () => {
  const h = harness();
  const a = await h.device('a', seed());
  assert.equal((await a.engine.syncNow()).ok, true);
  const b = await h.device('b');
  assert.equal((await b.engine.join()).ok, true);
  for (const device of [a, b]) {
    await device.store.updateMetadata(row => { row.settings.joined = true; });
    device.source = await createDataSource({ store: device.store, now: h.clock.now, tasksFirst: true });
    device.source.attachEngine(device.engine);
    device.actions = new GoalActions(device.source);
  }
  await a.actions.save(2026, 0, { span: 5, id: 't44-five', title: '甲改星图计划' });
  await b.actions.save(2026, 1, { span: 5, id: 't44-other', title: '乙改天文馆' });
  const sync = async (...devices) => {
    for (const device of devices) {
      h.clock.advance();
      assert.equal((await device.engine.syncNow()).ok, true);
      await device.source.refresh();
    }
  };
  await sync(a, b, a);
  assert.equal(goal(plannerOf(a), 't44-five').title, '甲改星图计划');
  assert.equal(goal(plannerOf(a), 't44-other').title, '乙改天文馆');
  assert.deepEqual(a.source.snapshot().conflicts, []);

  await a.actions.save(2026, 0, { span: 5, id: 't44-five', title: '甲修改同一条' });
  await b.actions.toggle('t44-five', true, '2026-11-20');
  await sync(a, b);
  const snapshot = b.source.snapshot();
  const conflict = snapshot.conflicts.find(row => row.key === key('goal', 't44-five'));
  assert.ok(conflict);
  assert.equal(conflict.candidates.length, 2);
  assert.equal(conflict.both, false);
  await b.source.resolve(conflict.key, { branch: conflict.candidates.find(row => row.value.done).branch, observed: snapshot.editToken });
  assert.equal(goal(plannerOf(b), 't44-five').done, true);
  assert.deepEqual(b.source.snapshot().conflicts, []);
});

test('v3.0.1 年度宫格中间写愿景：存在年度领域行，空白即删除，旧格式往返保留', async () => {
  const f = await fixture();
  const { actions } = f;
  await actions.saveVision(1, 2031, '');
  assert.equal(plannerOf(f).goalYears?.some(row => row.year === 2031) ?? false, false);
  await actions.saveVision(1, 2031, '  虚构年度愿景\r\n第二行  ', f.source.snapshot().editToken);
  const row = plannerOf(f).goalYears.find(entry => entry.year === 2031);
  assert.equal(row.vision, '虚构年度愿景\n第二行');
  assert.equal(row.names.length, 8);
  assert.equal(planLocked(plannerOf(f), 1, 2031), false);
  const projected = stateToPlanner(await f.state());
  assert.equal(projected.goalYears.find(entry => entry.year === 2031).vision, '虚构年度愿景\n第二行');
  assert.equal(stateToPlanner(plannerToState(projected, 'pc')).goalYears.find(entry => entry.year === 2031).vision, '虚构年度愿景\n第二行');
  await actions.saveVision(1, 2031, '   ');
  const cleared = plannerOf(f).goalYears.find(entry => entry.year === 2031);
  assert.equal(Object.hasOwn(cleared, 'vision'), false);
  assert.equal(cleared.names.length, 8);
});
