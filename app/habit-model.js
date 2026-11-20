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
  return weekDays(monday).filter(day => isChecked(habit, day)).length;
}
// PlannerModel.cs:908–912 周一为起点。日期已经按软件时区取整，后续只做日期运算。
export function weekDays(day) {
  const monday = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
export function weekProgress(habit, day, today = day) {
  const monday = weekStart(day);
  // HabitViews.cs:342–346 统计全周实际打卡数，目标取周次数或全周 Scheduled 天数。
  const target = habit.kind === 'TimesPerWeek' ? habit.perWeek ?? 3 :
    weekDays(monday).filter(date => scheduled(habit, date)).length;
  const done = checksInWeek(habit, monday);
  return { done, target, text: (monday === weekStart(today) ? '本周 ' : '当周 ') + done + '/' + target };
}
export function checkDayIssue(habit, day, today) {
  if (!validDay(day) || !validDay(today)) return '打卡日期无效';
  // HabitViews.cs:105–115 周卡允许非排程日，排除未来和开始前；PlannerForm.cs:589–595 再检查未来。
  if (day > today) return '未来日期，暂不能打卡';
  if (habit.start && day < habit.start) return '习惯尚未开始';
  // PlannerModel.cs:512 结束日含当天。按 T40 要求，结束后只读。
  if (habit.end && day > habit.end) return '习惯已经结束';
  // HabitViews.cs:329 的电脑月历可补更早的日期，没有天数上限。v3.0 起手机照电脑：开始日至今天都可补打（Claude 11-20 定）。
  return '';
}
// HabitJournal.cs:212–215,278；PlannerModel.cs:582。结束日期不限制写感想。
export function canJournal(habit, day, today) {
  return validDay(day) && validDay(today) && day <= today && (!habit.start || day >= habit.start);
}
export function journalPhotoCount(entry) { return Array.isArray(entry?.photos) ? entry.photos.length : 0; }
export function hasJournalEntry(entry) { return Boolean((typeof entry?.note === 'string' && entry.note.trim()) || journalPhotoCount(entry)); }
export function activeHabits(habits) {
  return (habits || []).filter(h => !h.archived).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id), 'en'));
}
export function groupHabits(habits, today) {
  const active = activeHabits(habits);
  return { due: active.filter(h => inPlan(h, today)), other: active.filter(h => !inPlan(h, today)) };
}
export function habitConflicts(snapshot, id) {
  return snapshot.conflicts.filter(c => c.path[0] === 'entity' ? c.path[1] === 'habits' && c.path[2] === id :
    ['habit-definition', 'habit-check', 'habit-journal'].includes(c.path[0]) && c.path[1] === id);
}
