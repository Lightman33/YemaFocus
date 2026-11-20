import { todayFocus } from './focus-records.js';
import { JOIN_TIP, timerReading, ZONE_TIP } from './focus-timer.js';

const actions = ['start', 'pause', 'resume', 'early', 'abandon', 'rest', 'skip', 'retry'];

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
    this.error = '';
    this.unsub = source.subscribe(snapshot => { this.render(); this.renderRecords(snapshot); });
    for (const action of actions) this.$(action).addEventListener('click', () => {
      if (['start', 'resume', 'rest'].includes(action)) armBell();
      this.run(() => action === 'retry' ? timer.advance(true) : timer.act(action, {
        taskId: this.$('task').value, subject: this.$('item').value
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
  destroy() { this.closed = true; this.stopTicks(); this.unsub(); }

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
      if (visible() && this.source.snapshot().today !== this.today) this.renderRecords(this.source.snapshot());
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
    this.$('time').textContent = clockText(value);
  }

  render() {
    this.onNotice(this.timer.notice);
    if (this.$('clock').parentNode.hidden) return;
    const snapshot = this.source.snapshot(), { session, offer } = this.timer.state;
    const paused = session?.pausedAt != null, ending = Boolean(session?.ending), work = session?.kind === 'work';
    const gate = !this.ready ? '正在打开本机存储…' : !snapshot.joined ? JOIN_TIP : !snapshot.timeZone ? ZONE_TIP : '';
    const occupied = Boolean(session) || offer;
    this.$('clock').setAttribute('aria-busy', String(!this.ready));
    this.$('phase').textContent = ending ? '正在保存记录' : session ? (work ? (paused ? '专注已暂停' : '专注中') : '休息中') : offer ? '可以休息了' : '番茄钟';
    this.renderClock();
    this.$('subject').textContent = session?.link ? session.link.slice(session.link.indexOf('|') + 1) : session?.subject || '';
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
  }

  renderTasks(snapshot) {
    const tasks = (snapshot.planner.tasks || []).filter(t => !t.done && !t.trashedAt)
      .map(t => [t.id, t.title]).sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
    const key = JSON.stringify(tasks), select = this.$('task');
    if (this.taskList !== key) {
      const selected = select.value;
      select.replaceChildren(...[['', '不关联任务'], ...tasks].map(([id, title]) => {
        const option = this.document.createElement('option'); option.value = id; option.textContent = title; return option;
      }));
      select.value = tasks.some(([id]) => id === selected) ? selected : '';
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
