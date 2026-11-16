// T22：连续编辑必须保持投影，显示时间不参与业务冲突。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonical, encodeLegacy, unitKey } from '../../sync/canonical.js';
import { plannerToState, stateToPlanner, applyPlannerChanges, splitReview } from '../../sync/convert.js';
import { merge, unitInfo, normalize } from '../../sync/merge.js';
import { updateUnit } from '../../sync/edit.js';
import { fakePlanner } from './fixtures.js';
import { comparablePlanner, editPlannerFixture, editRandomPlanner } from './convert-fixtures.js';

const hash = value => createHash('sha256').update(value, 'ascii').digest('hex');
const entity = (collection, id) => unitKey('entity', collection, id);

test('固定种子连续 400 次随机编辑，每步投影等于编辑结果且下一次可立即调用', () => {
  let random = 0x291113, before = editPlannerFixture(), state = plannerToState(before, 'seed');
  const next = max => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return Math.floor((random >>> 0) / 4294967296 * max); };
  const hashes = [], stateHashes = [], counts = Array(16).fill(0);
  for (let i = 0; i < 400; i++) {
    const after = structuredClone(before), millis = editRandomPlanner(after, i, next, counts);
    state = applyPlannerChanges(state, before, after, 'pc', millis);
    const projected = stateToPlanner(state);
    assert.deepEqual(projected, comparablePlanner(after), '步骤 ' + i);
    assert.deepEqual(applyPlannerChanges(state, after, after, 'pc', millis + 1), state, '紧接调用 ' + i);
    hashes.push(hash(canonical(encodeLegacy(projected)))); stateHashes.push(hash(canonical(state)));
    before = after;
  }
  assert.ok(counts.every(count => count > 0));
  console.log('T22 转换性质测试：400 步；操作计数 ' + counts.join('/'));
  console.log('T22 投影总哈希：' + hash(hashes.join('')));
  console.log('T22 状态总哈希：' + hash(stateHashes.join('')));
});

test('T16 两份转换夹具重新计算 JS 参考哈希', async () => {
  const sample = JSON.parse(await readFile(new URL('../../../source/tests/testdata/web_v1_sample.json', import.meta.url), 'utf8'));
  const fixture = fakePlanner(); fixture.tasks[0].steps[0].updated = '未知步骤业务字段'; fixture.habits[0].journal['未来日期键'] = { note: '仍然保留' };
  console.log('T22 旧样例转换哈希：' + hash(canonical(plannerToState(sample, 'pc'))));
  console.log('T22 完整虚构转换哈希：' + hash(canonical(plannerToState(fixture, 'seed', 100))));
});

test('背景缺陷甲：只改标题、步骤或复盘正文，时间保持新值并可再次编辑', () => {
  for (const [label, collection, updated, edit] of [
    ['只改标题', 'tasks', '2026-11-13T03:00:00.000Z', p => { p.tasks[0].title = '新标题'; }],
    ['只勾步骤', 'tasks', '2026-11-13T04:00:00.000Z', p => { p.tasks[0].steps[0].done = true; }],
    ['只改复盘正文', 'reviews', '2026-11-13T05:00:00.000Z', p => { p.reviews[0].content += '续写'; }]
  ]) {
    const before = { tasks: [{ id: 't', title: '旧标题', updated: '2026-11-13T02:00:00.000Z', steps: [{ id: 's', done: false }] }],
      reviews: [{ id: 'r', content: '【收获】\n读完一章', updated: '2026-11-12T13:00:00.000Z' }] };
    const after = structuredClone(before); edit(after); after[collection][0].updated = updated;
    const state = applyPlannerChanges(plannerToState(before, 'seed'), before, after, 'pc', Date.parse(updated));
    assert.deepEqual(stateToPlanner(state), after);
    assert.deepEqual(applyPlannerChanges(state, after, after, 'pc'), state);
    console.log(label + '：写入 ' + updated + '，拼回 ' + stateToPlanner(state)[collection][0].updated + '，紧接调用成功');
  }
});

test('只有 updated 或 checkEdits 改变也增加相应存在/打卡版本，子单元无实体时间', () => {
  const before = editPlannerFixture(), after = structuredClone(before), base = plannerToState(before, 'seed');
  for (const collection of ['tasks', 'projects', 'habits', 'reviews', 'weekNotes', 'countdowns']) after[collection][0].updated = '原字符串原样保留';
  const changed = applyPlannerChanges(base, before, after, 'pc', 10);
  assert.deepEqual(stateToPlanner(changed), after);
  const keys = Object.keys(changed.units).filter(key => canonical(changed.units[key]) !== canonical(base.units[key]));
  assert.equal(keys.length, 6); assert.ok(keys.every(key => JSON.parse(key)[0] === 'entity'));
  for (const [key, unit] of Object.entries(changed.units)) if (JSON.parse(key)[0] !== 'entity')
    assert.ok(unit.versions.every(v => v.sources.every(s => !Object.hasOwn(s.stamp, 'legacyUpdated'))));
  const one = { habits: [{ id: 'h', checks: ['2026-11-13'], checkEdits: { '2026-11-13': '旧时间' } }] };
  const two = structuredClone(one); two.habits[0].checkEdits['2026-11-13'] = '新时间';
  assert.deepEqual(stateToPlanner(applyPlannerChanges(plannerToState(one, 'seed'), one, two, 'pc')), two);
});

test('原时间缺省/空串/null 不伪造；低层有 UTC 毫秒时按 Json.Utc 兜底', () => {
  for (const updated of [undefined, '', null, '2026-11-13T01:02:03Z']) {
    const planner = { tasks: [{ id: 't' }], habits: [{ id: 'h', checks: ['2026-11-13'] }] };
    if (updated !== undefined) planner.tasks[0].updated = updated;
    assert.deepEqual(stateToPlanner(plannerToState(planner, 'seed', 999)), planner);
  }
  let state = plannerToState({ tasks: [{ id: 't' }], habits: [{ id: 'h' }] }, 'seed');
  const millis = 1794528000123;
  state = updateUnit(state, entity('tasks', 't'), 'pc', true, { updatedAt: millis });
  state = updateUnit(state, unitKey('habit-check', 'h', '2026-11-13'), 'pc', true, { updatedAt: millis });
  assert.equal(stateToPlanner(state).tasks[0].updated, '2026-11-13T00:00:00.123Z');
  assert.equal(stateToPlanner(state).habits[0].checkEdits['2026-11-13'], '2026-11-13T00:00:00.123Z');
  state = updateUnit(state, entity('tasks', 't'), 'pc', true, { updatedAt: 253402300799999 });
  assert.equal(stateToPlanner(state).tasks[0].updated, '9999-12-31T23:59:59.999Z');
  state = updateUnit(state, entity('tasks', 't'), 'pc', true, { updatedAt: 253402300800000 });
  assert.throws(() => stateToPlanner(state), /日期范围/);
});

test('并发存在单元同值多来源按毫秒取大，相同按来源规范文本取小；不改变核心首来源', () => {
  const before = { tasks: [{ id: 't', title: '原文', notes: '', updated: '基线' }] }, base = plannerToState(before, 'seed');
  const a = structuredClone(before), b = structuredClone(before); a.tasks[0].done = true; b.tasks[0].notes = '新备注';
  a.tasks[0].updated = '较早'; b.tasks[0].updated = '较晚';
  const first = applyPlannerChanges(base, before, a, 'a', 100), second = applyPlannerChanges(base, before, b, 'b', 200);
  for (const combined of [merge(first, second), merge(second, first)]) {
    assert.equal(unitInfo(combined.units[entity('tasks', 't')]).preferred.sources.length, 2);
    assert.equal(stateToPlanner(combined).tasks[0].updated, '较晚');
  }
  const tiedA = updateUnit(base, entity('tasks', 't'), 'a', true, { updatedAt: 300, legacyUpdated: 'a原字符串' });
  const tiedB = updateUnit(base, entity('tasks', 't'), 'b', true, { updatedAt: 300, legacyUpdated: 'b原字符串' });
  assert.equal(stateToPlanner(merge(tiedB, tiedA)).tasks[0].updated, 'a原字符串');
  const fallback = updateUnit(base, entity('tasks', 't'), 'b', true, { updatedAt: 400 });
  assert.equal(stateToPlanner(merge(tiedA, fallback)).tasks[0].updated, '1970-01-01T00:00:00.400Z');
});

test('背景缺陷乙：并发追加两模块后标题完整，模块重排补换行，原文空行与 CRLF 无损', () => {
  const before = { reviews: [{ id: 'r', content: '【收获】\n读完一章' }] }, base = plannerToState(before, 'seed');
  const a = structuredClone(before), b = structuredClone(before);
  a.reviews[0].content += '\n【明日计划】\n早睡'; b.reviews[0].content += '\n【问题】\n下午犯困';
  const result = merge(applyPlannerChanges(base, before, a, 'a'), applyPlannerChanges(base, before, b, 'b'));
  const content = stateToPlanner(result).reviews[0].content;
  assert.deepEqual(splitReview(content).map(p => p.title).sort(), ['收获', '明日计划', '问题'].sort());
  console.log('并发模块正文：' + JSON.stringify(content)); console.log('重新拆段标题：' + JSON.stringify(splitReview(content).map(p => p.title)));
  const original = { reviews: [{ id: 'r', content: '【甲】\n甲\n【乙】\n乙' }] }, initial = plannerToState(original, 'seed');
  const layoutKey = unitKey('layout', 'reviews', 'r'), local = structuredClone(initial.units[layoutKey].versions[0].value);
  local.content.reverse();
  assert.equal(stateToPlanner(updateUnit(initial, layoutKey, 'pc', local)).reviews[0].content, '【乙】\n乙\n【甲】\n甲\n');
  const after = { reviews: [{ id: 'r', content: '【乙】\n乙\n【甲】\n甲' }] };
  assert.deepEqual(stateToPlanner(applyPlannerChanges(initial, original, after, 'pc')), after);
  for (const text of ['\n\n【甲】\n甲', '\r\n\r\n【甲】\r\n甲\r\n【乙】\r\n乙', '', '只有正文', '【甲】\n【甲】\n']) {
    const p = { reviews: [{ id: 'r', content: text }] };
    assert.deepEqual(stateToPlanner(plannerToState(p, 'seed')), p);
  }
});

test('每个实体和步骤的编号一律取键，覆盖缺失或不一致的值', () => {
  const kinds = { projects: 'project', tasks: 'task-content', habits: 'habit-definition', reviews: 'review-meta', weekNotes: 'week-meta', countdowns: 'countdown' };
  for (const wrong of [false, true]) {
    let state = plannerToState(editPlannerFixture(), 'seed');
    for (const [collection, kind] of Object.entries(kinds)) {
      const field = collection === 'weekNotes' ? 'monday' : 'id', id = stateToPlanner(state)[collection][0][field];
      state = updateUnit(state, unitKey(kind, id), 'pc', wrong ? { [field]: '错号' } : {});
    }
    state = updateUnit(state, unitKey('step', 'keep', 's'), 'pc', wrong ? { id: '错号', updated: '步骤业务字段' } : {});
    const projected = stateToPlanner(state);
    for (const collection of Object.keys(kinds)) {
      const field = collection === 'weekNotes' ? 'monday' : 'id';
      assert.equal(projected[collection][0][field], editPlannerFixture()[collection][0][field]);
    }
    assert.equal(projected.tasks[0].steps[0].id, 's');
    if (wrong) assert.equal(projected.tasks[0].steps[0].updated, '步骤业务字段');
  }
});

test('pinned 随放弃/恢复留在状态单元，与并发改备注独立', () => {
  const before = editPlannerFixture(), base = plannerToState(before, 'seed');
  assert.equal(base.units[unitKey('task-status', 'keep')].versions[0].value.pinned, true);
  assert.equal(Object.hasOwn(base.units[unitKey('task-content', 'keep')].versions[0].value, 'pinned'), false);
  const phone = structuredClone(before), pc = structuredClone(before);
  Object.assign(phone.tasks[0], { pinned: false, done: true, abandoned: true }); pc.tasks[0].notes = '新备注';
  const combined = merge(applyPlannerChanges(base, before, phone, 'phone'), applyPlannerChanges(base, before, pc, 'pc'));
  assert.equal(Object.values(combined.units).some(u => unitInfo(u).conflict), false);
  assert.equal(stateToPlanner(combined).tasks[0].pinned, false);
});

test('集合和 checks 仅重排不增加任何版本，总布局不随任务或打卡数增长，实体内顺序保留', () => {
  const before = { tasks: [{ id: 'z', steps: [{ id: 'b' }, { id: 'a' }] }, { id: 'a', trashedAt: '虚构时间' }],
    habits: [{ id: 'h', checks: ['2026-11-13', '2026-11-12'] }], projects: [{ id: '\ue000' }, { id: '😀' }] };
  const base = plannerToState(before, 'seed'), after = structuredClone(before);
  after.tasks.reverse(); after.projects.reverse(); after.habits[0].checks.reverse();
  assert.deepEqual(applyPlannerChanges(base, before, after, 'pc', 100), base);
  assert.deepEqual(stateToPlanner(base), comparablePlanner(before));
  const added = structuredClone(after); added.tasks.push({ id: 'new' }); added.habits[0].checks.push('2026-11-14');
  const changed = applyPlannerChanges(base, after, added, 'pc');
  for (const key of [unitKey('planner-layout'), unitKey('layout', 'habits', 'h')]) assert.deepEqual(changed.units[key], base.units[key]);
  assert.deepEqual(base.units[unitKey('planner-layout')].versions[0].value, { arrays: { tasks: true, habits: true, projects: true }, deleted: false });
  assert.equal(Object.hasOwn(base.units[unitKey('layout', 'habits', 'h')].versions[0].value, 'checkOrder'), false);
  assert.deepEqual(stateToPlanner(base).tasks[1].steps.map(s => s.id), ['b', 'a']);
  assert.deepEqual(normalize(base), base);
});
