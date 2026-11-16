import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEntityChange, readEntity, plannerToState, stateToPlanner, applyPlannerChanges } from '../../sync/convert.js';
import { canonical } from '../../sync/canonical.js';
import { editPlannerFixture, editRandomPlanner } from './convert-fixtures.js';
const collections = ['tasks', 'projects', 'reviews', 'habits', 'weekNotes', 'countdowns'];
test('T27 实体增量与整份比较：固定种子 320 步、覆盖 T22 全部 16 种操作', () => {
  let seed = 0x27, before = editPlannerFixture(), fast = plannerToState(before, 'seed'), full = fast;
  const next = max => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; }, counts = Array(16).fill(0);
  for (let i = 0; i < 320; i++) {
    const after = structuredClone(before), ms = editRandomPlanner(after, i, next, counts);
    full = applyPlannerChanges(full, before, after, 'phone', ms);
    for (const c of collections) {
      const id = row => c === 'weekNotes' ? row.monday : row.id;
      const a = new Map((before[c] || []).map(r => [id(r), r])), b = new Map((after[c] || []).map(r => [id(r), r]));
      for (const key of new Set([...a.keys(), ...b.keys()])) {
        if (JSON.stringify(a.get(key)) === JSON.stringify(b.get(key))) continue;
        const change = applyEntityChange(fast, c, key, a.get(key), b.get(key), 'phone', ms);
        fast = change.state;
        assert.ok(change.keys.every(k => Object.hasOwn(fast.units, k)));
        assert.deepEqual(readEntity(fast, c, key), stateToPlanner(fast)[c]?.find(r => id(r) === key));
      }
    }
    // deleted 属根字段，实体接口没有替调用者推断旧格式删除日志；单独用原接口写根字段。
    if (JSON.stringify(before.deleted) !== JSON.stringify(after.deleted)) {
      const projection = stateToPlanner(fast), changed = structuredClone(projection); changed.deleted = after.deleted;
      fast = applyPlannerChanges(fast, projection, changed, 'phone', ms);
    }
    assert.equal(canonical(fast), canonical(full), '随机步 ' + i);
    before = after;
  }
  assert.ok(counts.every(x => x > 0));
});
test('实体读不存在返回undefined；新集合、新建、删除、恢复、错编号和陈旧before', () => {
  let state = plannerToState({}, 'seed');
  assert.equal(readEntity(state, 'tasks', 't'), undefined);
  state = applyEntityChange(state, 'tasks', 't', undefined, { id: 't', steps: [] }, 'phone', 1).state;
  assert.deepEqual(stateToPlanner(state), { tasks: [{ id: 't', steps: [], updated: '1970-01-01T00:00:00.001Z' }] });
  const before = readEntity(state, 'tasks', 't');
  assert.throws(() => applyEntityChange(state, 'tasks', 't', {}, { id: 't' }, 'phone'), /当前实体投影/);
  assert.throws(() => applyEntityChange(state, 'tasks', 't', before, { id: 'other' }, 'phone'), /编号/);
  state = applyEntityChange(state, 'tasks', 't', before, undefined, 'phone', 2).state;
  assert.equal(readEntity(state, 'tasks', 't'), undefined);
  state = applyEntityChange(state, 'tasks', 't', undefined, before, 'phone', 3).state;
  assert.equal(readEntity(state, 'tasks', 't').id, 't');
});
