import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserDouble, globalsFor, start, until } from '../shell/browser-double.js';
import { freshRecord } from '../../app/store.js';
import { GoalActions } from '../../app/goals-actions.js';
import { encodeLegacy, unitKey } from '../../sync/canonical.js';
import { updateUnit } from '../../sync/edit.js';
import { merge } from '../../sync/merge.js';

const tabs = ['tasks', 'habits', 'focus', 'goals', 'review', 'settings'];
const byLabel = (root, label) => root.querySelectorAll('button').find(btn => btn.getAttribute('aria-label') === label);
const click = button => { assert.ok(button); assert.equal(button.disabled, false); button.focus(); button.emit('click'); };
const GOALS_ROOT = 'goals-root';

for (const [hash, prefix] of [['#goals', ''], ['#sim/goals', 'sim/']]) {
  test(hash + ' 直达、未同步可看九宫格，详情只读', async t => {
    const b = browserDouble(freshRecord(), { hash });
    globalsFor(t, b.globals);
    const app = await start();
    t.after(() => app.disposeApp());
    await until(() => !b.node('clear-data').disabled);
    assert.equal(b.node('page-goals').hidden, false);
    assert.deepEqual(b.tabs.map(tab => tab.dataset.page), tabs);
    assert.equal(b.tabs[3].getAttribute('href'), '#' + prefix + 'goals');
    assert.equal(b.tabs[3].getAttribute('aria-current'), 'page');
    const root = b.node(GOALS_ROOT);
    assert.match(root.textContent, /第一次同步/);
    assert.equal(root.querySelector('.goal-grid').children.length, 9);
    assert.equal(root.querySelector('.goal-grid').children[4].className, 'goal-center goal-plan-center goal-annual-center');
    click(byLabel(root, '5 年'));
    assert.match(root.querySelector('.goal-center').textContent, /\d{4}–\d{4}/);
    assert.equal(byLabel(root, '编辑愿景'), undefined);
    assert.equal(byLabel(root, '调整起始年'), undefined);
    click(root.querySelector('.goal-cell'));
    assert.equal(byLabel(root, '添加目标').disabled, true);
    assert.equal(byLabel(root, '修改领域名称').disabled, true);
    assert.equal(b.requests.length, 0);
  });
}

test('T46-5/6/13 年度标题可展开收起和编辑，详情显示年份，保留任务联动和输入', async t => {
  const b = browserDouble(freshRecord(), { hash: '#demo/goals' });
  globalsFor(t, b.globals);
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-20T04:00:00Z');
  t.after(() => { Date.now = realNow; });
  const app = await start();
  t.after(() => app.disposeApp());
  await until(() => !b.node('clear-data').disabled);
  assert.equal(b.node('page-goals').hidden, false);
  assert.equal(b.tabs[3].getAttribute('href'), '#demo/goals');
  const root = b.node(GOALS_ROOT);
  const boardYear = () => root.querySelector('.goal-year-controls').querySelector('h2').textContent;
  assert.equal(boardYear(), '2026');
  assert.match(root.querySelector('.goal-center').textContent, /\d+ \/ \d+已完成/);
  assert.doesNotMatch(root.querySelector('.goal-center').textContent, /2026/);
  assert.match(root.querySelector('.goal-cell').textContent, /还有 1 条/);
  assert.equal(root.querySelector('.goal-cell').querySelectorAll('.goal-preview').length, 4);
  click(byLabel(root, '下一年'));
  await app.flushViews();
  assert.equal(boardYear(), '2027');
  assert.equal(byLabel(root, '下一年').disabled, true);
  click(byLabel(root, '上一年'));
  click(root.querySelector('.goal-cell'));
  assert.equal(root.querySelector('.goal-detail-heading').querySelector('h2').textContent, '2026 年 · 学习·成长');
  click(byLabel(root, '修改领域名称'));
  const name = root.querySelector('#goal-domain-name');
  name.value = '天文·探索';
  root.querySelector('form').emit('submit');
  await app.flushViews();
  assert.match(root.querySelector('.goal-detail-heading').textContent, /天文·探索/);

  click(byLabel(root, '展开关联任务和番茄：画一本星空速写册'));
  assert.match(root.textContent, /1 个番茄 · 17.5 分钟/);
  const link = root.querySelector('.goal-tasks').querySelectorAll('button').find(btn => btn.textContent.startsWith('整理书架'));
  click(link);
  await until(() => b.node('task-sheet').open && !!b.globals.document.getElementById('task-detail-goalId'));
  const picker = b.globals.document.getElementById('task-detail-goalId');
  assert.equal(picker.querySelector('option').textContent, '不关联');
  assert.ok(picker.querySelectorAll('optgroup').some(group => group.label === '2026 · 天文·探索'));
  assert.ok(picker.querySelectorAll('optgroup').some(group => group.label.startsWith('2025')));
  const nextGoal = app.dataSource.snapshot().planner.goals.find(goal => goal.year === 2026 && goal.domain === 1);
  picker.focus();
  picker.value = nextGoal.id;
  picker.emit('change');
  await app.flushViews();
  assert.equal(app.dataSource.snapshot().planner.tasks.find(task => task.id === 'demo-task-0').goalId, nextGoal.id);
  b.node('task-sheet-close').emit('click');
  await until(() => !b.node('task-sheet').open);
  await app.changePage('goals');

  click(byLabel(root, '添加目标'));
  const title = root.querySelector('#goal-title');
  title.value = '新做一个虚构模型';
  title.selectionStart = title.selectionEnd = 3;
  title.emit('compositionstart');
  root.querySelector('form').emit('submit');
  await app.flushViews();
  assert.equal(root.querySelector('dialog').open, true);
  const existing = app.dataSource.snapshot().planner.goals.find(g => g.title === '画一本星空速写册');
  await new GoalActions(app.dataSource).toggle(existing.id, true, '2026-11-20');
  assert.equal(root.querySelector('#goal-title'), title);
  assert.equal(title.value, '新做一个虚构模型');
  assert.equal(b.globals.document.activeElement, title);
  assert.equal(title.selectionStart, 3);
  title.emit('compositionend');
  root.querySelector('form').emit('submit');
  await app.flushViews();
  assert.equal(root.querySelector('dialog').open, false);

  click(byLabel(root, '完成：新做一个虚构模型'));
  await app.flushViews();
  assert.equal(byLabel(root, '取消完成：新做一个虚构模型').getAttribute('aria-checked'), 'true');
  assert.match(root.textContent, /2026-11-20 完成/);
  click(byLabel(root, '取消完成：新做一个虚构模型'));
  await app.flushViews();
  click(byLabel(root, '展开目标：新做一个虚构模型'));
  assert.equal(byLabel(root, '收起目标：新做一个虚构模型').getAttribute('aria-expanded'), 'true');
  assert.equal(root.querySelector('dialog').open, false);
  click(byLabel(root, '收起目标：新做一个虚构模型'));
  assert.equal(byLabel(root, '编辑目标：新做一个虚构模型'), undefined);
  click(byLabel(root, '展开目标：新做一个虚构模型'));
  click(byLabel(root, '编辑目标：新做一个虚构模型'));
  root.querySelector('#goal-notes').value = '更新后的虚构备注';
  root.querySelector('form').emit('submit');
  await app.flushViews();
  assert.match(root.textContent, /更新后的虚构备注/);
  click(byLabel(root, '删除目标：新做一个虚构模型'));
  assert.match(root.querySelector('dialog').textContent, /确认删除/);
  click(byLabel(root.querySelector('dialog'), '取消'));
  assert.ok(byLabel(root, '编辑目标：新做一个虚构模型'));
  click(byLabel(root, '删除目标：新做一个虚构模型'));
  root.querySelector('form').emit('submit');
  await app.flushViews();
  assert.equal(byLabel(root, '编辑目标：新做一个虚构模型'), undefined);
  assert.equal(b.requests.length, 0);
});

test('T46-15 明暗领域色相与电脑顺序一致，文字和边线达到 AA，弹窗按钮留出间距', async () => {
  const load = name => readFile(new URL('../../' + name, import.meta.url), 'utf8');
  const [css, ui, offline, desktop] = await Promise.all([
    load('app/goals.css'), load('app/ui.css'), load('sw.js'),
    readFile(new URL('../../../source/GoalViews.cs', import.meta.url), 'utf8')
  ]);
  const colors = Array.from(css.matchAll(/--goal-color: (#\w{6}); --goal-tint: (#\w{6})/g), row => row.slice(1));
  const themes = Array.from(ui.matchAll(/--ink: (#\w{6});[^\n]*\n[^\n]*--border: (#\w{6})/g), row => row.slice(1));
  assert.equal(colors.length, 16);
  assert.equal(themes.length, 2);
  const luminance = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => { const [min, max] = [luminance(a), luminance(b)].sort((a, b) => a - b); return (max + .05) / (min + .05); };
  const desktopColors = desktop.match(/Color\[\] Colors\s*=\s*\{([^}]+)\}/)[1].match(/#[0-9a-f]{6}/gi);
  const hue = hex => {
    const [r, g, b] = hex.slice(1).match(/../g).map(value => parseInt(value, 16));
    const min = Math.min(r, g, b), max = Math.max(r, g, b), delta = max - min;
    const position = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
    return (60 * position + 360) % 360;
  };
  const backgrounds = Array.from(ui.matchAll(/--bg: (#\w{6})/g), row => row[1]);
  const danger = Array.from(ui.matchAll(/--danger: (#\w{6})/g), row => row[1]);
  assert.equal(desktopColors.length, 8);
  for (const [i, [text, bg]] of colors.entries()) {
    const theme = Math.floor(i / 8), [ink, border] = themes[theme];
    const difference = Math.abs(hue(text) - hue(desktopColors[i % 8]));
    assert.ok(Math.min(difference, 360 - difference) < 20);
    assert.ok(ratio(text, bg) >= 4.5);
    assert.ok(ratio(text, backgrounds[theme]) >= 4.5);
    assert.ok(ratio(ink, bg) >= 4.5);
    assert.ok(ratio(border, bg) >= 3);
    assert.ok(ratio(danger[theme], bg) >= 4.5);
  }
  assert.match(css, /\.goal-dialog \.actions\s*\{[^}]*margin-top:\s*16px/);
  const surfaces = Array.from(ui.matchAll(/--surface: (#\w{6}); --hover: (#\w{6})/g), row => row.slice(1));
  assert.equal(surfaces.length, 2);
  for (const [i, [surface, hover]] of surfaces.entries()) {
    const [ink, border] = themes[i];
    for (const background of [surface, hover]) {
      assert.ok(ratio(ink, background) >= 4.5);
      assert.ok(ratio(border, background) >= 3);
    }
  }
  for (const name of ['goal-sync.js', 'goal-periods.js', 'goals-model.js', 'goals-actions.js', 'goals-view.js', 'goals.css']) assert.ok(offline.includes('./app/' + name));
});

test('T46-5/6/7/13/16 长期九宫格详情、愿景朗读、冲突标记、紧凑导航及拆解', async t => {
  const b = browserDouble(freshRecord(), { hash: '#demo/goals' });
  globalsFor(t, b.globals);
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-20T04:00:00Z');
  t.after(() => { Date.now = realNow; });
  const app = await start();
  t.after(() => app.disposeApp());
  await until(() => !b.node('clear-data').disabled);
  const root = b.node(GOALS_ROOT);
  const press = label => click(byLabel(root, label));
  const submit = async () => { root.querySelector('form').emit('submit'); await app.flushViews(); };
  const center = () => root.querySelector('.goal-center').textContent;

  assert.deepEqual(root.querySelector('.goal-span-controls').children.map(btn => btn.textContent), ['年度', '3 年', '5 年', '10 年']);
  press('5 年');
  assert.equal(byLabel(root, '5 年').getAttribute('aria-pressed'), 'true');
  assert.match(center(), /2026–2030.*可以分享/);
  assert.match(root.querySelector('.goal-plan-center').getAttribute('aria-label'), /2026–2030.*把对夜空的好奇变成可以分享的作品.*编辑愿景/);
  assert.equal(root.querySelector('.goal-grid').children.length, 9);
  assert.equal(byLabel(root, '调整起始年'), undefined);

  press('下一时段');
  assert.match(center(), /2031–2035/);
  assert.equal(byLabel(root, '下一时段').disabled, true);
  const periodMenu = root.querySelector('.goal-plan-control');
  assert.equal(periodMenu.parentNode, root.querySelector('.goal-year-controls'));
  assert.ok(periodMenu.querySelectorAll('option').some(option => option.value === 'adjust'));
  periodMenu.value = 'adjust';
  periodMenu.emit('change');
  assert.equal(root.querySelector('#goal-start').value, '2031');
  press('取消');
  press('上一时段');
  click(root.querySelector('.goal-cell'));
  assert.equal(root.querySelector('.goal-detail-heading').querySelector('h2').textContent, '2026–2030 · 学习·成长');
  press('展开目标：做成一套可分享的星空图鉴');
  assert.match(root.textContent, /已完成 1 \/ 共 2 个下级目标/);
  assert.match(root.textContent, /累计 1 个番茄 · 17\.5 分钟/);
  press('收起目标：做成一套可分享的星空图鉴');
  assert.equal(byLabel(root, '编辑目标：做成一套可分享的星空图鉴'), undefined);
  press('展开目标：做成一套可分享的星空图鉴');
  press('删除目标：做成一套可分享的星空图鉴');
  assert.match(root.querySelector('dialog').textContent, /2 个下级目标将失去与这条目标的关联/);
  press('取消');
  press('打开下级目标：练熟三种画星图的方法，未完成');
  assert.equal(byLabel(root, '3 年').getAttribute('aria-pressed'), 'true');
  press('打开下级目标：画一本星空速写册，未完成');
  assert.equal(byLabel(root, '年度').getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelector('.goal-detail-heading').querySelector('h2').textContent, '2026 年 · 学习·成长');
  press('删除目标：画一本星空速写册');
  assert.match(root.querySelector('dialog').textContent, /2 个关联任务将失去与这条目标的关联/);
  press('取消');
  press('服务于：练熟三种画星图的方法');
  press('编辑目标：练熟三种画星图的方法');
  const picker = root.querySelector('#goal-parent');
  assert.deepEqual(picker.querySelectorAll('optgroup').map(group => group.label), ['5 年']);
  assert.ok(picker.querySelectorAll('option').some(option => option.textContent.includes('做成一套可分享的星空图鉴')));
  press('取消');

  press('5 年');
  const store = app.dataSource.store;
  const base = (await store.read()).state;
  const key = unitKey('goal', 'demo-plan-star-2026');
  const sameGoal = app.dataSource.snapshot().planner.goals.find(row => row.id === 'demo-plan-star-2026');
  const branch = (device, title) => updateUnit(base, key, device, encodeLegacy({ ...sameGoal, title }), { updatedAt: Date.now() });
  await store.update(row => { row.state = merge(branch('demo-branch-a', '甲改虚构图鉴'), branch('demo-branch-b', '乙改虚构图鉴')); });
  await app.dataSource.refresh();
  assert.match(root.textContent, /此时段有 1 条目标两边都改过/);
  assert.equal(root.querySelectorAll('.has-conflict').length, 1);
  assert.equal(root.querySelector('.goal-cell').querySelector('.goal-conflict-marker').textContent, '!');
  assert.match(root.querySelector('.goal-cell').getAttribute('aria-label'), /有冲突需要处理/);
  click(root.querySelector('.goal-cell'));
  assert.match(root.textContent, /甲改虚构图鉴/);
  assert.match(root.textContent, /乙改虚构图鉴/);
  press('保留版本 1');
  await app.flushViews();
  assert.equal(root.querySelector('.conflict-card'), null);

  press('10 年');
  press('调整起始年');
  root.querySelector('#goal-start').value = '2022';
  await submit();
  assert.match(center(), /2022–2031/);
  click(root.querySelector('.goal-plan-center'));
  const input = root.querySelector('#goal-vision');
  input.value = '虚构愿景，十年后完成一册游记。';
  input.selectionStart = input.selectionEnd = 4;
  await new GoalActions(app.dataSource).toggle('demo-plan-practice-2026', true, '2026-11-20');
  assert.equal(root.querySelector('#goal-vision'), input);
  assert.equal(input.value, '虚构愿景，十年后完成一册游记。');
  assert.equal(input.selectionStart, 4);
  assert.equal(b.globals.document.activeElement, input);
  await submit();
  assert.match(center(), /十年后完成一册游记/);
  assert.equal(byLabel(root, '调整起始年'), undefined);
  click(root.querySelector('.goal-plan-center'));
  root.querySelector('#goal-vision').value = '';
  await submit();
  assert.equal(byLabel(root, '调整起始年'), undefined);
  press('上一时段');
  const savedPeriods = root.querySelector('.goal-plan-control');
  assert.ok(savedPeriods.querySelectorAll('option').some(option => option.value === '2022'));
  savedPeriods.value = '2022';
  savedPeriods.emit('change');
  assert.match(center(), /2022–2031/);
  click(root.querySelector('.goal-cell'));
  press('添加目标');
  assert.equal(root.querySelector('#goal-parent'), null);
  root.querySelector('#goal-title').value = '虚构十年目标';
  await submit();
  press('展开目标：虚构十年目标');
  assert.match(root.querySelector('.goal-children').textContent, /更短跨度的目标里选「服务于」/);
  press('编辑目标：虚构十年目标');
  assert.equal(root.querySelector('#goal-parent'), null);
  press('取消');
  assert.equal(b.requests.length, 0);
});

test('T46-13 目标九宫格导航紧凑，预览使用常规字重', async () => {
  const css = await readFile(new URL('../../app/goals.css', import.meta.url), 'utf8');
  assert.match(css, /\.goal-preview\s*\{[^}]*font-weight:\s*400/);
  assert.match(css, /\.goal-span-controls button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.goal-cell, \.goal-center\s*\{[^}]*min-height:\s*108px/);
});

test('T46-14 勾选与取消均可撤销五秒，撤销恢复原完成日期', async t => {
  const b = browserDouble(freshRecord(), { hash: '#demo/goals' });
  globalsFor(t, b.globals);
  const realNow = Date.now;
  let now = Date.parse('2026-11-20T04:00:00Z');
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const app = await start();
  t.after(() => app.disposeApp());
  await until(() => !b.node('clear-data').disabled);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = b.node(GOALS_ROOT), title = '画一本星空速写册';
  const state = () => app.dataSource.snapshot().planner.goals.find(goal => goal.title === title);
  const undo = () => byLabel(root, '撤销这次目标勾选变更');
  const setDone = async done => { click(byLabel(root, (done ? '完成：' : '取消完成：') + title)); await app.flushViews(); };
  click(root.querySelector('.goal-cell'));
  await setDone(true);
  assert.equal(byLabel(root, '取消完成：' + title).textContent, '✓');
  assert.match(undo().parentNode.textContent, /已勾选目标/);
  click(undo());
  await app.flushViews();
  assert.equal(state().done, false);
  assert.equal(state().doneOn, null);

  const oldDay = '2026-10-03';
  await new GoalActions(app.dataSource).toggle(state().id, true, oldDay);
  await setDone(false);
  assert.match(undo().parentNode.textContent, /已取消勾选/);
  t.mock.timers.tick(4999);
  now += 4999;
  assert.equal(undo().parentNode.hidden, false);
  click(undo());
  await app.flushViews();
  assert.equal(state().done, true);
  assert.equal(state().doneOn, oldDay);

  await setDone(false);
  t.mock.timers.tick(5000);
  now += 5000;
  assert.equal(undo().parentNode.hidden, true);
  undo().emit('click');
  await app.flushViews();
  assert.equal(state().done, false);
});
