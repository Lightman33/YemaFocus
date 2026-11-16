import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskActions, makeTask } from '../../app/task-actions.js';
import { MemoryStore, freshRecord } from '../../app/store.js';
import { createDataSource } from '../../app/datasource.js';
import { plannerToState } from '../../sync/convert.js';

const NOW = Date.parse('2026-11-13T02:00:00.345Z'); // 软件北京时间 10:00，含非零毫秒。
async function fixture(extra = {}, others = []) {
  const task = { ...makeTask('虚构任务', { id: 't', now: NOW, timeZone: 'Asia/Shanghai' }), ...extra };
  const planner = { version: 1, projects: [], tasks: [task, ...others], habits: [], weekNotes: [], deleted: {} };
  const store = new MemoryStore({ ...freshRecord(), state: plannerToState(planner, 'computer', NOW - 1000), settings: { joined: true, deviceId: 'phone' } });
  const source = await createDataSource({ store, now: () => NOW });
  let seq = 0;
  return { source, store, actions: new TaskActions(source, { now: () => NOW, id: () => '新编号' + ++seq }), row: () => source.snapshot().planner.tasks.find(t => t.id === 't') };
}

// PlannerModel.cs IsRepeating / Uncomplete / RestoreAbandoned：T29 只拦回退系列的两个操作。
test('T29 系列历史能改标题备注步骤和删除，取消完成及恢复仍拦截', async () => {
  const f = await fixture({ done: true, series: '系列', steps: [{ id: 's', text: '旧步骤', done: false }] });
  await f.actions.patch('t', { title: '虚构新标题', notes: '虚构新备注' });
  await f.actions.step('t', 's', 'text', '新步骤'); await f.actions.addSteps('t', '再一步');
  assert.equal(f.row().title, '虚构新标题'); assert.equal(f.row().notes, '虚构新备注'); assert.equal(f.row().steps.length, 2);
  await assert.rejects(f.actions.toggle('t'), /这条记录来自重复任务，取消完成请在电脑上操作/);
  const receipt = await f.actions.remove('t'); assert.equal(f.row(), undefined); await receipt.undo(); assert.equal(f.row().series, '系列');
  const g = await fixture({ done: true, abandoned: true, series: '系列' });
  for (const operation of [() => g.actions.restore('t'), () => g.actions.toggle('t')]) await assert.rejects(operation(), /这条记录来自重复任务/);
  const h = await fixture({ repeat: { kind: 'Daily' } });
  for (const operation of [() => h.actions.toggle('t'), () => h.actions.abandon('t', ''), () => h.actions.schedule('t', { date: '2026-11-14' }), () => h.actions.patch('t', { notes: '备注' }), () => h.actions.addSteps('t', '一步'), () => h.actions.remove('t')]) await assert.rejects(operation(), /重复任务请先在电脑上完成/);
});

// 直接按 PlannerModel.cs SetReminder(299–317)、SyncReminder(320–325) 和
// PlannerForm.cs DatePopup.Apply(746–761) 推算，包含跨午夜和跨两天。
// [原字段, 操作, 改后 time/date/remindBefore/remindTime/remindOffset/remindedAt]。
const reminders = [
  ['准时提醒改晚', { time: '09:00', remindBefore: 0, remindTime: '09:00' }, ['time', '16:00'], ['16:00', '2026-11-14', 0, '16:00', 0, '']],
  ['提前15分钟', { time: '09:00', remindBefore: 15, remindTime: '08:45' }, ['time', '14:00'], ['14:00', '2026-11-14', 15, '13:45', 0, '']],
  ['跨前一天', { time: '09:00', remindBefore: 30 }, ['time', '00:10'], ['00:10', '2026-11-14', 30, '23:40', 1, '']],
  ['刚好前一天午夜', { time: '09:00', remindBefore: 1440 }, ['time', '00:00'], ['00:00', '2026-11-14', 1440, '00:00', 1, '']],
  ['跨两天', { time: '09:00', remindBefore: 1500 }, ['time', '00:30'], ['00:30', '2026-11-14', 1500, '23:30', 2, '']],
  ['清除分钟提醒时间', { time: '09:00', remindBefore: 15, remindTime: '08:45' }, ['time', ''], ['', '2026-11-14', undefined, '', 0, '']],
  ['清除准时提醒时间', { time: '09:00', remindBefore: 0, remindTime: '09:00' }, ['time', ''], ['', '2026-11-14', undefined, '', 0, '']],
  ['旧全天提醒改时间仍保留', { time: '09:00', remindTime: '08:00', remindOffset: 2 }, ['time', '16:00'], ['16:00', '2026-11-14', undefined, '08:00', 2, '']],
  ['旧全天提醒清空时间仍有效', { time: '09:00', remindTime: '08:00', remindOffset: 2 }, ['time', ''], ['', '2026-11-14', undefined, '08:00', 2, '']],
  ['无提醒新增时间不开提醒', {}, ['time', '16:00'], ['16:00', '2026-11-14', undefined, '', 0, '']],
  ['分钟提醒改日期重算旧字段', { time: '00:10', remindBefore: 30, remindTime: '错误旧值', remindOffset: 0 }, ['date', '2026-11-15'], ['00:10', '2026-11-15', 30, '23:40', 1, '']],
  ['准时提醒改日期', { time: '16:00', remindBefore: 0, remindTime: '16:00' }, ['date', '2026-11-15'], ['16:00', '2026-11-15', 0, '16:00', 0, '']],
  ['全天提醒改日期保留', { remindTime: '08:00', remindOffset: 3 }, ['date', '2026-11-15'], ['', '2026-11-15', undefined, '08:00', 3, '']],
  ['快捷清除日期和分钟提醒', { time: '16:00', remindBefore: 15, remindTime: '15:45' }, ['date', null], ['16:00', null, undefined, '', 0, '']],
  ['快捷清除日期和全天提醒', { remindTime: '08:00', remindOffset: 3 }, ['date', null], ['', null, undefined, '', 0, '']],
  ['安排周内清理提醒留时间', { time: '16:00', remindBefore: 15, remindTime: '15:45' }, ['week', '2026-11-16'], ['16:00', null, undefined, '', 0, '']],
  ['详情清日期同时清时间', { time: '16:00', endTime: '17:00', remindBefore: 15, remindTime: '15:45' }, ['detail', null], ['', null, undefined, '', 0, '']],
  ['无时间遗留分钟提醒改期', { remindBefore: 15, remindTime: '15:45' }, ['date', '2026-11-15'], ['', '2026-11-15', undefined, '', 0, '']]
];
for (const [label, before, [kind, value], expected] of reminders) test('T29 提醒字段：' + label, async () => {
  const f = await fixture({ date: '2026-11-14', remindedAt: '已经提醒', ...before });
  if (kind === 'time') await f.actions.patch('t', { time: value });
  else await f.actions.schedule('t', kind === 'week' ? { weekOf: value } : { date: value }, { detailDate: kind === 'detail' });
  const row = f.row();
  assert.deepEqual([row.time, row.date, row.remindBefore, row.remindTime, row.remindOffset, row.remindedAt], expected);
  if (kind === 'week') assert.equal(row.weekOf, '2026-11-16');
  if (kind === 'detail') assert.equal(row.endTime, '');
  if (expected[2] === undefined) assert.equal(Object.hasOwn(row, 'remindBefore'), false);
});

// PlannerUI.cs ApplyQuickTime：只有未来具体时刻开准时提醒；等于当前秒或已过点不开。
for (const [date, time, before, remindTime] of [
  ['2026-11-13', '10:01', 0, '10:01'], ['2026-11-14', '00:00', 0, '00:00'],
  ['2026-11-13', '10:00', undefined, ''], ['2026-11-13', '09:59', undefined, ''],
  ['2026-11-14', '', undefined, ''], [null, '', undefined, '']
]) test('T29 快速新建提醒：' + date + ' ' + time, async () => {
  const f = await fixture(); await f.actions.add({ title: '虚构新任务', date, time });
  const row = f.source.snapshot().planner.tasks.find(t => t.id !== 't');
  assert.deepEqual([row.remindBefore, row.remindTime, row.remindOffset, row.remindedAt], [before, remindTime, 0, '']);
});

// 对照 SetDate/DatePopup.Apply 的提醒字段；撤销沿用 T15 的同步新版本规则。
test('T29 清日期撤销恢复提醒、未知字段和步骤提醒', async () => {
  const f = await fixture({ date: '2026-11-14', time: '16:00', remindBefore: 15, remindTime: '15:45', remindedAt: '旧标记', opaque: '保留', steps: [{ id: 's', text: '虚构步骤', remindTime: '08:00', remindedAt: '步骤标记' }] });
  const before = f.row(); const receipt = await f.actions.schedule('t', { date: null });
  await receipt.undo(); const after = f.row(); delete before.updated; delete after.updated; assert.deepEqual(after, before);
});

// PlannerModel.cs Add/MaxOrder：垃圾记录不计入；WeekStart 统一到周一。
test('T29 新建周一和活动顺序对齐电脑', async () => {
  const f = await fixture({ order: 7 }, [{ id: 'trash', title: '虚构垃圾记录', trashedAt: '2026-11-12T00:00:00.000Z', order: 999 }]);
  await f.actions.add({ title: '虚构新任务', weekOf: '2026-11-18' });
  const row = f.source.snapshot().planner.tasks.find(t => t.id.startsWith('新编号'));
  assert.equal(row.order, 8); assert.equal(row.weekOf, '2026-11-16');
});

// PlannerModel.cs Add.Trim、PlannerUI.cs FlatInput.Value，T29 裁决 4。
test('T29 新建和修改标题规整换行、首尾空白，步骤 Trim，备注统一 LF', async () => {
  const f = await fixture({ steps: [{ id: 's', text: '旧步骤', done: false }] });
  await f.actions.add('  虚构\r\n两行\r标题\n结尾  ');
  assert.equal(f.source.snapshot().planner.tasks.find(t => t.id !== 't').title, '虚构 两行 标题 结尾');
  await f.actions.add({ title: '  对象\n新建  ' });
  assert.equal(f.source.snapshot().planner.tasks.find(t => t.id === '新编号2').title, '对象 新建');
  const fields = { title: '  修改\r\n标题\n结尾  ', notes: '甲\r\n乙' };
  await f.actions.patch('t', fields); assert.equal(f.row().title, '修改 标题 结尾'); assert.equal(f.row().notes, '甲\n乙');
  assert.equal(fields.title, '  修改\r\n标题\n结尾  ', '不改调用方草稿');
  await f.actions.step('t', 's', 'text', '  新步骤  '); assert.equal(f.row().steps[0].text, '新步骤');
  await assert.rejects(f.actions.patch('t', { title: ' \r\n ' }), /不能为空/);
  await assert.rejects(f.actions.step('t', 's', 'text', '  '), /不能为空/);
  await f.actions.addSteps('t', '  第一步  \r\n  第二步  '); assert.deepEqual(f.row().steps.slice(1).map(s => s.text), ['第一步', '第二步']);
});

// PlannerUI.cs ParsePriority/PlannerModel.cs ParseQuick：保留 T15 已授权的语音扩展；
// 本周已过去日期、周内带时间、单词优先级等“疑似不一致”实际应与电脑一致。
test('T29 T26 边界：过去本周拒绝、周内不带时刻、只有日期词仍是标题', async () => {
  const f = await fixture();
  await assert.rejects(f.actions.add('虚构任务 本周三'), /已经过去/);
  await f.actions.add('虚构周报 下周 9点');
  let row = f.source.snapshot().planner.tasks.find(t => t.id === '新编号1');
  assert.deepEqual([row.title, row.date, row.weekOf, row.time], ['虚构周报', null, '2026-11-16', '']);
  await f.actions.add('明天 !高'); row = f.source.snapshot().planner.tasks.find(t => t.id === '新编号2');
  assert.deepEqual([row.title, row.date, row.priority], ['明天', null, 3]);
});

// Json.cs Json.Utc（固定三位毫秒）；PlannerModel.cs Abandon/RestoreAbandoned/AddAbandonHistory。
test('T29 UTC 毫秒、软件本地时间、无变化撤销与新增撤销回归', async () => {
  const f = await fixture(); await f.actions.patch('t', { notes: '虚构更新' });
  assert.equal(f.row().updated, '2026-11-13T02:00:00.345Z');
  assert.equal(await f.actions.patch('t', { notes: '虚构更新' }), null, '无变化不产生只有 updated 的伪操作');
  await f.actions.abandon('t', '条件变了'); let row = f.row();
  assert.equal(row.doneAt, '2026-11-13 10:00:00'); assert.equal(row.abandonedAt, '2026-11-13T02:00:00.345Z');
  assert.equal(row.abandonHistory[0].at, '2026-11-13T02:00:00.345Z');
  await f.actions.restore('t'); assert.equal(f.row().abandonHistory[1].at, '2026-11-13T02:00:00.345Z');
  const receipt = await f.actions.add('虚构可撤销新任务');
  assert.equal(f.source.snapshot().planner.tasks.length, 2); await receipt.undo(); assert.equal(f.source.snapshot().planner.tasks.length, 1);
});
