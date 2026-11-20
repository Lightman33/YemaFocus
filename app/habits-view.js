import { HabitActions } from './habit-actions.js';
import { DataError } from './datasource.js';
import { StoreError } from './store.js';
import { HabitJournal } from './habit-journal.js';
import { activeHabits, canJournal, checkDayIssue, frequencyText, groupHabits, hasJournalEntry, habitConflicts, inPlan, isChecked, journalPhotoCount, weekDays, weekProgress } from './habit-model.js';
import { addDays, weekStart } from './task-model.js';

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const shortDate = day => day.slice(5).split('-').map(Number).join('/');

export class HabitsView {
  constructor({ document, root, source, now = () => Date.now(), onSaved = () => {} }) {
    this.document = document; this.root = root; this.source = source; this.now = now; this.onSaved = onSaved;
    this.actions = new HabitActions(source, { now }); this.otherOpen = false; this.openJournals = new Set();
    this.selectedMonday = null;
    this.content = this.el('div'); this.status = this.el('p', '', 'caption'); this.status.setAttribute('role', 'status');
    this.weekBar = this.weekNavigation(); this.weekBar.hidden = true;
    this.snackbar = this.el('div', '', 'task-snackbar'); this.snackbar.hidden = true; this.snackbar.setAttribute('role', 'status'); this.snackbar.setAttribute('aria-live', 'polite');
    this.snackText = this.el('span'); this.undoButton = this.button('撤销', '撤销这次习惯打卡修改', () => {
      const undo = this.undo, until = this.undoUntil;
      this.run(async () => { if (undo && this.now() <= until) { await undo(); this.hideSnack(); this.onSaved(); } });
    });
    this.snackbar.append(this.snackText, this.undoButton); root.replaceChildren(this.status, this.weekBar, this.content, this.snackbar);
    this.journal = new HabitJournal({ document, root, actions: this.actions, source, onSaved,
      returnFocus: (id, key) => this.focus(key) || this.focus('write:' + id) });
    this.unsubscribe = source.subscribe(() => this.render()); this.render();
    this.dayTimer = setInterval(() => { if (source.snapshot().today !== this.snapshot.today) this.render(); }, 60000); this.dayTimer.unref?.();
  }
  el(tag, text = '', className = '') {
    const node = this.document.createElement(tag); if (text !== '') node.textContent = String(text); if (className) node.className = className; return node;
  }
  button(text, label, action, className = 'secondary') {
    const button = this.el('button', text, className); button.type = 'button'; button.setAttribute('aria-label', label);
    button.addEventListener('click', action); return button;
  }
  focus(key) {
    const node = Array.from(this.root.querySelectorAll('[data-habit-focus]')).find(n => n.getAttribute('data-habit-focus') === key);
    if (!node || node.disabled || node.hidden) return false;
    node.focus({ preventScroll: true });
    return true;
  }
  async run(action) {
    if (this.busy || this.destroyed) return false;
    this.busy = true;
    this.running = (async () => {
      try { await action(); return true; }
      catch (error) { this.snack(error instanceof DataError || error instanceof StoreError ? error.message : '操作没有完成，旧数据仍保留。请稍后重试。'); return false; }
      finally { this.busy = false; }
    })();
    return this.running;
  }
  perform(operation) {
    return this.run(async () => { const receipt = await operation(); if (receipt) { this.snack(receipt.description, receipt.undo); this.onSaved(); } });
  }
  async flush() { await this.running; await this.journal.flush(); }
  async leave() { await this.flush(); if (this.journal.dialog.open) await this.journal.close(); }
  snack(text, undo = null) {
    if (this.destroyed) return;
    clearTimeout(this.snackTimer); this.undo = undo; this.undoUntil = this.now() + 5000;
    this.snackText.textContent = text; this.undoButton.hidden = !undo; this.snackbar.hidden = false;
    this.snackTimer = setTimeout(() => this.hideSnack(), 5000); this.snackTimer.unref?.();
  }
  hideSnack() { this.snackbar.hidden = true; this.undo = null; clearTimeout(this.snackTimer); }
  render() {
    if (this.destroyed) return;
    const snapshot = this.source.snapshot(); this.snapshot = snapshot;
    this.journal.refresh(snapshot);
    const focused = this.document.activeElement, focusKey = this.root.contains(focused) ? focused?.getAttribute('data-habit-focus') : null;
    this.content.replaceChildren();
    const loading = Boolean(snapshot.loading?.habits);
    this.root.setAttribute('aria-busy', String(loading));
    this.unlocked = snapshot.joined && Boolean(snapshot.timeZone) && !loading;
    this.status.textContent = !snapshot.joined ? '先在设置里连接并完成第一次同步' : !snapshot.timeZone ? '请先在设置里选择软件时区。' :
      loading ? '习惯正在载入…' : '';
    this.status.hidden = !this.status.textContent;
    if (loading) { this.weekBar.hidden = true; return; }
    if (!snapshot.today) { this.weekBar.hidden = true; return; }
    this.currentMonday = weekStart(snapshot.today);
    if (this.selectedMonday && this.selectedMonday >= this.currentMonday) this.selectedMonday = null;
    this.days = weekDays(this.selectedMonday || this.currentMonday);
    const { due, other } = this.selectedMonday ? { due: activeHabits(snapshot.planner.habits), other: [] } : groupHabits(snapshot.planner.habits, snapshot.today);
    this.weekBar.hidden = !snapshot.joined && !due.length && !other.length;
    if (this.weekBar.hidden) return;
    const first = this.days[0], last = this.days[6], range = shortDate(first) + '–' + shortDate(last);
    if (this.weekRange.textContent !== range) this.weekRange.textContent = range;
    this.weekRange.title = first + ' 至 ' + last;
    this.nextWeek.disabled = this.backWeek.hidden = !this.selectedMonday;
    if (due.length || other.length) this.content.append(this.weekHeader());
    if (!due.length && !other.length) this.content.append(this.el('p', '没有未归档的习惯。', 'caption'));
    for (const habit of due) this.content.append(this.row(habit));
    if (other.length) {
      const details = this.el('details', '', 'habit-other'); details.open = this.otherOpen;
      const summary = this.el('summary', '今天不用打卡 · ' + other.length); details.append(summary);
      details.addEventListener('toggle', () => { this.otherOpen = details.open; });
      for (const habit of other) details.append(this.row(habit)); this.content.append(details);
    }
    // 即使首选定义已归档，仍保留冲突入口，不能让另一份打卡候选消失。
    const visible = new Set([...due, ...other].map(h => h.id));
    const remaining = snapshot.conflicts.filter(c => c.path[0] === 'entity' ? c.path[1] === 'habits' && !visible.has(c.path[2]) :
      c.path[0].startsWith('habit-') && !visible.has(c.path[1]));
    for (const conflict of remaining) this.content.append(this.conflictCard(conflict, '已归档或已删除的习惯'));
    this.content.append(this.el('p', '新建和修改习惯请在电脑上进行', 'caption habit-footer'));
    if (focusKey && !this.focus(focusKey) && focusKey.startsWith('week:')) this.focus('week:prev');
  }
  moveWeek(offset) {
    const target = offset ? addDays(this.days[0], offset * 7) : this.currentMonday;
    this.selectedMonday = target < this.currentMonday ? target : null;
    this.render();
  }
  weekNavigation() {
    const week = this.el('div', '', 'habit-week-nav'); week.setAttribute('role', 'group'); week.setAttribute('aria-label', '查看习惯的周次');
    this.weekRange = this.el('span', '', 'habit-week-range'); this.weekRange.setAttribute('aria-live', 'polite');
    const prev = this.button('‹ 上一周', '上一周', () => this.moveWeek(-1), 'habit-link');
    this.nextWeek = this.button('下一周 ›', '下一周', () => this.moveWeek(1), 'habit-link');
    this.backWeek = this.button('回到本周', '回到本周', () => this.moveWeek(0), 'habit-link habit-week-back');
    prev.setAttribute('data-habit-focus', 'week:prev'); this.nextWeek.setAttribute('data-habit-focus', 'week:next');
    this.backWeek.setAttribute('data-habit-focus', 'week:back');
    week.append(prev, this.weekRange, this.nextWeek, this.backWeek);
    return week;
  }
  weekHeader() {
    const header = this.el('div', '', 'habit-days habit-week-days');
    this.days.forEach((day, index) => {
      const cell = this.el('time', '', 'habit-week-day' + (day === this.snapshot.today ? ' is-today' : ''));
      cell.append(this.el('span', weekdays[index]), this.el('span', shortDate(day)));
      cell.setAttribute('datetime', day);
      if (day === this.snapshot.today) cell.setAttribute('aria-current', 'date');
      header.append(cell);
    });
    return header;
  }
  row(habit) {
    const today = this.snapshot.today, progress = weekProgress(habit, this.days[0], today), name = habit.name || '未命名习惯';
    const conflicts = habitConflicts(this.snapshot, habit.id), parentConflict = conflicts.some(c => c.path[0] === 'entity');
    const article = this.el('article', '', 'habit-item'); article.setAttribute('data-habit-id', habit.id);
    const line = this.el('div', '', 'habit-row');
    const color = Number.isInteger(habit.color) ? ((habit.color % 10) + 10) % 10 : 0;
    const dot = this.el('span', '', 'habit-dot habit-color-' + color); dot.setAttribute('aria-hidden', 'true'); line.append(dot);
    const heading = this.el('div', '', 'habit-heading');
    const frequency = frequencyText(habit) + (habit.end && today > habit.end ? ' · 已结束' : '');
    heading.append(this.el('h3', name, 'habit-name'), this.el('p', frequency, 'caption habit-frequency'));
    const writeLabel = hasJournalEntry(habit.journal?.[today]) ? '已记' : '记一笔';
    const write = this.button(writeLabel, name + '，' + (writeLabel === '已记' ? '今天已记，编辑感想' : '记一笔'),
      () => this.journal.open(habit, this.snapshot), 'habit-link habit-journal-write');
    write.setAttribute('data-habit-focus', 'write:' + habit.id);
    write.disabled = !this.unlocked || parentConflict || !canJournal(habit, today, today);
    line.append(heading, this.el('span', progress.text, 'caption habit-progress'), write);
    article.append(line);
    const days = this.el('div', '', 'habit-days'); days.setAttribute('role', 'group'); days.setAttribute('aria-label', name + '，一周打卡');
    for (const day of this.days) {
      const conflict = conflicts.find(c => c.path[0] === 'habit-check' && c.path[2] === day);
      days.append(this.checkButton(habit, day, conflict, parentConflict));
    }
    article.append(days);
    const written = this.days.filter(day => hasJournalEntry(habit.journal?.[day]));
    if (written.length) {
      const expanded = this.openJournals.has(habit.id);
      const count = (this.selectedMonday ? '当周感想 ' : '本周感想 ') + written.length + ' 条';
      const show = this.button(count + (expanded ? ' ⌃' : ' ⌄'), name + '，' + count, () => {
        if (expanded) this.openJournals.delete(habit.id); else this.openJournals.add(habit.id);
        this.render();
      }, 'habit-link habit-journal-toggle');
      show.setAttribute('aria-expanded', String(expanded)); show.setAttribute('data-habit-focus', 'journal:' + habit.id);
      article.append(show);
      if (expanded) article.append(this.journalPanel(habit, written, parentConflict));
    }
    for (const conflict of conflicts) article.append(this.conflictCard(conflict, habit.name));
    return article;
  }
  journalPanel(habit, written, parentConflict) {
    const panel = this.el('div', '', 'habit-journal-list');
    for (const day of written.reverse()) {
      const entry = habit.journal[day], key = JSON.stringify(['journal', habit.id, day]);
      const editable = this.unlocked && !parentConflict && canJournal(habit, day, this.snapshot.today);
      const section = editable ? this.el('button', '', 'habit-journal-entry') : this.el('div', '', 'habit-journal-entry');
      if (editable) {
        section.type = 'button';
        section.setAttribute('data-habit-focus', key);
        section.addEventListener('click', () => this.journal.open(habit, this.snapshot, day, key));
      }
      section.append(this.el('strong', shortDate(day)));
      if (typeof entry.note === 'string' && entry.note) section.append(this.el('span', entry.note, 'habit-note'));
      const photos = journalPhotoCount(entry);
      if (photos) section.append(this.el('span', '这一天有 ' + photos + ' 张照片，请在电脑上查看。', 'caption habit-photo-count'));
      panel.append(section);
    }
    return panel;
  }
  checkButton(habit, day, conflict, parentConflict) {
    const today = this.snapshot.today, checked = isChecked(habit, day), observed = this.snapshot.editToken;
    const dayIssue = checkDayIssue(habit, day, today);
    const issue = dayIssue || (!this.unlocked ? '习惯当前为只读' : parentConflict ? '请先处理习惯冲突' : '');
    const written = hasJournalEntry(habit.journal?.[day]), unscheduled = !inPlan(habit, day);
    const state = checked ? '已打卡' : '未打卡';
    const instruction = issue || (conflict ? '两边都改过，请在下方选择版本' : checked ? '点击取消' : day === today ? '点击打卡' : '点击补打卡');
    const label = [habit.name || '未命名习惯', day, day === today ? '今天' : '', state, instruction,
      !issue && unscheduled ? '不在计划内，仍可打卡' : '', written ? '有感想记录' : ''].filter(Boolean).join('，');
    const button = this.button('', label, () => {
      if (conflict) {
        const card = Array.from(this.root.querySelectorAll('[data-habit-conflict]')).find(n => n.getAttribute('data-habit-conflict') === conflict.key);
        card?.scrollIntoView?.({ block: 'nearest' }); card?.querySelector('button')?.focus();
      } else this.perform(() => this.actions.setCheck(habit.id, day, !checked, { baseToken: observed, previousChecked: checked }));
    }, 'habit-check' + (day === today ? ' habit-today is-today' : '') + (checked ? ' is-checked' : '') +
      (unscheduled ? ' is-unscheduled' : '') + (dayIssue ? ' is-outside-dates' : '') + (conflict ? ' has-conflict' : ''));
    button.disabled = Boolean(issue);
    button.setAttribute('aria-pressed', String(checked)); button.setAttribute('data-habit-focus', JSON.stringify([habit.id, day]));
    const symbol = this.el('span', conflict ? '!' : checked ? '✓' : '', 'habit-check-symbol');
    symbol.setAttribute('aria-hidden', 'true'); button.append(symbol);
    if (written) {
      const marker = this.el('span', '', 'habit-journal-marker'); marker.setAttribute('aria-hidden', 'true'); button.append(marker);
    }
    return button;
  }
  conflictCard(conflict, name) {
    const card = this.el('div', '', 'conflict-card'); card.setAttribute('data-habit-conflict', conflict.key);
    const type = conflict.path[0], day = conflict.path[2];
    card.append(this.el('h3', name + (type === 'habit-check' || type === 'habit-journal' ? ' · ' + day : '') + ' · 两边都改过，请选择'));
    const observed = this.snapshot.editToken;
    conflict.candidates.forEach((candidate, index) => {
      const version = this.el('div', '', 'conflict-version');
      const text = candidate.deleted ? '删除的版本' : type === 'habit-check' ? candidate.value ? '已打卡' : '未打卡（已取消）' :
        type === 'entity' ? '保留这个习惯' : JSON.stringify(candidate.value, null, 2);
      version.append(this.el('strong', '版本 ' + (index + 1)), this.el('p', text, 'conflict-value'));
      const choose = this.button(candidate.deleted ? '确认删除' : '保留这一份：' + (type === 'habit-check' ? text : '版本 ' + (index + 1)), name + '，' + (day || '') + '，选择版本 ' + (index + 1) + '：' + text,
        () => this.run(async () => { await this.source.resolve(conflict.key, { branch: candidate.branch, observed }); this.snack('已处理两边都改过的内容'); this.onSaved(); }));
      choose.disabled = !this.unlocked; choose.setAttribute('data-habit-focus', conflict.key + ':' + index); version.append(choose); card.append(version);
    });
    return card;
  }
  destroy() { this.destroyed = true; this.journal.destroy(); this.unsubscribe(); clearInterval(this.dayTimer); clearTimeout(this.snackTimer); }
}
