import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, habit, planner, mount, row, TODAY, NOW } from './helpers.js';
import { plannerToState } from '../../sync/convert.js';
import { updateUnit } from '../../sync/edit.js';
import { merge } from '../../sync/merge.js';
import { unitKey } from '../../sync/canonical.js';
const buttons = root => root.querySelectorAll('button');
const todayButton = root => root.querySelector('.habit-today');
const weekDates = root => root.querySelectorAll('.habit-week-day').map(day => day.getAttribute('datetime'));
const weekButton = (root, key) => root.querySelector('[data-habit-focus="week:' + key + '"]');
const checkFor = (root, day) => root.querySelectorAll('.habit-check').find(node => node.getAttribute('aria-label').includes(day));

test('模拟 DOM：只在表头显示周一到周日；点今天圆点打卡、取消、撤销', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  assert.match(root.textContent, /虚构阅读/); assert.match(root.textContent, /本周 0\/7/);
  assert.equal(root.querySelectorAll('.habit-week-days').length, 1);
  assert.equal(weekDates(root)[0], '2026-11-09'); assert.equal(weekDates(root)[6], '2026-11-15');
  assert.equal(root.querySelector('[aria-current="date"]').getAttribute('datetime'), TODAY);
  assert.equal(root.querySelectorAll('.habit-check').length, 7);
  assert.equal(root.querySelectorAll('.habit-today').length, 1);
  assert.match(todayButton(root).getAttribute('aria-label'), /虚构阅读，2026-11-13，今天，未打卡，点击打卡/);
  assert.doesNotMatch(root.querySelector('[data-habit-id="h"]').textContent, /周五|11\/13/);
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
  const past = checkFor(root, '2026-11-10');
  assert.match(past.className, /is-unscheduled/); assert.match(past.getAttribute('aria-label'), /不在计划内/); assert.equal(past.disabled, false);
  past.emit('click'); await view.flush(); assert.deepEqual(row(f.source).checks, ['2026-11-10']); assert.equal(root.querySelector('details').open, true);
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
  assert.match(todayButton(root).getAttribute('aria-label'), /只读/);
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
test('模拟 DOM：历史周继续向前，返回本周后封顶；打卡只读时说明原因，旧的已打卡照常显示', async t => {
  const state = plannerToState(planner([habit({ end: '2026-11-12', start: '2026-11-05', checks: ['2026-11-05', '2026-11-12'] })]), 'computer', NOW);
  const f = await fixture({ state }), { root } = mount(f, t);
  const details = root.querySelector('details'); details.open = true; details.emit('toggle');
  for (const [day, reason] of [[TODAY, /已经结束/], ['2026-11-14', /未来日期/]]) {
    const node = checkFor(root, day); assert.equal(node.disabled, true); assert.match(node.getAttribute('aria-label'), reason);
  }
  assert.equal(checkFor(root, '2026-11-12').disabled, false);
  assert.equal(weekButton(root, 'next').disabled, true);
  weekButton(root, 'next').emit('click'); assert.equal(weekDates(root)[0], '2026-11-09');
  weekButton(root, 'prev').emit('click'); assert.equal(weekDates(root)[0], '2026-11-02');
  assert.match(root.textContent, /当周 1\/7/);
  const oldCheck = checkFor(root, '2026-11-05');
  assert.equal(oldCheck.disabled, false); assert.equal(oldCheck.getAttribute('aria-pressed'), 'true'); // v3.0：照电脑可补打
  assert.match(checkFor(root, '2026-11-04').getAttribute('aria-label'), /尚未开始/);
  weekButton(root, 'prev').emit('click'); assert.equal(weekDates(root)[0], '2026-10-26');
  assert.ok(root.querySelectorAll('.habit-check').every(node => node.disabled));
  weekButton(root, 'next').emit('click'); assert.equal(weekDates(root)[0], '2026-11-02');
  weekButton(root, 'back').emit('click'); assert.equal(weekDates(root)[0], '2026-11-09');
  assert.equal(weekButton(root, 'back').hidden, true); assert.equal(weekButton(root, 'next').disabled, true);
});
test('模拟 DOM：软件跨午夜移动今天高亮，跨周自动到新本周；destroy 退订', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  f.clock.advance(86400000); f.source.publish();
  assert.equal(weekDates(root)[0], '2026-11-09');
  assert.equal(root.querySelector('[aria-current="date"]').getAttribute('datetime'), '2026-11-14');
  assert.match(todayButton(root).getAttribute('aria-label'), /2026-11-14/);
  f.clock.advance(2 * 86400000); f.source.publish(); assert.equal(weekDates(root)[0], '2026-11-16');
  view.destroy(); const before = root.textContent; f.clock.advance(86400000); f.source.publish(); assert.equal(root.textContent, before);
});

test('T46-3 共用周表头沿用七列，吸顶且有不透明背景', async t => {
  const f = await fixture(), { root, view } = mount(f, t);
  assert.equal(view.content.children[0], root.querySelector('.habit-week-days'));
  assert.match(view.content.children[0].className, /\bhabit-days\b/);
  assert.equal(view.content.children[0].children.length, 7);
  const css = await readFile(new URL('../../app/habits.css', import.meta.url), 'utf8');
  assert.match(css, /\.habit-week-days\s*\{[^}]*position:\s*sticky;\s*top:\s*0;[^}]*background:\s*var\(--bg\)/);
  assert.match(css, /\.habit-days\s*\{[^}]*repeat\(7, minmax\(44px, 1fr\)\)/);
});

test('T46-8 打卡具备三种形状，习惯频率和已结束可见', async t => {
  const fields = { kind: 'Weekdays', weekMask: 1, start: '2026-11-10', end: '2026-11-12' };
  const state = plannerToState(planner([habit(fields)]), 'computer', NOW);
  const f = await fixture({ state }), { root } = mount(f, t);
  assert.equal(root.querySelector('.habit-frequency').textContent, '每周一 · 已结束');
  const active = checkFor(root, '2026-11-10');
  assert.equal(active.disabled, false);
  assert.match(active.className, /is-unscheduled/);
  assert.doesNotMatch(active.className, /is-outside-dates/);
  for (const day of ['2026-11-09', TODAY, '2026-11-14']) {
    const outside = checkFor(root, day);
    assert.equal(outside.disabled, true);
    assert.match(outside.className, /is-outside-dates/);
  }
  const css = await readFile(new URL('../../app/habits.css', import.meta.url), 'utf8');
  assert.match(css, /\.habit-check\.is-unscheduled \.habit-check-symbol\s*\{[^}]*border-style:\s*dashed/);
  assert.match(css, /\.habit-check\.is-outside-dates[^{}]*\.habit-check-symbol\s*\{[^}]*width:\s*8px;[^}]*border:\s*0;[^}]*background:/);
});

test('T46-10 习惯页只在未加入、缺时区或载入时显示状态', async t => {
  const f = await fixture(), { view } = mount(f, t);
  assert.equal(view.status.hidden, true);
  assert.equal(view.status.textContent, '');
  const loading = mount(await fixture({ tasksFirst: true }), t).view;
  assert.equal(loading.status.hidden, false);
  assert.match(loading.status.textContent, /正在载入/);
  const readOnly = mount(await fixture({ joined: false }), t).view;
  assert.equal(readOnly.status.hidden, false);
  assert.match(readOnly.status.textContent, /第一次同步/);
  const state = updateUnit(plannerToState(planner(), 'computer'), unitKey('setting', 'TimeZone'), 'computer', 'Fictional unknown zone');
  const noZone = mount(await fixture({ state }), t).view;
  assert.equal(noZone.status.hidden, false);
  assert.match(noZone.status.textContent, /软件时区/);
});
