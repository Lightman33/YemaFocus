import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDataSource, conflictList } from '../../app/datasource.js';
import { GoalActions } from '../../app/goals-actions.js';
import { TaskActions } from '../../app/task-actions.js';
import { DEFAULT_DOMAINS, domainNames, goalsInDomain, goalGroups, goalPomoStats, tasksForGoal } from '../../app/goals-model.js';
import { plannerToState, stateToPlanner } from '../../app/goal-sync.js';
import { freshRecord, MemoryStore } from '../../app/store.js';
import { decodeLegacy, encodeLegacy, unitKey as K } from '../../sync/canonical.js';
import { updateUnit } from '../../sync/edit.js';
import { merge, unitInfo } from '../../sync/merge.js';
import { bucketOf, joinChunks, splitState } from '../../sync/pack.js';
import { harness } from '../pack/helpers.js';

const vector = JSON.parse(await readFile(new URL('../../../sync-spec/interop/t42-goals.json', import.meta.url)));
const NOW = Date.parse('2026-11-20T04:00:00Z');
const GOAL = 't42-star', OTHER = 't42-model', TASK = 't42-task';
const seed = () => plannerToState(vector.planner, 'seed');
const snapshot = source => source.snapshot().planner;
const changes = (before, after) => Object.keys(after.units).filter(key => JSON.stringify(after.units[key]) !== JSON.stringify(before.units[key])).sort();
const changed = (...paths) => paths.map(path => K(...path)).sort();
async function sourceFor(state, deviceId = 'phone', joined = true) {
  const store = new MemoryStore({ ...freshRecord(), state, settings: { joined, deviceId } });
  const source = await createDataSource({ store, now: () => NOW });
  const stateOf = async () => (await store.read()).state;
  let next = 0;
  return { store, source, stateOf, actions: new GoalActions(source, { id: () => deviceId + '-goal-' + ++next }) };
}
function goal(planner, id = GOAL) { return planner.goals?.find(row => row.id === id); }

test('两端读同一份向量，目标、年度领域、任务关联和小数额外字段走独立的旧桶单元', () => {
  const state = seed();
  for (const { path, value } of vector.units) {
    const key = K(...path);
    assert.equal(bucketOf(key), 'other');
    assert.deepEqual(decodeLegacy(unitInfo(state.units[key]).preferred.value), value);
  }
  assert.equal(Object.hasOwn(unitInfo(state.units[K('task-content', TASK)]).preferred.value, 'goalId'), false);
  const copy = joinChunks(Object.values(splitState(state)));
  const projection = stateToPlanner(copy);
  assert.deepEqual(projection.goalYears, vector.planner.goalYears);
  assert.deepEqual(projection.goals, [...vector.planner.goals].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(projection.tasks, vector.planner.tasks);
});

test('默认名称、首开继承上一年、改名仅影响当年；未连接不落盘', async () => {
  const blocked = await sourceFor(seed(), 'phone', false);
  assert.deepEqual(domainNames(snapshot(blocked.source), 2025), DEFAULT_DOMAINS);
  await assert.rejects(blocked.actions.ensureYear(2027), /第一次同步/);
  const f = await sourceFor(seed());
  await f.actions.ensureYear(2027);
  assert.equal(domainNames(snapshot(f.source), 2027)[0], '星图·学习');
  await f.actions.rename(2026, 0, '观星·学习');
  assert.equal(domainNames(snapshot(f.source), 2026)[0], '观星·学习');
  assert.equal(domainNames(snapshot(f.source), 2027)[0], '星图·学习');
  await f.actions.ensureYear(2025);
  assert.deepEqual(domainNames(snapshot(f.source), 2025), DEFAULT_DOMAINS);
  assert.deepEqual(goalGroups(snapshot(f.source)).map(group => group.label), ['2026 · 观星·学习', '2026 · 体验·突破']);
});

test('目标增改、勾选、取消、上移、删除逐单元同步往返', async () => {
  const f = await sourceFor(seed());
  const before = await f.stateOf(), id = 'phone-goal-1';
  await f.actions.save(2026, 0, { title: '  编一个虚构故事  ', notes: '甲\r\n乙' });
  assert.deepEqual(changes(before, await f.stateOf()), changed(['goal', id]));
  await f.actions.save(2026, 0, { id, title: '编两个虚构故事', notes: '更新备注' });
  const beforeMove = await f.stateOf();
  await f.actions.move(id, -1);
  assert.deepEqual(changes(beforeMove, await f.stateOf()), changed(['goal', id]));
  assert.equal(goalsInDomain(snapshot(f.source), 2026, 0)[0].id, id);
  await f.actions.toggle(id, true, '2026-11-20');
  const projected = stateToPlanner(joinChunks(Object.values(splitState(await f.stateOf()))));
  assert.deepEqual(goal(projected, id), { id, year: 2026, domain: 0, title: '编两个虚构故事', notes: '更新备注', order: 1, done: true, doneOn: '2026-11-20' });
  await f.actions.toggle(id, false, '2026-11-20');
  assert.equal(goal(snapshot(f.source), id).done, false);
  assert.equal(goal(snapshot(f.source), id).doneOn, null);
  await f.actions.remove(id);
  assert.equal(unitInfo((await f.stateOf()).units[K('goal', id)]).preferred.deleted, true);
  assert.equal(goal(stateToPlanner(await f.stateOf()), id), undefined);
  const empty = await sourceFor(plannerToState({ tasks: [] }, 'seed'));
  await empty.actions.save(2026, 0, { title: '第一条', notes: '' });
  assert.equal(goal(snapshot(empty.source), id).title, '第一条');
  await empty.actions.remove(id);
  assert.equal(goal(snapshot(empty.source), id), undefined);
});

test('T46-14 撤销只恢复完成字段，保留同步备注并拒绝覆盖更新的完成日期或冲突', async () => {
  const f = await sourceFor(seed());
  await f.actions.toggle(GOAL, true, '2026-10-03');
  const cancel = await f.actions.toggle(GOAL, false);
  const key = K('goal', GOAL);
  const current = () => goal(snapshot(f.source));
  const note = '电脑后改的虚构备注';
  const state = await f.stateOf();
  const remote = updateUnit(state, key, 'computer', encodeLegacy({ ...current(), notes: note }));
  await f.store.update(row => { row.state = remote; });
  await cancel.undo();
  assert.equal(current().done, true);
  assert.equal(current().doneOn, '2026-10-03');
  assert.equal(current().notes, note);

  const older = await f.actions.toggle(GOAL, false);
  await f.actions.toggle(GOAL, true, '2026-11-20');
  await assert.rejects(older.undo(), /已有新改动/);
  assert.equal(current().doneOn, '2026-11-20');

  const before = await f.stateOf(), observed = current();
  const latest = await f.actions.toggle(GOAL, false);
  const concurrent = updateUnit(before, key, 'other', encodeLegacy({ ...observed, notes: '另一台虚构编辑' }));
  const local = await f.stateOf();
  await f.store.update(row => { row.state = merge(local, concurrent); });
  await assert.rejects(latest.undo(), /已有新改动/);
  assert.equal(f.source.snapshot().conflicts.find(conflict => conflict.key === key).candidates.length, 2);
});

test('两设备不同目标互不冲突，同一目标提示两个版本并可处理', async () => {
  const h = harness();
  const a = await h.device('a', seed());
  await a.store.updateMetadata(row => { row.settings.joined = true; });
  assert.equal((await a.engine.syncNow()).ok, true);
  const b = await h.device('b');
  assert.equal((await b.engine.join()).ok, true);
  await b.store.updateMetadata(row => { row.settings.joined = true; });
  for (const d of [a, b]) {
    d.source = await createDataSource({ store: d.store, now: h.clock.now, tasksFirst: true });
    d.source.attachEngine(d.engine);
    d.actions = new GoalActions(d.source);
  }
  await a.actions.save(2026, 0, { id: GOAL, title: '手机画虚构星图', notes: '笔记 A' });
  await b.actions.save(2026, 1, { id: OTHER, title: '电脑搭纸板模型', notes: '笔记 B' });
  h.clock.advance();
  assert.equal((await a.engine.syncNow()).ok, true);
  assert.equal((await b.engine.syncNow()).ok, true);
  h.clock.advance();
  assert.equal((await a.engine.syncNow()).ok, true);
  await a.source.refresh();
  assert.equal(goal(snapshot(a.source)).title, '手机画虚构星图');
  assert.equal(goal(snapshot(a.source), OTHER).title, '电脑搭纸板模型');
  assert.deepEqual(a.source.snapshot().conflicts, []);
  await b.source.refresh();
  await a.actions.save(2026, 0, { id: GOAL, title: '甲改同一目标', notes: '甲' });
  await b.actions.toggle(GOAL, false, '2026-11-20');
  h.clock.advance();
  assert.equal((await a.engine.syncNow()).ok, true);
  assert.equal((await b.engine.syncNow()).ok, true);
  await b.source.refresh();
  const observed = b.source.snapshot(), conflict = observed.conflicts.find(c => c.key === K('goal', GOAL));
  assert.ok(conflict);
  assert.equal(conflict.candidates.length, 2);
  assert.equal(conflict.both, false);
  await b.source.resolve(conflict.key, { branch: conflict.candidates.find(c => c.value.title === '甲改同一目标').branch, observed: observed.editToken });
  assert.equal(goal(snapshot(b.source)).title, '甲改同一目标');
  assert.deepEqual(b.source.snapshot().conflicts, []);
});

test('编辑与删除同一目标保留候选，单边删除、恢复关联和取消关联均可往返', async () => {
  const a = await sourceFor(seed(), 'a'), b = await sourceFor(seed(), 'b');
  await a.actions.remove(GOAL);
  await b.actions.save(2026, 0, { id: GOAL, title: '电脑留下的标题', notes: '仍在' });
  assert.equal(conflictList(merge(await a.stateOf(), await b.stateOf()))[0].deleteConflict, true);
  assert.equal(snapshot(a.source).tasks[0].goalId, GOAL);
  assert.deepEqual(goalGroups(snapshot(a.source)).flatMap(g => g.goals.map(row => row.id)), [OTHER]);

  const actions = new TaskActions(a.source);
  const before = await a.stateOf();
  await actions.setGoal(TASK, OTHER);
  let state = await a.stateOf();
  assert.deepEqual(changes(before, state), changed(['entity', 'tasks', TASK], ['task-goal', TASK]));
  assert.equal(snapshot(a.source).tasks[0].goalId, OTHER);
  await actions.setGoal(TASK, '');
  state = await a.stateOf();
  assert.equal(unitInfo(state.units[K('task-goal', TASK)]).preferred.deleted, true);
  assert.equal(Object.hasOwn(stateToPlanner(state).tasks[0], 'goalId'), false);
  await actions.setGoal(TASK, OTHER);
  assert.equal(stateToPlanner(await a.stateOf()).tasks[0].goalId, OTHER);
});

test('任务内容并发可与关联并行，关联冲突不可合并两段，删除任务保留存在冲突', async () => {
  const a = await sourceFor(seed(), 'a'), b = await sourceFor(seed(), 'b'), c = await sourceFor(seed(), 'c');
  await new TaskActions(a.source).setGoal(TASK, OTHER);
  await new TaskActions(b.source).patch(TASK, { title: '另一端改标题' });
  const combined = merge(await a.stateOf(), await b.stateOf());
  assert.deepEqual(conflictList(combined), []);
  assert.equal(stateToPlanner(combined).tasks[0].title, '另一端改标题');
  assert.equal(stateToPlanner(combined).tasks[0].goalId, OTHER);
  await new TaskActions(c.source).setGoal(TASK, null);
  const conflict = conflictList(merge(await a.stateOf(), await c.stateOf())).find(item => item.path[0] === 'task-goal');
  assert.equal(conflict.taskId, TASK);
  assert.equal(conflict.both, false);
  const removed = await sourceFor(seed(), 'pc');
  await new TaskActions(removed.source).remove(TASK);
  assert.ok(conflictList(merge(await a.stateOf(), await removed.stateOf())).some(item => item.path[0] === 'entity' && item.deleteConflict));
});

test('番茄只算开始于指定年份、完成、关联多个任务的记录，系列号去重', () => {
  const planner = { tasks: [
    { id: 'a', goalId: GOAL }, { id: 'b', goalId: GOAL }, { id: 'instance', series: 'b', goalId: GOAL },
    { id: 'trashed', goalId: GOAL, trashedAt: '2026-11-01' }, { id: 'elsewhere', goalId: OTHER }
  ] };
  const make = (kind, status, start, end, min, link) => ({ columns: [kind, start, end, String(min), '虚构事项', status, '', link] });
  const t = '2026-12-31 23:50:00', e = '2027-01-01 00:15:00';
  const records = [
    make('番茄', '完成', t, e, 25, 'a|旧标题'), make('番茄', '完成', t, e, 15.5, 'b|本期任务'),
    ...[['正计时', '完成', 'a|甲'], ['番茄', '放弃', 'a|甲'], ['休息', '完成', 'a|甲'], ['番茄', '完成', 'aa|甲'],
      ['番茄', '完成', 'trashed|甲'], ['番茄', '完成', 'elsewhere|甲'], ['番茄', '完成', '']].map(([kind, status, link]) => make(kind, status, t, e, 10, link)),
    make('番茄', '完成', e, '2027-01-01 00:35:00', 20, 'a|任务')
  ];
  const tasks = tasksForGoal(planner, GOAL);
  assert.deepEqual(goalPomoStats(tasks, records, 2026), { count: 2, minutes: 40.5 });
  assert.deepEqual(goalPomoStats(tasks, records, 2027), { count: 1, minutes: 20 });
});

test('旧编辑页收到同条目标的新版本后再保存，两份文字仍可选择', async () => {
  const a = await sourceFor(seed(), 'a'), b = await sourceFor(seed(), 'b');
  const opened = a.source.snapshot().editToken;
  await b.actions.save(2026, 0, { id: GOAL, title: '远端在编辑期间更新', notes: '远端备注' });
  const incoming = await b.stateOf();
  await a.store.update(record => { record.state = merge(record.state, incoming); });
  await a.source.refresh();
  await a.actions.save(2026, 0, { id: GOAL, title: '本机编辑框文字', notes: '原有备注' }, opened);
  const conflict = a.source.snapshot().conflicts.find(row => row.path[0] === 'goal');
  assert.deepEqual(conflict.candidates.map(row => row.value.title).sort(), ['本机编辑框文字', '远端在编辑期间更新'].sort());
});

test('同序目标可上移，顺序确定后下一次独立修改只触及一条目标', async () => {
  const planner = structuredClone(vector.planner);
  planner.goals[0].order = 1;
  planner.goals[1].domain = 0;
  planner.goals.push({ ...planner.goals[0], id: 't42-zero', order: 1 });
  const f = await sourceFor(plannerToState(planner, 'seed'));
  await f.actions.move('t42-zero', -1);
  assert.deepEqual(goalsInDomain(snapshot(f.source), 2026, 0).map(row => row.id), [OTHER, 't42-zero', GOAL]);
  const before = await f.stateOf();
  await f.actions.move(GOAL, -1);
  assert.deepEqual(changes(before, await f.stateOf()), changed(['goal', GOAL]));
  assert.deepEqual(goalsInDomain(snapshot(f.source), 2026, 0).map(row => row.id), [OTHER, GOAL, 't42-zero']);
});
