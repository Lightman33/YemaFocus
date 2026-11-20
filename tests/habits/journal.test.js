import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, habit, planner, row, mount, savedState, TODAY, NOW } from './helpers.js';
import { plannerToState } from '../../sync/convert.js';
import { updateUnit } from '../../sync/edit.js';
import { merge, unitInfo } from '../../sync/merge.js';
import { unitKey, encodeLegacy } from '../../sync/canonical.js';
const day = '2026-11-12', key = unitKey('habit-journal', 'h', day);

test('感想只改 note，清空仍保留照片/未知字段；与打卡独立，不自动 checkToo', async () => {
  const f = await fixture(), before = await savedState(f.store);
  await f.actions.saveJournal('h', day, '  新的虚构感想\r\n第二行  '); const after = await savedState(f.store);
  assert.deepEqual(row(f.source).journal[day], { ...habit().journal[day], note: '新的虚构感想\n第二行' });
  assert.deepEqual(row(f.source).checks, []);
  assert.deepEqual(Object.keys(after.units).filter(k => JSON.stringify(before.units[k]) !== JSON.stringify(after.units[k])).sort(), [unitKey('entity', 'habits', 'h'), key].sort());
  f.clock.advance(); await f.actions.saveJournal('h', day, ''); assert.deepEqual(row(f.source).journal[day], { ...habit().journal[day], note: '' });
  assert.equal(unitInfo((await savedState(f.store)).units[key]).preferred.deleted, false);
});
test('感想日期遵循 CanJournal：开始之后、最近七天；结束后仍可写，旧对象格式异常不可覆盖', async () => {
  const f = await fixture({ state: plannerToState(planner([habit({ start: '2026-11-12', end: '2026-11-12' })]), 'computer', NOW) });
  await assert.rejects(f.actions.saveJournal('h', '2026-11-11', '不能写'), /开始日期/);
  await f.actions.saveJournal('h', TODAY, '结束后的感想'); assert.equal(row(f.source).journal[TODAY].note, '结束后的感想');
  await assert.rejects(f.actions.saveJournal('h', '2026-11-14', '未来'), /最近七天/);
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
test('模拟 DOM：点名称展开感想与照片提示；编辑节点在同步刷新时稳定，保存后保留照片引用', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  root.querySelector('.habit-name-button').emit('click'); assert.match(root.textContent, /虚构旧感想/); assert.match(root.textContent, /有 1 张照片，请在电脑上查看/);
  const edit = root.querySelectorAll('button').find(b => b.getAttribute('aria-label') === '虚构阅读，2026-11-12，编辑文字感想'); edit.emit('click');
  const input = view.journal.input; assert.equal(view.journal.dialog.open, true); input.value = '手机正在写'; input.selectionStart = 3; input.emit('input');
  await f.actions.toggle('h', TODAY); assert.equal(view.journal.input, input); assert.equal(input.value, '手机正在写'); assert.equal(input.selectionStart, 3);
  await view.journal.close(); assert.equal(view.journal.dialog.open, false); assert.equal(row(f.source).journal[day].note, '手机正在写'); assert.deepEqual(row(f.source).journal[day].photos, ['fiction.jpg']);
});
test('模拟 DOM：切页 flush 遇输入法/写失败不丢草稿，恢复后保存并关闭；只读不能编辑感想', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  root.querySelector('.habit-name-button').emit('click'); root.querySelectorAll('button').find(b => b.getAttribute('aria-label') === '虚构阅读，2026-11-13，编辑文字感想').emit('click');
  const input = view.journal.input; input.emit('compositionstart'); input.value = '尚在选词'; input.emit('input');
  await assert.rejects(view.leave(), /输入法/); assert.equal(view.journal.dialog.open, true);
  input.emit('compositionend'); f.store.failNextWrite(); await assert.rejects(view.leave(), /保存失败/); assert.equal(input.value, '尚在选词'); assert.equal(view.journal.dirty, true);
  await view.leave(); assert.equal(view.journal.dialog.open, false); assert.equal(row(f.source).journal[TODAY].note, '尚在选词');
  const g = await fixture({ joined: false }), other = mount(g, t); other.root.querySelector('.habit-name-button').emit('click');
  assert.ok(other.root.querySelectorAll('.habit-journal-entry').every(n => n.querySelector('button').disabled));
});
