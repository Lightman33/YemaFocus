// 独立、稳定的感想编辑节点；收到同步刷新也不替换正在输入的文字或光标。
import { DataError } from './datasource.js';
import { StoreError } from './store.js';
import { canJournal, habitConflicts, journalPhotoCount } from './habit-model.js';

const dateConflict = (snapshot, id, day) => habitConflicts(snapshot, id).some(c => c.path[0] === 'habit-journal' && c.path[2] === day);
const chooseVersion = '这一天两边都改过，请先关闭并选择保留的版本。';

export class HabitJournal {
  constructor({ document, root, actions, source, onSaved, returnFocus }) {
    this.source = source; this.actions = actions; this.onSaved = onSaved; this.returnFocus = returnFocus;
    const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
    this.dialog = el('dialog'); this.dialog.className = 'habit-journal-dialog';
    this.dialog.setAttribute('aria-labelledby', 'habit-journal-title');
    this.title = el('h2'); this.title.id = 'habit-journal-title';
    const dateLabel = el('label', '日期'); dateLabel.setAttribute('for', 'habit-journal-date');
    this.date = el('input'); this.date.type = 'date'; this.date.id = 'habit-journal-date';
    const label = el('label', '一句感想'); label.setAttribute('for', 'habit-journal-note');
    this.input = el('textarea'); this.input.id = 'habit-journal-note'; this.input.rows = 4; this.input.setAttribute('aria-label', '习惯感想');
    this.input.autofocus = true;
    this.photos = el('p'); this.photos.className = 'caption'; this.photos.hidden = true;
    this.status = el('p'); this.status.className = 'caption'; this.status.setAttribute('role', 'status');
    const button = (text, className, action) => {
      const node = el('button', text); node.type = 'button'; node.className = className;
      node.addEventListener('click', action); return node;
    };
    this.save = button('保存并关闭', 'primary', () => { this.close().catch(error => this.error(error)); });
    this.cancel = button('取消', 'secondary', () => this.requestCancel());
    this.controls = el('div'); this.controls.className = 'actions';
    this.controls.append(this.cancel, this.save);
    this.confirmation = el('div'); this.confirmation.hidden = true;
    const prompt = el('p', '要放弃这一天尚未保存的改动吗？');
    prompt.id = 'habit-journal-discard-prompt';
    const confirmActions = el('div'); confirmActions.className = 'actions';
    this.continueEditing = button('继续编辑', 'secondary', () => this.resumeEditing());
    this.continueEditing.setAttribute('aria-describedby', prompt.id);
    this.discard = button('放弃改动', 'danger-button', () => {
      if (!this.confirmation.hidden) this.finish();
    });
    confirmActions.append(this.continueEditing, this.discard);
    this.confirmation.append(prompt, confirmActions);
    this.dialog.append(this.title, dateLabel, this.date, label, this.input, this.photos, this.status, this.controls, this.confirmation);
    root.append(this.dialog);
    this.date.addEventListener('change', () => { this.changeDay(this.date.value).catch(error => this.error(error)); });
    this.input.addEventListener('input', () => { this.dirty = this.input.value !== this.savedValue; });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.dirty = this.input.value !== this.savedValue; });
    this.dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (this.confirmation.hidden) this.requestCancel(); else this.resumeEditing();
    });
  }
  open(habit, snapshot, day = snapshot.today, focusKey = 'write:' + habit.id) {
    if (this.dialog.open) return;
    this.id = habit.id; this.composing = false; this.focusKey = focusKey;
    this.title.textContent = (habit.name || '未命名习惯') + ' · 记一笔';
    this.loadDay(habit, day, snapshot);
    this.dialog.showModal(); (this.input.disabled ? this.date : this.input).focus();
  }
  loadDay(habit, day, snapshot) {
    this.day = day; this.baseToken = snapshot.editToken; this.dirty = false;
    this.date.min = habit.start || ''; this.date.max = snapshot.today; this.date.value = day;
    const entry = habit.journal?.[day];
    this.savedValue = typeof entry?.note === 'string' ? entry.note : '';
    this.input.value = this.savedValue; this.input.disabled = dateConflict(snapshot, habit.id, day);
    const count = journalPhotoCount(entry);
    this.photos.hidden = !count;
    this.photos.textContent = count ? '这一天有 ' + count + ' 张照片，请在电脑上查看。' : '';
    this.status.textContent = this.input.disabled ? chooseVersion : '切换日期或离开时会先保存到本机。';
  }
  async changeDay(day) {
    if (!this.dialog.open || day === this.day) return;
    // 保存完成前，日期和文字都指向原来的那一天。保存失败可继续输入或重试。
    this.date.value = this.day;
    if (this.saving || !this.confirmation.hidden) return;
    const readDay = () => {
      const snapshot = this.source.snapshot();
      const habit = (snapshot.planner.habits || []).find(h => h.id === this.id && !h.archived);
      if (!habit) throw new DataError('习惯已删除或归档；输入仍保留，请在电脑上核实。');
      if (!canJournal(habit, day, snapshot.today)) throw new DataError('请选择从习惯开始当天到今天之间的日期。');
      return { habit, snapshot };
    };
    readDay();
    await this.flush();
    if (!this.dialog.open) return;
    if (this.dirty || this.composing) throw new DataError('刚才的输入仍保留，请完成输入后再切换日期。');
    const { habit, snapshot } = readDay();
    this.loadDay(habit, day, snapshot);
  }
  error(error) { this.status.textContent = error instanceof DataError || error instanceof StoreError ? error.message : '感想尚未保存，输入仍保留。请稍后重试。'; }
  async flush() {
    if (this.saving) return this.saving;
    if (!this.dialog.open) return;
    if (!this.confirmation.hidden) throw new DataError('请先选择继续编辑或放弃感想改动。');
    if (this.composing) throw new DataError('输入法还在选词，请完成输入后再保存或切页。');
    if (!this.dirty) return;
    const value = this.input.value, id = this.id, day = this.day, baseToken = this.baseToken;
    this.save.disabled = this.date.disabled = this.cancel.disabled = true;
    this.saving = (async () => {
      try {
        const receipt = await this.actions.saveJournal(id, day, value, { baseToken });
        if (receipt) this.baseToken = receipt.editToken;
        this.savedValue = value; this.dirty = this.input.value !== value;
        this.status.textContent = '感想已存本机。'; this.onSaved();
      } catch (error) { this.error(error); throw error; }
      finally { this.save.disabled = this.date.disabled = this.cancel.disabled = false; this.saving = null; }
    })();
    return this.saving;
  }
  async close() {
    await this.flush();
    // 保存期间仍可输入；新输入也须落盘后才关闭，不能悄悄丢掉最后几个字。
    if (this.dirty) await this.flush();
    if (this.dirty) throw new DataError('还有输入尚未保存，请稍候再关闭。');
    this.finish();
  }
  requestCancel() {
    if (!this.dialog.open || this.saving) return;
    if (!this.dirty && !this.composing) { this.finish(); return; }
    this.controls.hidden = true;
    this.confirmation.hidden = false;
    this.date.disabled = true;
    this.continueEditing.focus();
  }
  resumeEditing() {
    this.controls.hidden = false;
    this.confirmation.hidden = true;
    this.date.disabled = false;
    (this.input.disabled ? this.date : this.input).focus();
  }
  finish() {
    this.dirty = this.composing = false;
    this.controls.hidden = false;
    this.confirmation.hidden = true;
    this.date.disabled = false;
    this.dialog.close(); this.returnFocus(this.id, this.focusKey);
  }
  refresh(snapshot) {
    if (!this.dialog.open) return;
    const habit = (snapshot.planner.habits || []).find(h => h.id === this.id);
    if (snapshot.today && this.date.max !== snapshot.today) this.date.max = snapshot.today;
    if (habit && this.date.min !== (habit.start || '')) this.date.min = habit.start || '';
    if (!habit || habit.archived) this.status.textContent = '习惯已删除或归档；输入仍保留，请在电脑上核实。';
    else if (dateConflict(snapshot, this.id, this.day)) this.status.textContent = this.input.disabled ? chooseVersion : '这一天两边都改过。当前输入会独立保存，请随后选择保留的版本。';
    else if (this.input.disabled) this.status.textContent = '冲突已处理。请重新选择日期或打开“记一笔”后编辑。';
  }
  destroy() { if (this.dialog.open) this.dialog.close(); }
}
