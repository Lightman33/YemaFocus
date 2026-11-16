import test from 'node:test';
import assert from 'node:assert/strict';
import { repeating, parseQuick, dateText, wallText, whenText } from '../../app/task-model.js';

// PlannerModel.cs PTask.IsRepeating；T29 裁决 1 区分系列历史与模板。
test('T29 重复判定只看 repeat，系列历史不标重复', () => {
  for (const row of [{}, { series: '系列' }, { repeat: null }, { repeat: { kind: 'None' }, series: '系列' }]) assert.equal(repeating(row), false);
  for (const kind of ['Daily', 'Weekly', 'Monthly', 'Yearly']) assert.equal(repeating({ repeat: { kind } }), true);
});

// 以 PlannerModel.cs ParseQuick/NormDateWord 的日期为基础，按 T29 裁决 3 保留粘连标题。
// 标题逐字等于输入，日期仍解析；不依赖手机系统日期。
const TODAY = '2026-11-13';
const glued = [
  ['本周工作总结', null, '2026-11-09'], ['明天给检验科打电话', '2026-11-14', null], ['排班下周', null, '2026-11-16'],
  ['今日门诊复盘', '2026-11-13', null], ['明日手术准备', '2026-11-14', null], ['下周排班表', null, '2026-11-16'],
  ['准备下周', null, '2026-11-16'], ['安排明天', '2026-11-14', null], ['值班周六', '2026-11-14', null],
  ['今天整理资料', '2026-11-13', null], ['后天检查材料', '2026-11-15', null], ['大后天整理书架', '2026-11-16', null],
  ['周末整理衣柜', '2026-11-14', null], ['这周整理材料', null, '2026-11-09'], ['下个星期排班', null, '2026-11-16'],
  ['礼拜天整理资料', '2026-11-15', null], ['总结今日', '2026-11-13', null], ['计划后天', '2026-11-15', null],
  ['下周一整理材料', '2026-11-16', null], ['整理材料星期天', '2026-11-15', null]
];
for (const [input, date, weekOf] of glued) test('T29 粘连标题一字不少：' + input, () => {
  const parsed = parseQuick(input, TODAY); assert.equal(parsed.title, input); assert.equal(parsed.date, date); assert.equal(parsed.weekOf, weekOf);
});

for (const [input, title, date, time] of [
  ['明天，整理资料', '整理资料', '2026-11-14', ''], ['整理资料，明天', '整理资料', '2026-11-14', ''],
  ['明天、整理资料', '整理资料', '2026-11-14', ''], ['整理资料;明天', '整理资料', '2026-11-14', ''],
  ['明天下午三点整理资料', '整理资料', '2026-11-14', '15:00'], ['整理资料明天下午三点', '整理资料', '2026-11-14', '15:00'],
  ['明天 整理   材料', '整理   材料', '2026-11-14', ''], ['整理   材料 明天', '整理   材料', '2026-11-14', ''],
  ['整理　材料 明天', '整理　材料', '2026-11-14', ''], ['整理   材料 !低 !高 明天', '整理   材料', '2026-11-14', '']
]) test('T29 分隔和具体时间仍提取：' + input, () => {
  const parsed = parseQuick(input, TODAY); assert.equal(parsed.title, title); assert.equal(parsed.date, date); assert.equal(parsed.time, time);
});

test('T29 句首跟“的”及单独日期词继续不识别（PlannerModel.ParseQuick，T15 保留规则）', () => {
  for (const input of ['今天的计划', '明天的安排', '本周的总结', '今天', '明天 !高']) assert.equal(parseQuick(input, TODAY).date, null);
});

// T29 界面裁决 7.1；today 对齐电脑版 AppClock.Today，由来源提供。
for (const [day, expected] of [
  ['2026-11-13', '今天 · 周五'], ['2026-11-14', '明天 · 周六'], ['2026-11-12', '昨天 · 周四'],
  ['2026-11-11', '前天 · 周三'], ['2026-11-15', '后天 · 周日'], ['2026-11-10', '11月10日 周二'],
  ['2027-01-02', '2027年1月2日 周六'], ['2025-11-10', '2025年11月10日 周一']
]) test('T29 可读日期：' + day, () => assert.equal(dateText(day, TODAY), expected));

test('T29 日期标签、读屏共用文案、跨天周月、逾期和本地时间显示', () => {
  assert.equal(dateText('2026-11-14', TODAY, { fullDate: true }), '明天 11月14日 周六');
  assert.equal(whenText({ date: '2026-11-10', time: '09:00' }, TODAY), '11月10日 周二 09:00 · 已逾期');
  assert.equal(whenText({ date: '2026-11-13', endDate: '2026-11-15', time: '09:00', endTime: '16:00' }, TODAY), '今天 · 周五 至 后天 · 周日 09:00–16:00');
  assert.equal(whenText({ weekOf: '2026-11-09' }, TODAY), '11月9日 周一 所在周内');
  assert.equal(whenText({ monthOf: '2026-11-01' }, TODAY), '11月内');
  assert.equal(whenText({ monthOf: '2027-01-01' }, TODAY), '2027年1月内');
  assert.equal(wallText('2026-11-13 10:00:00', TODAY), '今天 · 周五 10:00:00');
  assert.equal(dateText('2027-01-01', '2026-12-31', { fullDate: true }), '明天 2027年1月1日 周五');
});

// T26 第2节（2）/（3）D 的字段差异；PlannerUI.cs ParsePriority(30–48) 只 Split(' ')。
// 语音句末标点沿用 T15；优先级词本身必须有电脑版认可的空格边界。
for (const [input, title, priority] of [
  ['虚构任务!高', '虚构任务!高', null], ['虚构任务！高', '虚构任务！高', null],
  ['虚构任务　!高', '虚构任务　!高', null], ['虚构任务　！高', '虚构任务　！高', null],
  ['虚构任务 !低 !高', '虚构任务', 3], ['虚构任务 ！中', '虚构任务', 2],
  ['虚构任务 !无', '虚构任务', 0], ['虚构任务 !0', '虚构任务', 0],
  ['虚构任务 !高　', '虚构任务', 3], ['虚构任务   内容 !高', '虚构任务   内容', 3]
]) test('T29 优先级边界对齐电脑版：' + input, () => {
  const parsed = parseQuick(input, TODAY); assert.equal(parsed.title, title); assert.equal(parsed.priority, priority);
});
