// 与任务页共用本机事务及同步入口；取消/撤销都写明确布尔值，绝不删除打卡单元。
import { DataError } from './datasource.js';
import { canJournal, checkDayIssue, isChecked, habitConflicts } from './habit-model.js';

export function requireHabit(planner, id) {
  const habit = (planner.habits || []).find(h => h.id === id);
  if (!habit || habit.archived) throw new DataError('习惯已经归档或不在列表里，请重新查看。');
  return habit;
}
function writeCheck(habit, day, checked, utc) {
  habit.checks = (habit.checks || []).filter(d => d !== day);
  if (checked) habit.checks.push(day);
  habit.checks.sort();
  habit.checkEdits ||= {}; habit.checkEdits[day] = utc;
  habit.updated = utc;
}
export class HabitActions {
  constructor(source, { now = () => Date.now() } = {}) { this.source = source; this.now = now; }
  async toggle(id, day) {
    const snapshot = this.ready(), habit = requireHabit(snapshot.planner, id);
    return this.setCheck(id, day, !isChecked(habit, day));
  }
  ready() {
    const snapshot = this.source.snapshot();
    if (!snapshot.joined) throw new DataError('先在设置里连接并完成第一次同步');
    if (!snapshot.timeZone) throw new DataError('请先在设置里选择软件时区。');
    if (snapshot.loading?.habits) throw new DataError('习惯正在载入，请稍候再打卡。');
    return snapshot;
  }
  async setCheck(id, day, checked, { baseToken = null, undoable = true, previousChecked } = {}) {
    const snapshot = this.ready(), habit = requireHabit(snapshot.planner, id);
    const issue = checkDayIssue(habit, day, snapshot.today);
    if (issue) throw new DataError(issue + '。');
    if (typeof checked !== 'boolean') throw new DataError('打卡值必须是已打卡或未打卡。');
    if (habitConflicts(snapshot, id).some(c => c.path[0] === 'entity' || c.path[0] === 'habit-check' && c.path[2] === day)) {
      throw new DataError('这一天两边都改过，请先选择保留哪一份。');
    }
    const previous = typeof previousChecked === 'boolean' ? previousChecked : isChecked(habit, day), utc = new Date(this.now()).toISOString();
    const description = (checked ? day === snapshot.today ? '已打卡' : '已补打卡' : '已取消打卡') + '：' + habit.name + ' · ' + day;
    const receipt = await this.source.change(description, p => writeCheck(requireHabit(p, id), day, checked, utc),
      { undoable: false, baseToken: baseToken || snapshot.editToken });
    if (!receipt) return null;
    // 仅反向修改这一格。使用原编辑凭据，后来到达的远端分支由同步层保留。
    return { ...receipt, undo: undoable ? async () => {
      const current = requireHabit(this.source.snapshot().planner, id);
      if (isChecked(current, day) !== checked || current.checkEdits?.[day] !== utc) throw new DataError('这一天已有新改动，请重新查看，未覆盖新记录。');
      const undone = await this.setCheck(id, day, previous, { baseToken: receipt.editToken, undoable: false });
      return undone;
    } : null };
  }
  async saveJournal(id, day, note, { baseToken = null } = {}) {
    const snapshot = this.ready(), habit = requireHabit(snapshot.planner, id);
    if (!canJournal(habit, day, snapshot.today)) throw new DataError('请选择从习惯开始当天到今天之间的日期。');
    if (habitConflicts(snapshot, id).some(c => c.path[0] === 'entity')) throw new DataError('请先确认保留习惯还是删除，再写感想。');
    const utc = new Date(this.now()).toISOString();
    return this.source.change('已保存习惯感想：' + habit.name + ' · ' + day, p => {
      const h = requireHabit(p, id); h.journal ||= {};
      const old = h.journal[day];
      if (old !== undefined && (!old || typeof old !== 'object' || Array.isArray(old))) throw new DataError('这一天的感想格式暂不支持编辑，请在电脑上查看。');
      // 只改 note；照片文件名引用和全部未知字段都留在原对象中，空文字也不删除对象。
      h.journal[day] = { ...(old || { photos: [] }), note: String(note).trim().replace(/\r\n/g, '\n') };
      h.updated = utc;
    }, { baseToken: baseToken || snapshot.editToken, undoable: false });
  }
}
