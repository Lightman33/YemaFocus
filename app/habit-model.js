// 对照 PlannerModel.cs Habit；日期一律取软件日期，不读取手机本地日期。
import { addDays, weekStart, validDay } from './task-model.js';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
export function weekIndex(day) { return (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7; }
export function isChecked(habit, day) { return (habit.checks || []).includes(day); }
// Scheduled 本身不判断开始日期或归档，调用处另判；结束日期包含当天。
export function scheduled(habit, day) {
  if (habit.end && day > habit.end) return false;
  return habit.kind !== 'Weekdays' || Boolean((habit.weekMask ?? 127) & (1 << weekIndex(day)));
}
export function inPlan(habit, day) { return (!habit.start || day >= habit.start) && scheduled(habit, day); }
export function frequencyText(habit) {
  if (habit.kind === 'TimesPerWeek') return '每周 ' + (habit.perWeek ?? 3) + ' 次';
  if (habit.kind === 'Weekdays') {
    const mask = habit.weekMask ?? 127;
    if (mask === 127) return '每天';
    if (mask === 31) return '周一至周五';
    return '每周' + weekdays.filter((_, i) => mask & (1 << i)).join('、');
  }
  return '每天';
}
export function checksInWeek(habit, monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter(day => isChecked(habit, day)).length;
}
export function weekProgress(habit, today) {
  const monday = weekStart(today);
  // 与 HabitViews.DrawTrend 一致：全周实际打卡数；非周次数习惯以 Scheduled 的全周天数作目标。
  const target = habit.kind === 'TimesPerWeek' ? habit.perWeek ?? 3 :
    Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter(day => scheduled(habit, day)).length;
  const done = checksInWeek(habit, monday);
  return { done, target, text: '本周 ' + done + '/' + target };
}
export function recentDays(today) { return Array.from({ length: 7 }, (_, i) => addDays(today, i - 6)); }
export function editableDay(day, today) { return validDay(day) && validDay(today) && day >= addDays(today, -6) && day <= today; }
export function groupHabits(habits, today) {
  const active = (habits || []).filter(h => !h.archived).slice().sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id), 'en'));
  return { due: active.filter(h => inPlan(h, today)), other: active.filter(h => !inPlan(h, today)) };
}
export function habitConflicts(snapshot, id) {
  return snapshot.conflicts.filter(c => c.path[0] === 'entity' ? c.path[1] === 'habits' && c.path[2] === id :
    ['habit-definition', 'habit-check', 'habit-journal'].includes(c.path[0]) && c.path[1] === id);
}
