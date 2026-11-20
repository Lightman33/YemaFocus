import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, habit, planner, mount, row, TODAY, NOW } from './helpers.js';
import { until } from '../tasks/dom-double.js';
import { plannerToState } from '../../sync/convert.js';
import { updateUnit } from '../../sync/edit.js';
import { merge } from '../../sync/merge.js';
import { unitKey } from '../../sync/canonical.js';
const buttons = root => root.querySelectorAll('button');
const todayButton = root => root.querySelector('.habit-today');

test('模拟 DOM：名称、频率、本周进度、最近七天；今天按钮点一次打卡，再点取消，撤销有效', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  assert.match(root.textContent, /虚构阅读/); assert.match(root.textContent, /每天 · 本周 0\/7/);
  assert.equal(root.querySelectorAll('.habit-days')[0].querySelectorAll('button').length, 7);
  assert.match(todayButton(root).getAttribute('aria-label'), /虚构阅读，今天未打卡，本周 0\/7/);
  todayButton(root).emit('click'); await view.flush();
  assert.deepEqual(row(f.source).checks, [TODAY]); assert.equal(todayButton(root).getAttribute('aria-pressed'), 'true');
  assert.equal(view.snackbar.hidden, false); assert.equal(view.undoButton.hidden, false);
  f.clock.advance(); todayButton(root).emit('click'); await view.flush(); assert.deepEqual(row(f.source).checks, []);
  f.clock.advance(); view.undoButton.emit('click'); await view.flush(); assert.deepEqual(row(f.source).checks, [TODAY]);
});
test('模拟 DOM：非计划日可补打/取消；不用打卡折叠区保留展开状态，归档不显示', async t => {
  const f = await fixture({ state: plannerToState(planner([habit({ kind: 'Weekdays', weekMask: 1 }), habit({ id: 'archive', name: '已归档虚构习惯', archived: true })]), 'computer', NOW) });
  const { root, view } = mount(f, t), details = root.querySelector('details'); assert.equal(details.open, false);
  details.open = true; details.emit('toggle');
  const past = root.querySelectorAll('.habit-days')[0].querySelectorAll('button')[0];
  assert.match(past.className, /is-unscheduled/); assert.match(past.getAttribute('aria-label'), /2026-11-07.*不在计划内/); assert.equal(past.disabled, false);
  past.emit('click'); await view.flush(); assert.deepEqual(row(f.source).checks, ['2026-11-07']); assert.equal(root.querySelector('details').open, true);
  assert.doesNotMatch(root.textContent, /已归档虚构习惯/); assert.match(root.textContent, /新建和修改习惯请在电脑上进行/);
});
test('模拟 DOM：延后加载时是加载中，不能误显无习惯；加载完成才出现行和按钮', async t => {
  const f = await fixture({ tasksFirst: true }), { root } = mount(f, t);
  assert.equal(root.getAttribute('aria-busy'), 'true'); assert.match(root.textContent, /正在载入/); assert.doesNotMatch(root.textContent, /没有/); assert.equal(buttons(root).filter(b => b.className.includes('habit-check')).length, 0);
  await f.source.ensureLoaded(); assert.equal(root.getAttribute('aria-busy'), 'false'); assert.ok(todayButton(root)); assert.equal(todayButton(root).disabled, false);
});
test('模拟 DOM：未加入只读并提示；仅软件时区选择缺失也不可打卡', async t => {
  const f = await fixture({ joined: false }), { root } = mount(f, t);
  assert.match(root.textContent, /先在设置里连接并完成第一次同步/); assert.equal(todayButton(root).disabled, true);
  const state = updateUnit(plannerToState(planner(), 'computer'), unitKey('setting', 'TimeZone'), 'computer', 'Fictional unknown zone');
  const g = await fixture({ state }), mounted = mount(g, t); assert.match(mounted.root.textContent, /软件时区/); assert.equal(todayButton(mounted.root), null);
});
test('模拟 DOM：冲突格标记、展示 true/false 两个候选；用户点击 false 后保留取消并消除冲突', async t => {
  const base = plannerToState(planner(), 'seed', NOW), key = unitKey('habit-check', 'h', TODAY);
  const state = merge(updateUnit(base, key, 'a', true), updateUnit(base, key, 'b', false));
  const f = await fixture({ state }), { root, view } = mount(f, t);
  assert.match(todayButton(root).className, /has-conflict/); assert.match(todayButton(root).getAttribute('aria-label'), /两边都改过/);
  const card = root.querySelector('.conflict-card'); assert.match(card.textContent, /已打卡/); assert.match(card.textContent, /未打卡（已取消）/);
  todayButton(root).emit('click'); assert.equal(f.source.snapshot().conflicts.length, 1); assert.equal(card.scrolledIntoView.block, 'nearest');
  const chooseFalse = buttons(card).find(b => b.textContent === '保留这一份：未打卡（已取消）'); chooseFalse.emit('click'); await view.flush();
  assert.equal(f.source.snapshot().conflicts.length, 0); assert.deepEqual(row(f.source).checks, []); assert.ok(row(f.source).checkEdits[TODAY]); assert.doesNotMatch(todayButton(root).className, /has-conflict/);
});
test('模拟 DOM：双击保存期间不重放 toggle；flush 等待本机事务，存盘失败提示不伪造打卡', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  const change = f.source.change.bind(f.source); let release;
  f.source.change = async (...args) => { await new Promise(resolve => { release = resolve; }); return change(...args); };
  const button = todayButton(root); button.emit('click'); button.emit('click'); let flushed = false;
  const pending = view.flush().then(() => { flushed = true; }); await Promise.resolve(); assert.equal(flushed, false); release(); await pending;
  assert.deepEqual(row(f.source).checks, [TODAY]);
  f.source.change = change; f.store.failNextWrite(); todayButton(root).emit('click'); await view.flush();
  assert.deepEqual(row(f.source).checks, [TODAY]); assert.match(view.snackText.textContent, /保存失败/);
});
test('模拟 DOM：软件跨午夜刷新最近七天；destroy 退订', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  f.clock.advance(86400000); f.source.publish(); assert.match(root.textContent, /今天 2026-11-14/);
  assert.match(root.querySelector('.habit-days').querySelectorAll('button')[0].getAttribute('aria-label'), /2026-11-08/);
  view.destroy(); const before = root.textContent; f.clock.advance(86400000); f.source.publish(); assert.equal(root.textContent, before);
});
