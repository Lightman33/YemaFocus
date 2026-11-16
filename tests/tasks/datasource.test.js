import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, freshRecord } from '../../app/store.js';
import { createDataSource, wallTime, conflictList, softwareZone } from '../../app/datasource.js';
import { makeTask, TaskActions } from '../../app/task-actions.js';
import { demoState } from '../../app/demo-data.js';
import { stateToPlanner, plannerToState } from '../../sync/convert.js';
import { unitInfo, merge } from '../../sync/merge.js';
import { updateUnit, deleteUnit } from '../../sync/edit.js';
import { unitKey } from '../../sync/canonical.js';
const NOW = Date.parse('2026-11-13T04:30:00.000Z');
const task = (id = 't') => makeTask('虚构任务', { id, now: NOW, timeZone: 'Asia/Shanghai' });
const planner = () => ({ version: 1, projects: [{ id: 'p', name: '虚构项目' }], tasks: [task()], habits: [], weekNotes: [], deleted: {} });
async function fixture({ state = plannerToState(planner(), 'computer', NOW), joined = true } = {}) {
  const store = new MemoryStore({ ...freshRecord(), state, settings: { joined, deviceId: 'phone' } });
  const source = await createDataSource({ store, now: () => NOW });
  let seq = 0; const actions = new TaskActions(source, { now: () => NOW, id: () => 'new-' + ++seq });
  return { store, source, actions };
}
const changed = (a, b) => [...new Set([...Object.keys(a.units), ...Object.keys(b.units)])].filter(k => JSON.stringify(a.units[k]) !== JSON.stringify(b.units[k])).sort();
const keys = (...paths) => paths.map(p => unitKey(...p)).sort();
const row = source => source.snapshot().planner.tasks.find(t => t.id === 't');
async function verify(f, operation, expected, check) {
  const before = (await f.store.read()).state;
  const receipt = await operation();
  const after = (await f.store.read()).state;
  assert.deepEqual(changed(before, after), expected);
  assert.deepEqual(stateToPlanner(after, { allowConflicts: true }), f.source.snapshot().planner);
  check?.(row(f.source), after); return receipt;
}
const entity = ['entity', 'tasks', 't'];
test('数据来源：软件时区、明确加入、失败不发通知且保留旧值', async () => {
  const f = await fixture({ joined: false });
  assert.equal(f.source.snapshot().today, '2026-11-13');
  await assert.rejects(f.actions.toggle('t'), /第一次同步/);
  const g = await fixture(); let notices = 0; g.source.subscribe(() => notices++);
  const before = g.source.snapshot(); g.store.failNextWrite();
  await assert.rejects(g.actions.toggle('t'), /保存失败/);
  assert.deepEqual(g.source.snapshot(), before); assert.equal(notices, 0);
  assert.equal(softwareZone({ units: {} }).timeZone, 'Asia/Shanghai');
  assert.equal(wallTime(Date.parse('2026-12-31T20:00:00Z'), 'Asia/Shanghai').slice(0, 10), '2027-01-01');
});
test('完成、取消完成只动状态与存在单元；撤销产生新版本', async () => {
  const f = await fixture();
  const receipt = await verify(f, () => f.actions.toggle('t'), keys(entity, ['task-status', 't']), t => { assert.equal(t.done, true); assert.equal(t.doneAt, '2026-11-13 12:30:00'); });
  await verify(f, () => receipt.undo(), keys(entity, ['task-status', 't']), t => assert.equal(t.done, false));
  await f.actions.toggle('t');
  await verify(f, () => f.actions.toggle('t'), keys(entity, ['task-status', 't']), t => assert.equal(t.doneAt, null));
});
test('新建、删除与撤销；删除保留内容单元', async () => {
  const f = await fixture();
  await verify(f, () => f.actions.add('虚构新事项 明天 ！高。'), keys(['entity', 'tasks', 'new-1'], ['task-content', 'new-1'], ['task-status', 'new-1'], ['layout', 'tasks', 'new-1']), () => {
    const t = f.source.snapshot().planner.tasks.find(t => t.id === 'new-1'); assert.equal(t.date, '2026-11-14'); assert.equal(t.priority, 3);
  });
  const removed = await verify(f, () => f.actions.remove('t'), keys(entity), (_t, state) => assert.equal(unitInfo(state.units[unitKey('task-content', 't')]).preferred.deleted, false));
  await removed.undo(); assert.equal(row(f.source).title, '虚构任务');
});
test('放弃与恢复严格保留原因、完整快照与历史（PlannerModel.cs Abandon 1150 / RestoreAbandoned 1184）', async () => {
  const p = planner(); p.tasks[0].pinned = true; p.tasks[0].opaque = { keep: 1.5 };
  const f = await fixture({ state: plannerToState(p, 'computer', NOW) });
  await verify(f, () => f.actions.abandon('t', '  条件变了  '), keys(entity, ['task-status', 't']), t => {
    assert.equal(t.done, true); assert.equal(t.abandoned, true); assert.equal(t.abandonReason, '条件变了');
    assert.equal(t.abandonedAt, '2026-11-13T04:30:00.000Z'); assert.deepEqual(t.abandonPrevious.tasks, p.tasks);
    assert.deepEqual(Object.keys(t.abandonPrevious).sort(), ['deleted', 'habits', 'projects', 'tasks', 'version', 'weekNotes']);
    assert.deepEqual(t.abandonHistory, [{ action: 'abandoned', at: '2026-11-13T04:30:00.000Z', reason: '条件变了' }]); assert.equal(t.pinned, false);
  });
  await verify(f, () => f.actions.restore('t'), keys(entity, ['task-status', 't']), t => {
    assert.equal(t.done, false); assert.equal(t.doneAt, null); assert.equal(t.abandoned, false); assert.equal(t.pinned, true);
    assert.ok(!Object.hasOwn(t, 'abandonedAt')); assert.ok(!Object.hasOwn(t, 'abandonPrevious')); assert.equal(t.abandonReason, '条件变了');
    assert.deepEqual(t.abandonHistory.at(-1), { action: 'restored', at: '2026-11-13T04:30:00.000Z', reason: '条件变了' }); assert.deepEqual(t.opaque, { keep: 1.5 });
  });
});
for (const [label, operation, check] of [
  ['改期', a => a.schedule('t', { date: '2026-11-14' }), t => assert.equal(t.date, '2026-11-14')],
  ['改项目', a => a.patch('t', { project: 'p' }), t => assert.equal(t.project, 'p')],
  ['改备注', a => a.patch('t', { notes: '虚构备注' }), t => assert.equal(t.notes, '虚构备注')],
  ['改标题和优先级', a => a.patch('t', { title: '新标题', priority: 3 }), t => assert.equal(t.priority, 3)]
]) test(label + '只动内容与存在单元', async () => { const f = await fixture(); await verify(f, () => operation(f.actions), keys(entity, ['task-content', 't']), check); });
test('步骤增删改勾独立计数，不修改任务内容或状态', async () => {
  const f = await fixture();
  await verify(f, () => f.actions.addSteps('t', '准备\n\n检查\r\n收尾'), keys(entity, ['layout', 'tasks', 't'], ['step', 't', 'new-1'], ['step', 't', 'new-2'], ['step', 't', 'new-3']), t => assert.equal(t.steps.length, 3));
  await verify(f, () => f.actions.step('t', 'new-1', 'toggle'), keys(entity, ['step', 't', 'new-1']), t => assert.equal(t.steps[0].done, true));
  await verify(f, () => f.actions.step('t', 'new-2', 'text', '再次检查'), keys(entity, ['step', 't', 'new-2']), t => assert.equal(t.steps[1].text, '再次检查'));
  await verify(f, () => f.actions.step('t', 'new-3', 'remove'), keys(entity, ['step', 't', 'new-3'], ['layout', 'tasks', 't']), t => assert.equal(t.steps.length, 2));
});
test('重复规则只读；系列历史可编辑、删除，但取消完成仍交给电脑（T29 接口）', async () => {
  const p = planner(); Object.assign(p.tasks[0], { repeat: { kind: 'Daily' } }); const f = await fixture({ state: plannerToState(p, 'computer', NOW) });
  for (const operation of [() => f.actions.toggle('t'), () => f.actions.abandon('t', ''), () => f.actions.patch('t', { notes: '变更' }), () => f.actions.remove('t')]) await assert.rejects(operation(), /重复任务请先在电脑上完成/);
  const history = planner(); Object.assign(history.tasks[0], { series: 'series-1', done: true }); const g = await fixture({ state: plannerToState(history, 'computer', NOW) });
  await g.actions.patch('t', { notes: '系列历史仍可补备注' });
  assert.equal(g.source.snapshot().planner.tasks[0].notes, '系列历史仍可补备注');
  await assert.rejects(g.actions.toggle('t'), /这条记录来自重复任务/);
  await g.actions.remove('t'); assert.equal(g.source.snapshot().planner.tasks.length, 0);
});
test('冲突：显示候选、保留某份、两段都留着、删除与修改明确解决', async () => {
  const base = plannerToState(planner(), 'computer', NOW), key = unitKey('task-content', 't'), value = base.units[key].versions[0].value;
  const conflict = merge(updateUnit(base, key, 'computer', { ...value, notes: '电脑备注' }), updateUnit(base, key, 'phone', { ...value, notes: '手机备注' }));
  const f = await fixture({ state: conflict });
  const c = f.source.snapshot().conflicts[0]; assert.equal(c.key, key); assert.equal(c.candidates.length, 2); assert.equal(c.both, true);
  await assert.rejects(f.actions.patch('t', { notes: '不能直接覆盖' }), /请先选择/);
  await f.source.resolve(key, { type: 'both' }); assert.equal(row(f.source).notes.split('\n\n').length, 2); assert.equal(f.source.snapshot().conflicts.length, 0);
  const g = await fixture({ state: conflict }); const chosen = c.candidates[1]; await g.source.resolve(key, { branch: chosen.branch }); assert.equal(row(g.source).notes, chosen.value.notes);
  const ek = unitKey(...entity), dc = merge(deleteUnit(base, ek, 'computer'), updateUnit(base, ek, 'phone', true));
  for (const deleted of [false, true]) {
    const h = await fixture({ state: dc }), info = h.source.snapshot().conflicts[0]; assert.equal(info.deleteConflict, true);
    await h.source.resolve(ek, { branch: info.candidates.find(v => v.deleted === deleted).branch }); assert.equal(Boolean(row(h.source)), !deleted);
  }
});
test('有别处冲突仍可编辑普通任务，冲突分支完整保留', async () => {
  const state = demoState(NOW), f = await fixture({ state }); const key = unitKey('task-content', 'demo-task-12');
  await f.actions.toggle('demo-task-0'); assert.deepEqual((await f.store.read()).state.units[key], state.units[key]);
});
test('本机事务读到更新的数据时合并；撤销不覆盖其他任务或字段的新内容', async () => {
  const f = await fixture(); const receipt = await f.actions.toggle('t');
  await f.actions.patch('t', { notes: '后来记下的' }); await receipt.undo();
  assert.equal(row(f.source).done, false); assert.equal(row(f.source).notes, '后来记下的');
  const r = await f.actions.patch('t', { notes: '一次修改' }); await f.actions.patch('t', { notes: '更新修改' });
  await assert.rejects(r.undo(), /已有新改动/); assert.equal(row(f.source).notes, '更新修改');
});
test('示例覆盖 40+ 任务、三个项目和冲突；引擎挂接只读已落盘通知', async () => {
  const f = await fixture({ state: demoState(NOW) }); const s = f.source.snapshot();
  assert.ok(s.planner.tasks.length >= 40); assert.equal(s.planner.projects.length, 3); assert.equal(s.conflicts.length, 1);
  let notify, count = 0; f.source.attachEngine({ subscribe(listener) { notify = listener; return () => {}; }, localChanged() { count++; } });
  await f.actions.toggle('demo-task-0'); assert.equal(count, 1); notify();
});

test('未知字段的小数、-0 和嵌套值不被副本改写；勾完成仍只动状态', async () => {
  const p = planner(); p.tasks[0].opaque = { negativeZero: -0, fractional: 1.25, nested: [{ keep: '未知字段' }] };
  const f = await fixture({ state: plannerToState(p, 'computer', NOW - 10000) });
  assert.ok(Object.is(row(f.source).opaque.negativeZero, -0));
  await verify(f, () => f.actions.toggle('t'), keys(entity, ['task-status', 't']), t => assert.ok(Object.is(t.opaque.negativeZero, -0)));
});
test('并行操作与同设备两标签页不会用旧整单元覆盖彼此字段', async () => {
  const f = await fixture();
  const second = await createDataSource({ store: f.store, now: () => NOW });
  const token = second.snapshot().editToken;
  await f.actions.patch('t', { priority: 3 });
  const otherActions = new TaskActions(second, { now: () => NOW });
  await otherActions.patch('t', { notes: '另一页刚写的备注' }, { baseToken: token });
  await f.source.refresh(); assert.equal(row(f.source).priority, 3); assert.equal(row(f.source).notes, '另一页刚写的备注');
  await Promise.all([f.actions.patch('t', { title: '新标题' }), f.actions.patch('t', { notes: '并行备注' })]);
  assert.equal(row(f.source).title, '新标题'); assert.equal(row(f.source).notes, '并行备注');
  assert.equal(f.source.snapshot().conflicts.length, 0);
});
test('冲突解决只覆盖实际看过的候选，新到的第三份继续保留；失败不更新投影', async () => {
  const base = plannerToState(planner(), 'computer', NOW), key = unitKey('task-content', 't'), value = base.units[key].versions[0].value;
  const conflict = merge(updateUnit(base, key, 'computer', { ...value, notes: 'A' }), updateUnit(base, key, 'phone', { ...value, notes: 'B' }));
  const f = await fixture({ state: conflict }); const shown = f.source.snapshot();
  await f.store.update(r => { r.state = merge(r.state, updateUnit(base, key, 'third', { ...value, notes: '新来的C' })); });
  await f.source.refresh();
  await f.source.resolve(key, { branch: shown.conflicts[0].candidates[0].branch, observed: shown.editToken });
  assert.equal(f.source.snapshot().conflicts[0].candidates.length, 2);
  assert.ok(f.source.snapshot().conflicts[0].candidates.some(c => c.value.notes === '新来的C'));
  const before = f.source.snapshot(); f.store.failNextWrite();
  await assert.rejects(f.source.resolve(key, { type: 'both' }), /保存失败/);
  assert.deepEqual(f.source.snapshot(), before);
});
test('未知 Windows 时区必须选地区；时区和 UI 设置留在本机，不改同步单元', async () => {
  const base = updateUnit(plannerToState(planner(), 'computer', NOW), unitKey('setting', 'TimeZone'), 'computer', 'Unknown Fictional Time');
  const f = await fixture({ state: base }); assert.equal(f.source.snapshot().today, null);
  await assert.rejects(f.actions.toggle('t'), /选择软件时区/);
  await f.source.selectTimeZone('America/Los_Angeles');
  assert.equal(f.source.snapshot().today, '2026-11-12');
  assert.equal(f.source.snapshot().timeZoneUnknown, 'Unknown Fictional Time');
  assert.deepEqual((await f.store.read()).state, base);
  const otherZone = updateUnit(base, unitKey('setting', 'TimeZone'), 'computer', 'Another Unknown Fictional Time');
  assert.equal(softwareZone(otherZone, (await f.store.read()).settings).timeZone, null, '电脑改成另一个未知时区后，不能复用旧映射');
  await f.source.saveUI({ mode: 'project', expanded: { done: true }, scrollTop: 200 });
  assert.deepEqual(f.source.uiState(), { mode: 'project', expanded: { done: true }, scrollTop: 200 });
});
test('实体删除与步骤修改冲突先确认任务存在，再解决步骤；三种解决都只动必要单元', async () => {
  const p = planner(); p.tasks[0].steps = [{ id: 's', text: '初始步骤', done: false }];
  const base = plannerToState(p, 'computer', NOW), ek = unitKey(...entity), sk = unitKey('step', 't', 's');
  let conflict = merge(deleteUnit(base, ek, 'computer'), updateUnit(base, ek, 'phone', true));
  conflict = merge(conflict, merge(updateUnit(base, sk, 'computer', { id: 's', text: 'A', done: false }), updateUnit(base, sk, 'phone', { id: 's', text: 'B', done: false })));
  const f = await fixture({ state: conflict }), c = f.source.snapshot().conflicts.find(c => c.key === sk);
  await assert.rejects(f.source.resolve(sk, { branch: c.candidates[0].branch }), /先确认保留任务/);
  const e = f.source.snapshot().conflicts.find(c => c.key === ek); await f.source.resolve(ek, { branch: e.candidates.find(c => !c.deleted).branch });
  const before = (await f.store.read()).state; await f.source.resolve(sk, { type: 'both' }); const after = (await f.store.read()).state;
  assert.deepEqual(changed(before, after), keys(entity, ['step', 't', 's']));
  assert.match(row(f.source).steps[0].text, /A\n\nB/);
});
test('改期保留跨天跨度和旧提醒字段；清日期可撤销，项目只选已有项', async () => {
  const p = planner(); Object.assign(p.tasks[0], { date: '2026-11-10', endDate: '2026-11-11', time: '09:00', endTime: '18:00', remindTime: '08:00', remindedAt: '旧提醒', postponed: 2 });
  const f = await fixture({ state: plannerToState(p, 'computer', NOW) });
  await f.actions.schedule('t', { date: '2026-11-14' }); let t = row(f.source);
  assert.equal(t.endDate, '2026-11-15'); assert.equal(t.postponed, 3); assert.equal(t.endTime, '18:00'); assert.equal(t.remindTime, '08:00'); assert.equal(t.remindedAt, '');
  const receipt = await f.actions.schedule('t', { date: null }); assert.equal(row(f.source).date, null); assert.ok(!Object.hasOwn(row(f.source), 'endDate'));
  await receipt.undo(); assert.equal(row(f.source).endDate, '2026-11-15');
  await assert.rejects(f.actions.patch('t', { project: 'not-existing' }), /只能选择已有项目/);
  await assert.rejects(f.actions.schedule('t', { date: '2026-02-30' }), /无效/);
});
test('本机状态在事务期间被远端更新时，其他单元和未展示的新改动不会丢', async () => {
  const f = await fixture(); const base = (await f.store.read()).state, key = unitKey('task-content', 't');
  const shown = f.source.snapshot();
  await f.store.update(r => { r.state = updateUnit(base, key, 'computer', { ...base.units[key].versions[0].value, title: '远端新标题' }); });
  await f.actions.patch('t', { notes: '用户尚在输入' }, { baseToken: shown.editToken });
  assert.equal(f.source.snapshot().conflicts.length, 1);
  assert.ok(f.source.snapshot().conflicts[0].candidates.some(c => c.value.title === '远端新标题'));
  assert.ok(f.source.snapshot().conflicts[0].candidates.some(c => c.value.notes === '用户尚在输入'));
});
test('内容编辑与步骤编辑写真实 UTC 元数据，不靠修改无关业务单元更新时间', async t => {
  const p = planner(); p.tasks[0].updated = '2020-01-01T00:00:00Z'; p.tasks[0].steps = [{ id: 's', text: '步骤', done: false }];
  const f = await fixture({ state: plannerToState(p, 'computer', Date.parse('2020-01-01T00:00:00Z')) });
  await f.actions.patch('t', { notes: '新内容' });
  let state = (await f.store.read()).state;
  assert.equal(unitInfo(state.units[unitKey('task-content', 't')]).preferred.sources[0].stamp.updatedAt, NOW);
  assert.equal(unitInfo(state.units[unitKey(...entity)]).preferred.sources[0].stamp.legacyUpdated, '2026-11-13T04:30:00.000Z');
  assert.equal(row(f.source).updated, '2026-11-13T04:30:00.000Z');
  await f.actions.step('t', 's', 'toggle'); state = (await f.store.read()).state;
  assert.equal(unitInfo(state.units[unitKey('step', 't', 's')]).preferred.sources[0].stamp.updatedAt, NOW);
  assert.equal(unitInfo(state.units[unitKey(...entity)]).preferred.sources[0].stamp.updatedAt, NOW);
  assert.equal(row(f.source).updated, '2026-11-13T04:30:00.000Z');
});

test('冲突保留某份/两段都留着只动内容与存在单元；确认实体删除只动存在', async () => {
  const base = plannerToState(planner(), 'computer', NOW), key = unitKey('task-content', 't'), value = base.units[key].versions[0].value;
  const state = merge(updateUnit(base, key, 'computer', { ...value, notes: 'A' }), updateUnit(base, key, 'phone', { ...value, notes: 'B' }));
  for (const type of ['one', 'both']) {
    const f = await fixture({ state }); const c = f.source.snapshot().conflicts[0], before = (await f.store.read()).state;
    await f.source.resolve(key, type === 'both' ? { type } : { branch: c.candidates[0].branch });
    assert.deepEqual(changed(before, (await f.store.read()).state), keys(entity, ['task-content', 't']));
  }
  const ek = unitKey(...entity), f = await fixture({ state: merge(deleteUnit(base, ek, 'computer'), updateUnit(base, ek, 'phone', true)) });
  const before = (await f.store.read()).state; await f.source.resolve(ek, { branch: f.source.snapshot().conflicts[0].candidates.find(c => c.deleted).branch });
  assert.deepEqual(changed(before, (await f.store.read()).state), [ek]);
});
test('放弃/恢复重复多轮不嵌套快照；无原因仍保留历史', async () => {
  const f = await fixture(); await f.actions.abandon('t', ''); await f.actions.restore('t'); await f.actions.abandon('t', '条件变了');
  let t = row(f.source); assert.equal(t.abandonHistory.length, 3); assert.equal(t.abandonHistory[0].reason, '');
  assert.ok(!Object.hasOwn(t.abandonPrevious.tasks[0], 'abandonPrevious'));
  await f.actions.restore('t'); t = row(f.source); assert.equal(t.abandonHistory.length, 4); assert.equal(t.abandonHistory.at(-1).reason, '条件变了');
});
test('重复任务拒绝步骤变更与恢复；未加入也拒绝新建/解决冲突', async () => {
  const p = planner(); p.tasks[0].repeat = { kind: 'Daily' }; p.tasks[0].steps = [{ id: 's', text: '步骤', done: false }];
  p.tasks[0].done = true; p.tasks[0].abandoned = true;
  const f = await fixture({ state: plannerToState(p, 'computer', NOW) });
  await assert.rejects(f.actions.step('t', 's', 'toggle'), /重复任务请先在电脑上完成/); await assert.rejects(f.actions.restore('t'), /重复任务请先在电脑上完成/);
  const g = await fixture({ joined: false }); await assert.rejects(g.actions.add('虚构新建'), /第一次同步/); await assert.rejects(g.source.resolve(unitKey(...entity), { type: 'both' }), /第一次同步/);
});
test('只读专注统计与电脑版一致：番茄计个数，正计时计分钟，未完成/休息不计', async () => {
  let state = plannerToState(planner(), 'computer', NOW);
  for (const [id, kind, status, minutes, link] of [['1', '番茄', '完成', '25', 't|虚构'], ['2', '正计时', '完成', '12.5', 't|虚构'], ['3', '番茄', '打断', '2', 't|虚构'], ['4', '休息', '完成', '5', 't|虚构']]) state = updateUnit(state, unitKey('record', id), 'computer', { day: '2026-11-13', columns: [kind, '2026-11-13 08:00:00', '', minutes, '', status, '', link] });
  const f = await fixture({ state }); assert.deepEqual(f.source.snapshot().focus.t, { count: 1, minutes: 37.5 });
});

test('改期到今天时，保留的时刻已过去则先改时间（PlannerForm.MoveTask）；未过时刻允许移动', async () => {
  const p = planner(); Object.assign(p.tasks[0], { date: '2026-11-14', time: '09:00' });
  const f = await fixture({ state: plannerToState(p, 'computer', NOW) });
  await assert.rejects(f.actions.schedule('t', { date: '2026-11-13' }), /已经过去了，请先改时间/);
  assert.equal(row(f.source).date, '2026-11-14'); await f.actions.patch('t', { time: '15:00' });
  await f.actions.schedule('t', { date: '2026-11-13' }); assert.equal(row(f.source).date, '2026-11-13');
});
