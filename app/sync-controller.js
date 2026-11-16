// 所有环境从参数注入；外壳只调用控制器，不直接操作引擎。
import { TransportError } from '../transport/transport.js';
export const repositoryId = settings => (settings.owner + '/' + settings.repo).toLowerCase();
export function validateConfiguration({ settings, token }) {
  if (!settings.deviceName || !/^[A-Za-z0-9-]+$/.test(settings.owner || '') ||
      !/^[A-Za-z0-9_.-]+$/.test(settings.repo || '') || ['.', '..'].includes(settings.repo) ||
      !token || !/^[\x21-\x7e]+$/.test(token) || settings.owner.includes(token) || settings.repo.includes(token)) {
    throw new TransportError('config', '请填写有效的仓库所有者、仓库名、令牌和设备名（填名称，不填网址）。');
  }
}
export function createSyncController({ store, syncState, makeTransport, makeEngine, now, timers, newDeviceId,
  isVisible, isOnline, dataSource = null, tasksFirst = false }) {
  let engine = null, transport = null, running = null, record, closed = false, changing = false;
  let error = null, details = [], retryAt = null, message = '', offline = !isOnline();
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(snapshot()); };
  function snapshot() {
    const progress = syncState.snapshot(), local = record?.state;
    return { joined: Boolean(record?.settings.joined), repository: local?.repositoryId || null,
      deviceId: record?.settings.deviceId, lastSuccess: record?.settings.syncLastSuccess || null,
      pending: local?.joined ? Math.max(0, local.revision - (local.published?.revision || 0)) : 0,
      error: error ? { ...error } : null, details: details.map(d => ({ ...d })), retryAt, message, offline, busy: Boolean(running), progress };
  }
  async function refresh() { record = (await store.readMetadata()).record; await dataSource?.refresh(); emit(); }
  // 设置与清空只读小封套；即使业务桶损坏，也能原子保留配置、换号并清除旧状态。
  async function changeRecord(mutator) {
    for (;;) {
      const meta = await store.readMetadata(), draft = meta.record, oldPending = draft.pendingSnapshots;
      mutator(draft);
      try {
        const saved = await store.writeTransaction({ expectedVersion: meta.version, record: draft,
          deleteBuckets: draft.state === null ? meta.buckets : [],
          ...(draft.pendingSnapshots !== oldPending ? { pendingSnapshots: draft.pendingSnapshots } : {}) });
        return saved.record;
      } catch (e) { if (e.code !== 'stale') throw e; }
    }
  }
  async function recover() {
    engine?.dispose(); engine = null; transport = null; dataSource?.attachEngine(null);
    record = await changeRecord(r => {
      r.state = null; r.pendingSnapshots = []; r.settings.joined = false;
      r.settings.deviceId = newDeviceId(); delete r.settings.syncLastSuccess;
    });
    syncState.reset(); error = null; details = []; retryAt = null;
    message = '本机同步记录丢失或损坏，已换一个新设备号。请重新“从电脑加入”。';
    await dataSource?.refresh(); emit();
  }
  async function checkLocalRecord() {
    const current = (await store.readMetadata()).record;
    if (current.settings.joined && (!current.state || current.state.format !== 'yema-engine-local' || !current.state.joined || current.state.device !== current.settings.deviceId)) { await recover(); return false; }
    return true;
  }
  // 定时回调也通过同一结果通道，警告详情不能经 SyncState 中转。
  const engineTimers = {
    setTimeout: (fn, ms) => timers.setTimeout(() => {
      if (!isVisible() || !isOnline() || changing || closed || error) return;
      // 引擎回调先清自己的计时标记，再由引擎单飞复用在途轮次。
      // 不能直接丢弃，否则在途上传期间的新编辑会失去下一次自动发布。
      if (running) return fn();
      return track(fn);
    }, ms),
    clearTimeout: id => timers.clearTimeout(id)
  };
  function gatedTransport(raw) {
    return Object.fromEntries(['list', 'get', 'put', 'remove', 'test'].map(method => [method, (...args) => {
      if (closed || !isVisible() || !isOnline()) throw new TransportError('offline', '离线，联网后自动同步');
      return raw[method](...args);
    }]));
  }
  function attach() {
    if (!dataSource) return;
    dataSource.attachEngine(engine ? {
      commit: async (...args) => {
        if (!(await checkLocalRecord())) throw new TransportError('local', message);
        const state = await engine.commit(...args); record = (await store.readMetadata()).record; emit(); return state; },
      ...(engine.commitUnits ? { commitUnits: async (...args) => {
        if (!(await checkLocalRecord())) throw new TransportError('local', message);
        const state = await engine.commitUnits(...args); record = (await store.readMetadata()).record; emit(); return state;
      } } : {}),
      ensureLoaded: () => engine.ensureLoaded?.(),
      subscribe: fn => engine.subscribe(fn),
      localChanged: async () => { record = (await store.readMetadata()).record; emit(); }
    } : null);
  }
  async function ensureEngine() {
    if (engine) return engine;
    transport ||= makeTransport({ ...record.settings, token: record.token });
    engine = makeEngine({ store, syncState, transport: gatedTransport(transport), repositoryId: repositoryId(record.settings), now, timers: engineTimers });
    try { await (tasksFirst && engine.loadTasks ? engine.loadTasks() : engine.load()); } catch (e) { engine.dispose(); engine = null; throw e; }
    attach(); return engine;
  }
  async function accept(result) {
    if (result.ok) {
      error = null; retryAt = null; offline = false; syncState.setOffline(false);
      details = (result.details || []).map(d => ({ ...d }));
      if (result.joined) {
        record = await store.updateMetadata(r => { r.settings.joined = true; r.settings.syncLastSuccess = now(); });
        await dataSource?.ensureLoaded?.();
        message = result.warning || '同步完成。';
      } else { message = '请先在电脑上开启同步并发布一次'; result = { ...result, message }; }
    } else if (['offline', 'timeout'].includes(result.code)) {
      offline = true; syncState.setOffline(true); message = '离线，联网后自动同步';
    } else if (result.code === 'ratelimit') {
      retryAt = result.retryAt || now() + 60000; message = '请求过多，请等待自动重试';
    } else { error = { code: result.code || 'sync', message: result.message || '同步出错，本机数据已保留。' }; message = error.message; }
    await refresh(); return result;
  }
  function track(action) {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      if (!(await checkLocalRecord())) return { ok: false, code: 'local-reset', message };
      return action();
    }).then(result => result.code === 'local-reset' ? result : accept(result)).catch(e => accept({ ok: false, code: e.code, message: e.message }))
      .finally(() => { running = null; emit(); });
    emit(); return running;
  }
  async function init() {
    record = (await store.readMetadata()).record;
    if (!record.settings.deviceId) record = await store.updateMetadata(r => { r.settings.deviceId = newDeviceId(); });
    let invalidLocal = false;
    if (record.state !== null) {
      try {
        if (record.state.format !== 'yema-engine-local') throw new Error();
        if (record.state.state?.schema !== 1 || !record.state.state?.units || !record.state.state?.archives || Object.keys(record.state.state.archives).length) throw new Error();
      } catch { invalidLocal = true; }
    }
    if (invalidLocal || record.settings.joined && (!record.state || !record.state.joined)) await recover();
    if (record.settings.joined) {
      try { await ensureEngine(); }
      catch (e) {
        if (e.code !== 'repository' && e.code !== 'crypto' && !['write', 'unavailable', 'blocked'].includes(e.code)) await recover();
        else { error = { code: e.code, message: e.message }; message = e.message; }
      }
    }
    emit(); return snapshot();
  }
  function sync({ retry = false } = {}) {
    if (running) return running;
    if (closed || changing || !record?.settings.joined || !isVisible()) return Promise.resolve({ ok: false, code: 'inactive' });
    if (error && !retry) return Promise.resolve({ ok: false, ...error });
    return track(async () => { const e = await ensureEngine(); return e.syncNow(); });
  }
  function join() {
    if (closed || changing || !isVisible()) return Promise.resolve({ ok: false, code: 'inactive' });
    return track(async () => {
      const e = await ensureEngine();
      const permission = await gatedTransport(transport).test();
      if (!permission.ok) return permission;
      return e.join();
    });
  }
  async function testConnection() {
    if (closed || !isVisible()) return { ok: false, code: 'inactive' };
    transport ||= makeTransport({ ...record.settings, token: record.token });
    return gatedTransport(transport).test();
  }
  async function saveConfiguration(config, { choice, confirmDiscard = false } = {}) {
    validateConfiguration(config);
    const newRepo = repositoryId(config.settings), oldRepo = record.state?.repositoryId || repositoryId(record.settings);
    const changedRepo = Boolean(record.settings.joined && newRepo !== oldRepo);
    if (changedRepo && !['move', 'replace'].includes(choice)) return { needsChoice: true, pending: snapshot().pending };
    if (changedRepo && choice === 'replace' && !confirmDiscard) return { needsDiscard: true, pending: snapshot().pending };
    changing = true;
    try {
      if (running) await running;
      const changed = newRepo !== oldRepo || config.token !== record.token;
      if (changed) { engine?.dispose(); engine = null; transport = null; dataSource?.attachEngine(null); }
      if (changedRepo && choice === 'replace') {
        // 确认之后才在同一事务清状态、换身份和保存新配置。
        record = await changeRecord(r => {
          r.state = null; r.pendingSnapshots = []; r.settings = { ...r.settings, ...config.settings, joined: false, deviceId: newDeviceId() };
          delete r.settings.syncLastSuccess; r.token = config.token;
        });
        syncState.reset(); error = null; details = []; retryAt = null;
      } else if (changedRepo) {
        transport = makeTransport({ ...config.settings, token: config.token });
        const permission = await gatedTransport(transport).test();
        if (!permission.ok) throw new TransportError(permission.code, permission.message);
        engine = makeEngine({ store, syncState, transport: gatedTransport(transport), repositoryId: newRepo, now, timers: engineTimers });
        // rebind 自己原子换身份并清旧发布凭据；不调用可能因仓库不符而失败的 load。
        await engine.rebind(newRepo, newDeviceId());
        record = await store.updateMetadata(r => { r.settings = { ...r.settings, ...config.settings, deviceId: r.settings.deviceId }; r.token = config.token; delete r.settings.syncLastSuccess; });
        error = null; details = []; retryAt = null; attach();
      } else {
        record = await changeRecord(r => {
          if (!r.settings.joined && newRepo !== oldRepo && r.state) { r.state = null; r.pendingSnapshots = []; r.settings.deviceId = newDeviceId(); }
          r.settings = { ...r.settings, ...config.settings, deviceId: r.settings.deviceId }; r.token = config.token; });
        if (record.settings.joined && !engine) await ensureEngine();
      }
      await refresh(); return { ok: true, replaced: changedRepo && choice === 'replace', moved: changedRepo && choice === 'move' };
    } finally { changing = false; }
  }
  async function clear() {
    changing = true;
    try {
      if (running) await running;
      engine?.dispose(); engine = null; transport = null; dataSource?.attachEngine(null);
      await store.clear(); record = await store.updateMetadata(r => { r.settings.deviceId = newDeviceId(); });
      syncState.reset(); error = null; details = []; retryAt = null; message = ''; await refresh();
    } finally { changing = false; }
  }
  return { init, snapshot, refresh, join, syncNow: () => sync({ retry: true }),
    foreground: () => sync(), networkChanged: () => { offline = !isOnline(); syncState.setOffline(offline); emit(); return isOnline() ? sync() : Promise.resolve(); },
    saveConfiguration, testConnection, clear,
    setDataSource(source) { dataSource = source; attach(); },
    subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
    async dispose() { closed = true; if (running) await running; engine?.dispose(); dataSource?.attachEngine(null); listeners.clear(); }
  };
}
