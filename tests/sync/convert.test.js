// 核对字段无损往返、任务状态/内容分离，以及父对象删除的并发保护。
// 旧版夹具仅来自源码测试目录；其余资料在测试中虚构。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakePlanner } from './fixtures.js';
import { comparablePlanner } from './convert-fixtures.js';
import { canonical, encodeLegacy, decodeLegacy, unitKey } from '../../sync/canonical.js';
import { plannerToState, stateToPlanner, applyPlannerChanges, splitReview, parseCsv, writeCsv, csvToState, stateToCsv, recordRowToValue } from '../../sync/convert.js';
import { merge, unitInfo } from '../../sync/merge.js';
import { occurrenceId, derivedId } from '../../sync/edit.js';

test('源码内的旧网页 JSON 样例逐字段往返', async () => {
  const planner = JSON.parse(await readFile(new URL('../../../source/tests/testdata/web_v1_sample.json', import.meta.url), 'utf8'));
  assert.deepEqual(stateToPlanner(plannerToState(planner, 'pc')), comparablePlanner(planner));
});
test('完整虚构 JSON：未知字段、小数、放弃历史、照片名和模块原文逐字段往返', () => {
  const planner = fakePlanner(), text = JSON.stringify(planner);
  const state = plannerToState(planner, 'pc', 100);
  assert.deepEqual(stateToPlanner(state), planner);
  assert.equal(JSON.stringify(planner), text, '输入未改写');
  const status = state.units[unitKey('task-status', 't-fiction')].versions[0].value;
  assert.ok(status.abandonPrevious && status.abandonHistory);
  assert.equal(Object.hasOwn(state.units[unitKey('task-content', 't-fiction')].versions[0].value, 'abandoned'), false);
  const parsed = splitReview(planner.reviews[0].content);
  assert.equal(parsed.map(part => part.raw).join(''), planner.reviews[0].content);
  assert.equal(parsed.filter(part => part.title === '自定义模块').length, 2);
});
test('缺省、空值、空集合、特殊对象键与被转义数字不会混淆', () => {
  for (const planner of [{}, { version: 1 }, { projects: [], tasks: [], deleted: {}, habits: [], reviews: [], weekNotes: [], countdowns: [] },
    JSON.parse('{"__proto__":{"保留":1},"constructor":{"值":2},"tasks":[{"id":"constructor","title":"原文","steps":[]}]}')]) {
    assert.deepEqual(stateToPlanner(plannerToState(planner, 'constructor')), planner);
  }
  const legacy = JSON.parse('{"$sync":"number","bits":"3ff0000000000000","nested":{"$sync":"object","entries":[["x",7]]}}');
  assert.deepEqual(decodeLegacy(encodeLegacy(legacy)), legacy);
  for (const number of [0.1, -0, Number.MAX_VALUE, Number.MIN_VALUE, -1.25, 9007199254740992]) {
    assert.ok(Object.is(decodeLegacy(encodeLegacy(number)), number));
  }
});
test('手机勾完成、电脑改备注：两个业务单元独立，无冲突', () => {
  const before = { version: 1, tasks: [{ id: 't', title: '虚构练习', notes: '原备注', done: false, doneAt: null, updated: '2026-11-13T00:00:00.000Z', steps: [] }] };
  const baseline = plannerToState(before, 'seed');
  const phone = structuredClone(before); phone.tasks[0].done = true; phone.tasks[0].doneAt = '2026-11-13 09:00:00'; phone.tasks[0].updated = '2026-11-13T01:00:00.000Z';
  const pc = structuredClone(before); pc.tasks[0].notes = '电脑版补充'; pc.tasks[0].updated = '2026-11-13T02:00:00.000Z';
  const result = merge(applyPlannerChanges(baseline, before, phone, 'phone', 100), applyPlannerChanges(baseline, before, pc, 'pc', 200));
  assert.equal(Object.values(result.units).some(unit => unitInfo(unit).conflict), false);
  const projected = stateToPlanner(result);
  assert.equal(projected.tasks[0].done, true); assert.equal(projected.tasks[0].notes, '电脑版补充');
});
test('删除任务遇到并发步骤编辑：保留原内容和步骤，存在单元提示冲突', () => {
  const before = { tasks: [{ id: 't', title: '纸飞机', notes: '原备注', steps: [{ id: 's', text: '折纸', done: false }] }] };
  const baseline = plannerToState(before, 'seed'), removed = { tasks: [] }, modified = structuredClone(before);
  modified.tasks[0].steps[0].text = '折成两层';
  const deletion = applyPlannerChanges(baseline, before, removed, 'a', 1);
  assert.deepEqual(stateToPlanner(deletion), removed);
  const edited = applyPlannerChanges(baseline, before, modified, 'b', 2), result = merge(deletion, edited);
  const gate = unitInfo(result.units[unitKey('entity', 'tasks', 't')]);
  assert.equal(gate.deleteConflict, true);
  assert.throws(() => stateToPlanner(result), /冲突/);
  const projected = stateToPlanner(result, { allowConflicts: true });
  assert.equal(projected.tasks[0].title, '纸飞机'); assert.equal(projected.tasks[0].notes, '原备注');
  assert.equal(projected.tasks[0].steps[0].text, '折成两层');
});
test('不同复盘模块、评分、一句话总结和不同习惯日期互不冲突', () => {
  const before = fakePlanner(), baseline = plannerToState(before, 'seed');
  const a = structuredClone(before), b = structuredClone(before);
  a.reviews[0].title = '新的总结'; a.reviews[0].content = a.reviews[0].content.replace('完成纸飞机', '完成两架纸飞机');
  b.reviews[0].score = 5; b.reviews[0].content = b.reviews[0].content.replace('第二段', '第二段续写');
  a.habits[0].checks.push('2026-11-10'); b.habits[0].journal['2026-11-11'] = { note: '虚构感想', photos: [] };
  const result = merge(applyPlannerChanges(baseline, before, a, 'a'), applyPlannerChanges(baseline, before, b, 'b'));
  const projected = stateToPlanner(result);
  assert.equal(projected.reviews[0].title, '新的总结'); assert.equal(projected.reviews[0].score, 5);
  assert.match(projected.reviews[0].content, /完成两架纸飞机/); assert.match(projected.reviews[0].content, /第二段续写/);
  assert.ok(projected.habits[0].checks.includes('2026-11-10')); assert.equal(projected.habits[0].journal['2026-11-11'].note, '虚构感想');
});
test('两天新建的同名任务保持两个编号；同一步骤内容也不能合并', () => {
  const planner = { tasks: [{ id: 'day-a', title: '同名任务', date: '2026-11-12', steps: [{ id: 'a', text: '一样' }, { id: 'b', text: '一样' }] },
    { id: 'day-b', title: '同名任务', date: '2026-11-13' }] };
  assert.deepEqual(stateToPlanner(plannerToState(planner, 'a')), planner);
});
test('两个设备新增不同任务，布局候选不挡住全部实体', () => {
  const before = { tasks: [] }, base = plannerToState(before, 'seed');
  const a = { tasks: [{ id: 'a', title: '同名' }] }, b = { tasks: [{ id: 'b', title: '同名' }] };
  const result = merge(applyPlannerChanges(base, before, a, 'a'), applyPlannerChanges(base, before, b, 'b'));
  assert.equal(stateToPlanner(result).tasks.length, 2);
  const beforeNext = stateToPlanner(result), afterNext = structuredClone(beforeNext);
  afterNext.tasks.push({ id: 'c', title: '第三条' });
  assert.equal(stateToPlanner(applyPlannerChanges(result, beforeNext, afterNext, 'c')).tasks.length, 3);
});
test('旧编辑界面不能把新到的改动当成已经看过的版本', () => {
  const before = { tasks: [{ id: 't', title: '原文' }] }, base = plannerToState(before, 'seed');
  const remote = { tasks: [{ id: 't', title: '另一端的新内容' }] };
  const current = applyPlannerChanges(base, before, remote, 'phone');
  assert.throws(() => applyPlannerChanges(current, before, { tasks: [{ id: 't', title: '本机旧界面的编辑' }] }, 'pc'), /不是当前投影/);
});
test('转换失败时拒绝重复编号、缺失编号或损坏字段', () => {
  for (const data of [{ tasks: [{ title: '无编号' }] }, { tasks: [{ id: 'a' }, { id: 'a' }] }, { tasks: [{ id: 'a', steps: [{ id: 'b' }, { id: 'b' }] }] }, { habits: [{ id: 'h', checks: ['bad'] }] }, { tasks: null }]) {
    assert.throws(() => plannerToState(data, 'a'));
  }
});
test('确定编号区分种类、组成边界、系列和日期', () => {
  assert.equal(occurrenceId('s', '2026-11-13'), 'd1-' + Buffer.from('["derived","occurrence","s","2026-11-13"]', 'ascii').toString('hex'));
  assert.notEqual(derivedId('x', 'a|b', 'c'), derivedId('x', 'a', 'b|c'));
  assert.notEqual(occurrenceId('s', '2026-11-13'), occurrenceId('s', '2026-11-14'));
  assert.match(derivedId('top-three', '来源|带竖线😀', '0'), /^d1-[0-9a-f]+$/);
});
test('CSV 字段往返：小数分钟、引号、逗号、多行备注、额外未知列与同内容独立行', () => {
  const rows = [['类型', '开始', '结束', '分钟', '事项', '状态', '备注', '关联任务', '未来列'],
    ['番茄', '2026-11-13 09:00:00', '2026-11-13 09:25:00', '25.25', '折纸,"练习"', '完成', '第一行\r\n第二行😀', 't|练习', '保留'],
    ['番茄', '2026-11-13 09:00:00', '2026-11-13 09:25:00', '25.25', '折纸,"练习"', '完成', '第一行\r\n第二行😀', 't|练习', '保留']];
  const text = writeCsv(rows), state = csvToState(text, { device: 'pc', ids: ['r1', 'r2'] });
  assert.equal(stateToCsv(state), text); assert.deepEqual(parseCsv(stateToCsv(state)), rows);
  assert.equal(Object.keys(state.units).filter(key => JSON.parse(key)[0] === 'record').length, 2);
  assert.deepEqual(recordRowToValue(rows[1]).columns, rows[1]);
  assert.throws(() => csvToState(text, { device: 'pc', ids: ['r1', 'r1'] }), /独立编号/);
  assert.throws(() => csvToState(text, { device: 'pc' }), /独立编号/);
});
test('CSV 旧七列表头、六列记录、无表头与转义错误', () => {
  for (const rows of [[['类型', '开始', '结束', '分钟', '事项', '状态', '备注'], ['番茄', '2026-11-13 09:00:00', '2026-11-13 09:25:00', '25', '练习', '完成', '']],
    [['番茄', '2026-11-13 09:00:00', '2026-11-13 09:25:00', '25', '练习', '完成']]]) {
    const text = writeCsv(rows); assert.equal(stateToCsv(csvToState(text, { device: 'pc', ids: ['r1'] })), text);
  }
  assert.deepEqual(parseCsv('\ufeffa,b\r\n"c,d",e\n'), [['a', 'b'], ['c,d', 'e']]);
  for (const text of ['"未闭合', 'a"b,c', '"a"b,c']) assert.throws(() => parseCsv(text));
});
test('带归档引用的局部状态拒绝当成完整 CSV 导出', () => {
  const state = plannerToState({}, 'a');
  const hash = '0'.repeat(64), name = 'a--1--' + hash + '--archive-2025.json';
  state.archives[name] = { hash, stateHash: '1'.repeat(64), year: '2025', device: 'a', sequence: 1 };
  assert.throws(() => stateToCsv(state), /全部年度归档/);
  assert.doesNotThrow(() => stateToCsv(state, { allowPartial: true }));
});
