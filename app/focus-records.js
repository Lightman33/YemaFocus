import { canonical, unitKey } from '../sync/canonical.js';
import { hashText } from '../sync/snapshot.js';
import { computeStats, normalizeTask, parseRecord, Period, rootProject, trim, wallTime } from './review-model.js';

export const MINUTE = 60000;

export async function recordKey(day, columns, occurrence) {
  const hash = await hashText(canonical(columns) + '#' + occurrence);
  return unitKey('record', day + ':' + hash.slice(0, 16));
}

export function taskFocus(planner, task, subject) {
  if (!task) return { subject: normalizeTask(subject) || '专注', link: '' };
  const project = (planner.projects || []).find(p => p.id === task.project);
  const root = rootProject(planner, task.project);
  const category = project && root ? normalizeTask(root.id === project.id ? root.name : root.name + '/' + project.name) : '';
  return { subject: category || '无项目任务', link: trim((task.series ?? task.id) + '|' + (task.title || '').replace(/[\r\n]/g, ' ')) };
}

export function recordMinutes(milliseconds) {
  // Framework 4 的 0.## 在中点向上舍入。整数毫秒先转百分之一分钟，避免浮点中点偏移。
  return String(Math.floor((milliseconds + 300) / 600) / 100);
}

export function focusRecord(session) {
  const { kind, startedAt, ending, zone } = session;
  const start = wallTime(startedAt, zone), end = wallTime(ending.at, zone);
  return { day: start.slice(0, 10), columns: [
    kind === 'work' ? '番茄' : '休息', start, end, recordMinutes(ending.elapsed),
    normalizeTask(session.subject), ending.status, ending.note, trim(session.link)
  ] };
}

export function todayFocus(snapshot) {
  const period = Period.of('day', snapshot.today);
  const records = snapshot.records;
  const stats = computeStats({}, period, records, snapshot.today, snapshot.timeZone);
  const recent = records.map(parseRecord).filter(r => r && r.start.slice(0, 10) === snapshot.today)
    .sort((a, b) => b.start.localeCompare(a.start)).slice(0, 5);
  return { count: stats.pomos, minutes: stats.pomoMin, recent };
}
