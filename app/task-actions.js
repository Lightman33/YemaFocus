// 业务操作只通过 datasource.change；不读写同步状态。
import { copy, parseQuick, repeating, REPEAT_READONLY, SERIES_READONLY, validDay, weekStart, lastDay, addDays, parseTime, normalizeTitle } from './task-model.js';
import { DataError, wallTime } from './datasource.js';

export function newId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function makeTask(title, { id = newId(), date = null, weekOf = null, time = '', priority = 0, project = null, now, timeZone }) {
  const task = { id, project, title: normalizeTitle(title), notes: '', date, weekOf: date ? null : weekOf ? weekStart(weekOf) : null, time: date ? time : '',
    remindTime: '', remindOffset: 0, remindedAt: '', priority, done: false, doneAt: null,
    created: wallTime(now, timeZone), series: null, order: 1, updated: new Date(now).toISOString(), steps: [] };
  // PlannerUI.cs ApplyQuickTime（254–262）、PlannerForm.cs QuickAdd（635）：
  // 有具体日期、时间且严格晚于软件当前时刻，才 SetReminder(0, 0, null)。
  if (date && time && date + ' ' + time + ':00' > wallTime(now, timeZone)) { task.remindBefore = 0; syncReminder(task); }
  return task;
}
function clearReminder(task) { delete task.remindBefore; task.remindTime = ''; task.remindOffset = 0; }
function syncReminder(task) {
  // PlannerModel.cs SyncReminder（320–325）/ SetReminder（299–317）：
  // 只有提前分钟提醒跟时间走；旧式全天提醒继续保留。按墙上时间算，不引入手机时区或夏令时。
  const before = typeof task.remindBefore === 'number' ? Math.trunc(task.remindBefore) : -1;
  if (before < 0) return;
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(task.time || '');
  if (!clock) { clearReminder(task); return; }
  task.remindBefore = before;
  if (!task.date) { task.remindTime = ''; task.remindOffset = 0; return; }
  const minutes = +clock[1] * 60 + +clock[2] - before;
  task.remindOffset = Math.max(0, -Math.floor(minutes / 1440));
  const at = ((minutes % 1440) + 1440) % 1440;
  task.remindTime = String(Math.floor(at / 60)).padStart(2, '0') + ':' + String(at % 60).padStart(2, '0');
}
export function requireTask(planner, id) {
  const task = (planner.tasks || []).find(t => t.id === id);
  if (!task) throw new DataError('任务已经不在列表里，请重新查看。');
  if (repeating(task)) throw new DataError(REPEAT_READONLY);
  return task;
}
export function abandonTask(task, planner, reason, now, timeZone) {
  if (task.done) throw new DataError('先恢复为未完成任务，再选择放弃。');
  // 对应 PlannerModel.cs Abandon / AddAbandonHistory：1150–1181。
  // abandonPrevious 是完整 PlannerData.ToJson 根对象，不是裸任务；去掉递归快照。
  const previous = copy(task); delete previous.abandonPrevious;
  const utc = new Date(now).toISOString();
  task.done = true; task.doneAt = wallTime(now, timeZone); task.abandoned = true;
  task.abandonedAt = utc; task.abandonReason = String(reason || '').trim();
  task.abandonPrevious = { version: 1, projects: [], tasks: [previous], habits: [], weekNotes: [], deleted: {} };
  if (Object.hasOwn(task, 'pinned')) task.pinned = false;
  task.abandonHistory = [...(Array.isArray(task.abandonHistory) ? task.abandonHistory : []), { action: 'abandoned', at: utc, reason: task.abandonReason }];
}
export function restoreTask(task, now) {
  if (!task.done || !task.abandoned) return;
  // PlannerModel.cs RestoreAbandoned / Uncomplete 会回退系列；手机第一版仅拦这条路径。
  if (task.series) throw new DataError(SERIES_READONLY);
  // 对应 PlannerModel.cs RestoreAbandoned / Uncomplete：1184–1245。
  const previous = task.abandonPrevious?.tasks?.[0], reason = task.abandonReason || '';
  task.done = false; task.doneAt = null; task.abandoned = false;
  if (previous?.pinned || Object.hasOwn(task, 'pinned')) task.pinned = Boolean(previous?.pinned);
  delete task.abandonedAt; delete task.abandonPrevious;
  task.abandonHistory = [...(Array.isArray(task.abandonHistory) ? task.abandonHistory : []), { action: 'restored', at: new Date(now).toISOString(), reason }];
}
export function scheduleTask(task, { date = null, weekOf = null }, today, currentTime = '', detailDate = false) {
  if (date && (!validDay(date) || (date < today && date !== task.date))) throw new DataError('不能安排到已经过去或无效的日期。');
  if (date === today && date !== task.date && currentTime && parseTime(task.time || '') && parseTime(task.time) <= currentTime) throw new DataError('今天 ' + task.time + ' 已经过去了，请先改时间。');
  if (date === (task.date || null) && weekOf === (task.weekOf || null) && !task.monthOf) return;
  // 对应 PlannerData.SetDate / SetWeek，保留原跨天跨度，不提供修改跨度的入口。
  const oldLast = lastDay(task), span = task.date && oldLast ? Math.round((new Date(oldLast) - new Date(task.date)) / 86400000) : 0;
  if (!task.done && oldLast && oldLast < today && (!date || date > oldLast)) task.postponed = (task.postponed || 0) + 1;
  task.date = date; task.weekOf = date ? null : weekOf ? weekStart(weekOf) : null;
  if (Object.hasOwn(task, 'endDate') || span) {
    if (date && span > 0) task.endDate = addDays(date, span); else delete task.endDate;
  }
  delete task.monthOf;
  // PlannerForm.cs DatePopup.Apply（755–761）：无具体日期时清掉提醒，始终复位已提醒标记。
  // T29 裁决把这项清理也用于手机的日期快捷项（电脑版旧右键 SetWeek 本身未清理）。
  if (!date) {
    clearReminder(task);
    // 详情日期框对应 DatePopup；无日期时弹窗的 Time / EndTime 也为空。
    // 快捷项则沿用 PlannerData.SetWeek 保留时间的行为。
    if (detailDate) { task.time = ''; if (Object.hasOwn(task, 'endTime')) task.endTime = ''; }
  } else syncReminder(task);
  task.remindedAt = '';
}
export class TaskActions {
  constructor(source, { now = () => Date.now(), id = newId } = {}) { this.source = source; this.now = now; this.id = id; }
  description(label, id) { return label + '：' + ((this.source.snapshot().planner.tasks || []).find(t => t.id === id)?.title || '任务'); }
  add(input) {
    const snapshot = this.source.snapshot(), parsed = typeof input === 'string' ? parseQuick(input, snapshot.today) : input;
    if (!parsed.title.trim()) return Promise.reject(new DataError('请写下任务标题。'));
    if (parsed.date && parsed.date < snapshot.today) return Promise.reject(new DataError('不能把任务添加到已经过去的日期。'));
    const now = this.now(), id = this.id();
    return this.source.change('已添加：' + normalizeTitle(parsed.title), planner => {
      planner.tasks ||= [];
      const task = makeTask(parsed.title, { ...parsed, id, priority: parsed.priority ?? 0, now, timeZone: snapshot.timeZone });
      // PlannerModel.cs Add / MaxOrder（1101–1114）：Trash 不参与活动任务顺序。
      task.order = Math.max(0, ...planner.tasks.filter(t => !t.trashedAt).map(t => t.order || 0)) + 1;
      planner.tasks.push(task);
    });
  }
  toggle(id) {
    const now = this.now(), snapshot = this.source.snapshot();
    const current = snapshot.planner.tasks?.find(t => t.id === id);
    return this.source.change(this.description(current?.done ? current.abandoned ? '已恢复' : '已取消完成' : '已完成', id), planner => {
      const t = requireTask(planner, id);
      if (t.done && t.series) throw new DataError(SERIES_READONLY);
      if (t.done && t.abandoned) { restoreTask(t, now); return; }
      if (t.done) { t.done = false; t.doneAt = null; if (Object.keys(t).some(key => !['id', 'project', 'title', 'notes', 'date', 'weekOf', 'time', 'endTime', 'remindTime', 'remindOffset', 'remindedAt', 'remind', 'remindedOn', 'priority', 'done', 'doneAt', 'created', 'series', 'order', 'updated', 'steps', 'repeat'].includes(key))) t.abandoned = false; }
      else { t.done = true; t.doneAt = wallTime(now, snapshot.timeZone); }
    });
  }
  abandon(id, reason) {
    const now = this.now(), snapshot = this.source.snapshot();
    return this.source.change(this.description('已放弃', id) + '（原因已保留）', p => abandonTask(requireTask(p, id), p, reason, now, snapshot.timeZone));
  }
  restore(id) { const now = this.now(); return this.source.change(this.description('已恢复', id), p => restoreTask(requireTask(p, id), now)); }
  remove(id) { return this.source.change(this.description('已删除', id), p => { requireTask(p, id); p.tasks = p.tasks.filter(t => t.id !== id); }); }
  schedule(id, schedule, options = {}) {
    const { today, timeZone } = this.source.snapshot();
    const currentTime = timeZone ? wallTime(this.now(), timeZone).slice(11, 16) : '';
    const { detailDate = false, ...changeOptions } = options;
    return this.source.change(this.description('已改期', id), p => scheduleTask(requireTask(p, id), schedule, today, currentTime, detailDate), changeOptions);
  }
  patch(id, fields, options = {}) {
    const allowed = ['title', 'notes', 'priority', 'project', 'time'];
    if (Object.keys(fields).some(k => !allowed.includes(k))) return Promise.reject(new DataError('不能修改这项属性。'));
    fields = copy(fields);
    if (Object.hasOwn(fields, 'title')) fields.title = normalizeTitle(fields.title);
    // PlannerUI.cs FlatInput.Value：备注用 LF；保留内容和内部空白。
    if (Object.hasOwn(fields, 'notes')) fields.notes = fields.notes.replace(/\r\n/g, '\n');
    return this.source.change(this.description('已保存任务详情', id), p => {
      const task = requireTask(p, id);
      if (Object.hasOwn(fields, 'title') && !fields.title.trim()) throw new DataError('任务标题不能为空。');
      if (Object.hasOwn(fields, 'project') && fields.project && !(p.projects || []).some(project => project.id === fields.project)) throw new DataError('只能选择已有项目。');
      if (Object.hasOwn(fields, 'time') && fields.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.time)) throw new DataError('时间格式应为 09:30。');
      if (fields.time && !task.date) throw new DataError('请先选择具体日期，再填写时间。');
      const timeChanged = Object.hasOwn(fields, 'time') && fields.time !== task.time;
      Object.assign(task, copy(fields));
      // PlannerModel.cs SyncReminder；PlannerForm.cs DatePopup.Apply：改时间后清空已提醒标记。
      if (timeChanged) { syncReminder(task); task.remindedAt = ''; }
    }, options);
  }
  addSteps(id, text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean), ids = lines.map(() => this.id());
    return this.source.change(this.description('已添加步骤', id), p => {
      const task = requireTask(p, id); task.steps ||= [];
      lines.forEach((text, i) => task.steps.push({ id: ids[i], text, done: false, date: null, remindTime: '', remindedAt: '' }));
    });
  }
  step(id, stepId, action, text, options = {}) {
    return this.source.change(this.description('已保存步骤', id), p => {
      const t = requireTask(p, id), s = (t.steps || []).find(s => s.id === stepId);
      if (!s) throw new DataError('步骤已经不在列表里。');
      if (action === 'remove') t.steps = t.steps.filter(s => s.id !== stepId);
      else if (action === 'toggle') s.done = !s.done;
      // 电脑版步骤单行输入；T29 裁决 4：校验与保存均使用 Trim 后的文字。
      else if (action === 'text') { if (!text.trim()) throw new DataError('步骤内容不能为空。'); s.text = text.trim(); }
      else throw new DataError('未知的步骤操作。');
    }, options);
  }
}
