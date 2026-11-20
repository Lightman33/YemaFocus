// 全部为虚构数据；只允许写入 yema-mobile-v29-demo，不导入正式数据库。
import { createDemoReviewData } from './demo-review-data.js';
import { plannerToState } from '../sync/convert.js';
import { merge } from '../sync/merge.js';
import { updateUnit } from '../sync/edit.js';
import { unitKey, encodeLegacy } from '../sync/canonical.js';
import { makeTask, abandonTask } from './task-actions.js';
import { addDays, weekStart } from './task-model.js';
import { wallTime, DEFAULT_TIME_ZONE } from './datasource.js';
import { recordKey } from './focus-records.js';
export const DEMO_DATABASE = 'yema-mobile-v29-demo';
export function demoState(now) {
  const timeZone = DEFAULT_TIME_ZONE, today = wallTime(now, timeZone).slice(0, 10);
  const planner = { version: 1, projects: ['学习计划', '生活日常', '创作练习'].map((name, i) => ({ id: 'demo-project-' + i, name, order: i, archived: false, created: today + ' 08:00:00', updated: '2026-01-01T00:00:00Z' })), tasks: [], habits: [], weekNotes: [], deleted: {} };
  const titles = ['整理书架', '阅读一章科普书', '准备读书会提纲', '给阳台植物浇水', '散步并观察秋叶', '整理虚构练习资料', '备好明天的早餐', '写一段随笔'];
  for (let i = 0; i < 76; i++) {
    const t = makeTask(titles[i % titles.length] + ' · ' + (i + 1), { id: 'demo-task-' + i, now, timeZone, priority: i % 4, project: i % 4 === 0 ? null : planner.projects[i % 3].id });
    t.order = i + 1;
    if (i < 12) t.date = addDays(today, -2 - (i % 3));
    else if (i < 24) t.date = today;
    else if (i < 32) t.date = addDays(today, 1);
    else if (i < 38) t.weekOf = weekStart(today);
    else if (i < 46) t.date = addDays(today, 12);
    else if (i >= 54 && i < 68) { t.done = true; t.doneAt = today + ' 09:00:00'; }

    if (i % 7 === 0) t.notes = '这是虚构备注。\n可以在示例模式中试着修改，不会影响正式数据。';
    if (i % 5 === 0) t.steps = [{ id: 'demo-step-' + i + '-1', text: '准备材料', done: true, date: null, remindTime: '', remindedAt: '' }, { id: 'demo-step-' + i + '-2', text: '整理为一页摘要', done: false, date: null, remindTime: '', remindedAt: '' }];
    if (i === 15) { t.repeat = { kind: 'Daily', interval: 1, weekMask: 0, anchorDay: 0, anchorMonth: 0, until: null, count: 0, doneCount: 0 }; t.title = '重复任务示例：每日阅读'; }
    if (i === 13) t.title = '这是一条很长的虚构任务标题，用来检查手机上只显示两行，而在详情中仍能看到并修改全部文字';
    if (i >= 68) abandonTask(t, planner, '不再需要：已合并到另一份练习计划', now, timeZone);
    planner.tasks.push(t);
  }
  const reviews = createDemoReviewData(today);
  planner.reviews = reviews.planner.reviews; planner.habits = reviews.planner.habits;
  let state = plannerToState(planner, 'demo-computer', now);
  for (const [key, value] of Object.entries(reviews.settings)) state = updateUnit(state, unitKey('setting', key), 'demo-computer', encodeLegacy(value), { updatedAt: now });
  for (const r of reviews.records) state = updateUnit(state, unitKey('record', r.id), 'demo-computer', encodeLegacy({ day: r.day, columns: r.columns }), { updatedAt: now });
  state = updateUnit(state, unitKey('setting', 'TimeZone'), 'demo-computer', 'China Standard Time', { updatedAt: now });
  const key = unitKey('task-content', 'demo-task-12'), value = { ...planner.tasks[12] };
  for (const field of ['done', 'doneAt', 'steps', 'updated']) delete value[field];
  state = merge(updateUnit(state, key, 'demo-phone', encodeLegacy({ ...value, notes: '手机记下：先做提纲。' }), { updatedAt: now }),
    updateUnit(state, key, 'demo-computer', encodeLegacy({ ...value, notes: '电脑记下：记得检查最后一页。' }), { updatedAt: now }));
  return state;
}
export async function seedDemo(store, now) {
  const day = wallTime(now, DEFAULT_TIME_ZONE).slice(0, 10);
  const todayRecords = await Promise.all([
    ['番茄', day + ' 10:00:00', day + ' 10:25:00', '25', '示例事项／读书笔记', '完成', '', ''],
    ['休息', day + ' 10:25:00', day + ' 10:30:00', '5', '短休息', '完成', '', ''],
    ['番茄', day + ' 11:00:00', day + ' 11:17:30', '17.5', '创作练习', '完成', '', 'demo-task-7|写一段随笔']
  ].map(async columns => ({ key: await recordKey(day, columns, 0), value: { day, columns } })));
  return store.update(record => {
    if (!record.state) { record.state = demoState(now); record.settings.joined = true; }
    else if (!record.settings.demoReviewSeed || !record.settings.demoHabitSeed) {
      // 老示例库升级时只补缺少的复盘、记录和模块设置，保留已做的任务练习。
      const additions = demoState(now);
      for (const [key, value] of Object.entries(additions.units)) {
        const path = JSON.parse(key), kind = path[0];
        const wanted = kind.startsWith('review-') || kind === 'record' || kind.startsWith('habit-') ||
          kind === 'entity' && ['reviews', 'habits'].includes(path[1]) || kind === 'layout' && ['reviews', 'habits'].includes(path[1]) || kind === 'setting';
        if (wanted && !Object.hasOwn(record.state.units, key)) record.state.units[key] = value;
      }
    }
    record.settings.demoReviewSeed = true;
    record.settings.demoHabitSeed = true;
    for (const { key, value } of todayRecords) if (!Object.hasOwn(record.state.units, key)) {
      record.state = updateUnit(record.state, key, 'demo-computer', value, { updatedAt: now });
    }
  });
}
