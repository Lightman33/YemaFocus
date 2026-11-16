/**
 * 不依赖 DOM、存储或合并实现。subscribe(listener) 立即推送一份独立快照，返回退订函数。
 * localSaved(revision) 只能在本机事务完成后调用；uploaded(revision) 只能在 PUT 成功后调用；
 * peerMerged(revision) 必须有对方快照的明确确认，不能用“读通目录”代替。
 * revision 是本机单调递增的非负整数。迟到的上传/确认不覆盖较新的本机状态。
 * 四种事实独立保存：本机保存、上传、对方确认、冲突；离线和错误为附加状态。
 * 此模块只在内存中显示进度；刷新后不会假称已上传。持久化确认由后续同步层负责。
 */
export class SyncState {
  #listeners = new Set();
  #value = { localRevision: null, uploadedRevision: null, peerRevision: null, conflicts: 0, offline: false, error: null };

  snapshot() {
    const state = { ...this.#value, error: this.#value.error ? { ...this.#value.error } : null };
    state.localSaved = state.localRevision !== null;
    state.uploaded = state.localSaved && state.uploadedRevision !== null && state.uploadedRevision >= state.localRevision;
    state.peerMerged = state.uploaded && state.peerRevision !== null && state.peerRevision >= state.localRevision;
    state.labels = [
      state.localSaved ? '已存本机' : '尚未保存本机数据',
      state.uploaded ? '已上传' : '尚未上传',
      state.peerMerged ? '对方已合并' : '尚未收到对方合并确认',
      state.conflicts ? '有冲突待处理（' + state.conflicts + ' 处）' : '没有已知冲突'
    ];
    return state;
  }
  #emit() { for (const listener of this.#listeners) listener(this.snapshot()); }
  #revision(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('同步版本必须是非负整数。');
  }
  localSaved(revision) {
    this.#revision(revision);
    this.#value.localRevision = Math.max(revision, this.#value.localRevision ?? 0);
    this.#emit();
  }
  uploaded(revision) {
    this.#revision(revision);
    if (this.#value.localRevision === null || revision > this.#value.localRevision) throw new TypeError('上传前必须先保存对应本机版本。');
    this.#value.uploadedRevision = Math.max(revision, this.#value.uploadedRevision ?? 0);
    this.#value.error = null;
    this.#emit();
  }
  peerMerged(revision) {
    this.#revision(revision);
    if (this.#value.uploadedRevision === null || revision > this.#value.uploadedRevision) throw new TypeError('没有这个版本的上传记录，不能标记对方已合并。');
    this.#value.peerRevision = Math.max(revision, this.#value.peerRevision ?? 0);
    this.#emit();
  }
  setConflicts(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('冲突数必须是非负整数。');
    this.#value.conflicts = count;
    this.#emit();
  }
  setOffline(offline) { this.#value.offline = Boolean(offline); this.#emit(); }
  setError(error) {
    this.#value.error = error ? { code: String(error.code || 'sync'), message: String(error.message || '同步出错，请稍后重试。') } : null;
    this.#emit();
  }
  reset() {
    this.#value = { localRevision: null, uploadedRevision: null, peerRevision: null, conflicts: 0, offline: this.#value.offline, error: null };
    this.#emit();
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }
}
