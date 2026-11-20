import { HabitActions } from './habit-actions.js';
import { DataError } from './datasource.js';
import { StoreError } from './store.js';
import { HabitJournal } from './habit-journal.js';
import { groupHabits, frequencyText, weekProgress, recentDays, weekIndex, isChecked, inPlan, habitConflicts } from './habit-model.js';

export class HabitsView {
  constructor({ document, root, source, now = () => Date.now(), onSaved = () => {} }) {
    this.document = document; this.root = root; this.source = source; this.now = now; this.onSaved = onSaved;
    this.actions = new HabitActions(source, { now }); this.otherOpen = false; this.openJournals = new Set();
    this.content = this.el('div'); this.status = this.el('p', '', 'caption'); this.status.setAttribute('role', 'status');
    this.snackbar = this.el('div', '', 'task-snackbar'); this.snackbar.hidden = true; this.snackbar.setAttribute('role', 'status'); this.snackbar.setAttribute('aria-live', 'polite');
    this.snackText = this.el('span'); this.undoButton = this.button('撤销', '撤销这次习惯打卡修改', () => {
      const undo = this.undo, until = this.undoUntil;
      this.run(async () => { if (undo && this.now() <= until) { await undo(); this.hideSnack(); this.onSaved(); } });
    });
    this.snackbar.append(this.snackText, this.undoButton); root.replaceChildren(this.status, this.content, this.snackbar);
    this.journal = new HabitJournal({ document, root, actions: this.actions, source, onSaved, returnFocus: id => {
      Array.from(root.querySelectorAll('[data-habit-name]')).find(n => n.getAttribute('data-habit-name') === id)?.focus({ preventScroll: true });
    } });
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
      loading ? '习惯正在载入…' : '今天 ' + snapshot.today + ' · 按软件时区';
    if (loading) { this.content.append(this.el('p', '习惯正在载入…', 'caption')); return; }
    if (!snapshot.today) return;
    const { due, other } = groupHabits(snapshot.planner.habits, snapshot.today);
    if (!snapshot.joined && !due.length && !other.length) return;
    this.content.append(this.el('h2', '今天要打卡 · ' + due.filter(h => isChecked(h, snapshot.today)).length + '/' + due.length));
    for (const habit of due) this.content.append(this.row(habit));
    if (snapshot.joined && !due.length) this.content.append(this.el('p', other.length ? '今天没有按计划要打卡的习惯。' : '没有未归档的习惯。', 'caption'));
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
    if (focusKey) Array.from(this.root.querySelectorAll('[data-habit-focus]')).find(n => n.getAttribute('data-habit-focus') === focusKey)?.focus({ preventScroll: true });
  }
  row(habit) {
    const today = this.snapshot.today, checked = isChecked(habit, today), progress = weekProgress(habit, today);
    const conflicts = habitConflicts(this.snapshot, habit.id), parentConflict = conflicts.some(c => c.path[0] === 'entity');
    const article = this.el('article', '', 'habit-item'); article.setAttribute('data-habit-id', habit.id);
    const line = this.el('div', '', 'habit-row');
    const color = Number.isInteger(habit.color) ? ((habit.color % 10) + 10) % 10 : 0;
    const dot = this.el('span', '', 'habit-dot habit-color-' + color); dot.setAttribute('aria-hidden', 'true'); line.append(dot);
    const text = this.el('div', '', 'habit-text');
    const name = this.el('h3', '', 'habit-name'), expanded = this.openJournals.has(habit.id);
    const open = this.button(habit.name || '未命名习惯', (expanded ? '收起' : '展开') + '感想：' + habit.name + '，今天' + (checked ? '已打卡' : '未打卡') + '，' + progress.text, () => {
      if (expanded) this.openJournals.delete(habit.id); else this.openJournals.add(habit.id); this.render();
    }, 'habit-name-button');
    open.setAttribute('aria-expanded', String(expanded)); open.setAttribute('data-habit-name', habit.id); open.setAttribute('data-habit-focus', 'name:' + habit.id); name.append(open);
    text.append(name, this.el('p', frequencyText(habit) + ' · ' + progress.text, 'caption'));
    if (habit.start > today) text.append(this.el('p', habit.start + ' 开始', 'caption'));
    if (habit.end) text.append(this.el('p', (habit.end < today ? '已于 ' : '至 ') + habit.end + (habit.end < today ? ' 结束' : ''), 'caption'));
    line.append(text);
    const stateLabel = habit.name + '，今天' + (checked ? '已打卡' : '未打卡') + '，' + progress.text;
    const todayConflict = conflicts.find(c => c.path[0] === 'habit-check' && c.path[2] === today);
    const big = this.checkButton(habit, today, stateLabel, todayConflict, parentConflict, true); line.append(big); article.append(line);
    const days = this.el('div', '', 'habit-days'); days.setAttribute('role', 'group'); days.setAttribute('aria-label', habit.name + '，最近七天打卡');
    for (const day of recentDays(today)) {
      const conflict = conflicts.find(c => c.path[0] === 'habit-check' && c.path[2] === day);
      const label = habit.name + '，' + day + '，' + (isChecked(habit, day) ? '已打卡，点击取消' : '未打卡，点击' + (day === today ? '打卡' : '补打卡')) +
        (inPlan(habit, day) ? '' : '，不在计划内，仍可打卡');
      days.append(this.checkButton(habit, day, label, conflict, parentConflict));
    }
    article.append(days);
    if (expanded) article.append(this.journalPanel(habit, conflicts));
    for (const conflict of conflicts) article.append(this.conflictCard(conflict, habit.name));
    return article;
  }
  journalPanel(habit, conflicts) {
    const panel = this.el('div', '', 'habit-journal-list'); panel.append(this.el('h3', '最近七天的感想'));
    for (const day of recentDays(this.snapshot.today).reverse()) {
      const entry = habit.journal?.[day], section = this.el('div', '', 'habit-journal-entry');
      section.append(this.el('strong', day), this.el('p', typeof entry?.note === 'string' && entry.note ? entry.note : '还没有文字感想', 'habit-note'));
      const photos = Array.isArray(entry?.photos) ? entry.photos.length : 0;
      if (photos) section.append(this.el('p', '有 ' + photos + ' 张照片，请在电脑上查看', 'caption'));
      const edit = this.button(entry ? '修改感想' : '写一句感想', habit.name + '，' + day + '，编辑文字感想', () => this.journal.open(habit, day, this.snapshot));
      edit.disabled = !this.unlocked || Boolean(habit.start && day < habit.start) || conflicts.some(c => c.path[0] === 'entity' || c.path[0] === 'habit-journal' && c.path[2] === day);
      section.append(edit); panel.append(section);
    }
    return panel;
  }
  checkButton(habit, day, label, conflict, parentConflict, big = false) {
    const checked = isChecked(habit, day), observed = this.snapshot.editToken;
    const button = this.button('', label + (conflict ? '，两边都改过，请在下方选择版本' : ''), () => {
      if (conflict) {
        const card = Array.from(this.root.querySelectorAll('[data-habit-conflict]')).find(n => n.getAttribute('data-habit-conflict') === conflict.key);
        card?.scrollIntoView?.({ block: 'nearest' }); card?.querySelector('button')?.focus();
      } else this.perform(() => this.actions.setCheck(habit.id, day, !checked, { baseToken: observed, previousChecked: checked }));
    }, 'habit-check' + (big ? ' habit-today' : '') + (checked ? ' is-checked' : '') + (!inPlan(habit, day) ? ' is-unscheduled' : '') + (conflict ? ' has-conflict' : ''));
    button.disabled = !this.unlocked || parentConflict;
    button.setAttribute('aria-pressed', String(checked)); button.setAttribute('data-habit-focus', JSON.stringify([habit.id, day, big]));
    if (!big) {
      button.append(this.el('span', day === this.snapshot.today ? '今天' : '周' + ['一', '二', '三', '四', '五', '六', '日'][weekIndex(day)], 'habit-day-label'));
      button.append(this.el('span', day.slice(5).replace('-', '/'), 'habit-day-date'));
    }
    button.append(this.el('span', conflict ? '!' : checked ? '✓' : '○', 'habit-check-symbol'));
    if (big) button.append(this.el('span', conflict ? '待确认' : checked ? '已打卡' : '打卡', 'habit-day-label'));
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
