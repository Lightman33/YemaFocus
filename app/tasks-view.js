import { TaskActions } from './task-actions.js';
import { DataError, wallTime } from './datasource.js';
import { StoreError } from './store.js';
import { parseQuick, groupTasks, visibleGroups, projectTree, repeating, abandoned, overdue, whenText, dateText, wallText, PRIORITIES, ABANDON_REASONS, REPEAT_READONLY, addDays, weekStart } from './task-model.js';

const FIELD_NAMES = { title: '标题', notes: '备注', date: '日期', weekOf: '周内安排', time: '时间', endTime: '结束时间', endDate: '结束日期', priority: '优先级', project: '项目', done: '已关闭', doneAt: '完成时间', abandoned: '已放弃', abandonedAt: '放弃时间', abandonReason: '放弃原因', abandonHistory: '放弃与恢复记录', abandonPrevious: '放弃前快照', text: '步骤内容', steps: '步骤', pinned: '置顶', monthOf: '月内安排', created: '创建时间', estPomo: '预估番茄', postponed: '推迟次数', series: '重复系列', remindTime: '提醒时间', remindOffset: '提前提醒天数', remindedAt: '上次提醒', pomoTag: '专注归类', order: '顺序', repeat: '重复规则', trashedAt: '垃圾桶时间' };
export class TasksView {
  constructor({ document, source, main, now = () => Date.now(), onSaved = () => {} }) {
    this.document = document; this.source = source; this.main = main; this.now = now; this.onSaved = onSaved;
    this.actions = new TaskActions(source, { now }); this.ui = { mode: 'time', expanded: {}, stepDrafts: {}, ...source.uiState() };
    this.limits = { ...(this.ui.limits || {}) }; this.openSteps = new Set(); this.pending = new Map(); this.inputs = new Map(); this.stepRows = new Map(); this.busy = false;
    this.$ = id => document.getElementById(id); this.sheet = this.$('task-sheet');
    this.$('task-quick-form').addEventListener('submit', e => { e.preventDefault(); this.add(); });
    this.$('task-quick').addEventListener('input', () => { this.suppressed = new Set(); this.preview(); });
    this.$('task-quick').addEventListener('compositionstart', () => { this.quickComposing = true; });
    this.$('task-quick').addEventListener('compositionend', () => { this.quickComposing = false; this.preview(); });
    for (const mode of ['time', 'project']) this.$('group-' + mode).addEventListener('click', () => { this.ui.mode = mode; this.render(); this.saveUI(); });
    this.$('task-conflicts').addEventListener('click', () => this.firstConflict());
    this.$('task-sheet-close').addEventListener('click', () => this.closeSheet());
    this.sheet.addEventListener('cancel', e => { e.preventDefault(); this.closeSheet(); });
    this.sheet.addEventListener('keydown', e => this.trapFocus(e));
    this.$('task-undo').addEventListener('click', () => {
      const undo = this.undo, until = this.undoUntil;
      this.run(async () => { if (!undo || this.now() > until) return; await undo(); this.hideSnack(); this.onSaved(); });
    });
    this.$('task-zone-save').addEventListener('click', () => this.run(async () => { await source.selectTimeZone(this.$('task-zone').value); this.snack('已保存软件时区选择'); }));
    this.main.addEventListener('scroll', () => {
      if (this.$('page-tasks').hidden) return;
      clearTimeout(this.scrollTimer); this.scrollTimer = setTimeout(() => { this.ui.scrollTop = main.scrollTop; this.saveUI(); }, 180);
    });
    // 和 review-view.js 一样：输入框 blur 保存可能重建按钮，等 pointerup 后的 click 处理完再绘制。
    this.onPointerDown = event => {
      if (this.$('page-tasks').contains(event.target) || this.sheet.contains(event.target)) this.pointerDown = true;
    };
    this.onPointerEnd = () => {
      if (!this.pointerDown) return;
      this.pointerDown = false; this.pointerSettling = true;
      clearTimeout(this.pointerTimer);
      this.pointerTimer = setTimeout(() => {
        this.pointerSettling = false;
        if (this.destroyed || this.pointerDown) return;
        if (this.refreshQueued) { this.refreshQueued = false; this.detailQueued = false; this.render(); }
        else if (this.detailQueued) { this.detailQueued = false; if (this.sheet.open && this.sheetMode === 'detail') this.updateDetail(); }
      }, 0);
    };
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('pointerup', this.onPointerEnd, true); document.addEventListener('pointercancel', this.onPointerEnd, true);
    this.unsubscribe = source.subscribe(() => this.render()); this.render();
    this.dayTimer = setInterval(() => { if (source.snapshot().today !== this.snapshot.today) this.render(); }, 60000);
    this.dayTimer.unref?.();
  }
  el(tag, text = '', className = '') {
    const node = this.document.createElement(tag); if (text !== '') node.textContent = String(text); if (className) node.className = className; return node;
  }
  button(text, label, action, className = 'secondary') {
    const button = this.el('button', text, className); button.type = 'button'; button.setAttribute('aria-label', label || text);
    button.addEventListener('click', action); return button;
  }
  message(error) { return error instanceof DataError || error instanceof StoreError ? error.message : '操作没有完成，旧数据仍保留。请稍后重试。'; }
  async run(action, { closeDetail = false } = {}) {
    if (this.busy) return false;
    this.busy = true;
    try { await this.flush({ commitSteps: closeDetail }); await action(); return true; }
    catch (error) { this.snack(this.message(error)); this.$('task-save-status').textContent = this.message(error); return false; }
    finally { this.busy = false; }
  }
  async perform(operation, { close = false, undo = true } = {}) {
    return this.run(async () => {
      const receipt = await operation();
      if (receipt) { this.snack(receipt.description, undo ? receipt.undo : null); this.onSaved(); }
      if (close) this.finishClose();
    }, { closeDetail: close });
  }
  snack(text, undo = null) {
    clearTimeout(this.snackTimer); this.undo = undo; this.undoUntil = this.now() + 5000;
    this.$('task-snack-text').textContent = text; this.$('task-snack-text').setAttribute('title', text); this.$('task-undo').hidden = !undo; this.$('task-snackbar').hidden = false;
    this.snackTimer = setTimeout(() => this.hideSnack(), 5000);
  }
  hideSnack() { this.$('task-snackbar').hidden = true; this.undo = null; clearTimeout(this.snackTimer); }
  saveUI() { this.source.saveUI(this.ui).catch(error => this.snack(this.message(error))); }
  entered() { this.main.scrollTop = this.ui.scrollTop || 0; }
  savePosition() {
    if (!this.$('page-tasks').hidden) { clearTimeout(this.scrollTimer); this.ui.scrollTop = this.main.scrollTop; this.saveUI(); }
  }
  async leave() {
    clearTimeout(this.scrollTimer); this.ui.scrollTop = this.main.scrollTop; this.saveUI();
    const okay = await this.run(async () => {}, { closeDetail: true }); if (okay && this.sheet.open) this.finishClose(); return okay;
  }
  parsed() {
    const snapshot = this.source.snapshot();
    if (!snapshot.today) return { title: this.$('task-quick').value.trim(), date: null, weekOf: null, time: '', priority: null };
    const parsed = parseQuick(this.$('task-quick').value, snapshot.today);
    if (this.suppressed?.has('date')) { parsed.date = null; parsed.weekOf = null; parsed.time = ''; }
    if (this.suppressed?.has('time')) parsed.time = '';
    if (this.suppressed?.has('priority')) parsed.priority = null;
    return parsed;
  }
  preview() {
    const box = this.$('task-parse'); box.replaceChildren();
    const parsed = this.parsed();
    for (const [key, label] of [['date', parsed.date ? dateText(parsed.date, this.source.snapshot().today, { fullDate: true }) : (parsed.weekOf ? dateText(parsed.weekOf, this.source.snapshot().today, { fullDate: true }) + ' 所在周内' : '')], ['time', parsed.time], ['priority', parsed.priority === null ? '' : PRIORITIES[parsed.priority]]]) {
      if (!label) continue;
      box.append(this.button(label + ' ×', '去掉新任务的' + (key === 'date' ? '日期' : key === 'time' ? '时间' : '优先级') + '：' + label, () => { this.suppressed ||= new Set(); this.suppressed.add(key); this.preview(); }, 'parse-chip'));
    }
    if (!parsed.date && !parsed.weekOf) box.append(this.el('span', '放入未安排事项', 'caption'));
    // T29：明确展示真正保存的标题，尤其日期/时间/优先级片段被剥离时。
    if (parsed.title !== this.$('task-quick').value.trim()) box.append(this.el('span', '标题：' + parsed.title, 'caption parse-title'));
  }
  async add() {
    if (this.quickComposing) return;
    const text = this.$('task-quick').value;
    await this.perform(async () => {
      const receipt = await this.actions.add(this.parsed());
      if (this.$('task-quick').value === text) this.$('task-quick').value = '';
      this.suppressed = new Set(); this.preview(); return receipt;
    });
  }
  render() {
    if (this.destroyed) return;
    if (this.pointerDown || this.pointerSettling) { this.refreshQueued = true; return; }
    const snapshot = this.source.snapshot(); this.snapshot = snapshot;
    const unlocked = snapshot.joined && Boolean(snapshot.timeZone);
    this.$('task-join-tip').hidden = unlocked;
    this.$('task-join-tip').textContent = snapshot.joined ? '请先在设置里选择软件时区。' : '先在设置里连接并完成第一次同步';
    this.$('task-quick').disabled = !unlocked; this.$('task-add').disabled = !unlocked;
    this.$('demo-badge').hidden = !snapshot.demo;
    this.$('task-zone-card').hidden = !snapshot.timeZoneUnknown;
    this.$('task-zone-tip').textContent = snapshot.timeZoneUnknown ? '电脑的软件时区是“' + snapshot.timeZoneUnknown + '”。' + (snapshot.timeZone ? '当前对应 ' + snapshot.timeZone + '，可在这里调整。' : '请选对应地区。未选择前不会猜测日期。') : '';
    if (snapshot.timeZoneUnknown && snapshot.timeZone && this.document.activeElement !== this.$('task-zone')) this.$('task-zone').value = snapshot.timeZone;
    this.$('task-count').textContent = snapshot.joined ? String((snapshot.planner.tasks || []).filter(t => !t.done && !t.trashedAt).length) + ' 未完成' : '';
    for (const mode of ['time', 'project']) this.$('group-' + mode).setAttribute('aria-pressed', String(mode === this.ui.mode));
    const conflicts = snapshot.conflicts.filter(c => c.taskId && !c.hiddenByDeletion);
    this.$('task-conflicts').hidden = !snapshot.joined || !conflicts.length;
    this.$('task-conflicts').textContent = conflicts.length ? '有 ' + conflicts.length + ' 处两边都改过 · 点此查看' : '';
    const list = this.$('task-list'); list.replaceChildren();
    const groups = snapshot.joined && snapshot.today ? visibleGroups(groupTasks(snapshot.planner, snapshot.today, this.ui.mode), this.ui.expanded, this.limits) : [];
    this.groups = groups;
    this.$('task-empty').hidden = !snapshot.joined || groups.some(g => g.tasks.some(t => !t.done));
    for (const group of groups) {
      const section = this.el('div', '', 'task-group');
      const header = this.button((group.open ? '▾ ' : '▸ ') + group.title + ' · ' + group.tasks.length, (group.open ? '收起' : '展开') + group.title + '，' + group.tasks.length + '项', () => {
        this.ui.expanded[group.key] = !group.open; this.render(); this.saveUI();
      }, 'group-heading');
      header.setAttribute('aria-expanded', String(group.open)); section.append(header);
      // 折叠组只生成分组头，完全不调用 row()。
      if (group.open) {
        for (const task of group.visible) section.append(this.row(task));
        if (group.visible.length < group.tasks.length) section.append(this.button('再显示 50 条（剩余 ' + (group.tasks.length - group.visible.length) + '）', '再显示' + group.title + '的50条任务', () => { this.limits[group.key] = (this.limits[group.key] || 50) + 50; this.ui.limits = { ...this.limits }; this.render(); this.saveUI(); }, 'load-more secondary'));
      }
      list.append(section);
    }
    this.preview();
    if (this.sheet.open && this.sheetMode === 'detail') this.updateDetail();
  }
  projectName(task) { return projectTree(this.snapshot.planner.projects).find(p => p.id === task.project)?.path || (this.snapshot.planner.projects || []).find(p => p.id === task.project)?.name || '无项目'; }
  row(task) {
    const article = this.el('article', '', 'task-item'); article.dataset.taskId = task.id;
    const line = this.el('div', '', 'task-row');
    const label = task.title + '，' + this.projectName(task) + '，' + whenText(task, this.snapshot.today) + '，' + PRIORITIES[task.priority || 0];
    const check = this.button(abandoned(task) ? '↺' : task.done ? '✓' : '○', (abandoned(task) ? '恢复任务：' : task.done ? '取消完成任务：' : '完成任务：') + label, () => this.perform(() => this.actions.toggle(task.id)), 'task-check priority-' + (task.priority || 0));
    check.textContent = ''; check.append(this.el('span', abandoned(task) ? '↺' : task.done ? '✓' : '○', 'check-symbol'), this.el('span', ['无', '低', '中', '高'][task.priority || 0], 'priority-word'));
    check.setAttribute('role', 'checkbox'); check.setAttribute('aria-checked', String(Boolean(task.done)));
    line.append(check);
    const open = this.button('', '查看任务详情：' + label, () => this.openDetail(task.id), 'task-open');
    const title = this.el('span', task.title, 'task-title' + (task.done && !abandoned(task) ? ' is-done' : '')); open.append(title);
    const details = [this.ui.mode === 'time' ? this.projectName(task) : '', whenText(task, this.snapshot.today), PRIORITIES[task.priority || 0], task.notes ? '有备注' : '', repeating(task) ? '重复' : ''];
    if ((task.steps || []).length) details.push('步骤 ' + task.steps.filter(s => s.done).length + '/' + task.steps.length);
    if (task.doneAt) details.push((abandoned(task) ? '放弃于 ' : '完成于 ') + wallText(task.doneAt, this.snapshot.today));
    const meta = this.el('span', details.filter(Boolean).join(' · '), 'task-meta' + (overdue(task, this.snapshot.today) ? ' error-text' : '')); open.append(meta);
    if (abandoned(task)) open.append(this.el('span', '原因：' + (task.abandonReason || '未填写原因'), 'task-reason'));
    if (this.snapshot.conflicts.some(c => c.taskId === task.id)) { article.className += ' has-conflict'; open.append(this.el('span', '两边都改过 · 点开确认', 'conflict-label')); }
    line.append(open);
    if ((task.steps || []).length) {
      const expanded = this.openSteps.has(task.id);
      const steps = this.button(task.steps.filter(s => s.done).length + '/' + task.steps.length + (expanded ? ' ▴' : ' ▾'), (expanded ? '收起' : '展开') + '任务步骤：' + task.title, () => { if (expanded) this.openSteps.delete(task.id); else this.openSteps.add(task.id); this.render(); }, 'task-step-toggle');
      steps.setAttribute('aria-expanded', String(expanded)); line.append(steps);
    }
    line.append(this.button('⋯', '更多操作：' + task.title, () => this.openMenu(task.id), 'task-more')); article.append(line);
    if (this.openSteps.has(task.id)) {
      const steps = this.el('div', '', 'inline-steps');
      for (const step of task.steps || []) {
        const button = this.button('', (step.done ? '取消完成步骤：' : '完成步骤：') + step.text + (step.date ? '，' + dateText(step.date, this.snapshot.today) : ''), () => this.perform(() => this.actions.step(task.id, step.id, 'toggle')), 'inline-step');
        button.setAttribute('role', 'checkbox'); button.setAttribute('aria-checked', String(Boolean(step.done)));
        button.append(this.el('span', step.done ? '☑' : '□', 'step-symbol'), this.el('span', step.text + (step.date ? ' · ' + dateText(step.date, this.snapshot.today) : ''), 'step-text'));
        steps.append(button);
      }
      article.append(steps);
    }
    return article;
  }
  task(id) { return (this.source.snapshot().planner.tasks || []).find(t => t.id === id); }
  async showSheet(title, mode, id) {
    if (!(await this.run(async () => {}, { closeDetail: true }))) return false;
    this.returnFocus = this.sheet.open ? this.returnFocus : this.document.activeElement;
    this.sheetMode = mode; this.selected = id; this.$('task-sheet-title').textContent = title;
    this.$('task-save-status').textContent = ''; this.$('task-sheet-body').replaceChildren();
    this.inputs.clear(); this.stepRows.clear();
    this.sheet.append(this.$('task-snackbar'));
    if (!this.sheet.open) this.sheet.showModal();
    return true;
  }
  finishClose() {
    this.sheet.close(); this.main.parentNode.append(this.$('task-snackbar')); this.selected = null; this.sheetMode = null;
    // 列表刚刷新可能已移走原按钮，回到新行或页头，避免焦点落到 body。
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    else this.$('title-tasks').focus({ preventScroll: true });
  }
  async closeSheet() { const okay = await this.run(async () => {}, { closeDetail: true }); if (okay) this.finishClose(); }
  trapFocus(event) {
    if (event.key === 'Escape') { event.preventDefault(); this.closeSheet(); return; }
    if (event.key !== 'Tab') return;
    const visible = node => { for (let p = node; p && p !== this.sheet; p = p.parentNode) if (p.hidden) return false; return !node.disabled && node.tabIndex !== -1; };
    const nodes = [...this.sheet.querySelectorAll('button, input, textarea, select, [tabindex]')].filter(visible);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && this.document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && this.document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  field(parent, name, label, type, value, save, readonly = false) {
    const id = 'task-detail-' + name, wrapper = this.el('div', '', 'detail-field'), title = this.el('label', label); title.setAttribute('for', id);
    const input = this.el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input'); input.id = id;
    if (type !== 'textarea' && type !== 'select') input.type = type;
    input.value = value ?? ''; input.disabled = readonly; input.setAttribute('aria-label', label); input.dataset.field = name;
    wrapper.append(title, input); parent.append(wrapper); this.inputs.set(name, input);
    if (save) this.bindInput(input, save);
    return input;
  }
  bindInput(input, save) {
    input.savedValue = input.value; input.baseToken = this.source.snapshot().editToken;
    input.addEventListener('focus', () => {
      if (!this.pending.has(input)) input.baseToken = this.source.snapshot().editToken;
      input.scrollIntoView?.({ block: 'center' });
    });
    const stage = () => {
      if (input.value === input.savedValue) { clearTimeout(this.pending.get(input)?.timer); this.pending.delete(input); return; }
      clearTimeout(this.pending.get(input)?.timer);
      const entry = { value: input.value, save, token: input.baseToken };
      if (!input.composing) entry.timer = setTimeout(() => this.flushInput(input).catch(error => { this.$('task-save-status').textContent = this.message(error); this.snack(this.message(error)); }), 300);
      this.pending.set(input, entry); this.$('task-save-status').textContent = '正在输入，稍后自动保存…';
    };
    input.addEventListener('compositionstart', () => { input.composing = true; clearTimeout(this.pending.get(input)?.timer); });
    input.addEventListener('compositionend', () => { input.composing = false; stage(); });
    input.addEventListener('input', stage); input.addEventListener('change', stage);
    input.addEventListener('blur', () => this.flushInput(input).then(() => { if (this.sheet.open && this.sheetMode === 'detail') this.updateDetail(); }).catch(error => { this.$('task-save-status').textContent = this.message(error); this.snack(this.message(error)); }));
  }
  async flushInput(input) {
    if (input.saving) { await input.saving; if (this.pending.has(input)) return this.flushInput(input); return; }
    const entry = this.pending.get(input); if (!entry || input.composing) return;
    clearTimeout(entry.timer);
    const saving = (async () => {
      const receipt = await entry.save(entry.value, entry.token);
      if (receipt?.undo && ['date', 'time'].includes(input.dataset.field)) this.snack('已改期：' + (this.task(this.selected)?.title || '任务'), receipt.undo);
      input.savedValue = entry.value; input.baseToken = receipt?.editToken || this.source.snapshot().editToken;
      if (this.pending.get(input) === entry) this.pending.delete(input);
      else if (this.pending.has(input)) this.pending.get(input).token = input.baseToken;
      this.$('task-save-status').textContent = '已存本机'; if (receipt) this.onSaved();
    })();
    input.saving = saving;
    try { await saving; } finally { input.saving = null; }
  }
  hasStepDraft() { return Boolean(this.sheetMode === 'detail' && this.inputs.get('new-steps')?.value.trim()); }
  saveStepDraft() {
    if (this.sheetMode !== 'detail') return;
    const input = this.inputs.get('new-steps'); if (!input) return;
    clearTimeout(this.draftTimer);
    if (input.value) this.ui.stepDrafts[this.selected] = input.value; else delete this.ui.stepDrafts[this.selected];
    this.saveUI();
  }
  async commitStepDraft(closing = false) {
    if (this.stepFlush) { await this.stepFlush; return; }
    if (!this.hasStepDraft()) return;
    const input = this.inputs.get('new-steps'), value = input.value, id = this.selected;
    if (input.composing) throw new DataError('输入法还在组织文字，请完成输入后再关闭。');
    this.stepFlush = (async () => {
      const receipt = await this.actions.addSteps(id, value);
      if (input.value === value) input.value = '';
      this.saveStepDraft();
      if (receipt) {
        this.snack(closing ? '已把未提交的文字添加为步骤：' + (this.task(id)?.title || '') : receipt.description, receipt.undo);
        this.onSaved();
      }
    })();
    try { await this.stepFlush; } finally { this.stepFlush = null; }
  }
  async flush({ commitSteps = false } = {}) {
    if ([...this.pending.keys()].some(input => input.composing) || this.inputs.get('new-steps')?.composing) throw new DataError('输入法还在组织文字，请完成输入后再关闭。');
    for (const input of this.pending.keys()) await this.flushInput(input);
    this.saveStepDraft();
    // T29：普通 flush/失焦只存草稿；关闭详情、切页或切换面板才补交并显示撤销。
    if (commitSteps) await this.commitStepDraft(true);
  }
  options(select, items, value) {
    select.replaceChildren();
    for (const [key, name] of items) { const option = this.el('option', name); option.value = String(key); select.append(option); }
    select.value = value ?? '';
  }
  projectOptions() { return [['', '无项目'], ...projectTree(this.snapshot.planner.projects).map(p => [p.id, p.path]), ...(this.snapshot.planner.projects || []).filter(p => p.archived).map(p => [p.id, p.name + '（已归档）'])]; }
  async openDetail(id) {
    const task = this.task(id); if (!task || !(await this.showSheet('任务详情', 'detail', id))) return;
    const body = this.$('task-sheet-body'), readonly = repeating(task) || this.snapshot.conflicts.some(c => c.taskId === id);
    this.conflictBox = this.el('div'); body.append(this.conflictBox); this.conflictSignature = '';
    this.readOnlyNote = this.el('p', '', 'caption'); body.append(this.readOnlyNote);
    const title = this.field(body, 'title', '任务标题', 'textarea', task.title, (title, baseToken) => this.actions.patch(id, { title }, { baseToken, undoable: false }), readonly);
    // 电脑版标题为单行输入；T29 回车完成输入，输入法选词期间不触发。
    title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && !title.composing && e.keyCode !== 229) { e.preventDefault(); title.blur(); } });
    const pair = this.el('div', '', 'field-pair'); body.append(pair);
    const date = this.field(pair, 'date', '日期', 'date', task.date, async (value, baseToken) => this.actions.schedule(id, { date: value || null }, { baseToken, detailDate: true }), readonly);
    date.min = this.snapshot.today;
    this.field(pair, 'time', '时间', 'time', task.time, (time, baseToken) => this.actions.patch(id, { time }, { baseToken }), readonly || Boolean(task.endDate || task.endTime));
    this.scheduleInfo = this.el('p', '', 'caption'); body.append(this.scheduleInfo);
    const prio = this.field(body, 'priority', '优先级', 'select', task.priority || 0, (value, baseToken) => this.actions.patch(id, { priority: +value }, { baseToken, undoable: false }), readonly);
    this.options(prio, PRIORITIES.map((p, i) => [i, p]), task.priority || 0);
    const project = this.field(body, 'project', '所属项目', 'select', task.project, (value, baseToken) => this.actions.patch(id, { project: value || null }, { baseToken, undoable: false }), readonly);
    this.options(project, this.projectOptions(), task.project);
    this.field(body, 'notes', '备注', 'textarea', task.notes || '', (notes, baseToken) => this.actions.patch(id, { notes }, { baseToken, undoable: false }), readonly);
    this.stepsTitle = this.el('h3', '步骤'); this.stepsBox = this.el('div', '', 'detail-steps'); body.append(this.stepsTitle, this.stepsBox);
    const newSteps = this.field(body, 'new-steps', '添加步骤（粘贴多行自动拆开）', 'textarea', this.ui.stepDrafts[id] || '', null, readonly);
    newSteps.addEventListener('input', () => {
      clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => this.saveStepDraft(), 300);
    });
    newSteps.addEventListener('compositionstart', () => { newSteps.composing = true; });
    newSteps.addEventListener('compositionend', () => { newSteps.composing = false; this.saveStepDraft(); });
    newSteps.addEventListener('blur', () => this.saveStepDraft());
    const addSteps = () => this.run(() => this.commitStepDraft());
    newSteps.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !newSteps.composing && e.keyCode !== 229) { e.preventDefault(); addSteps(); } });
    newSteps.addEventListener('paste', e => {
      const text = e.clipboardData?.getData('text/plain');
      if (text && /[\r\n]/.test(text)) {
        e.preventDefault();
        const start = newSteps.selectionStart ?? newSteps.value.length, end = newSteps.selectionEnd ?? start;
        newSteps.value = newSteps.value.slice(0, start) + text + newSteps.value.slice(end); addSteps();
      }
    });
    const add = this.button('添加步骤', '添加步骤', addSteps); add.disabled = readonly; this.addStepButton = add; body.append(add);
    this.stats = this.el('p', '', 'caption detail-history'); body.append(this.stats);
    const actions = this.el('div', '', 'actions detail-actions');
    this.abandonButton = this.button('放弃任务…', '放弃任务', () => abandoned(this.task(id) || {}) ? this.perform(() => this.actions.restore(id), { close: true }) : this.openAbandon(id), 'danger-button');
    const remove = this.button('删除任务', '删除任务', () => this.perform(() => this.actions.remove(id), { close: true }), 'danger-button');
    remove.disabled = readonly; this.deleteButton = remove; actions.append(this.abandonButton, remove); body.append(actions, this.button('更多操作（改期、移动等）', '更多任务操作', () => this.openMenu(id))); this.updateDetail(); this.$('task-sheet-close').focus();
  }
  updateDetail() {
    if (this.pointerDown || this.pointerSettling) { this.detailQueued = true; return; }
    const task = this.task(this.selected); if (!task) { this.$('task-save-status').textContent = '任务在另一处已删除；正在输入的文字仍保留，保存会保留两份供选择。'; return; }
    const conflict = this.snapshot.conflicts.some(c => c.taskId === task.id), readonly = repeating(task) || conflict;
    this.readOnlyNote.textContent = repeating(task) ? REPEAT_READONLY : conflict ? '请先在上方选择保留哪一份，再编辑任务。正在输入的文字会继续保留。' : '';
    this.readOnlyNote.hidden = !readonly;
    this.addStepButton.disabled = readonly; this.deleteButton.disabled = readonly;
    if (this.document.activeElement !== this.inputs.get('new-steps')) this.inputs.get('new-steps').disabled = readonly;
    for (const key of ['title', 'date', 'time', 'priority', 'project', 'notes']) {
      const input = this.inputs.get(key); if (!input || this.document.activeElement === input || this.pending.has(input)) continue;
      input.disabled = readonly || (key === 'time' && Boolean(task.endDate || task.endTime));
      const value = task[key] ?? '';
      if (key === 'project') this.options(input, this.projectOptions(), value); else input.value = String(value);
      input.savedValue = input.value; input.baseToken = this.snapshot.editToken;
    }
    this.scheduleInfo.textContent = whenText(task, this.snapshot.today) + ((task.weekOf || task.monthOf || task.endDate || task.endTime) ? ' · 可在“更多操作”里整体改期；跨天跨度、周/月安排和时段细节请在电脑修改。' : '');
    this.abandonButton.textContent = abandoned(task) ? '恢复任务' : '放弃任务…';
    this.abandonButton.disabled = conflict || Boolean(task.done && !task.abandoned);
    // 重复任务的入口保留可点说明；其他属性全部只读。
    if (readonly) { this.abandonButton.disabled = false; }
    const focus = this.snapshot.focus[task.series || task.id] || { count: 0, minutes: 0 };
    this.stats.textContent = '预估：' + (task.estPomo || 0) + ' 个番茄 · 已专注 ' + focus.count + ' 个番茄（' + Math.round(focus.minutes) + ' 分钟）\n创建于 ' + wallText(task.created, this.snapshot.today) + (task.doneAt ? '\n' + (abandoned(task) ? '放弃于 ' : '完成于 ') + wallText(task.doneAt, this.snapshot.today) : '') + (task.remindTime ? '\n电脑提醒：' + task.remindTime + (task.remindOffset ? '，提前 ' + task.remindOffset + ' 天' : '') + '（手机不提醒）' : '') +
      ((task.abandonHistory || []).length ? '\n决策记录：\n' + task.abandonHistory.map(h => this.historyTime(h.at) + ' ' + (h.action === 'restored' ? '恢复' : '放弃') + (h.reason ? ' — ' + h.reason : '')).join('\n') : abandoned(task) ? '\n原因：' + (task.abandonReason || '未填写原因') : '');
    this.stepsTitle.textContent = '步骤 ' + (task.steps || []).filter(s => s.done).length + '/' + (task.steps || []).length;
    this.reconcileSteps(task, readonly); this.renderConflicts(task.id);
  }
  historyTime(at) {
    try { return wallText(wallTime(new Date(at).getTime(), this.snapshot.timeZone), this.snapshot.today); } catch { return at || ''; }
  }
  reconcileSteps(task, readonly) {
    const ids = new Set((task.steps || []).map(s => s.id));
    for (const [id, row] of this.stepRows) if (!ids.has(id) && this.document.activeElement !== row.input && !this.pending.has(row.input)) { row.node.remove(); this.stepRows.delete(id); }
    for (const step of task.steps || []) {
      let row = this.stepRows.get(step.id);
      if (!row) {
        const node = this.el('div', '', 'detail-step');
        const toggle = this.button('', '', () => this.perform(() => this.actions.step(task.id, step.id, 'toggle')), 'step-check');
        const input = this.el('input'); input.type = 'text'; input.value = step.text; input.setAttribute('aria-label', '步骤内容：' + step.text);
        this.bindInput(input, (text, baseToken) => this.actions.step(task.id, step.id, 'text', text, { baseToken, undoable: false }));
        const remove = this.button('×', '删除步骤：' + step.text, () => this.perform(() => this.actions.step(task.id, step.id, 'remove')), 'task-more');
        const editor = this.el('div', '', 'step-editor'), meta = this.el('span', '', 'step-date'); editor.append(input, meta);
        node.append(toggle, editor, remove); this.stepsBox.append(node); row = { node, toggle, input, remove, meta }; this.stepRows.set(step.id, row);
      }
      row.meta.textContent = (step.date ? '步骤日期：' + dateText(step.date, this.snapshot.today) + '（在电脑上修改）' : '') + (step.remindTime ? ' · 电脑提醒 ' + step.remindTime : ''); row.meta.hidden = !row.meta.textContent;
      row.toggle.textContent = step.done ? '☑' : '□'; row.toggle.setAttribute('aria-label', (step.done ? '取消完成步骤：' : '完成步骤：') + step.text);
      row.toggle.setAttribute('role', 'checkbox'); row.toggle.setAttribute('aria-checked', String(Boolean(step.done))); row.input.setAttribute('aria-description', step.date ? '步骤单独安排在 ' + dateText(step.date, this.snapshot.today) + '，日期请在电脑修改' : '步骤日期跟随任务'); if (this.document.activeElement !== row.input) row.input.disabled = readonly; row.toggle.disabled = readonly; row.remove.disabled = readonly;
      if (this.document.activeElement !== row.input && !this.pending.has(row.input)) { row.input.value = step.text; row.input.savedValue = step.text; row.input.baseToken = this.snapshot.editToken; }
    }
  }
  renderConflicts(id) {
    const conflicts = this.snapshot.conflicts.filter(c => c.taskId === id).sort((a, b) => (a.path[0] === 'entity' ? -1 : 0) - (b.path[0] === 'entity' ? -1 : 0));
    const signature = JSON.stringify(conflicts);
    if (signature === this.conflictSignature) return;
    this.conflictSignature = signature; this.conflictBox.replaceChildren();
    for (const conflict of conflicts) {
      const observed = this.snapshot.editToken, card = this.el('div', '', 'conflict-card');
      card.append(this.el('h3', conflict.deleteConflict ? '一边删除，一边修改' : '两边都改过，请选保留哪一份'));
      const live = conflict.candidates.filter(c => !c.deleted);
      const fields = [...new Set(live.flatMap(c => typeof c.value === 'object' && c.value ? Object.keys(c.value) : []))].filter(field => live.some(c => JSON.stringify(c.value?.[field]) !== JSON.stringify(live[0]?.value?.[field])));
      conflict.candidates.forEach((candidate, index) => {
        const version = this.el('div', '', 'conflict-version'); version.append(this.el('strong', candidate.deleted ? '删除的版本' : '版本 ' + (index + 1)));
        if (!candidate.deleted) {
          const value = candidate.value;
          if (value && typeof value === 'object') {
            const show = fields.length ? fields : Object.keys(value).filter(k => k !== 'id');
            for (const field of show) version.append(this.el('p', (FIELD_NAMES[field] || field) + '：' + this.displayValue(field, value[field]), 'conflict-value'));
          } else version.append(this.el('p', value === true ? '保留这条任务及其内容' : String(value), 'conflict-value'));
        }
        const text = conflict.deleteConflict ? candidate.deleted ? '确认删除' : conflict.path[0] === 'step' ? '保留步骤' : '保留任务' : candidate.deleted ? '确认删除' : '保留这一份（版本 ' + (index + 1) + '）';
        version.append(this.button(text, text, () => this.perform(() => this.resolveConflict(conflict.key, { branch: candidate.branch, observed }), { undo: false }), candidate.deleted ? 'danger-button' : 'secondary')); card.append(version);
      });
      if (conflict.both) card.append(this.button('两段都留着', '两段都留着，按页面版本顺序各占一段', () => this.perform(() => this.resolveConflict(conflict.key, { type: 'both', observed }), { undo: false })));
      this.conflictBox.append(card);
    }
  }
  async resolveConflict(key, choice) {
    await this.source.resolve(key, choice); this.onSaved(); this.conflictSignature = ''; this.snapshot = this.source.snapshot();
    if (!this.task(this.selected)) this.finishClose(); else this.updateDetail();
    this.snack('已处理两边都改过的内容');
  }
  displayValue(field, value) {
    if (['date', 'weekOf', 'endDate', 'monthOf'].includes(field) && value) return dateText(value, this.snapshot.today);
    if (['created', 'doneAt'].includes(field) && value) return wallText(value, this.snapshot.today);
    if (field === 'priority') return PRIORITIES[value] || String(value);
    if (field === 'project') return (this.snapshot.planner.projects || []).find(p => p.id === value)?.name || '无项目';
    if (field === 'abandonHistory' && Array.isArray(value)) return value.map(row => this.historyTime(row.at) + ' ' + (row.action === 'restored' ? '恢复' : '放弃') + '：' + (row.reason || '未填写原因')).join('\n');
    if (field === 'abandonPrevious' && value?.tasks?.[0]) return value.tasks[0].title + ' · ' + whenText(value.tasks[0], this.snapshot.today) + ' · ' + PRIORITIES[value.tasks[0].priority || 0];
    if (value === undefined) return '未设置'; if (value === null || value === '') return '未设置';
    if (typeof value === 'boolean') return value ? '是' : '否';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }
  async firstConflict() {
    const c = this.snapshot.conflicts.find(c => c.taskId && !c.hiddenByDeletion); if (!c) return;
    const group = this.groups.find(g => g.tasks.some(t => t.id === c.taskId));
    if (group) { this.ui.expanded[group.key] = true; this.limits[group.key] = Math.max(50, Math.ceil((group.tasks.findIndex(t => t.id === c.taskId) + 1) / 50) * 50); this.render(); this.saveUI(); }
    await this.openDetail(c.taskId); this.conflictBox?.scrollIntoView?.({ block: 'start' });
  }
  async openMenu(id) {
    const task = this.task(id); if (!task || !(await this.showSheet('任务操作', 'menu', id))) return;
    const body = this.$('task-sheet-body'); body.append(this.el('p', task.title, 'sheet-task-title'));
    if (repeating(task)) { body.append(this.el('p', REPEAT_READONLY)); this.$('task-sheet-close').focus(); return; }
    const dates = this.el('div', '', 'quick-dates'); body.append(this.el('h3', '改期'), dates);
    const today = this.snapshot.today, monday = weekStart(today);
    for (const [text, date, weekOf] of [['今天', today, null], ['明天', addDays(today, 1), null], ['下周一', addDays(monday, 7), null], ['本周内', null, monday], ['清除日期', null, null]]) dates.append(this.button(text, text, () => this.perform(() => this.actions.schedule(id, { date, weekOf }), { close: true })));
    dates.append(this.button('指定日期…', '选择指定日期', () => specific.focus()));
    const specific = this.field(body, 'specific-date', '指定日期', 'date', task.date || today); specific.min = today;
    body.append(this.button('安排到指定日期', '安排到指定日期', () => this.perform(() => this.actions.schedule(id, { date: specific.value }), { close: true })));
    body.append(this.el('h3', '优先级')); const priorities = this.el('div', '', 'priority-options');
    PRIORITIES.forEach((label, priority) => { const b = this.button(label, label, () => this.perform(() => this.actions.patch(id, { priority }), { close: true })); b.setAttribute('aria-pressed', String(priority === (task.priority || 0))); priorities.append(b); }); body.append(priorities);
    const project = this.field(body, 'move-project', '移动到项目', 'select', task.project); this.options(project, this.projectOptions(), task.project);
    project.addEventListener('change', () => this.perform(() => this.actions.patch(id, { project: project.value || null }), { close: true }));
    body.append(this.button('移动到所选项目', '移动到所选项目', () => this.perform(() => this.actions.patch(id, { project: project.value || null }), { close: true })));
    const actions = this.el('div', '', 'actions detail-actions');
    const abandon = this.button(abandoned(task) ? '恢复任务' : '放弃任务…', abandoned(task) ? '恢复任务' : '放弃任务', () => abandoned(task) ? this.perform(() => this.actions.restore(id), { close: true }) : this.openAbandon(id), 'danger-button');
    abandon.disabled = Boolean(task.done && !abandoned(task)); actions.append(abandon, this.button('删除任务', '删除任务', () => this.perform(() => this.actions.remove(id), { close: true }), 'danger-button')); body.append(actions);
    dates.querySelector('button')?.focus();
  }
  async openAbandon(id) {
    const task = this.task(id); if (!task) return;
    if (repeating(task)) { this.snack(REPEAT_READONLY); return; }
    if (!(await this.showSheet('放弃这件任务', 'abandon', id))) return;
    const body = this.$('task-sheet-body'); body.append(this.el('p', task.title), this.el('p', '放弃不是删除，以后可以回看或恢复。', 'caption'));
    let quick = ''; const reasons = this.el('div', '', 'quick-dates abandon-reasons'); body.append(reasons);
    for (const reason of ABANDON_REASONS) { const button = this.button(reason, reason, () => {
      quick = quick === reason ? '' : reason;
      for (const b of reasons.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.textContent === quick));
    }); button.setAttribute('aria-pressed', 'false'); reasons.append(button); }
    const detail = this.field(body, 'reason', '具体原因（可选）', 'textarea', '');
    body.append(this.button('确认放弃', '确认放弃任务并保存原因', () => this.perform(() => this.actions.abandon(id, quick + (quick && detail.value.trim() ? '：' : '') + detail.value.trim()), { close: true }), 'danger-button'));
    reasons.querySelector('button')?.focus();
  }
  destroy() { this.destroyed = true; clearTimeout(this.pointerTimer); this.document.removeEventListener?.('pointerdown', this.onPointerDown, true); this.document.removeEventListener?.('pointerup', this.onPointerEnd, true); this.document.removeEventListener?.('pointercancel', this.onPointerEnd, true); this.unsubscribe(); clearInterval(this.dayTimer); clearTimeout(this.draftTimer); clearTimeout(this.scrollTimer); clearTimeout(this.snackTimer); for (const e of this.pending.values()) clearTimeout(e.timer); }
}
