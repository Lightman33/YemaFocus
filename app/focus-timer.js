import { DataError } from './datasource.js';
import { focusRecord, MINUTE, taskFocus } from './focus-records.js';

const DEFAULTS = { workMinutes: 25, breakMinutes: 5, revision: 0, session: null, offer: false };
export const JOIN_TIP = '先在设置里连接并完成第一次同步';
export const ZONE_TIP = '请先在设置里选择软件时区。';
const validMinutes = (n, max) => Number.isInteger(n) && n > 0 && n <= max;
const preferences = settings => ({ ...DEFAULTS, ...settings.focusTimer });
const eligible = (s, device) => s.joined === true && s.deviceId === device;
// 切到别的 App 或锁屏不足 3 秒（如误触、看一眼通知）不算离开。
export const AWAY_MIN_MS = 3000;

export function durationText(milliseconds) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000)), minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return minutes ? minutes + ' 分' + (rest ? ' ' + rest + ' 秒' : '钟') : rest + ' 秒';
}
export function awaySummary(session) {
  return session?.awayCount ? '中途离开 ' + session.awayCount + ' 次，共 ' + durationText(session.awayMs) : '';
}

export function timerReading(session, now) {
  const duration = session.minutes * MINUTE;
  const deadline = session.startedAt + session.pausedMs + duration;
  const elapsed = session.ending?.elapsed ?? Math.max(0, Math.min(duration, (session.pausedAt ?? now) - session.startedAt - session.pausedMs));
  return { elapsed, remaining: duration - elapsed, deadline };
}

export class FocusTimer {
  constructor({ store, source, now = () => Date.now(), newId = () => crypto.randomUUID() }) {
    Object.assign(this, { store, source, now, newId, state: { ...DEFAULTS }, device: null, notice: '' });
  }

  async refresh() {
    const { record: { settings } } = await this.store.readMetadata();
    this.device = settings.deviceId;
    this.state = preferences(settings);
    if (this.state.session && this.state.session.device !== this.device) {
      // 更换仓库或身份时，旧计时不会被记到新仓库。
      await this.save({ session: null, offer: false }, false);
    }
  }

  async save(patch, requireJoined = true) {
    const before = this.state.revision, device = this.device;
    let applied;
    const record = await this.store.updateMetadata(r => {
      const current = preferences(r.settings);
      applied = r.settings.deviceId === device && current.revision === before;
      if (!applied) return;
      if (requireJoined && !eligible(r.settings, device)) throw new DataError(JOIN_TIP);
      r.settings.focusTimer = { ...current, ...patch, revision: before + 1 };
    });
    this.device = record.settings.deviceId;
    this.state = preferences(record.settings);
    return applied;
  }

  saveMinutes(workMinutes, breakMinutes) {
    if (!validMinutes(workMinutes, 180) || !validMinutes(breakMinutes, 60)) throw new DataError('请填写整分钟。专注 1 至 180 分钟，休息 1 至 60 分钟。');
    return this.save({ workMinutes, breakMinutes }, false);
  }

  start(kind, taskId = '', subject = '', skip = false, longTermItem = '') {
    const snapshot = this.source.snapshot();
    if (!snapshot.joined) throw new DataError(JOIN_TIP);
    if (!snapshot.timeZone) throw new DataError(ZONE_TIP);
    if (this.state.session || (kind === 'break' && !this.state.offer)) return;
    const task = (snapshot.planner.tasks || []).find(t => t.id === taskId && !t.done && !t.trashedAt);
    if (kind === 'work' && taskId && !task) throw new DataError('所选任务已完成或删除，请重新选择。');
    if (kind === 'work' && longTermItem && !snapshot.longTermItems?.includes(longTermItem))
      throw new DataError('所选长期事项已改名或删除，请重新选择。');
    const target = kind === 'work' ? taskFocus(snapshot.planner, task, longTermItem || subject) : { subject: '短休息', link: '' };
    const startedAt = this.now();
    return this.save({ offer: false, session: {
      id: this.newId(), device: this.device, kind, startedAt, zone: snapshot.timeZone, pausedAt: null, pausedMs: 0,
      minutes: kind === 'work' ? this.state.workMinutes : this.state.breakMinutes, ...target,
      ...(skip ? { ending: { at: startedAt, elapsed: 0, status: '跳过', note: '', automatic: false } } : {})
    } });
  }

  // 网页挡不住切换 App；离开时记下时刻，回来后把离开的次数和时长记在这个番茄上。
  async left(now = this.now()) {
    const session = this.state.session;
    if (session?.kind !== 'work' || session.pausedAt !== null || session.ending || session.awaySince != null) return;
    if (session.device !== this.device || now >= timerReading(session, now).deadline) return;
    await this.save({ session: { ...session, awaySince: now } }, false);
  }

  async returned() {
    const session = this.state.session;
    if (!session || session.awaySince == null || session.ending || session.device !== this.device) return null;
    const now = this.now(), away = Math.max(0, Math.min(now, timerReading(session, now).deadline) - session.awaySince);
    const counted = away >= AWAY_MIN_MS;
    const next = { ...session, awaySince: null };
    if (counted) Object.assign(next, { awayCount: (session.awayCount || 0) + 1, awayMs: (session.awayMs || 0) + away });
    if (!(await this.save({ session: next }, false))) return null;
    if (counted) this.notice = '刚才离开了 ' + durationText(away) + '，已记在这个番茄上';
    return counted ? away : null;
  }

  async act(action, { taskId, subject, longTermItem } = {}) {
    const result = await this.advance(true);
    if (result || this.state.session?.ending) return result;
    const session = this.state.session, now = this.now();
    switch (action) {
      case 'start': await this.start('work', taskId, subject, false, longTermItem); break;
      case 'rest': await this.start('break'); break;
      case 'skip':
        if (session?.kind === 'break') await this.end(session, now, '跳过');
        else if (!session && this.state.offer) await this.start('break', '', '', true);
        else return null;
        return this.complete();
      case 'pause':
        if (session?.kind === 'work' && session.pausedAt === null) await this.save({ session: { ...session, pausedAt: now } });
        break;
      case 'resume':
        if (session?.kind === 'work' && session.pausedAt !== null) {
          await this.save({ session: { ...session, pausedAt: null, pausedMs: session.pausedMs + Math.max(0, now - session.pausedAt) } });
        }
        break;
      case 'early':
      case 'abandon':
        if (session?.kind !== 'work') return null;
        await this.end(session, now, action === 'early' ? '完成' : '放弃');
        return this.complete();
    }
    this.notice = '';
    return null;
  }

  async end(session, at, status, automatic = false, recovered = false) {
    const elapsed = timerReading(session, at).elapsed;
    const note = [recovered ? (session.kind === 'work' ? '程序关闭期间到点' : '关机/退出期间完成') : '', awaySummary(session)]
      .filter(Boolean).join('；');
    await this.save({ session: { ...session, zone: this.source.snapshot().timeZone || session.zone,
      ending: { at, elapsed, status, note, automatic } } });
  }

  async advance(recovered = false) {
    const session = this.state.session;
    if (!session || session.device !== this.device) return null;
    if (session.ending) return this.complete();
    if (session.awaySince != null) {
      // 别的标签页刚改过计时会让这次保存落空；用刚读到的最新状态再结算一次。
      if (!(await this.returned()) && this.state.session?.awaySince != null) await this.returned();
      if (this.state.session?.awaySince != null) return null;
      return this.advance(recovered);
    }
    const now = this.now(), { deadline } = timerReading(session, now);
    if (session.pausedAt !== null || now < deadline) return null;
    await this.end(session, deadline, '完成', true, recovered);
    return this.complete();
  }

  async complete() {
    const session = this.state.session;
    if (!session?.ending) return null;
    const { automatic, status } = session.ending;
    const saved = await this.source.saveFocusRecord(session, focusRecord(session));
    if (!saved || !(await this.save({ session: null, offer: session.kind === 'work' && status === '完成' }))) return null;
    const away = awaySummary(session);
    this.notice = ({ 完成: session.kind === 'work' ? '专注完成' : '休息完成', 放弃: '已记为放弃', 跳过: '已跳过休息' })[status] +
      (away ? '（' + away + '）' : '');
    return { automatic, message: this.notice };
  }
}
