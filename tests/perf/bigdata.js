// T27/T18 共用：固定种子、纯虚构数据。makeBigData(seed=0x27) 返回
// { planner, state, taskId, reviewId }；每次返回独立对象，state 含记录和只读设置。
import { plannerToState, CSV_HEADER } from '../../sync/convert.js';
import { unitKey } from '../../sync/canonical.js';
export function makeBigData(seed = 0x27) {
  let n = seed >>> 0;
  const random = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n; };
  const day = i => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  const updated = '2026-01-01T00:00:00.000Z';
  const planner = { version: 1, deleted: {}, projects: [], tasks: [], reviews: [], weekNotes: [], habits: [], countdowns: [] };
  for (let i = 0; i < 6; i++) planner.projects.push({ id: 'project-' + i, name: '虚构项目' + i, updated });
  for (let i = 0; i < 3000; i++) planner.tasks.push({ id: 'task-' + String(i).padStart(4, '0'), title: '虚构事项' + random(), notes: '虚构测试备注', project: 'project-' + i % 6, done: i >= 300, doneAt: i >= 300 ? '2025-01-01 08:00:00' : null, updated,
    steps: [0, 1].map(j => ({ id: 's' + j, text: '虚构步骤' + j, done: i >= 300 })) });
  const content = Array.from({ length: 5 }, (_, i) => '【模块' + i + '】\n' + '这是完全虚构的性能测试文字'.repeat(8).slice(0, 100) + '\n').join('');
  for (let i = 0; i < 730; i++) planner.reviews.push({ id: 'day:' + day(i), title: '虚构日复盘', content, score: i % 6, updated });
  for (let i = 0; i < 104; i++) planner.reviews.push({ id: 'week:' + day(i * 7), title: '虚构周复盘', content, updated });
  for (let i = 0; i < 5; i++) {
    const checks = Array.from({ length: 730 }, (_, j) => day(j));
    planner.habits.push({ id: 'habit-' + i, name: '虚构习惯' + i, checks, checkEdits: Object.fromEntries(checks.map(d => [d, updated])), journal: Object.fromEntries(checks.filter((_, j) => j % 5 === 0).map(d => [d, { note: '虚构感想' }])), updated });
  }
  const state = plannerToState(planner, 'computer', 1767225600000);
  const add = (key, value) => { state.units[key] = { versions: [{ vv: { computer: 1 }, deleted: false, value, sources: [{ vv: { computer: 1 }, stamp: { updatedAt: 1767225600000 } }] }] }; };
  const ids = [];
  for (let i = 0; i < 4000; i++) {
    const d = day(i % 730), id = d + ':record-' + i; ids.push(id);
    add(unitKey('record', id), { day: d, columns: ['番茄', d + ' 08:00:00', d + ' 08:25:00', '25', '虚构事项', '完成', '', planner.tasks[i % 3000].id + '|虚构事项'] });
  }
  add(unitKey('csv-layout'), { header: CSV_HEADER, ids });
  add(unitKey('setting', 'TimeZone'), 'China Standard Time');
  add(unitKey('setting', 'ReviewModules.day'), '模块0|模块1|模块2|模块3|模块4');
  return { planner, state, taskId: planner.tasks[0].id, reviewId: planner.reviews[0].id };
}
