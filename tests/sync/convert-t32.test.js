// T32：快捷投影必须与合并核心的完整归并等价，不能略过单元校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { plannerToState, stateToPlanner } from '../../sync/convert.js';
import { normalize, merge } from '../../sync/merge.js';
import { updateUnit, deleteUnit } from '../../sync/edit.js';
import { encodeLegacy, unitKey } from '../../sync/canonical.js';
import { fakePlanner } from './fixtures.js';

test('T32 首次投影：单来源快捷读取与多来源核心归并等价，未知字段及冲突均保留', () => {
  const base = plannerToState(fakePlanner(), 'pc', 100), key = unitKey('task-content', 't-fiction');
  const states = [base, merge(updateUnit(base, key, 'a', encodeLegacy({ title: '虚构并发甲', unknown: { x: -0.5 } }), { updatedAt: 200 }),
    updateUnit(base, key, 'b', { title: '虚构并发乙' }, { updatedAt: 300 })), deleteUnit(base, unitKey('entity', 'tasks', 't-fiction'), 'a', { updatedAt: 400 })];
  for (const state of states) {
    const before = structuredClone(state), viaCore = structuredClone(state);
    for (const unit of Object.values(viaCore.units)) for (const version of unit.versions) version.sources.push(structuredClone(version.sources[0]));
    assert.deepEqual(normalize(viaCore), normalize(state));
    assert.deepEqual(stateToPlanner(state, { allowConflicts: true }), stateToPlanner(viaCore, { allowConflicts: true }));
    assert.deepEqual(state, before);
  }
});
test('T32 快捷投影仍拒绝损坏单元、错误向量、墓碑、时间和非规范键', () => {
  const key = unitKey('task-content', 't-fiction'), base = plannerToState(fakePlanner(), 'pc', 100);
  const mutations = [
    s => { s.units[key].extra = true; },
    s => { s.units[key].versions[0].extra = true; },
    s => { s.units[key].versions[0].sources[0].extra = true; },
    s => { s.units[key].versions[0].vv.pc = 0; },
    s => { s.units[key].versions[0].sources[0].vv.pc = 2; },
    s => { s.units[key].versions[0].sources[0].stamp.updatedAt = -1; },
    s => { s.units[key].versions[0].sources[0].stamp.bad = 0.1; },
    s => { s.units[key].versions[0].deleted = true; },
    s => { s.units[key].versions[0].value.bad = 0.5; },
    s => { s.units['[ "root", "bad" ]'] = s.units[key]; },
    s => { s.schema = 2; }, s => { s.units = null; }
  ];
  for (const change of mutations) {
    const bad = structuredClone(base); change(bad);
    assert.throws(() => normalize(bad)); assert.throws(() => stateToPlanner(bad, { allowConflicts: true }));
  }
});
test('T32 首次投影返回对象可改，不能改到原单元或下次投影', () => {
  const base = plannerToState(fakePlanner(), 'pc', 100), before = structuredClone(base);
  const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } };
  freeze(base);
  const first = stateToPlanner(base); first.tasks[0].title = '虚构本机草稿'; first.tasks[0].steps.push({ id: 'new' });
  assert.deepEqual(base, before); assert.deepEqual(stateToPlanner(base), fakePlanner());
});
