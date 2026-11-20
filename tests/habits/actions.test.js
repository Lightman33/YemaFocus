import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, habit, planner, row, savedState, savedPlanner, TODAY, NOW } from './helpers.js';
import { createDataSource } from '../../app/datasource.js';
import { HabitActions } from '../../app/habit-actions.js';
import { plannerToState, stateToPlanner } from '../../sync/convert.js';
import { merge, unitInfo } from '../../sync/merge.js';
import { updateUnit, deleteUnit } from '../../sync/edit.js';
import { unitKey, canonical } from '../../sync/canonical.js';
const key = day => unitKey('habit-check', 'h', day);
const entity = unitKey('entity', 'habits', 'h');
const changed = (a, b) => [...new Set([...Object.keys(a.units), ...Object.keys(b.units)])].filter(k => canonical(a.units[k] || null) !== canonical(b.units[k] || null)).sort();

test('打卡→取消→补打→撤销：精确单元键和值；取消/撤销均为 false 活单元，日期显示时间 UTC', async () => {
  const f = await fixture(); let before = await savedState(f.store);
  await f.actions.toggle('h', TODAY); let after = await savedState(f.store);
  assert.deepEqual(changed(before, after), [entity, key(TODAY)].sort());
  assert.equal(unitInfo(after.units[key(TODAY)]).preferred.value, true);
  assert.equal(unitInfo(after.units[key(TODAY)]).preferred.sources[0].stamp.legacyCheckEdit, new Date(NOW).toISOString());
  assert.deepEqual(row(f.source).checks, [TODAY]); assert.equal(row(f.source).checkEdits[TODAY], new Date(NOW).toISOString());
  f.clock.advance(); await f.actions.toggle('h', TODAY); after = await savedState(f.store);
  assert.equal(unitInfo(after.units[key(TODAY)]).preferred.value, false); assert.equal(unitInfo(after.units[key(TODAY)]).preferred.deleted, false);
  assert.deepEqual(row(f.source).checks, []); assert.ok(Object.hasOwn(row(f.source).checkEdits, TODAY));
  f.clock.advance(); const receipt = await f.actions.toggle('h', '2026-11-07');
  assert.equal(unitInfo((await savedState(f.store)).units[key('2026-11-07')]).preferred.value, true);
  f.clock.advance(); await receipt.undo(); after = await savedState(f.store);
  assert.equal(unitInfo(after.units[key('2026-11-07')]).preferred.value, false); assert.equal(unitInfo(after.units[key('2026-11-07')]).preferred.deleted, false);
  assert.equal(row(f.source).checkEdits['2026-11-07'], new Date(f.clock.now()).toISOString());
  assert.deepEqual(stateToPlanner(after), f.source.snapshot().planner);
});
test('撤销取消会重新打卡；撤销只改那一天，另一日期和未知 journal/定义原样保留', async () => {
  const initial = planner([habit({ checks: [TODAY], future: { keep: true } })]), f = await fixture({ state: plannerToState(initial, 'computer', NOW) });
  const receipt = await f.actions.toggle('h', TODAY); f.clock.advance(); await f.actions.toggle('h', '2026-11-12');
  f.clock.advance(); await receipt.undo();
  assert.deepEqual(row(f.source).checks, ['2026-11-12', TODAY]);
  assert.deepEqual(row(f.source).journal, initial.habits[0].journal); assert.deepEqual(row(f.source).future, { keep: true });
});
test('不能撤销该格子之后的新编辑；写失败不发布假成功，上传失败仍保留本机', async () => {
  const f = await fixture(); f.store.failNextWrite();
  await assert.rejects(f.actions.toggle('h', TODAY), /保存失败/); assert.deepEqual(row(f.source).checks, []);
  let notified = 0; f.source.attachEngine({ localChanged() { notified++; throw new Error('虚构断网'); } });
  const receipt = await f.actions.toggle('h', TODAY); f.clock.advance(); await f.actions.toggle('h', TODAY); f.clock.advance(); await f.actions.toggle('h', TODAY);
  await assert.rejects(receipt.undo(), /新改动/); assert.equal(notified, 3);
  assert.deepEqual((await savedPlanner(f.store)).habits[0].checks, [TODAY]);
});
test('未加入、未知时区、延后加载、归档、超过补打窗口都不能写；非计划日期仍能打', async () => {
  const f = await fixture({ joined: false }); await assert.rejects(f.actions.toggle('h', TODAY), /第一次同步/);
  const loading = await fixture({ tasksFirst: true }); await assert.rejects(loading.actions.toggle('h', TODAY));
  const zone = await fixture({ state: updateUnit(plannerToState(planner(), 'computer'), unitKey('setting', 'TimeZone'), 'computer', 'Unknown fiction zone') });
  await assert.rejects(zone.actions.toggle('h', TODAY), /软件时区/);
  const archived = await fixture({ state: plannerToState(planner([habit({ archived: true })]), 'computer') }); await assert.rejects(archived.actions.toggle('h', TODAY), /归档/);
  const g = await fixture({ state: plannerToState(planner([habit({ kind: 'Weekdays', weekMask: 1, start: '2026-11-12', end: '2026-11-12' })]), 'computer') });
  for (const day of ['2026-11-06', '2026-11-14', '2026-02-30']) await assert.rejects(g.actions.toggle('h', day), /过去六天/);
  await g.actions.toggle('h', '2026-11-07'); await g.actions.toggle('h', TODAY); assert.deepEqual(row(g.source).checks, ['2026-11-07', TODAY]);
});
test('同设备多个来源同时打不同日期，首个 checkEdits 缺省也不能互相覆盖', async () => {
  const f = await fixture({ state: plannerToState({ habits: [{ id: 'h', name: '虚构', kind: 'Daily', start: '2026-01-01', checks: [] }] }, 'computer') });
  const other = await createDataSource({ store: f.store, now: () => f.clock.now() }), actions = new HabitActions(other, { now: () => f.clock.now() });
  await Promise.all([f.actions.toggle('h', TODAY), actions.toggle('h', '2026-11-12')]);
  await f.source.refresh(); assert.deepEqual(row(f.source).checks, ['2026-11-12', TODAY]);
  assert.deepEqual(Object.keys(row(f.source).checkEdits).sort(), ['2026-11-12', TODAY]);
});
test('habit-check 冲突不能直接 toggle；选择 false 同时更新存在单元及 checkEdits', async () => {
  const base = plannerToState(planner(), 'seed', NOW), state = merge(updateUnit(base, key(TODAY), 'computer', true), updateUnit(base, key(TODAY), 'phone-old', false));
  const f = await fixture({ state }); await assert.rejects(f.actions.toggle('h', TODAY), /两边都改过/);
  const before = await savedState(f.store), snapshot = f.source.snapshot(), conflict = snapshot.conflicts.find(c => c.key === key(TODAY));
  assert.deepEqual(conflict.candidates.map(c => c.value), [false, true]);
  await f.source.resolve(conflict.key, { branch: conflict.candidates.find(c => c.value === false).branch, observed: snapshot.editToken });
  const after = await savedState(f.store); assert.deepEqual(changed(before, after), [entity, key(TODAY)].sort());
  assert.equal(unitInfo(after.units[key(TODAY)]).conflict, false); assert.equal(unitInfo(after.units[key(TODAY)]).preferred.value, false);
  assert.equal(Object.hasOwn(unitInfo(after.units[key(TODAY)]).preferred.sources[0].stamp, 'legacyUpdated'), false);
  assert.equal(row(f.source).checkEdits[TODAY], new Date(NOW).toISOString()); assert.deepEqual(row(f.source).checks, []);
});
test('冲突页面打开后又到的第三分支保留；父实体删除冲突先处理', async () => {
  const base = plannerToState(planner(), 'seed', NOW), state = merge(updateUnit(base, key(TODAY), 'a', true), updateUnit(base, key(TODAY), 'b', false));
  const f = await fixture({ state }), seen = f.source.snapshot(), conflict = seen.conflicts.find(c => c.key === key(TODAY));
  const later = deleteUnit(base, key(TODAY), 'c'); await f.store.update(r => { r.state = merge(r.state, later); }); await f.source.refresh();
  await f.source.resolve(conflict.key, { branch: conflict.candidates.find(c => c.value).branch, observed: seen.editToken });
  assert.equal(unitInfo((await savedState(f.store)).units[key(TODAY)]).conflict, true);
  const deleted = merge(deleteUnit(base, entity, 'computer'), updateUnit(base, entity, 'phone-old', true));
  const g = await fixture({ state: merge(state, deleted) }); await assert.rejects(g.actions.toggle('h', TODAY), /两边都改过/);
  const c = g.source.snapshot().conflicts.find(c => c.key === key(TODAY)); await assert.rejects(g.source.resolve(c.key, { branch: c.candidates[0].branch }), /先确认/);
});
test('契约向量 22：两个明确 true 合并为一份，补实体后投影与手机打卡格式一致', async () => {
  const vector = JSON.parse(await readFile(new URL('../../../sync-spec/vectors/22-generated-habit-check.json', import.meta.url), 'utf8'));
  assert.equal(canonical(merge(...vector.inputs)), vector.expectedCanonical);
  const base = plannerToState({ habits: [habit({ id: 'fiction-habit' })] }, 'seed', NOW);
  const projected = stateToPlanner(merge(base, vector.expected));
  assert.deepEqual(projected.habits[0].checks, [TODAY]); assert.deepEqual(projected.habits[0].checkEdits, {});
  const f = await fixture({ state: base }); await f.actions.toggle('fiction-habit', TODAY);
  const result = (await savedPlanner(f.store)).habits[0]; assert.deepEqual(result.checks, projected.habits[0].checks);
  assert.equal(result.checkEdits[TODAY], new Date(NOW).toISOString());
  // 再次导入投影不会丢掉取消项及其原 UTC 时间；电脑读入格式是日期数组 + UTC 字典。
  await f.actions.toggle('fiction-habit', TODAY); const cancelled = await savedPlanner(f.store);
  assert.deepEqual(stateToPlanner(plannerToState(cancelled, 'round-trip', NOW)), cancelled);
  assert.equal(unitInfo(plannerToState(cancelled, 'round-trip').units[unitKey('habit-check', 'fiction-habit', TODAY)]).preferred.value, false);
});
