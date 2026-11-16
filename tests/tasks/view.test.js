import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument, until } from './dom-double.js';
import { MemoryStore, freshRecord } from '../../app/store.js';
import { createDataSource } from '../../app/datasource.js';
import { TasksView } from '../../app/tasks-view.js';
import { makeTask } from '../../app/task-actions.js';
import { plannerToState } from '../../sync/convert.js';
import { unitKey } from '../../sync/canonical.js';
import { updateUnit, deleteUnit } from '../../sync/edit.js';
import { merge } from '../../sync/merge.js';
import { demoState } from '../../app/demo-data.js';
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-13T01:00:00Z');
const plain = () => ({ version: 1, tasks: [makeTask('虚构首条任务', { id: 't', date: '2026-11-13', now: NOW, timeZone: 'Asia/Shanghai' })], projects: [{ id: 'p', name: '虚构项目' }], habits: [], weekNotes: [], deleted: {} });
async function setup(t, { planner = plain(), state = plannerToState(planner, 'computer', NOW), joined = true, ui = {} } = {}) {
  const store = new MemoryStore({ ...freshRecord(), state, settings: { deviceId: 'phone', joined, taskUI: ui } });
  const source = await createDataSource({ store, now: () => NOW });
  const document = parseDocument(html), $ = id => document.getElementById(id);
  let saved = 0;
  const view = new TasksView({ document, source, main: $('main'), now: () => NOW, onSaved: () => saved++ });
  $('page-tasks').hidden = false;
  t.after(() => view.destroy());
  return { store, source, document, $, view, saved: () => saved };
}
function byName(document, name) {
  return document.querySelectorAll('button').find(b => b.getAttribute('aria-label') === name);
}
function byText(document, text) { return document.querySelectorAll('button').find(b => b.textContent === text); }
const task = f => f.source.snapshot().planner.tasks.find(t => t.id === 't');
test('DOM 模拟：勾选圈、5 秒撤销条、打开详情及键盘/关闭按钮', async t => {
  const f = await setup(t);
  const check = f.document.querySelector('.task-check'); assert.match(check.getAttribute('aria-label'), /完成任务：虚构首条任务，.*今天.*无优先级/);
  check.emit('click'); await until(() => !f.$('task-undo').hidden);
  assert.equal(task(f).done, true); assert.equal(f.$('task-snackbar').hidden, false);
  f.$('task-undo').emit('click'); await until(() => task(f).done === false && f.$('task-snackbar').hidden);
  f.document.querySelector('.task-open').emit('click'); await until(() => f.$('task-detail-title'));
  assert.equal(f.$('task-sheet').open, true); assert.equal(f.$('task-detail-title').value, '虚构首条任务');
  const buttons = f.$('task-sheet').querySelectorAll('button, input, textarea, select, [tabindex]').filter(n => { if (n.disabled) return false; for (let p = n; p; p = p.parentNode) if (p.hidden) return false; return true; });
  buttons.at(-1).focus(); const tab = f.$('task-sheet').emit('keydown', { key: 'Tab' }); assert.equal(tab.defaultPrevented, true); assert.equal(f.document.activeElement, buttons[0]);
  f.$('task-sheet').emit('keydown', { key: 'Escape' }); await until(() => !f.$('task-sheet').open);
  await f.view.openDetail('t'); f.$('task-sheet-close').emit('click'); await until(() => !f.$('task-sheet').open);
});
test('DOM 模拟：未加入禁用新建，示例页折叠组不生成任务节点，分页 50 条', async t => {
  const f = await setup(t, { joined: false });
  assert.equal(f.$('task-quick').disabled, true); assert.equal(f.$('task-list').children.length, 0);
  assert.match(f.$('task-join-tip').textContent, /第一次同步/);
  const p = plain(); p.tasks = Array.from({ length: 120 }, (_, i) => ({ ...p.tasks[0], id: 'done-' + i, done: true, doneAt: '2026-11-13 09:00:00' }));
  const g = await setup(t, { planner: p }); assert.equal(g.document.querySelectorAll('.task-item').length, 0);
  byName(g.document, '展开已完成，120项').emit('click'); assert.equal(g.document.querySelectorAll('.task-item').length, 50);
  byName(g.document, '再显示已完成的50条任务').emit('click'); assert.equal(g.document.querySelectorAll('.task-item').length, 100);
  byName(g.document, '收起已完成，120项').emit('click'); assert.equal(g.document.querySelectorAll('.task-item').length, 0);
});
test('DOM 模拟：快速新建解析标签可去掉；输入中刷新不丢字，提交后数据正确', async t => {
  const f = await setup(t); const input = f.$('task-quick'); input.focus(); input.value = '整理虚构材料 明天 9点半 ！高。'; input.emit('input');
  assert.match(f.$('task-parse').textContent, /明天 11月14日 周六.*09:30.*高优先级/);
  byName(f.document, '去掉新任务的优先级：高优先级').emit('click');
  await f.source.refresh(); assert.equal(input.value, '整理虚构材料 明天 9点半 ！高。');
  f.$('task-quick-form').emit('submit'); await until(() => f.source.snapshot().planner.tasks.length === 2 && !f.view.busy);
  const created = f.source.snapshot().planner.tasks.find(t => t.id !== 't'); assert.equal(created.date, '2026-11-14'); assert.equal(created.time, '09:30'); assert.equal(created.priority, 0); assert.equal(created.title, '整理虚构材料');
  assert.equal(input.value, '');
});
test('DOM 模拟：备注停顿 300ms 保存；聚焦时收到新数据保留同一个输入框和草稿，其他字段更新', async t => {
  const f = await setup(t); await f.view.openDetail('t'); const notes = f.$('task-detail-notes'); notes.focus(); notes.value = '正在语音输入的虚构备注'; notes.emit('input');
  // 模拟已落盘的同步刷新，不调用真实联网。
  const key = unitKey('task-content', 't'), base = (await f.store.read()).state;
  await f.store.update(r => { r.state = updateUnit(base, key, 'computer', { ...base.units[key].versions[0].value, title: '电脑改过的虚构标题' }, { updatedAt: NOW + 1 }); });
  await f.source.refresh(); assert.equal(f.$('task-detail-notes'), notes); assert.equal(notes.value, '正在语音输入的虚构备注'); assert.equal(f.document.activeElement, notes);
  assert.equal(f.$('task-detail-title').value, '电脑改过的虚构标题');
  await until(() => /已存本机/.test(f.$('task-save-status').textContent));
  assert.equal(f.source.snapshot().conflicts.length, 1, '基于看到的旧版本保存，不暗中覆盖后来收到的字段');
  assert.ok(f.source.snapshot().conflicts[0].candidates.some(c => c.value.notes === '正在语音输入的虚构备注'));
  notes.value = '正在语音输入的虚构备注，补完下一句'; notes.emit('input');
  await until(() => f.source.snapshot().conflicts[0].candidates.some(c => c.value.notes === notes.value));
  await f.view.closeSheet(); assert.equal(f.$('task-sheet').open, false);
});
test('DOM 模拟：失焦和切页立即保存；存储失败时保留输入且不关闭抽屉', async t => {
  const f = await setup(t); await f.view.openDetail('t'); const title = f.$('task-detail-title'); title.focus(); title.value = '失焦立即保存'; title.emit('input'); title.blur(); await until(() => task(f).title === '失焦立即保存');
  const notes = f.$('task-detail-notes'); notes.focus(); notes.value = '切页前保存'; notes.emit('input'); await f.view.leave(); assert.equal(task(f).notes, '切页前保存'); assert.equal(f.$('task-sheet').open, false);
  await f.view.openDetail('t'); const n = f.$('task-detail-notes'); n.focus(); n.value = '未成功的文字'; n.emit('input'); f.store.failNextWrite();
  await f.view.closeSheet(); assert.equal(f.$('task-sheet').open, true); assert.equal(n.value, '未成功的文字'); assert.equal(task(f).notes, '切页前保存'); assert.match(f.$('task-save-status').textContent, /保存失败/);
  await f.view.closeSheet(); assert.equal(task(f).notes, '未成功的文字'); assert.equal(f.$('task-sheet').open, false);
});
test('DOM 模拟：详情步骤增删改勾、多行粘贴拆分、列表步骤可直接勾', async t => {
  const f = await setup(t); await f.view.openDetail('t'); const add = f.$('task-detail-new-steps');
  const paste = add.emit('paste', { clipboardData: { getData: () => '准备材料\n检查\n收尾' } }); assert.equal(paste.defaultPrevented, true);
  await until(() => task(f).steps.length === 3 && !f.view.busy);
  let steps = f.document.querySelectorAll('.detail-step'); assert.equal(steps.length, 3);
  steps[0].querySelector('button').emit('click'); await until(() => task(f).steps[0].done);
  const input = steps[1].querySelector('input'); input.focus(); input.value = '再次检查'; input.emit('input'); input.blur(); await until(() => task(f).steps[1].text === '再次检查');
  steps = f.document.querySelectorAll('.detail-step'); steps[2].querySelectorAll('button').at(-1).emit('click'); await until(() => task(f).steps.length === 2);
  await f.view.closeSheet(); f.document.querySelector('.task-step-toggle').emit('click'); assert.equal(f.document.querySelectorAll('.inline-step').length, 2);
  f.document.querySelectorAll('.inline-step')[1].emit('click'); await until(() => task(f).steps.every(s => s.done));
});
test('DOM 模拟：操作面板改期、优先级、项目；放弃原因与恢复、删除后撤销', async t => {
  const f = await setup(t); await f.view.openMenu('t'); byText(f.document, '明天').emit('click'); await until(() => task(f).date === '2026-11-14' && !f.view.busy);
  assert.equal(f.$('task-sheet').open, false); assert.equal(f.$('task-undo').hidden, false);
  await f.view.openMenu('t'); byText(f.document, '高优先级').emit('click'); await until(() => task(f).priority === 3 && !f.view.busy);
  await f.view.openMenu('t'); f.$('task-detail-move-project').value = 'p'; byText(f.document, '移动到所选项目').emit('click'); await until(() => task(f).project === 'p' && !f.view.busy);
  await f.view.openAbandon('t'); byText(f.document, '条件变了').emit('click'); f.$('task-detail-reason').value = '虚构说明'; byName(f.document, '确认放弃任务并保存原因').emit('click');
  await until(() => task(f).abandoned && !f.view.busy); assert.equal(task(f).abandonReason, '条件变了：虚构说明');
  byName(f.document, '展开已放弃，1项').emit('click'); assert.match(f.document.querySelector('.task-reason').textContent, /条件变了：虚构说明/);
  f.document.querySelector('.task-check').emit('click'); await until(() => !task(f).done && !f.view.busy);
  await f.view.openMenu('t'); byText(f.document, '删除任务').emit('click'); await until(() => !task(f) && !f.view.busy);
  f.$('task-undo').emit('click'); await until(() => Boolean(task(f)) && !f.view.busy);
});
test('DOM 模拟：冲突横幅定位、完整字段卡片和“两段都留着”入口', async t => {
  const f = await setup(t, { state: demoState(NOW) }); f.$('task-conflicts').emit('click'); await until(() => f.$('task-sheet').open && f.document.querySelector('.conflict-card'));
  assert.match(f.document.querySelector('.conflict-card').textContent, /备注：.*电脑记下/s);
  byText(f.document, '两段都留着').emit('click'); await until(() => f.source.snapshot().conflicts.length === 0 && !f.view.busy);
  assert.equal(f.$('task-conflicts').hidden, true);
});
test('DOM 模拟：重复任务提示、界面状态持久化、数据文字只当文字显示', async t => {
  const p = plain(); p.tasks[0].title = '<img src=x onerror=alert(1)>'; p.tasks[0].repeat = { kind: 'Daily' };
  const f = await setup(t, { planner: p }); assert.equal(f.document.querySelectorAll('img').length, 0); assert.equal(f.document.querySelector('.task-title').textContent, p.tasks[0].title);
  f.document.querySelector('.task-check').emit('click'); await until(() => /重复任务请先在电脑上完成/.test(f.$('task-snack-text').textContent));
  assert.equal(task(f).done, false); await f.view.openDetail('t'); assert.equal(f.$('task-detail-notes').disabled, true);
  byName(f.document, '放弃任务').emit('click'); assert.match(f.$('task-snack-text').textContent, /重复任务/);
  await f.view.closeSheet(); f.$('group-project').emit('click'); f.$('main').scrollTop = 321; f.$('main').emit('scroll');
  await until(() => f.source.uiState().mode === 'project' && f.source.uiState().scrollTop === 321);
  assert.equal((await f.store.read()).settings.taskUI.mode, 'project');
});

test('DOM 模拟：详情改期自动保存后，在模态面板内可按撤销，不被背景遮住', async t => {
  const f = await setup(t); await f.view.openDetail('t'); const date = f.$('task-detail-date'); date.focus(); date.value = '2026-11-14'; date.emit('input');
  await until(() => task(f).date === '2026-11-14' && !f.$('task-undo').hidden);
  assert.equal(f.$('task-sheet').contains(f.$('task-snackbar')), true);
  f.$('task-undo').emit('click'); await until(() => task(f).date === '2026-11-13' && !f.view.busy);
  assert.equal(f.$('task-sheet').open, true); await f.view.closeSheet();
  assert.equal(f.$('task-sheet').contains(f.$('task-snackbar')), false);
});
test('DOM 模拟：输入法组合期间不保存半句话，组合结束后 300ms 保存；新步骤草稿切走也提交', async t => {
  const f = await setup(t); await f.view.openDetail('t'); const notes = f.$('task-detail-notes'); notes.focus(); notes.emit('compositionstart'); notes.value = '组合中的半句话'; notes.emit('input');
  await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(task(f).notes, '');
  await f.view.closeSheet(); assert.equal(f.$('task-sheet').open, true); assert.match(f.$('task-save-status').textContent, /输入法还在组织文字/);
  notes.value = '组合完成的完整句子'; notes.emit('compositionend'); await until(() => task(f).notes === '组合完成的完整句子');
  const steps = f.$('task-detail-new-steps'); steps.focus(); steps.value = '尚未按添加的一条步骤'; steps.emit('input');
  await f.view.leave(); assert.equal(task(f).steps.length, 1); assert.equal(task(f).steps[0].text, '尚未按添加的一条步骤');
});
test('DOM 模拟：关闭再创建视图保留分组/折叠和滚动位置；5 秒后不可撤销', async t => {
  const f = await setup(t); f.$('group-project').emit('click'); f.$('main').scrollTop = 123; f.view.savePosition(); await until(() => f.source.uiState().scrollTop === 123);
  const state = await f.store.read(); const g = await setup(t, { state: state.state, ui: state.settings.taskUI });
  g.view.entered(); assert.equal(g.$('main').scrollTop, 123); assert.equal(g.$('group-project').getAttribute('aria-pressed'), 'true');
  g.document.querySelector('.task-check').emit('click'); await until(() => !g.$('task-undo').hidden); g.view.now = () => NOW + 5001;
  g.$('task-undo').emit('click'); await until(() => !g.view.busy); assert.equal(task(g).done, true);
});

test('DOM 模拟：确认删除任务后，保留的子单元候选不形成无法定位的冲突横幅', async t => {
  const base = plannerToState(plain(), 'computer', NOW), ek = unitKey('entity', 'tasks', 't'), ck = unitKey('task-content', 't'), value = base.units[ck].versions[0].value;
  const state = merge(merge(deleteUnit(base, ek, 'computer'), updateUnit(base, ek, 'phone', true)), merge(updateUnit(base, ck, 'computer', { ...value, notes: 'A' }), updateUnit(base, ck, 'phone', { ...value, notes: 'B' })));
  const f = await setup(t, { state }); await f.view.openDetail('t'); byText(f.document, '确认删除').emit('click');
  await until(() => !task(f) && !f.view.busy); assert.equal(f.$('task-sheet').open, false); assert.equal(f.$('task-conflicts').hidden, true);
  assert.equal(f.source.snapshot().conflicts[0].candidates.length, 2); assert.equal(f.source.snapshot().conflicts[0].hiddenByDeletion, true);
});
