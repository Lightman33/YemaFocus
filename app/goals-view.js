import { DataError } from './datasource.js';
import { GoalActions } from './goals-actions.js';
import { childGoals, childGroups, domainNames, findGoalPlan, goalPomoStats, goalsInDomain, longGoalPomoStats,
  parentGoal, parentGroups, planLocked, planNames, savedPlanStarts, tasksForGoal } from './goals-model.js';
import { defaultGoalStart, GOAL_SPANS, goalSpan, lastGoalStart, planId, rangeLabel, samePeriod, shiftGoalPeriod, spanLabel } from './goal-periods.js';

const positions = [0, 1, 2, 3, -1, 4, 5, 6, 7];
const UNDO_MS = 5000;

export class GoalsView {
  constructor({ document, root, source, main, openTask, now = () => Date.now(), onSaved = () => {} }) {
    this.document = document;
    this.source = source;
    this.main = main;
    this.openTask = openTask;
    this.now = now;
    this.onSaved = onSaved;
    this.actions = new GoalActions(source);
    this.domain = null;
    this.span = 1;
    this.starts = new Map();
    this.expanded = new Set();
    this.controls = new Map();
    this.content = this.el('div');
    this.notice = this.el('p', '', 'caption');
    this.notice.setAttribute('role', 'status');
    this.message = this.el('p', '', 'error-text');
    this.message.setAttribute('role', 'alert');
    this.snackbar = this.el('div', '', 'task-snackbar');
    this.snackbar.hidden = true;
    this.snackText = this.el('span');
    this.snackText.setAttribute('role', 'status');
    this.undoButton = this.button('撤销', '撤销这次目标勾选变更', () => {
      const undo = this.undo;
      if (undo && this.now() < undo.until && !this.pending && this.editable) {
        this.run(undo.apply, () => this.hideUndo());
      }
    });
    this.snackbar.append(this.snackText, this.undoButton);
    this.dialog = this.el('dialog', '', 'goal-dialog');
    this.dialog.setAttribute('aria-labelledby', 'goal-editor-title');
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.closeEditor(); });
    root.replaceChildren(this.notice, this.message, this.content, this.snackbar, this.dialog);
    root.setAttribute('aria-busy', 'false');
    this.unsubscribe = source.subscribe(() => { if (this.visible) this.refresh(); });
  }

  el(tag, text = '', className = '') {
    const el = this.document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  button(text, label, action, { key, disabled = false, className = 'secondary' } = {}) {
    const button = this.el('button', text, className);
    button.type = 'button';
    button.disabled = disabled;
    button.setAttribute('aria-label', label || text);
    button.addEventListener('click', action);
    if (key) this.controls.set(key, button);
    return button;
  }

  get currentYear() { return this.snapshot.today ? +this.snapshot.today.slice(0, 4) : new Date(this.now()).getFullYear(); }
  get year() {
    const start = this.starts.get(this.span) ?? defaultGoalStart(this.span, this.currentYear);
    return this.span === 1 ? Math.min(start, lastGoalStart(1, this.currentYear)) : start;
  }
  get editable() { return this.snapshot.joined && Boolean(this.snapshot.timeZone); }
  get plan() { return findGoalPlan(this.snapshot.planner, this.span, this.year); }
  get vision() {
    return (this.span === 1 ? this.snapshot.planner.goalYears?.find(row => row.year === this.year)?.vision : this.plan?.vision) || '';
  }
  get names() {
    return this.span === 1 ? domainNames(this.snapshot.planner, this.year) : planNames(this.snapshot.planner, this.span, this.year);
  }
  get yearReady() { return this.span !== 1 || this.snapshot.planner.goalYears?.some(row => row.year === this.year); }
  periodGoals(domain) { return goalsInDomain(this.snapshot.planner, this.year, domain, this.span); }

  enter() {
    this.visible = true;
    this.failedYear = null;
    this.refresh();
  }

  async leave() {
    await this.flush();
    if (this.hasDraft()) throw new DataError('请先保存或取消正在编辑的目标内容。');
    this.closeEditor();
    this.visible = false;
  }

  async flush() { await this.pending; await this.initializing; }
  hasDraft() { return Boolean(this.editor?.fields.some(field => field.value !== field.initial)); }
  destroy() { this.unsubscribe(); this.visible = false; clearTimeout(this.undoTimer); this.dialog.close(); }

  refresh() {
    this.snapshot = this.source.snapshot();
    this.render();
    this.prepareYear();
  }

  prepareYear() {
    const year = this.year;
    if (this.span !== 1 || !this.visible || !this.editable || this.yearReady || this.initializing || this.failedYear === year) return;
    this.initializing = Promise.resolve().then(() => this.actions.ensureYear(year)).then(receipt => {
      if (receipt) this.onSaved();
    }).catch(error => {
      this.failedYear = year;
      this.message.textContent = '年度领域初始化失败。' + error.message;
    }).finally(() => {
      this.initializing = null;
      if (this.visible) this.refresh();
    });
  }

  navigate({ span = this.span, year = this.starts.get(span) ?? defaultGoalStart(span, this.currentYear), domain = null, focus, goal }) {
    this.span = span;
    if (year !== this.year || this.starts.has(span)) this.starts.set(span, year);
    this.domain = domain;
    this.expanded.clear();
    if (goal) this.expanded.add(goal);
    this.message.textContent = '';
    this.refresh();
    if (this.main) this.main.scrollTop = 0;
    const target = this.controls.get(focus) || this.controls.get('heading');
    target?.focus({ preventScroll: true });
    if (goal) target?.scrollIntoView({ block: 'nearest' });
  }

  openGoal(goal) {
    this.navigate({ span: goalSpan(goal), year: goal.year, domain: goal.domain, focus: 'expand-' + goal.id, goal: goal.id });
  }

  run(operation, after) {
    if (this.pending || !this.editable) return this.pending;
    this.message.textContent = '';
    if (this.editor) this.editor.error.textContent = '';
    this.pending = Promise.resolve().then(operation).then(receipt => {
      if (receipt) this.onSaved();
      after?.(receipt);
    }).catch(error => {
      (this.editor?.error || this.message).textContent = error.message || '操作没有完成，请重试。';
    }).finally(() => {
      this.pending = null;
      if (this.visible) this.refresh();
    });
    this.renderEditor();
    return this.pending;
  }

  showUndo(receipt, goal) {
    if (!receipt?.undo || !this.visible) return;
    clearTimeout(this.undoTimer);
    this.undo = { apply: receipt.undo, until: this.now() + UNDO_MS, goal };
    this.snackbar.hidden = false;
    this.snackText.textContent = receipt.description;
    this.undoTimer = setTimeout(() => this.hideUndo(), UNDO_MS);
    this.undoTimer.unref?.();
  }

  hideUndo() {
    if (this.document.activeElement === this.undoButton) {
      const check = this.controls.get('check-' + this.undo?.goal);
      (check && !check.disabled ? check : this.controls.get('heading'))?.focus({ preventScroll: true });
    }
    this.snackbar.hidden = true;
    this.undo = null;
    clearTimeout(this.undoTimer);
  }

  render() {
    const active = [...this.controls].find(([, node]) => node === this.document.activeElement)?.[0];
    this.controls.clear();
    this.notice.textContent = !this.snapshot.joined ? '先在设置里连接并完成第一次同步' : !this.snapshot.timeZone ? '请先在设置里选择软件时区。' : '';
    this.notice.hidden = !this.notice.textContent;
    this.undoButton.disabled = !this.editable;
    this.content.replaceChildren(this.spanControls(), this.domain === null ? this.board() : this.detail());
    if (active && !this.editor) (this.controls.get(active) || this.controls.get('heading'))?.focus({ preventScroll: true });
    this.renderEditor();
  }

  spanControls() {
    const controls = this.el('div', '', 'goal-span-controls');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', '目标视角');
    for (const span of GOAL_SPANS) {
      const button = this.button(spanLabel(span), '', () => {
        if (this.span !== span) this.navigate({ span, focus: 'span-' + span });
      }, { key: 'span-' + span, className: this.span === span ? 'primary' : 'secondary' });
      button.setAttribute('aria-pressed', String(this.span === span));
      controls.append(button);
    }
    return controls;
  }

  planControl(conflicts) {
    const span = this.span, year = this.year, planner = this.snapshot.planner;
    const starts = new Set(savedPlanStarts(planner, span));
    for (const conflict of this.snapshot.conflicts || []) {
      if (conflict.path[0] === 'goal-plan' && conflict.path[1].startsWith(span + ':')) starts.add(+conflict.path[1].split(':')[1]);
    }
    starts.delete(year);
    const canAdjust = this.editable && !planLocked(planner, span, year) && !conflicts.names.length && !conflicts.goals.length;
    if (starts.size) {
      const select = this.el('select', '', 'goal-plan-control');
      select.setAttribute('aria-label', canAdjust ? '时段设置' : '已保存时段');
      this.controls.set('saved-periods', select);
      const hint = this.el('option', canAdjust ? '时段设置' : '已保存时段');
      hint.value = '';
      select.append(hint);
      for (const start of [...starts].sort((a, b) => b - a)) {
        const option = this.el('option', rangeLabel(start, span));
        option.value = String(start);
        select.append(option);
      }
      if (canAdjust) {
        const adjust = this.el('option', '调整起始年');
        adjust.value = 'adjust';
        select.append(adjust);
      }
      select.value = '';
      select.addEventListener('change', () => {
        if (select.value === 'adjust') { select.value = ''; this.openEditor('start'); }
        else if (select.value) this.navigate({ year: +select.value });
      });
      return select;
    }
    if (canAdjust) {
      return this.button('调整起始年', '', () => this.openEditor('start'), { key: 'start', className: 'secondary goal-plan-control' });
    }
  }

  board() {
    const box = this.el('div');
    const header = this.el('div', '', 'goal-year-controls');
    const year = this.el('h2', rangeLabel(this.year, this.span));
    year.tabIndex = -1;
    this.controls.set('heading', year);
    const previous = shiftGoalPeriod(this.year, this.span, -1, this.currentYear);
    const next = shiftGoalPeriod(this.year, this.span, 1, this.currentYear);
    header.append(this.button('‹', this.span === 1 ? '上一年' : '上一时段', () => this.navigate({ year: previous, focus: 'previous' }), { key: 'previous', disabled: previous === null }), year,
      this.button('›', this.span === 1 ? '下一年' : '下一时段', () => this.navigate({ year: next, focus: 'next' }), { key: 'next', disabled: next === null }));
    const conflicts = this.yearConflicts();
    if (this.span !== 1) {
      const control = this.planControl(conflicts);
      if (control) header.append(control);
    }
    box.append(header);
    if (conflicts.goals.length) box.append(this.el('p', (this.span === 1 ? '本年' : '此时段') + '有 ' + conflicts.goals.length + ' 条目标两边都改过。', 'caption'));
    for (const conflict of conflicts.names) box.append(this.conflictCard(conflict, this.span === 1 ? '领域名称两边都改过' : '宫格设置两边都改过'));
    const grid = this.el('div', '', 'goal-grid'), names = this.names;
    for (const domain of positions) {
      if (domain < 0) {
        grid.append(this.visionCell(conflicts.names.length > 0));
        continue;
      }
      const goals = this.periodGoals(domain);
      const conflicted = conflicts.goals.filter(item => item.candidates.some(c => c.value?.domain === domain && samePeriod(c.value, this.span, this.year)));
      const cell = this.button('', names[domain] + '，' + goals.length + ' 条目标' + (conflicted.length ? '，有冲突需要处理' : ''),
        () => this.navigate({ domain, focus: 'heading' }),
        { key: 'domain-' + domain, className: 'goal-cell goal-color-' + domain + (conflicted.length ? ' has-conflict' : '') });
      const title = this.el('span', '', 'goal-cell-title');
      title.append(this.el('strong', names[domain]), this.el('span', String(goals.length), 'goal-count'));
      if (conflicted.length) {
        const marker = this.el('span', '!', 'goal-conflict-marker');
        marker.setAttribute('aria-hidden', 'true');
        title.append(marker);
      }
      cell.append(title);
      for (const goal of goals.slice(0, 3)) cell.append(this.el('span', (goal.done ? '✓ ' : '○ ') + goal.title, 'goal-preview'));
      if (goals.length > 3) cell.append(this.el('span', '还有 ' + (goals.length - 3) + ' 条', 'goal-preview'));
      grid.append(cell);
    }
    box.append(grid);
    return box;
  }

  visionCell(blocked) {
    const vision = this.vision;
    const canEdit = this.editable && !blocked && this.yearReady;
    const className = 'goal-center goal-plan-center' + (this.span === 1 ? ' goal-annual-center' : '');
    const period = this.span === 1 ? this.year + ' 年' : rangeLabel(this.year, this.span), action = canEdit ? '编辑愿景' : '查看愿景';
    const annual = this.span === 1 ? (this.snapshot.planner.goals || []).filter(goal => samePeriod(goal, 1, this.year)) : [];
    const done = annual.filter(goal => goal.done).length;
    const label = period + ' 愿景：' + (vision || '尚未填写') + (annual.length ? '，目标已完成 ' + done + ' / ' + annual.length : '') + '，' + action;
    const cell = canEdit || vision ? this.button('', label,
      () => this.openEditor(canEdit ? 'vision' : 'readVision'), { key: 'vision', className }) : this.el('div', '', className);
    // 年度宫格的年份已在标题里，中间格只放愿景和完成数。
    if (this.span !== 1) cell.append(this.el('strong', period));
    if (vision || canEdit) cell.append(this.el('span', vision || '写下愿景', 'goal-vision' + (vision ? '' : ' goal-vision-empty')));
    if (annual.length) {
      const progress = this.el('span', '', 'goal-center-progress');
      progress.append(this.el('strong', done + ' / ' + annual.length), this.el('span', '已完成'));
      cell.append(progress);
    }
    return cell;
  }

  detail() {
    const box = this.el('div'), header = this.el('div', '', 'goal-detail-heading');
    const period = this.span === 1 ? this.year + ' 年' : rangeLabel(this.year, this.span);
    const title = this.el('h2', period + ' · ' + this.names[this.domain], 'goal-color-' + this.domain);
    title.tabIndex = -1;
    this.controls.set('heading', title);
    const conflicts = this.yearConflicts();
    const nameBlocked = conflicts.names.length > 0;
    header.append(title, this.button('‹ 九宫格', this.span === 1 ? '返回年度九宫格' : '返回长期九宫格', () => this.navigate({ focus: 'domain-' + this.domain }), { key: 'back' }),
      this.button('改名', '修改领域名称', () => this.openEditor('rename'), { key: 'rename', disabled: !this.editable || !this.yearReady || nameBlocked }),
      this.button('添加目标', '添加目标', () => this.openEditor('add'), { key: 'add', disabled: !this.editable, className: 'primary' }));
    box.append(header);
    for (const conflict of conflicts.names) box.append(this.conflictCard(conflict, this.span === 1 ? '领域名称两边都改过' : '宫格设置两边都改过'));
    const here = conflicts.goals.filter(item => item.candidates.some(c => c.value?.domain === this.domain && samePeriod(c.value, this.span, this.year)));
    for (const conflict of here) box.append(this.conflictCard(conflict, '目标两边都改过'));
    const goals = this.periodGoals(this.domain);
    if (!goals.length && !here.length) box.append(this.el('p', '这里还没有目标。', 'caption'));
    const list = this.el('div', '', 'goal-detail-list');
    goals.forEach((goal, index) => list.append(this.goalRow(goal, index, goals.length, here.some(conflict => conflict.path[1] === goal.id))));
    box.append(list);
    return box;
  }

  goalRow(goal, index, count, conflict) {
    const observed = this.snapshot.editToken, disabled = !this.editable || conflict;
    const row = this.el('article', '', 'card goal-detail-row');
    const line = this.el('div', '', 'goal-row-line');
    const check = this.button(goal.done ? '✓' : '○', (goal.done ? '取消完成：' : '完成：') + goal.title,
      () => this.run(() => this.actions.toggle(goal.id, !goal.done, this.snapshot.today, observed), receipt => this.showUndo(receipt, goal.id)),
      { key: 'check-' + goal.id, disabled });
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(goal.done));
    const open = this.expanded.has(goal.id);
    const long = goalSpan(goal) !== 1;
    const toggleDetails = () => {
      if (open) this.expanded.delete(goal.id); else this.expanded.add(goal.id);
      this.render();
    };
    const title = this.button(goal.title, (open ? '收起目标：' : '展开目标：') + goal.title, toggleDetails,
      { key: 'title-' + goal.id, className: 'goal-row-title' });
    title.setAttribute('aria-expanded', String(open));
    const expand = this.button(open ? '收起' : '展开', (open ? '收起' : '展开') + (long ? '下级目标和番茄：' : '关联任务和番茄：') + goal.title,
      toggleDetails, { key: 'expand-' + goal.id });
    expand.setAttribute('aria-expanded', String(open));
    line.append(check, title, expand);
    row.append(line);
    if (goal.doneOn) row.append(this.el('p', goal.doneOn + ' 完成', 'caption'));
    if (open) {
      if (goal.notes) row.append(this.el('p', goal.notes, 'goal-notes'));
      const parent = parentGoal(this.snapshot.planner, goal);
      if (parent) row.append(this.goalLink(parent, '服务于', goal.id));
      else if (goal.parentId) row.append(this.el('p', '服务于的目标已不可用。', 'caption'));
      if (long) row.append(this.longDetails(goal));
      else row.append(this.annualDetails(goal));
      const actions = this.el('div', '', 'actions');
      actions.append(this.button('编辑', '编辑目标：' + goal.title, () => this.openEditor('edit', goal), { key: 'edit-' + goal.id, disabled }),
        this.button('上移', '上移目标：' + goal.title, () => this.run(() => this.actions.move(goal.id, -1, observed)), { key: 'up-' + goal.id, disabled: disabled || index === 0 }),
        this.button('下移', '下移目标：' + goal.title, () => this.run(() => this.actions.move(goal.id, 1, observed)), { key: 'down-' + goal.id, disabled: disabled || index === count - 1 }),
        this.button('删除', '删除目标：' + goal.title, () => this.openEditor('delete', goal), { key: 'delete-' + goal.id, disabled, className: 'danger-button' }));
      row.append(actions);
    }
    return row;
  }

  goalLink(goal, prefix, contextId) {
    return this.button((prefix ? prefix + ' · ' : '') + (goal.done ? '✓ ' : '○ ') + goal.title, (prefix ? prefix + '：' : '打开下级目标：') + goal.title,
      () => this.openGoal(goal), { key: 'goal-link-' + JSON.stringify([contextId, goal.id]), className: 'secondary goal-link' });
  }

  statsLine(label, stats) {
    return this.el('p', label + stats.count + ' 个番茄 · ' +
      new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(stats.minutes) + ' 分钟');
  }

  annualDetails(goal) {
    const box = this.el('div');
    const tasks = tasksForGoal(this.snapshot.planner, goal.id);
    if (this.snapshot.loading?.records) box.append(this.el('p', '专注记录正在载入…', 'caption'));
    else box.append(this.statsLine(this.year + ' 年 · ', goalPomoStats(tasks, this.snapshot.records, this.year)));
    const links = this.el('div', '', 'goal-tasks');
    for (const task of tasks) links.append(this.button(task.title, '打开任务：' + task.title, () => this.openTask(task.id), { key: 'task-' + task.id }));
    if (!tasks.length) links.append(this.el('p', '还没有关联任务。', 'caption'));
    box.append(links);
    return box;
  }

  longDetails(goal) {
    const box = this.el('div', '', 'goal-children');
    const children = childGoals(this.snapshot.planner, goal);
    if (children.length) box.append(this.el('p', '已完成 ' + children.filter(child => child.done).length + ' / 共 ' + children.length + ' 个下级目标'));
    else box.append(this.el('p', '在年度或更短跨度的目标里选「服务于」，就能把它归到这里。', 'caption'));
    if (this.snapshot.loading?.records) box.append(this.el('p', '专注记录正在载入…', 'caption'));
    else box.append(this.statsLine('累计 ', longGoalPomoStats(this.snapshot.planner, goal, this.snapshot.records)));
    for (const [label, group] of childGroups(children)) {
      const links = this.el('div', '', 'goal-tasks');
      links.append(this.el('h3', label));
      for (const child of group) {
        const link = this.goalLink(child, null, goal.id);
        link.setAttribute('aria-label', '打开下级目标：' + child.title + '，' + (child.done ? '已完成' : '未完成'));
        links.append(link);
      }
      box.append(links);
    }
    return box;
  }

  yearConflicts() {
    const conflicts = this.snapshot.conflicts || [];
    return {
      names: conflicts.filter(c => this.span === 1 ? c.path[0] === 'goal-year' && +c.path[1] === this.year :
        c.path[0] === 'goal-plan' && c.path[1] === planId(this.span, this.year)),
      goals: conflicts.filter(c => c.path[0] === 'goal' && c.candidates.some(v => v.value && samePeriod(v.value, this.span, this.year)))
    };
  }

  conflictCard(conflict, title) {
    const card = this.el('div', '', 'conflict-card');
    const observed = this.snapshot.editToken;
    card.append(this.el('h3', title));
    conflict.candidates.forEach((candidate, i) => {
      const row = this.el('div', '', 'conflict-version'), value = candidate.value;
      const board = conflict.path[0] !== 'goal';
      const parent = !board && value && parentGoal(this.snapshot.planner, value);
      const description = candidate.deleted ? board ? '删除宫格设置' : '删除目标' : board ?
        [value.names.join(' · '), value.vision && '愿景：' + value.vision].filter(Boolean).join('\n') :
        [value.title, value.done ? '已完成' + (value.doneOn ? '（' + value.doneOn + '）' : '') : '未完成', '顺序 ' + value.order, value.notes,
          value.parentId ? '服务于：' + (parent?.title || '目标已不可用') : conflict.candidates.some(branch => branch.value?.parentId) && '不指定上级'].filter(Boolean).join('\n');
      row.append(this.el('p', description, 'conflict-value'), this.button(candidate.deleted ? '确认删除' : '保留版本 ' + (i + 1), '',
        () => this.run(() => this.source.resolve(conflict.key, { branch: candidate.branch, observed })), { disabled: !this.editable }));
      card.append(row);
    });
    return card;
  }

  openEditor(mode, goal) {
    const reading = mode === 'readVision';
    if ((!this.editable && !reading) || this.editor) return;
    const year = this.year, span = this.span, domain = this.domain, observed = this.snapshot.editToken;
    const titles = { rename: '修改领域名称', add: '添加目标', edit: '编辑目标', delete: '删除目标',
      start: '调整起始年份', vision: '编辑愿景', readVision: '愿景' };
    const form = this.el('form');
    const heading = this.el('h2', titles[mode]);
    heading.id = 'goal-editor-title';
    form.append(heading);
    const fields = [];
    const field = (id, label, value, multi = false) => {
      const wrapper = this.el('div', '', 'detail-field'), name = this.el('label', label);
      name.setAttribute('for', id);
      const input = this.el(multi ? 'textarea' : 'input');
      input.id = id;
      if (!multi) { input.type = 'text'; input.required = true; }
      input.value = input.initial = value;
      input.addEventListener('compositionstart', () => { input.composing = true; });
      input.addEventListener('compositionend', () => { input.composing = false; });
      wrapper.append(name, input);
      form.append(wrapper);
      fields.push(input);
      return input;
    };
    let save, saved;
    if (mode === 'rename') {
      const name = field('goal-domain-name', '名称', this.names[domain]);
      save = () => this.actions.rename(year, domain, name.value, observed, span);
    } else if (mode === 'delete') {
      form.append(this.el('p', '删除「' + goal.title + '」？'));
      const planner = this.snapshot.planner;
      const children = childGoals(planner, goal).length, tasks = tasksForGoal(planner, goal.id).length;
      if (children || tasks) {
        const affected = [children && children + ' 个下级目标', tasks && tasks + ' 个关联任务'].filter(Boolean);
        form.append(this.el('p', '删除后，' + affected.join('和') + '将失去与这条目标的关联。', 'caption'));
      }
      save = () => this.actions.remove(goal.id, observed);
    } else if (mode === 'start') {
      const start = field('goal-start', '起始年份', String(year));
      start.type = 'number'; start.min = 1; start.max = lastGoalStart(span, this.currentYear); start.step = 1;
      start.inputMode = 'numeric';
      save = () => this.actions.changeStart(span, year, Number(start.value), this.currentYear, observed);
      saved = () => this.navigate({ year: Number(start.value) });
    } else if (mode === 'vision') {
      const vision = field('goal-vision', (span === 1 ? year + ' 年' : rangeLabel(year, span)) + ' 的愿景', this.vision, true);
      save = () => this.actions.saveVision(span, year, vision.value, observed);
    } else if (reading) {
      form.append(this.el('p', this.vision, 'goal-notes'));
    } else {
      const title = field('goal-title', '目标标题', goal?.title || '');
      const notes = field('goal-notes', '备注', goal?.notes || '', true);
      const child = goal || { span, year };
      const parent = span < 10 ? this.parentPicker(form, child) : null;
      if (parent) fields.push(parent);
      save = () => this.actions.save(year, domain, { id: goal?.id, title: title.value, notes: notes.value, span, parentId: parent?.value }, observed);
    }
    const error = this.el('p', '', 'error-text');
    error.setAttribute('role', 'alert');
    const actions = this.el('div', '', 'actions');
    const cancel = this.button(reading ? '关闭' : '取消', '', () => this.closeEditor());
    const submit = this.el('button', mode === 'delete' ? '确认删除' : '保存', mode === 'delete' ? 'danger-button' : 'primary');
    submit.type = 'submit';
    actions.append(cancel);
    if (!reading) {
      actions.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!fields.some(input => input.composing)) this.run(save, () => { this.closeEditor(true); saved?.(); });
      });
    }
    form.append(error, actions);
    const focus = [...this.controls].find(([, node]) => node === this.document.activeElement)?.[0];
    this.editor = { fields, cancel, submit, error, focus };
    this.dialog.replaceChildren(form);
    this.dialog.showModal();
    (fields[0] || cancel).focus();
  }

  parentPicker(form, child) {
    const wrapper = this.el('div', '', 'detail-field');
    const label = this.el('label', '服务于');
    const select = this.el('select');
    select.id = 'goal-parent';
    label.setAttribute('for', select.id);
    const none = this.el('option', '不指定上级');
    none.value = '';
    select.append(none);
    const groups = parentGroups(this.snapshot.planner, child);
    for (const { label, goals } of groups) {
      const group = this.el('optgroup');
      group.label = label;
      for (const parent of goals) {
        const option = this.el('option', rangeLabel(parent.year, goalSpan(parent)) + ' · ' + parent.title);
        option.value = parent.id;
        group.append(option);
      }
      select.append(group);
    }
    if (child.parentId && !groups.some(group => group.goals.some(goal => goal.id === child.parentId))) {
      const unavailable = this.el('option', '原上级已不可用');
      unavailable.value = child.parentId;
      unavailable.disabled = true;
      select.append(unavailable);
    }
    select.value = select.initial = child.parentId || '';
    wrapper.append(label, select);
    form.append(wrapper);
    return select;
  }

  renderEditor() {
    if (!this.editor) return;
    this.editor.submit.disabled = Boolean(this.pending) || !this.editable;
    this.editor.cancel.disabled = Boolean(this.pending);
  }

  closeEditor(saved = false) {
    if (!this.editor || this.pending && !saved) return;
    const { focus } = this.editor;
    this.editor = null;
    this.dialog.close();
    this.dialog.replaceChildren();
    (this.controls.get(focus) || this.controls.get('heading'))?.focus({ preventScroll: true });
  }
}
