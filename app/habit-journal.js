// 独立、稳定的感想编辑节点；收到同步刷新也不替换正在输入的文字或光标。
import { DataError } from './datasource.js';
import { StoreError } from './store.js';
import { habitConflicts } from './habit-model.js';

export class HabitJournal {
  constructor({ document, root, actions, source, onSaved, returnFocus }) {
    this.document = document; this.source = source; this.actions = actions; this.onSaved = onSaved; this.returnFocus = returnFocus;
    const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
    this.dialog = el('dialog'); this.dialog.className = 'habit-journal-dialog';
    this.dialog.setAttribute('aria-labelledby', 'habit-journal-title');
    this.title = el('h2'); this.title.id = 'habit-journal-title';
    const label = el('label', '一句感想'); label.setAttribute('for', 'habit-journal-note');
    this.input = el('textarea'); this.input.id = 'habit-journal-note'; this.input.rows = 4; this.input.setAttribute('aria-label', '习惯感想');
    this.status = el('p'); this.status.className = 'caption'; this.status.setAttribute('role', 'status');
    this.save = el('button', '保存并关闭'); this.save.type = 'button'; this.save.className = 'primary';
    this.dialog.append(this.title, label, this.input, this.status, this.save); root.append(this.dialog);
    this.input.addEventListener('input', () => { this.dirty = this.input.value !== this.savedValue; });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.dirty = this.input.value !== this.savedValue; });
    this.save.addEventListener('click', () => { this.close().catch(error => this.error(error)); });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close().catch(error => this.error(error)); });
  }
  open(habit, day, snapshot) {
    if (this.dialog.open) return;
    this.id = habit.id; this.day = day; this.baseToken = snapshot.editToken; this.dirty = false; this.composing = false;
    this.savedValue = typeof habit.journal?.[day]?.note === 'string' ? habit.journal[day].note : '';
    this.input.value = this.savedValue; this.title.textContent = habit.name + ' · ' + day;
    this.status.textContent = '关闭或切页时会先保存到本机。'; this.dialog.showModal(); this.input.focus();
  }
  error(error) { this.status.textContent = error instanceof DataError || error instanceof StoreError ? error.message : '感想尚未保存，输入仍保留。请稍后重试。'; }
  async flush() {
    if (this.saving) return this.saving;
    if (!this.dialog.open || !this.dirty) return;
    if (this.composing) throw new DataError('输入法还在选词，请完成输入后再保存或切页。');
    const value = this.input.value, id = this.id, day = this.day, baseToken = this.baseToken;
    this.save.disabled = true;
    this.saving = (async () => {
      try {
        const receipt = await this.actions.saveJournal(id, day, value, { baseToken });
        if (receipt) this.baseToken = receipt.editToken;
        this.savedValue = value; this.dirty = this.input.value !== value;
        this.status.textContent = '感想已存本机。'; this.onSaved();
      } catch (error) { this.error(error); throw error; }
      finally { this.save.disabled = false; this.saving = null; }
    })();
    return this.saving;
  }
  async close() {
    await this.flush();
    // 保存期间仍可输入；新输入也须落盘后才关闭，不能悄悄丢掉最后几个字。
    if (this.dirty) await this.flush();
    if (this.dirty) throw new DataError('还有输入尚未保存，请稍候再关闭。');
    this.dialog.close(); this.returnFocus(this.id);
  }
  refresh(snapshot) {
    if (!this.dialog.open) return;
    const habit = (snapshot.planner.habits || []).find(h => h.id === this.id);
    if (!habit || habit.archived) this.status.textContent = '习惯已删除或归档；输入仍保留，请在电脑上核实。';
    else if (habitConflicts(snapshot, this.id).some(c => c.path[0] === 'habit-journal' && c.path[2] === this.day)) this.status.textContent = '这一天两边都改过。当前输入会独立保存，请随后选择保留的版本。';
  }
  destroy() { if (this.dialog.open) this.dialog.close(); }
}
