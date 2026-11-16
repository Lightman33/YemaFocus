import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuick, groupTasks, visibleGroups, compareTasks, validDay } from '../../app/task-model.js';
const TODAY = '2026-11-13'; // 周五。期望对照 PlannerModel.cs 932–1100 / PlannerUI.cs 30–49。
// 每行明确写出 [输入, 标题, 日期, 周一, 时间, 优先级]；不读取系统日期。
const cases = [
  ['整理书架', '整理书架', null, null, '', null],
  ['今天', '今天', null, null, '', null],
  ['整理 今天', '整理', '2026-11-13', null, '', null],
  ['整理 明天', '整理', '2026-11-14', null, '', null],
  ['整理 后天', '整理', '2026-11-15', null, '', null],
  ['整理 大后天', '整理', '2026-11-16', null, '', null],
  ['整理 今日', '整理', '2026-11-13', null, '', null],
  ['整理 今儿个', '整理', '2026-11-13', null, '', null],
  ['整理 明日', '整理', '2026-11-14', null, '', null],
  ['整理 明儿', '整理', '2026-11-14', null, '', null],
  ['整理 后日', '整理', '2026-11-15', null, '', null],
  ['整理 大后日', '整理', '2026-11-16', null, '', null],
  ['整理 本周', '整理', null, '2026-11-09', '', null],
  ['整理 下周', '整理', null, '2026-11-16', '', null],
  ['整理 这礼拜', '整理', null, '2026-11-09', '', null],
  ['整理 下个星期', '整理', null, '2026-11-16', '', null],
  ['整理 周一', '整理', '2026-11-16', null, '', null],
  ['整理 本周一', '整理', '2026-11-09', null, '', null],
  ['整理 下周一', '整理', '2026-11-16', null, '', null],
  ['整理 星期五', '整理', '2026-11-13', null, '', null],
  ['整理 礼拜天', '整理', '2026-11-15', null, '', null],
  ['整理 周末', '整理', '2026-11-14', null, '', null],
  ['整理 下周末', '整理', '2026-11-21', null, '', null],
  ['整理 周7', '整理', '2026-11-15', null, '', null],
  ['整理 下礼拜三', '整理', '2026-11-18', null, '', null],
  ['整理 本星期四', '整理', '2026-11-12', null, '', null],
  ['整理 15号', '整理', '2026-11-15', null, '', null],
  ['整理 3日', '整理', '2026-12-03', null, '', null],
  ['整理 31号', '整理', '2026-12-31', null, '', null],
  ['整理 11月3日', '整理', '2027-11-03', null, '', null],
  ['整理 12/1', '整理', '2026-12-01', null, '', null],
  ['整理 12-1', '整理', '2026-12-01', null, '', null],
  ['整理 2月30日', '整理 2月30日', null, null, '', null],
  ['整理 32号', '整理 32号', null, null, '', null],
  ['整理 9点半', '整理', '2026-11-13', null, '09:30', null],
  ['整理 15:30', '整理', '2026-11-13', null, '15:30', null],
  ['整理 上午九点', '整理', '2026-11-13', null, '09:00', null],
  ['整理 下午四点', '整理', '2026-11-13', null, '16:00', null],
  ['整理 中午一点', '整理', '2026-11-13', null, '13:00', null],
  ['整理 晚上十二点', '整理', '2026-11-13', null, '12:00', null],
  ['整理 下周一 9点半', '整理', '2026-11-16', null, '09:30', null],
  ['整理 周六下午四点', '整理', '2026-11-14', null, '16:00', null],
  ['整理 明天9点', '整理', '2026-11-14', null, '09:00', null],
  ['整理 今晚8点', '整理', '2026-11-13', null, '20:00', null],
  ['整理 明早9点', '整理', '2026-11-14', null, '09:00', null],
  ['整理 本周 9点', '整理', null, '2026-11-09', '', null],
  ['整理 24:00', '整理 24:00', null, null, '', null],
  ['整理 四点一刻', '整理 四点一刻', null, null, '', null],
  ['整理 !高', '整理', null, null, '', 3],
  ['!低 整理 明天', '整理', '2026-11-14', null, '', 1],
  ['整理 !3 !1', '整理', null, null, '', 1],
  ['整理 !无', '整理', null, null, '', 0],
  ['整理 !2', '整理', null, null, '', 2],
  ['整理 ！中', '整理', null, null, '', 2],
  ['整理 明天 ！高。', '整理', '2026-11-14', null, '', 3],
  ['整理 明天。，！？、', '整理', '2026-11-14', null, '', null],
  ['整理　明天　９点', '整理　明天　９点', null, null, '', null],
  ['整理 明天 9：30。', '整理', '2026-11-14', null, '09:30', null],
  ['明天 整理。', '整理', '2026-11-14', null, '', null],
  ['下周一 整理材料', '整理材料', '2026-11-16', null, '', null],
  ['明天下午三点 整理材料', '整理材料', '2026-11-14', null, '15:00', null],
  ['明天 9点半 整理材料', '整理材料', '2026-11-14', null, '09:30', null],
  ['本周 整理材料', '整理材料', null, '2026-11-09', '', null],
  ['明天 整理材料 9点', '整理材料', '2026-11-14', null, '09:00', null],
  ['明天下午三点整理资料。', '整理资料', '2026-11-14', null, '15:00', null],
  ['整理资料明天。', '整理资料明天', '2026-11-14', null, '', null],
  ['明天整理资料！高。', '明天整理资料！高', '2026-11-14', null, '', null],
  ['今天的计划', '今天的计划', null, null, '', null],
  ['完成第3章', '完成第3章', null, null, '', null],
  ['整理 今天的材料', '整理 今天的材料', null, null, '', null],
  ['整理 3天后', '整理 3天后', null, null, '', null], // 老网页版支持，电脑版不支持；以电脑版为准。
  ['整理 0:00', '整理', '2026-11-13', null, '00:00', null],
  ['整理 下午两点三十分', '整理', '2026-11-13', null, '14:30', null]
];
for (const [input, title, date, weekOf, time, priority] of cases) test('解析：' + input, () => {
  assert.deepEqual(parseQuick(input, TODAY), { title, date, weekOf, time, priority });
});
test('解析日期由参数决定，跨年、月底和闰年边界', () => {
  assert.equal(parseQuick('整理 明天', '2026-12-31').date, '2027-01-01');
  assert.equal(parseQuick('整理 31号', '2026-04-30').date, '2026-05-31');
  assert.equal(parseQuick('整理 2/29', '2028-03-01').date, '2029-02-28');
  assert.equal(parseQuick('整理 明天', '2028-02-28').date, '2028-02-29');
  assert.equal(validDay('2026-13-01'), false);
});
const t = (id, data = {}) => ({ id, title: id, date: null, weekOf: null, time: '', order: 0, priority: 0, done: false, ...data });
const ids = groups => Object.fromEntries(groups.map(g => [g.key, g.tasks.map(t => t.id)]));
test('分组与顺序：日期、时间、优先级、顺序，周/月/跨天、隐藏垃圾桶、完成倒序', () => {
  const p = { tasks: [t('none'), t('late', { date: '2026-12-01' }), t('oldweek', { weekOf: '2026-11-02' }), t('oldmonth', { monthOf: '2026-10-01' }),
    t('over', { date: '2026-11-12' }), t('span', { date: '2026-11-12', endDate: '2026-11-15' }),
    t('today-low', { date: TODAY, priority: 1 }), t('today-high-2', { date: TODAY, priority: 3, order: 2 }), t('today-high-1', { date: TODAY, priority: 3, order: 1 }),
    t('today-time', { date: TODAY, time: '09:00' }), t('tom', { date: '2026-11-14' }), t('sun', { date: '2026-11-15' }), t('wk', { weekOf: '2026-11-09' }),
    t('nextwk', { weekOf: '2026-11-16' }), t('month', { monthOf: '2026-11-01' }), t('done1', { done: true, doneAt: '2026-11-12 09:00:00' }),
    t('done2', { done: true, doneAt: '2026-11-13 09:00:00' }), t('abandon', { done: true, abandoned: true }), t('trash', { trashedAt: '2026-11-13T00:00:00Z' })] };
  assert.deepEqual(ids(groupTasks(p, TODAY)), { over: ['oldmonth', 'oldweek', 'over'], today: ['span', 'today-time', 'today-high-1', 'today-high-2', 'today-low'], tomorrow: ['tom'], week: ['sun', 'wk'], later: ['nextwk', 'month', 'late'], none: ['none'], done: ['done2', 'done1'], abandoned: ['abandon'] });
});
for (const [today, tasks, expected] of [
  ['2026-11-30', [t('nov', { date: '2026-11-29' }), t('dec', { date: '2026-12-01' }), t('sun', { date: '2026-12-06' }), t('week', { weekOf: '2026-11-23' })], { over: ['nov', 'week'], tomorrow: ['dec'], week: ['sun'] }],
  ['2027-01-01', [t('old', { monthOf: '2026-12-01' }), t('wk', { weekOf: '2026-12-28' }), t('next', { date: '2027-01-04' })], { over: ['old'], week: ['wk'], later: ['next'] }],
  ['2026-11-15', [t('tom', { date: '2026-11-16' }), t('next', { weekOf: '2026-11-16' })], { tomorrow: ['tom'], later: ['next'] }]
]) test('分组边界：' + today, () => assert.deepEqual(ids(groupTasks({ tasks }, today)), expected));
test('按项目：无项目在前，树形顺序、已归档项目归无项目，与电脑版 ProjectTree 一致', () => {
  const projects = [{ id: 'b', name: 'B', order: 2 }, { id: 'child', name: '子项目', parent: 'a' }, { id: 'a', name: 'A', order: 1 }, { id: 'archived', archived: true }];
  const groups = groupTasks({ projects, tasks: [t('none'), t('archived', { project: 'archived' }), t('b', { project: 'b' }), t('a', { project: 'a' }), t('child', { project: 'child' })] }, TODAY, 'project');
  assert.deepEqual(ids(groups), { inbox: ['none', 'archived'], 'p:a': ['a'], 'p:child': ['child'], 'p:b': ['b'] });
  assert.equal(groups[2].title, 'A › 子项目');
});
test('折叠组没有可渲染行，展开每次只给 50 条；3000 任务实际计时', () => {
  const planner = { tasks: Array.from({ length: 3000 }, (_, i) => t(String(i), { done: i > 99, date: i < 100 ? '2027-01-01' : null, doneAt: '2026-11-13 09:00:00', order: i })) };
  const start = performance.now(); const groups = groupTasks(planner, TODAY); const elapsed = performance.now() - start;
  console.log('T15 3000 个虚构任务生成分组列表：' + elapsed.toFixed(3) + ' ms');
  assert.equal(visibleGroups(groups).reduce((sum, g) => sum + g.visible.length, 0), 0);
  assert.equal(visibleGroups(groups, { done: true }).find(g => g.key === 'done').visible.length, 50);
  assert.equal(visibleGroups(groups, { done: true }, { done: 100 }).find(g => g.key === 'done').visible.length, 100);
  assert.equal(compareTasks(t('x', { date: TODAY }), t('y', { date: TODAY })), 0);
});
