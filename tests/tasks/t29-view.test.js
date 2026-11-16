import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument, until } from './dom-double.js';
import { MemoryStore, freshRecord } from '../../app/store.js';
import { createDataSource } from '../../app/datasource.js';
import { TasksView } from '../../app/tasks-view.js';
import { makeTask } from '../../app/task-actions.js';
import { plannerToState } from '../../sync/convert.js';
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-13T02:00:00.345Z');
async function setup(t, extra = {}) {
  const planner = { version: 1, tasks: [{ ...makeTask('虚构任务', { id: 't', date: '2026-11-13', now: NOW, timeZone: 'Asia/Shanghai' }), ...extra }], projects: [], habits: [], weekNotes: [], deleted: {} };
  const store = new MemoryStore({ ...freshRecord(), state: plannerToState(planner, 'computer', NOW - 1000), settings: { deviceId: 'phone', joined: true } });
  const source = await createDataSource({ store, now: () => NOW });
  const document = parseDocument(html), $ = id => document.getElementById(id);
  const view = new TasksView({ document, source, main: $('main'), now: () => NOW }); $('page-tasks').hidden = false;
  t.after(() => view.destroy());
  return { store, source, document, $, view, row: () => source.snapshot().planner.tasks.find(t => t.id === 't') };
}
const byText = (f, text) => f.document.querySelectorAll('button').find(b => b.textContent === text);

// PlannerModel.cs IsRepeating / Uncomplete；T29 裁决 1 只拦系列回退。
test('T29 DOM 模拟：系列历史不标重复，详情可编辑删除，取消完成给专用说明', async t => {
  const f = await setup(t, { done: true, series: '系列' });
  byText(f, '▸ 已完成 · 1').emit('click');
  assert.doesNotMatch(f.document.querySelector('.task-meta').textContent, /重复/);
  f.document.querySelector('.task-check').emit('click'); await until(() => /这条记录来自重复任务/.test(f.$('task-snack-text').textContent));
  await f.view.openDetail('t'); assert.equal(f.$('task-detail-title').disabled, false); assert.equal(f.$('task-detail-notes').disabled, false); assert.equal(f.view.deleteButton.disabled, false);
});

// PlannerModel.cs ParseQuick；T29 裁决 3 要求预览真实标题。
test('T29 DOM 模拟：分隔日期显示最终标题，粘连纯日期仍保留原文', async t => {
  const f = await setup(t), input = f.$('task-quick');
  input.value = '明天，整理资料'; input.emit('input'); assert.match(f.$('task-parse').textContent, /标题：整理资料/);
  input.value = '本周工作总结'; input.emit('input'); assert.equal(f.view.parsed().title, input.value); assert.ok(f.view.parsed().weekOf);
});

// 电脑版单行标题提交，PlannerModel.cs Add.Trim；T29 裁决 4。
test('T29 DOM 模拟：标题回车保存失焦，组合输入和选词回车不提交', async t => {
  const f = await setup(t); await f.view.openDetail('t'); const input = f.$('task-detail-title');
  input.focus(); input.emit('compositionstart'); input.value = '选词中的虚构标题'; input.emit('input');
  assert.equal(input.emit('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, false);
  assert.equal(input.emit('keydown', { key: 'Enter', isComposing: false }).defaultPrevented, false);
  assert.equal(f.document.activeElement, input); assert.equal(f.row().title, '虚构任务');
  input.emit('compositionend');
  assert.equal(input.emit('keydown', { key: 'Enter', keyCode: 229 }).defaultPrevented, false);
  input.value = '  完成\n标题  '; input.emit('input');
  assert.equal(input.emit('keydown', { key: 'Enter' }).defaultPrevented, true);
  await until(() => f.row().title === '完成 标题'); assert.notEqual(f.document.activeElement, input);
});

// T26 问题 6 / T29 裁决 5；电脑版 Step 的字段形状见 PlannerModel.cs Step/ToJson。
test('T29 DOM 模拟：步骤失焦只存草稿，其他字段操作不暗中提交', async t => {
  const f = await setup(t); await f.view.openDetail('t'); const input = f.$('task-detail-new-steps');
  input.focus(); input.value = '尚未输入完的虚构步骤'; input.emit('input'); input.blur();
  await until(() => f.source.uiState().stepDrafts?.t === input.value);
  assert.equal(f.row().steps.length, 0); assert.equal(input.value, '尚未输入完的虚构步骤');
  const notes = f.$('task-detail-notes'); notes.focus(); notes.value = '虚构备注'; notes.emit('input'); notes.blur();
  await until(() => f.row().notes === '虚构备注'); assert.equal(f.row().steps.length, 0);
});

for (const route of ['按钮', '回车', '多行粘贴', '关闭', '切页', '切到更多']) test('T29 DOM 模拟：添加步骤途径都有撤销：' + route, async t => {
  const f = await setup(t); await f.view.openDetail('t'); const input = f.$('task-detail-new-steps');
  input.focus(); input.value = '虚构待添加步骤'; input.emit('input');
  if (route === '按钮') { input.blur(); byText(f, '添加步骤').emit('click'); }
  if (route === '回车') input.emit('keydown', { key: 'Enter' });
  if (route === '多行粘贴') { input.value = ''; input.emit('paste', { clipboardData: { getData: () => '甲\n乙' } }); }
  if (route === '关闭') await f.view.closeSheet();
  if (route === '切页') await f.view.leave();
  if (route === '切到更多') await f.view.openMenu('t');
  await until(() => f.row().steps.length > 0 && !f.view.busy);
  assert.equal(f.$('task-snackbar').hidden, false); assert.equal(f.$('task-undo').hidden, false); assert.equal(input.value, '');
  if (['关闭', '切页', '切到更多'].includes(route)) assert.match(f.$('task-snack-text').textContent, /已把未提交的文字添加为步骤/);
  f.$('task-undo').emit('click'); await until(() => f.row().steps.length === 0 && !f.view.busy);
  assert.equal(f.source.uiState().stepDrafts?.t, undefined);
});

test('T29 DOM 模拟：新步骤输入法选词不提交，保存失败保留草稿与详情', async t => {
  const f = await setup(t); await f.view.openDetail('t'); const input = f.$('task-detail-new-steps');
  input.focus(); input.emit('compositionstart'); input.value = '正在选词'; input.emit('input');
  assert.equal(input.emit('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, false);
  await f.view.closeSheet(); assert.equal(f.$('task-sheet').open, true); assert.equal(f.row().steps.length, 0);
  input.emit('compositionend'); await until(() => f.source.uiState().stepDrafts?.t === input.value);
  // 只让业务提交失败，草稿保存仍允许；不用真实数据或真实数据库。
  const addSteps = f.view.actions.addSteps.bind(f.view.actions);
  f.view.actions.addSteps = async () => { throw new Error('虚构存盘失败'); };
  await f.view.closeSheet(); assert.equal(f.$('task-sheet').open, true); assert.equal(input.value, '正在选词'); assert.equal(f.row().steps.length, 0);
  f.view.actions.addSteps = addSteps; await f.view.closeSheet(); assert.equal(f.row().steps[0].text, '正在选词');
});

// T29 7.1；与电脑版 AppClock.Now/Today 一样用软件时区。DOM 时间固定为北京时间。
test('T29 DOM 模拟：列表、详情、步骤和读屏日期均可读，标签可取消', async t => {
  const f = await setup(t, { date: '2026-11-10', steps: [{ id: 's', text: '虚构步骤', date: '2026-11-14', done: false }] });
  const open = f.document.querySelector('.task-open'); assert.match(open.textContent, /11月10日 周二.*已逾期/);
  assert.match(open.getAttribute('aria-label'), /11月10日 周二.*已逾期/); assert.doesNotMatch(open.textContent, /2026-11-10/);
  await f.view.openDetail('t'); assert.match(f.view.scheduleInfo.textContent, /11月10日 周二/);
  assert.match(f.view.stats.textContent, /创建于 今天 · 周五 10:00:00/);
  assert.match(f.view.stepRows.get('s').meta.textContent, /明天 · 周六/);
  assert.match(f.view.stepRows.get('s').input.getAttribute('aria-description'), /明天 · 周六/);
  await f.view.closeSheet(); f.$('task-quick').value = '整理资料 明天'; f.$('task-quick').emit('input');
  const chip = f.$('task-parse').querySelector('button'); assert.equal(chip.textContent, '明天 11月14日 周六 ×');
  assert.match(chip.getAttribute('aria-label'), /明天 11月14日 周六/); chip.emit('click'); assert.equal(f.view.parsed().date, null);
});

// T29 7.3；描述由 TaskActions 提供，撤销事务仍沿用 datasource 的因果新版本。
test('T29 DOM 模拟：完成、改期、删除的撤销条写明任务，长标题保留完整可读名称', async t => {
  const title = '虚构的很长任务标题'.repeat(20), f = await setup(t, { title });
  await f.view.perform(() => f.view.actions.toggle('t')); assert.equal(f.$('task-snack-text').textContent, '已完成：' + title);
  assert.equal(f.$('task-snack-text').getAttribute('title'), '已完成：' + title);
  f.$('task-undo').emit('click'); await until(() => !f.row().done && !f.view.busy);
  await f.view.perform(() => f.view.actions.schedule('t', { date: '2026-11-14' })); assert.equal(f.$('task-snack-text').textContent, '已改期：' + title);
  await f.view.perform(() => f.view.actions.remove('t')); assert.equal(f.$('task-snack-text').textContent, '已删除：' + title);
});

// T29 7.5；按 review-view.js 的事件顺序模拟：pointerdown → blur保存 → pointerup → click。
test('T29 DOM 模拟：手指按住期间保存和刷新不替换按钮，抬起点击后补画', async t => {
  const f = await setup(t); await f.view.openDetail('t');
  const notes = f.$('task-detail-notes'); notes.focus(); notes.value = '点击前的虚构备注'; notes.emit('input');
  const close = f.$('task-sheet-close'); f.document.emit('pointerdown', { target: close });
  notes.blur(); await until(() => f.row().notes === '点击前的虚构备注');
  assert.equal(f.view.refreshQueued, true); assert.equal(f.view.detailQueued, true); assert.equal(close.isConnected, true);
  const listButton = f.document.querySelector('.task-check');
  await f.source.refresh(); assert.equal(f.document.querySelector('.task-check'), listButton);
  f.document.emit('pointerup', { target: close });
  await f.source.refresh(); assert.equal(f.document.querySelector('.task-check'), listButton, '抬起和 click 之间仍不换节点');
  close.emit('click'); await until(() => !f.$('task-sheet').open && !f.view.pointerSettling);
  await until(() => f.document.querySelector('.task-check') !== listButton);
  assert.equal(f.row().notes, '点击前的虚构备注');
});

test('T29 DOM 模拟：列表按钮按下时远端刷新不吞点击，pointercancel 也释放绘制', async t => {
  const f = await setup(t); const check = f.document.querySelector('.task-check');
  f.document.emit('pointerdown', { target: check }); await f.source.refresh();
  assert.equal(f.document.querySelector('.task-check'), check);
  f.document.emit('pointerup', { target: check }); check.emit('click');
  await until(() => f.row().done && !f.view.busy && !f.view.pointerSettling);
  f.document.emit('pointerdown', { target: f.$('task-quick') }); await f.source.refresh();
  f.document.emit('pointercancel'); await until(() => !f.view.pointerSettling); assert.equal(f.view.refreshQueued, false);
});

// T29 7.6；CSS [hidden] 强制 display:none。0 时既隐藏也清空文案，非零才出现。
test('T29 DOM 模拟：零冲突横幅隐藏且没有“有0处”的残留文字', async t => {
  const f = await setup(t); assert.equal(f.$('task-conflicts').hidden, true); assert.equal(f.$('task-conflicts').textContent, '');
  const snapshot = f.source.snapshot.bind(f.source);
  f.source.snapshot = () => ({ ...snapshot(), conflicts: [{ taskId: 't', path: ['task-content', 't'], candidates: [] }] });
  f.view.render(); assert.equal(f.$('task-conflicts').hidden, false); assert.match(f.$('task-conflicts').textContent, /有 1 处/);
  f.source.snapshot = snapshot; f.view.render(); assert.equal(f.$('task-conflicts').hidden, true); assert.equal(f.$('task-conflicts').textContent, '');
});

// T29 7.2/7.3/7.4：只有 CSS 静态检查，不能代替 375px 浏览器实际量测。
test('T29 样式静态检查：原因换行、撤销标题省略、步骤44像素点击区和放大符号', async t => {
  const f = await setup(t, { steps: [{ id: 's', text: '虚构步骤', done: false }] });
  await f.view.openAbandon('t'); const reasons = f.document.querySelector('.abandon-reasons'); assert.equal(reasons.children.length, 4);
  const css = await readFile(new URL('../../app/ui.css', import.meta.url), 'utf8');
  assert.match(css, /\.abandon-reasons\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow-x:\s*visible;/);
  assert.match(css, /\.task-snackbar span\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/);
  assert.match(css, /\.step-check\s*\{[^}]*font-size:\s*1\.6rem;/);
  assert.match(css, /\.step-symbol\s*\{[^}]*width:\s*44px;[^}]*min-height:\s*44px;/);
  assert.match(css, /\.task-check, \.task-more, \.task-step-toggle, \.step-check\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  await f.view.openDetail('t'); assert.equal(f.view.stepRows.get('s').toggle.getAttribute('role'), 'checkbox');
  await f.view.closeSheet(); f.document.querySelector('.task-step-toggle').emit('click'); assert.equal(f.document.querySelectorAll('.step-symbol').length, 1);
});
