import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, habit, planner, row, mount, savedState, TODAY, NOW } from './helpers.js';
import { plannerToState } from '../../sync/convert.js';
import { updateUnit } from '../../sync/edit.js';
import { merge, unitInfo } from '../../sync/merge.js';
import { unitKey, encodeLegacy } from '../../sync/canonical.js';
import { until } from '../tasks/dom-double.js';
const day = '2026-11-12', key = unitKey('habit-journal', 'h', day);
const selectDay = (editor, value) => { editor.date.value = value; editor.date.emit('change'); };

test('感想只改 note，清空仍保留照片/未知字段；与打卡独立，不自动 checkToo', async () => {
  const f = await fixture(), before = await savedState(f.store);
  await f.actions.saveJournal('h', day, '  新的虚构感想\r\n第二行  '); const after = await savedState(f.store);
  assert.deepEqual(row(f.source).journal[day], { ...habit().journal[day], note: '新的虚构感想\n第二行' });
  assert.deepEqual(row(f.source).checks, []);
  assert.deepEqual(Object.keys(after.units).filter(k => JSON.stringify(before.units[k]) !== JSON.stringify(after.units[k])).sort(), [unitKey('entity', 'habits', 'h'), key].sort());
  f.clock.advance(); await f.actions.saveJournal('h', day, ''); assert.deepEqual(row(f.source).journal[day], { ...habit().journal[day], note: '' });
  assert.equal(unitInfo((await savedState(f.store)).units[key]).preferred.deleted, false);
});
test('感想日期遵循 CanJournal：开始当天至今天，早于六天和结束后仍可写，旧对象格式异常不可覆盖', async () => {
  const f = await fixture({ state: plannerToState(planner([habit({ start: '2026-11-12', end: '2026-11-12' })]), 'computer', NOW) });
  await assert.rejects(f.actions.saveJournal('h', '2026-11-11', '不能写'), /开始当天到今天/);
  await f.actions.saveJournal('h', TODAY, '结束后的感想'); assert.equal(row(f.source).journal[TODAY].note, '结束后的感想');
  await assert.rejects(f.actions.saveJournal('h', '2026-11-14', '未来'), /开始当天到今天/);
  const older = await fixture();
  await older.actions.saveJournal('h', '2026-10-01', '开始当天的虚构感想');
  assert.equal(row(older.source).journal['2026-10-01'].note, '开始当天的虚构感想');
  const g = await fixture({ state: plannerToState(planner([habit({ journal: { [day]: '未知旧格式' } })]), 'computer', NOW) });
  await assert.rejects(g.actions.saveJournal('h', day, '不能覆盖'), /格式/); assert.equal(row(g.source).journal[day], '未知旧格式');
});
test('感想编辑打开后收到远端新版，使用旧凭据保存形成候选，不覆盖照片或新分支', async () => {
  const base = plannerToState(planner(), 'computer', NOW), f = await fixture({ state: base }), seen = f.source.snapshot();
  const remoteEntry = { note: '电脑的虚构感想', photos: ['new-fiction.jpg'], future: { keep: 2 } };
  const remote = updateUnit(base, key, 'computer', encodeLegacy(remoteEntry));
  await f.store.update(r => { r.state = merge(r.state, remote); }); await f.source.refresh();
  await f.actions.saveJournal('h', day, '手机的虚构感想', { baseToken: seen.editToken });
  const conflict = f.source.snapshot().conflicts.find(c => c.key === key); assert.equal(conflict.candidates.length, 2);
  assert.deepEqual(conflict.candidates.find(c => c.value.note === '电脑的虚构感想').value, remoteEntry);
  assert.deepEqual(conflict.candidates.find(c => c.value.note === '手机的虚构感想').value.photos, ['fiction.jpg']);
  await f.source.resolve(key, { branch: conflict.candidates.find(c => c.value.note === '手机的虚构感想').branch, observed: f.source.snapshot().editToken });
  assert.equal(row(f.source).journal[day].note, '手机的虚构感想'); assert.equal(f.source.snapshot().conflicts.length, 0);
});
test('模拟 DOM：已知感想冲突须先选版本，仍能切换到其他日期编辑', async t => {
  const base = plannerToState(planner(), 'computer', NOW);
  const version = note => encodeLegacy({ note, photos: ['fiction.jpg'] });
  const state = merge(updateUnit(base, key, 'computer', version('虚构甲')), updateUnit(base, key, 'other', version('虚构乙')));
  const f = await fixture({ state }), { root, view } = mount(f, t), editor = view.journal;
  root.querySelector('.habit-journal-write').emit('click');
  selectDay(editor, day); await until(() => editor.day === day);
  assert.equal(editor.input.disabled, true); assert.match(editor.status.textContent, /选择保留的版本/);
  selectDay(editor, TODAY); await until(() => editor.day === TODAY);
  assert.equal(editor.input.disabled, false);
  await editor.close(); assert.ok(root.querySelector('.conflict-card'));
});
test('模拟 DOM：默认今天，可选旧日期及照片提示；模拟远端刷新保留文字、焦点和选区，保存写到所选日期', async t => {
  const f = await fixture(), { document, root, view } = mount(f, t), editor = view.journal;
  root.querySelector('.habit-journal-toggle').emit('click');
  assert.match(root.querySelector('.habit-journal-list').textContent, /虚构旧感想/);
  assert.equal(root.querySelectorAll('.habit-journal-marker').length, 1);
  root.querySelector('.habit-journal-write').emit('click');
  assert.equal(editor.dialog.open, true); assert.equal(editor.date.type, 'date');
  assert.equal(editor.date.value, TODAY); assert.equal(editor.date.min, '2026-10-01'); assert.equal(editor.date.max, TODAY);
  selectDay(editor, day); await until(() => editor.day === day);
  assert.match(editor.photos.textContent, /这一天有 1 张照片，请在电脑上查看/);
  const input = editor.input; input.focus(); input.value = '手机正在写'; input.selectionStart = 2; input.selectionEnd = 4; input.emit('input');
  await f.store.update(record => { record.state = updateUnit(record.state, unitKey('habit-check', 'h', TODAY), 'computer', true); });
  await f.source.refresh(); assert.equal(editor.input, input); assert.equal(document.activeElement, input);
  assert.equal(editor.date.value, day); assert.equal(input.value, '手机正在写');
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 4);
  await editor.close(); assert.equal(editor.dialog.open, false);
  assert.equal(row(f.source).journal[day].note, '手机正在写'); assert.deepEqual(row(f.source).journal[day].photos, ['fiction.jpg']);
  assert.equal(row(f.source).journal[TODAY], undefined);
  assert.equal(document.activeElement, root.querySelector('.habit-journal-write'));
});
test('模拟 DOM：切日期先保存原日期草稿，失败恢复原日期；周感想只显示当前翻到的周', async t => {
  const f = await fixture(), { root, view } = mount(f, t), editor = view.journal;
  root.querySelector('.habit-journal-write').emit('click');
  editor.input.value = '今天虚构草稿'; editor.input.emit('input');
  f.store.failNextWrite(); selectDay(editor, '2026-10-01');
  await until(() => /保存失败/.test(editor.status.textContent) && !editor.date.disabled);
  assert.equal(editor.date.value, TODAY); assert.equal(editor.input.value, '今天虚构草稿');
  selectDay(editor, '2026-11-14'); await until(() => /到今天之间/.test(editor.status.textContent));
  assert.equal(editor.date.value, TODAY); assert.equal(editor.input.value, '今天虚构草稿');
  selectDay(editor, '2026-10-01'); await until(() => editor.day === '2026-10-01');
  assert.equal(row(f.source).journal[TODAY].note, '今天虚构草稿'); assert.equal(editor.input.value, '');
  editor.input.value = '跨月的虚构感想'; editor.input.emit('input'); await editor.close();
  assert.equal(row(f.source).journal['2026-10-01'].note, '跨月的虚构感想');
  root.querySelector('.habit-journal-toggle').emit('click');
  const panel = () => root.querySelector('.habit-journal-list').textContent;
  assert.match(panel(), /今天虚构草稿/); assert.doesNotMatch(panel(), /跨月的虚构感想/);
  for (let i = 0; i < 6; i++) root.querySelector('[data-habit-focus="week:prev"]').emit('click');
  assert.match(panel(), /跨月的虚构感想/); assert.doesNotMatch(panel(), /今天虚构草稿/);
});
test('模拟 DOM：切页 flush 遇输入法/写失败不丢草稿，恢复后保存并关闭；只读不能编辑感想', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  root.querySelector('.habit-journal-write').emit('click');
  const input = view.journal.input; input.emit('compositionstart'); input.value = '尚在选词'; input.emit('input');
  await assert.rejects(view.leave(), /输入法/); assert.equal(view.journal.dialog.open, true);
  input.emit('compositionend'); f.store.failNextWrite(); await assert.rejects(view.leave(), /保存失败/); assert.equal(input.value, '尚在选词'); assert.equal(view.journal.dirty, true);
  await view.leave(); assert.equal(view.journal.dialog.open, false); assert.equal(row(f.source).journal[TODAY].note, '尚在选词');
  const g = await fixture({ joined: false }), other = mount(g, t);
  assert.equal(other.root.querySelector('.habit-journal-write').disabled, true);
  other.root.querySelector('.habit-journal-toggle').emit('click');
  assert.match(other.root.querySelector('.habit-journal-list').textContent, /虚构旧感想/);
  assert.equal(other.root.querySelector('.habit-journal-entry').tagName, 'DIV');
});

test('T46-4 取消无改动直接关闭，有草稿须确认且保持原感想与照片', async t => {
  const f = await fixture(), { root, view, document } = mount(f, t), editor = view.journal;
  const write = root.querySelector('.habit-journal-write');
  write.emit('click');
  editor.cancel.emit('click');
  assert.equal(editor.dialog.open, false);
  assert.equal(document.activeElement, write);

  write.emit('click');
  selectDay(editor, day);
  await until(() => editor.day === day);
  const before = await savedState(f.store);
  editor.input.value = '';
  editor.input.emit('input');
  editor.cancel.emit('click');
  assert.equal(editor.dialog.open, true);
  assert.equal(editor.confirmation.hidden, false);
  await assert.rejects(view.flush(), /继续编辑或放弃/);
  editor.dialog.emit('cancel');
  assert.equal(editor.confirmation.hidden, true);
  assert.equal(editor.input.value, '');
  assert.equal(document.activeElement, editor.input);
  editor.dialog.emit('cancel');
  assert.equal(editor.confirmation.hidden, false);
  editor.discard.emit('click');
  assert.equal(editor.dialog.open, false);
  assert.equal(editor.dirty, false);
  assert.deepEqual(await savedState(f.store), before);
});

test('T46-9 今日已记入口在标题行，历史周按条计数且可跳到对应日期编辑', async t => {
  const journal = {
    ...habit().journal,
    [TODAY]: { note: '今天的虚构笔记' },
    '2026-11-08': { note: '上一周的虚构笔记' }
  };
  const state = plannerToState(planner([habit({ journal })]), 'computer', NOW);
  const f = await fixture({ state }), { root, view, document } = mount(f, t), editor = view.journal;
  const write = root.querySelector('.habit-journal-write');
  assert.equal(write.parentNode, root.querySelector('.habit-row'));
  assert.equal(write.textContent, '已记');
  write.emit('click');
  assert.equal(editor.day, TODAY);
  assert.equal(document.activeElement, editor.input);
  editor.cancel.emit('click');
  const toggle = () => root.querySelector('.habit-journal-toggle');
  assert.match(toggle().textContent, /^本周感想 2 条/);
  root.querySelector('[data-habit-focus="week:prev"]').emit('click');
  assert.match(toggle().textContent, /^当周感想 1 条/);
  toggle().emit('click');
  let entry = root.querySelector('.habit-journal-entry');
  entry.emit('click');
  assert.equal(editor.day, '2026-11-08');
  assert.equal(document.activeElement, editor.input);
  editor.input.value = '更新旧日笔记';
  editor.input.emit('input');
  await editor.close();
  entry = root.querySelector('.habit-journal-entry');
  assert.equal(document.activeElement, entry);
  assert.match(entry.textContent, /更新旧日笔记/);
  root.querySelector('[data-habit-focus="week:prev"]').emit('click');
  assert.equal(toggle(), null);
});
