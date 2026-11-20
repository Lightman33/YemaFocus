import { FocusFullscreen } from './focus-fullscreen.js';
import { todayFocus } from './focus-records.js';
import { JOIN_TIP, timerReading, ZONE_TIP } from './focus-timer.js';
import { lastDay } from './task-model.js';

const actions = ['start', 'pause', 'resume', 'early', 'abandon', 'rest', 'skip', 'retry'];
const stopLabels = { early: ['提前结束', '确认结束'], abandon: ['放弃', '再点一次确认放弃'] };
const CONFIRM_MS = 3000;

function sessionSubject(session) {
  return session?.link ? session.link.slice(session.link.indexOf('|') + 1) : session?.subject || '';
}
const runningWork = session => session?.kind === 'work' && session.pausedAt === null && !session.ending;

function clockText(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  const pad = n => String(n).padStart(2, '0');
  return pad(Math.floor(seconds / 60)) + ':' + pad(seconds % 60);
}

export class FocusView {
  constructor({ document, source, timer, onNotice, playBell, armBell }) {
    Object.assign(this, { document, source, timer, onNotice, playBell, armBell });
    this.$ = name => document.getElementById('focus-' + name);
    this.taskList = '';
    this.fullscreen = new FocusFullscreen(document, this.$);
    this.$('fullscreen-open').addEventListener('click', () => {
      const session = this.timer.state.session;
      if (!runningWork(session) || this.pending) return;
      const { remaining } = timerReading(session, this.timer.now());
      if (remaining > 0) {
        this.clearConfirmation();
        this.fullscreen.open(clockText(remaining), sessionSubject(session));
      }
    });
    this.error = '';
    this.unsub = source.subscribe(snapshot => { this.render(); this.renderRecords(snapshot); });
    for (const action of actions) this.$(action).addEventListener('click', () => {
      if (this.fullscreen.active || this.pending || this.$(action).hidden || this.$(action).disabled) return;
      if (stopLabels[action] && !this.confirmStop(action)) return;
      this.clearConfirmation();
      if (['start', 'resume', 'rest'].includes(action)) armBell();
      const selection = this.$('task').value;
      this.run(() => action === 'retry' ? timer.advance(true) : timer.act(action, {
        taskId: selection.startsWith('task:') ? selection.slice(5) : '',
        longTermItem: selection.startsWith('item:') ? selection.slice(5) : '',
        subject: this.$('item').value
      }), false, action);
    });
    this.$('task').addEventListener('change', () => this.render());
    this.$('preferences').addEventListener('submit', event => {
      event.preventDefault();
      this.run(async () => {
        const applied = await timer.saveMinutes(Number(this.$('work-minutes').value), Number(this.$('break-minutes').value));
        this.$('preferences-message').textContent = applied ? '时长已保存在本机。' : '时长已在另一页更新，请再确认。';
        this.$('preferences-message').hidden = false;
        this.renderPreferences();
      });
    });
  }

  async entered() {
    this.clearConfirmation();
    if (this.pending) await this.pending;
    await this.run(async () => {
      await this.timer.refresh();
      this.ready = true;
      this.renderPreferences();
      return this.timer.advance(true);
    });
    this.renderRecords(this.source.snapshot());
  }

  stopTicks() { clearTimeout(this.tick); this.tick = null; }
  destroy() { this.closed = true; this.stopTicks(); this.clearConfirmation(); this.fullscreen.destroy(); this.unsub(); }

  clearConfirmation() {
    if (!this.confirmation) return;
    this.$(this.confirmation.action).textContent = stopLabels[this.confirmation.action][0];
    clearTimeout(this.confirmationTimer);
    this.confirmation = null;
  }

  confirmStop(action) {
    const session = this.timer.state.session;
    if (session?.kind !== 'work' || session.ending) return false;
    const now = this.timer.now(), previous = this.confirmation;
    if (previous?.action === action && previous.session === session.id && now < previous.until) return true;
    this.clearConfirmation();
    this.confirmation = { action, session: session.id, until: now + CONFIRM_MS };
    this.$(action).textContent = stopLabels[action][1];
    this.confirmationTimer = setTimeout(() => this.clearConfirmation(), CONFIRM_MS);
    return false;
  }

  async run(operation, sound = false, action = '') {
    if (this.pending || this.closed) return this.pending;
    this.error = '';
    this.pending = Promise.resolve().then(operation).then(result => {
      if (result?.automatic && sound && !this.document.hidden) this.playBell();
    }).catch(error => {
      this.error = error.message || '这次操作没有保存，请重试。';
    });
    this.render();
    await this.pending;
    this.pending = null;
    if (this.closed) return;
    this.render();
    if (action && this.document.activeElement === this.$(action) && this.$(action).hidden) {
      const next = actions.map(x => this.$(x)).find(button => !button.hidden && !button.disabled);
      next?.focus({ preventScroll: true });
    }
    this.schedule();
  }

  schedule() {
    this.stopTicks();
    if (this.closed || this.document.hidden) return;
    const session = this.timer.state.session;
    const visible = () => !this.$('clock').parentNode.hidden;
    const dayChanged = () => {
      const snapshot = this.source.snapshot();
      if (visible() && snapshot.today !== this.today) {
        this.render();
        this.renderRecords(snapshot);
      }
    };
    if (!session || session.ending || session.pausedAt !== null) {
      if (visible()) this.tick = setTimeout(() => { dayChanged(); this.schedule(); }, 60000 - this.timer.now() % 60000);
      return;
    }
    const remaining = timerReading(session, this.timer.now()).remaining;
    this.tick = setTimeout(() => {
      if (this.closed || this.document.hidden) return;
      if (timerReading(session, this.timer.now()).remaining === 0) this.run(() => this.timer.advance(), true);
      else { this.renderClock(); this.schedule(); }
      dayChanged();
    }, remaining % 1000 || 1000);
  }

  renderPreferences() {
    this.$('work-minutes').value = String(this.timer.state.workMinutes);
    this.$('break-minutes').value = String(this.timer.state.breakMinutes);
  }

  renderClock() {
    const { session, workMinutes, breakMinutes, offer } = this.timer.state;
    const value = session ? timerReading(session, this.timer.now()).remaining : (offer ? breakMinutes : workMinutes) * 60000;
    const clock = clockText(value);
    this.$('time').textContent = clock;
    if (this.fullscreen.active) this.fullscreen.update(clock, sessionSubject(session));
  }

  render() {
    this.onNotice(this.timer.notice);
    const { session, offer } = this.timer.state;
    const full = runningWork(session);
    if (this.confirmation && (this.confirmation.session !== session?.id || session?.ending || this.$('clock').parentNode.hidden)) this.clearConfirmation();
    const closeFullscreen = this.fullscreen.active && !full && !(session?.ending && this.pending);
    if (this.$('clock').parentNode.hidden) {
      if (closeFullscreen) this.fullscreen.close();
      else if (this.fullscreen.active) this.renderClock();
      return;
    }
    const snapshot = this.source.snapshot();
    const paused = session?.pausedAt != null, ending = Boolean(session?.ending), work = session?.kind === 'work';
    const gate = !this.ready ? '正在打开本机存储…' : !snapshot.joined ? JOIN_TIP : !snapshot.timeZone ? ZONE_TIP : '';
    const occupied = Boolean(session) || offer;
    this.$('clock').setAttribute('aria-busy', String(!this.ready));
    this.$('phase').textContent = ending ? '正在保存记录' : session ? (work ? (paused ? '专注已暂停' : '专注中') : '休息中') : offer ? '可以休息了' : '番茄钟';
    this.renderClock();
    this.$('subject').textContent = sessionSubject(session);
    this.$('subject').hidden = !session;
    this.$('gate').textContent = gate;
    this.$('gate').hidden = !gate;
    this.$('error').textContent = this.error;
    this.$('error').hidden = !this.error;
    const message = this.$('message');
    if (message.textContent !== this.timer.notice) message.textContent = this.timer.notice;
    if (message.hidden === Boolean(this.timer.notice)) message.hidden = !this.timer.notice;
    this.$('fields').hidden = occupied;
    this.$('task').disabled = this.$('item').disabled = Boolean(gate || this.pending);
    this.$('save-minutes').disabled = !this.ready || Boolean(this.pending);
    if (!occupied) this.renderTasks(snapshot);

    const visible = { start: !occupied, pause: work && !paused && !ending, resume: work && paused && !ending,
      early: work && !ending, abandon: work && !ending, rest: !session && offer, skip: !ending && (!session && offer || session?.kind === 'break'),
      retry: ending && !this.pending };
    for (const action of actions) {
      this.$(action).hidden = !visible[action];
      this.$(action).disabled = Boolean(this.pending || gate && (action === 'start' || action === 'rest' || action === 'skip' && !session));
    }
    this.$('fullscreen-open').hidden = !full;
    this.$('fullscreen-open').disabled = Boolean(this.pending);
    if (closeFullscreen) {
      this.fullscreen.close();
      actions.map(action => this.$(action)).find(button => !button.hidden && !button.disabled)?.focus({ preventScroll: true });
    }
  }

  renderTasks(snapshot) {
    const today = [], others = [];
    for (const task of snapshot.planner.tasks || []) {
      if (task.done || task.trashedAt) continue;
      const scheduledToday = snapshot.today && task.date && task.date <= snapshot.today && lastDay(task) >= snapshot.today;
      (scheduledToday ? today : others).push([task.id, task.title]);
    }
    for (const group of [today, others]) group.sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
    const items = snapshot.longTermItems ?? null;
    const key = JSON.stringify([today, others, items]), select = this.$('task');
    if (this.taskList !== key) {
      const selected = select.value;
      const choices = new Set(['']);
      const option = (value, text, disabled = false) => {
        const node = this.document.createElement('option');
        node.value = value;
        node.textContent = text;
        node.disabled = disabled;
        if (!disabled) choices.add(value);
        return node;
      };
      const group = (label, options) => {
        const node = this.document.createElement('optgroup');
        node.setAttribute('label', label);
        node.append(...options);
        return node;
      };
      const groups = new Map();
      for (const item of items || []) {
        const slash = item.indexOf('/');
        const category = slash < 0 ? '' : item.slice(0, slash);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(option('item:' + item, item.slice(slash + 1)));
      }
      const children = [option('', '不选（自己写事项）')];
      const taskOptions = tasks => tasks.map(([id, title]) => option('task:' + id, title));
      if (today.length) children.push(group('今天的任务', taskOptions(today)));
      if (others.length) children.push(group(today.length ? '其他未完成任务' : '未完成任务', taskOptions(others)));
      for (const [category, options] of groups) {
        if (category) children.push(group('长期事项 · ' + category, options));
      }
      if (groups.has('')) children.push(group('长期事项 · 无大类', groups.get('')));
      if (!groups.size) children.push(group('长期事项', [
        option('', items === null ? '电脑升级到 v3.0 后显示' : '暂无长期事项', true)
      ]));
      select.replaceChildren(...children);
      select.value = choices.has(selected) ? selected : '';
      this.taskList = key;
    }
    this.$('custom').hidden = Boolean(select.value);
  }

  renderRecords(snapshot) {
    if (this.$('clock').parentNode.hidden) return;
    const status = this.$('today-status'), list = this.$('recent');
    let message = '';
    this.today = snapshot.today;
    if (!snapshot.joined) message = JOIN_TIP;
    else if (!snapshot.today) message = ZONE_TIP;
    else if (snapshot.loading?.records) message = '记录正在载入…';
    this.$('metrics').hidden = Boolean(message);
    if (message) list.replaceChildren();
    else {
      const { count, minutes, recent } = todayFocus(snapshot);
      this.$('count').textContent = count;
      this.$('minutes').textContent = String(Math.round(minutes));
      list.replaceChildren(...recent.map(r => {
        const row = this.document.createElement('li'), time = this.document.createElement('time');
        const label = this.document.createElement('span'), detail = this.document.createElement('small');
        time.textContent = r.start.slice(11, 16);
        time.setAttribute('datetime', r.start.replace(' ', 'T'));
        label.textContent = (r.link.includes('|') && r.link.slice(r.link.indexOf('|') + 1)) || r.task || r.kind;
        detail.textContent = r.kind + ' · ' + r.status + ' · ' + r.minutes + ' 分钟';
        row.append(time, label, detail); return row;
      }));
      if (!recent.length) message = '今天还没有记录。';
    }
    status.textContent = message;
    status.hidden = !message;
    this.renderConflicts(snapshot);
  }

  renderConflicts(snapshot) {
    const conflicts = snapshot.conflicts.filter(c => c.path[0] === 'record');
    this.$('conflicts').hidden = conflicts.length === 0;
    this.$('conflict-items').replaceChildren(...conflicts.map(conflict => {
      const card = this.document.createElement('div');
      card.className = 'conflict-card';
      const hasDeletion = conflict.candidates.some(candidate => candidate.deleted);
      const liveCount = conflict.candidates.filter(candidate => !candidate.deleted).length;
      let versionNumber = 0;
      conflict.candidates.forEach(candidate => {
        const version = this.document.createElement('div'), text = this.document.createElement('p');
        const columns = candidate.value?.columns;
        version.className = 'conflict-version';
        text.className = 'conflict-value';
        text.textContent = candidate.deleted ? '删除的版本' : (Array.isArray(columns) ? columns.join(' · ') : '无法识别的记录');
        version.append(text);
        card.append(version);
        if (candidate.deleted) return;
        ++versionNumber;
        const button = this.document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = liveCount === 1 ? '保留这条记录' : '保留版本 ' + versionNumber;
        button.disabled = !snapshot.joined || !snapshot.timeZone;
        button.addEventListener('click', () => this.run(async () => {
          await this.source.resolve(conflict.key, { branch: candidate.branch, observed: snapshot.editToken });
          const target = this.$('conflicts').hidden ? this.$('today-title') : this.$('conflict-title');
          target.focus({ preventScroll: true });
        }));
        version.append(button);
      });
      if (hasDeletion) {
        const hint = this.document.createElement('p');
        hint.textContent = '要删除请在电脑上撤销这条记录。';
        card.append(hint);
      }
      return card;
    }));
  }
}

export function focusBell(window) {
  let context;
  return {
    armBell() {
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (Audio) { context ||= new Audio(); context.resume().catch(() => {}); }
      } catch { /* 声音不可用时，仍显示完成提示。 */ }
    },
    playBell() {
      if (context?.state !== 'running') return;
      const at = context.currentTime, note = context.createOscillator(), gain = context.createGain();
      note.frequency.value = 660;
      gain.gain.setValueAtTime(0.18, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.45);
      note.connect(gain); gain.connect(context.destination);
      note.start(at); note.stop(at + 0.45);
    }
  };
}
