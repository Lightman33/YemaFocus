/**
 * createEngine({store,transport,syncState,now,timers,repositoryId})：全部环境依赖注入。
 * timers={setTimeout(fn,ms),clearTimeout(id)}；now() 返回UTC毫秒；同仓库复用transport。
 * load() / getState()（独立副本）/ isJoined()；未加入禁止commit。
 * commit(nextState,hint?)：只合并变化单元及重算相关桶，存盘后安排60秒发布；返回只读状态，失败reject。
 * syncNow()：单飞，重复调用返回同一Promise；返回{ok,joined,code?,message?,warning?,details?}。
 * join()：空仓库保持未加入；已有完整设备清单才加入；不导入手机旧库。
 * subscribe(listener)：仅远端合并改变业务状态时通知，返回退订函数。
 * resetDevice(newId)：调用者提供从未用过的身份；保留本机内容、清除旧身份发布计划。
 * dispose()：取消定时器；运行中请求不能取消，但不会安排下一轮。
 *
 * record.state 封套 yema-engine-local 见格式文档；settings/token未知字段保留。
 * pendingSnapshots 只允许本引擎的一个不可变发布计划；不能与旧快照发布器共用队列。
 * UI须基于打开编辑器时的旧state用edit.js生成nextState。merge保留未观察远端分支；
 * 不得把业务JSON重新导入/伪造版本向量，否则无法保证陈旧编辑安全。
 */
import { canonical, clone, exactKeys, object, put } from './canonical.js';
import { emptyState, merge, assertState } from './merge.js';
import { assertDevice } from './vv.js';
import * as pack from './pack.js';

export const PUBLISH_INTERVAL = 60_000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const positive = n => Number.isSafeInteger(n) && n > 0;
const same = (a, b) => canonical(a) === canonical(b);
const encode = text => { const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; };
function decode(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.some(x => x > 127)) throw failure('corrupt', '同步文件不是规范ASCII字节，未安装损坏内容。');
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
}
function fresh(device = null) {
  return { format: 'yema-engine-local', schema: 1, device, joined: false, state: emptyState(), revision: 0,
    sequence: 0, seen: {}, published: null, lastPublishedAt: null, confirmed: [], repositoryId: null, merged: {}, basis: {}, generation: 0 };
}
function upgrade(local) {
  if (!Object.hasOwn(local, 'confirmed')) local.confirmed = [];
  if (!Object.hasOwn(local, 'repositoryId')) local.repositoryId = null;
  if (!Object.hasOwn(local, 'merged')) local.merged = {};
  if (!Object.hasOwn(local, 'basis')) local.basis = {};
  if (!Object.hasOwn(local, 'generation')) local.generation = 0;
  return local;
}
function assertLocal(local, full = true) {
  if (!exactKeys(local, ['format', 'schema', 'device', 'joined', 'state', 'revision', 'sequence', 'seen', 'published', 'lastPublishedAt', 'confirmed', 'repositoryId', 'merged', 'basis', 'generation']) || local.format !== 'yema-engine-local' || local.schema !== 1 || typeof local.joined !== 'boolean') throw failure('local', '本机同步记录格式不受支持，请保留数据并更换设备身份。');
  if (!object(local.merged) || !object(local.basis) || !Number.isSafeInteger(local.generation) || local.generation < 0) throw failure('local', '本机合并凭据损坏。');
  for (const [device, entry] of Object.entries(local.merged)) {
    assertDevice(device);
    if (!exactKeys(entry, ['sequence', 'buckets']) || !positive(entry.sequence) || !object(entry.buckets)) throw failure('local', '本机合并凭据损坏。');
  }
  for (const table of [local.basis, ...Object.values(local.merged).map(entry => entry.buckets)]) {
    for (const [bucket, hash] of Object.entries(table)) if (!pack.validBucket(bucket) || !/^[0-9a-f]{64}$/.test(hash)) throw failure('local', '本机桶凭据损坏。');
  }
  if (local.repositoryId !== null && (typeof local.repositoryId !== 'string' || !local.repositoryId.length)) throw failure('local', '本机仓库标识损坏。');
  if (!Array.isArray(local.confirmed) || local.confirmed.some(path => { const m = pack.parseManifestPath(path); return !m || m.device !== local.device; })) throw failure('local', '本机发布历史损坏。');
  if (local.device !== null) assertDevice(local.device);
  if (!exactKeys(local.state, ['schema', 'units', 'archives']) || local.state.schema !== 1 || !object(local.state.units) || !object(local.state.archives) || Object.keys(local.state.archives).length) throw failure('local', '本机业务状态结构错误或含不支持的归档，请保留数据。');
  if (full) assertState(local.state);
  if (!local.joined && Object.keys(local.state.units).length) throw failure('local', '未加入状态不能导入手机旧库，请保留原数据并从空状态加入。');
  if (!Number.isSafeInteger(local.revision) || local.revision < 0 || !Number.isSafeInteger(local.sequence) || local.sequence < 0 || !object(local.seen)) throw failure('local', '本机同步计数损坏，请保留数据。');
  for (const [d, s] of Object.entries(local.seen)) { assertDevice(d); if (!positive(s)) throw failure('local', '本机合并确认损坏。'); }
  if (local.lastPublishedAt !== null && (!Number.isSafeInteger(local.lastPublishedAt) || local.lastPublishedAt < 0)) throw failure('local', '本机发布时间损坏。');
  if (local.published !== null && (!exactKeys(local.published, ['sequence', 'revision', 'buckets']) || !positive(local.published.sequence) || !Number.isSafeInteger(local.published.revision) || local.published.revision < 0 || local.published.revision > local.revision || local.published.sequence > local.sequence || !object(local.published.buckets))) throw failure('local', '本机上传确认损坏。');
}

export function createEngine({ store, transport, syncState, now, timers, repositoryId }) {
  if (typeof repositoryId !== 'string' || !repositoryId.length) throw new TypeError('同步引擎需要明确的仓库标识。');
  if (!store || ['readMetadata', 'readBuckets', 'readPending', 'writeTransaction'].some(name => typeof store[name] !== 'function') || !transport || !syncState || typeof now !== 'function' || !timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') throw new TypeError('同步引擎需要注入存储、传输、状态、时钟和定时器');
  let local = null, pending = [], running = null, queue = Promise.resolve(), timer = null;
  let loadedVersion = -1, loadedDataVersion = -1, unloaded = new Set();
  let blockedUntil = 0, halted = false, disposed = false;
  const listeners = new Set(), warnings = new Map();
  // 索引只持有引擎拥有的不可变单元；改变桶后才重新序列化和散列。
  const keyBuckets = new Map();
  const unitBucket = key => { if (!keyBuckets.has(key)) keyBuckets.set(key, pack.bucketOf(key)); return keyBuckets.get(key); };
  const indexes = new WeakMap(), unitTexts = new WeakMap(), readonly = new WeakSet();
  function freeze(value) {
    if (value && typeof value === 'object' && !readonly.has(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value); readonly.add(value);
    }
    return value;
  }
  function unitText(unit) {
    // 只缓存引擎拥有的只读单元，调用者可写副本每次重新比较。
    if (!readonly.has(unit)) return canonical(unit);
    if (!unitTexts.has(unit)) unitTexts.set(unit, canonical(unit));
    return unitTexts.get(unit);
  }
  function indexState(state, previous = null, changed = null) {
    if (indexes.has(state)) return indexes.get(state);
    const buckets = previous && changed ? { ...previous.buckets } : {};
    const dirty = changed && new Set(changed.map(unitBucket));
    if (dirty) {
      for (const bucket of dirty) buckets[bucket] = { format: 'yema-chunk', schema: 1, bucket, units: { ...previous.buckets[bucket]?.units } };
      for (const key of changed) {
        const units = buckets[unitBucket(key)].units;
        if (Object.hasOwn(state.units, key)) put(units, key, state.units[key]); else delete units[key];
      }
    } else for (const [key, unit] of Object.entries(state.units)) {
      const bucket = unitBucket(key);
      if (!Object.hasOwn(buckets, bucket)) put(buckets, bucket, { format: 'yema-chunk', schema: 1, bucket, units: {} });
      put(buckets[bucket].units, key, unit);
    }
    for (const bucket of Object.keys(buckets)) if (!Object.keys(buckets[bucket].units).length) delete buckets[bucket];
    const artifacts = previous ? new Map(previous.artifacts) : new Map();
    if (dirty) for (const bucket of dirty) artifacts.delete(bucket);
    else artifacts.clear();
    let conflicts = previous && changed ? previous.conflicts : 0;
    if (previous && changed) {
      for (const key of changed) {
        const old = previous.buckets[unitBucket(key)]?.units[key];
        conflicts += Number((state.units[key]?.versions.length || 0) > 1) - Number((old?.versions.length || 0) > 1);
      }
    } else for (const unit of Object.values(state.units)) conflicts += Number(unit.versions.length > 1);
    if (previous && changed) {
      for (const key of changed) freeze(state.units[key]);
      if (!readonly.has(state.units)) Object.freeze(state.units); readonly.add(state.units); freeze(state.archives); Object.freeze(state); readonly.add(state);
    } else freeze(state);
    const result = { buckets, artifacts, conflicts }; indexes.set(state, result); return result;
  }
  function changedKeys(a, b) {
    return [...new Set([...Object.keys(a.units), ...Object.keys(b.units)])].filter(key => {
      const x = a.units[key], y = b.units[key];
      return x !== y && (!x || !y || unitText(x) !== unitText(y));
    });
  }
  // 按桶共享的只读字典。常见编辑不复制整库键表，只有显式全量枚举才展开键。
  function unitsView(buckets) {
    const units = new Proxy({}, {
      get: (target, key) => (typeof key === 'string' ? buckets[unitBucket(key)]?.units[key] : undefined) ?? Reflect.get(target, key),
      ownKeys: () => Object.values(buckets).flatMap(chunk => Object.keys(chunk.units)),
      getOwnPropertyDescriptor: (_target, key) => {
        const table = typeof key === 'string' && buckets[unitBucket(key)]?.units;
        return table && Object.hasOwn(table, key) ? { configurable: true, enumerable: true, writable: false, value: table[key] } : undefined;
      },
      set() { throw new TypeError('已提交单元只读'); }, deleteProperty() { throw new TypeError('已提交单元只读'); },
      defineProperty() { throw new TypeError('已提交单元只读'); }, setPrototypeOf() { throw new TypeError('已提交单元只读'); },
      preventExtensions() { throw new TypeError('已提交单元只读'); }
    });
    readonly.add(units); return units;
  }
  function mergeChanges(current, edited, keys) {
    const a = emptyState(), b = emptyState();
    for (const key of keys) {
      if (Object.hasOwn(current.units, key)) put(a.units, key, current.units[key]);
      if (Object.hasOwn(edited.units, key)) put(b.units, key, edited.units[key]);
    }
    const combined = merge(a, b), actual = changedKeys(a, combined);
    if (!actual.length) return current;
    const previous = indexState(current), buckets = { ...previous.buckets };
    for (const name of new Set(actual.map(unitBucket))) buckets[name] = { format: 'yema-chunk', schema: 1, bucket: name, units: { ...buckets[name]?.units } };
    for (const key of actual) put(buckets[unitBucket(key)].units, key, combined.units[key]);
    const result = { schema: 1, units: unitsView(buckets), archives: {} };
    indexState(result, previous, actual); return result;
  }
  function serial(fn) {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  }
  function checkRepository(value) {
    if (value.repositoryId !== null && value.repositoryId !== repositoryId) throw failure('repository', '这台设备的数据属于另一个仓库，请确认保留本机内容并换新设备号后重新绑定。');
    value.repositoryId = repositoryId;
  }
  function requireLoad() { if (!local) throw failure('load', '请先读取本机同步状态。'); }
  function cancelTimer() { if (timer !== null) timers.clearTimeout(timer); timer = null; }
  function emit(state) {
    for (const listener of listeners) { try { listener(clone(state)); } catch { /* 界面异常不能中止已完成的原子保存 */ } }
  }
  function showLocal() {
    if (local.joined) syncState.localSaved(local.revision);
    syncState.setConflicts(indexState(local.state).conflicts);
  }
  function report(error) {
    cancelTimer();
    const code = error.code || 'merge';
    const message = typeof error.message === 'string' && /[\u3400-\u9fff]/.test(error.message) ? error.message : '同步出错，本机数据已保留。请检查配置及浏览器功能。';
    if (code === 'ratelimit') {
      blockedUntil = Math.max(now() + 1000, error.retryAt || now() + PUBLISH_INTERVAL);
      syncState.setError({ code, message });
      schedule(blockedUntil);
    } else if (['offline', 'timeout'].includes(code)) {
      syncState.setOffline(true);
    } else {
      halted = true;
      syncState.setError({ code, message });
    }
    return { ok: false, joined: Boolean(local && local.joined), code, message, retryAt: code === 'ratelimit' ? blockedUntil : null };
  }
  // 读取小元数据；同一 generation 复用已校验内存状态，其他页面变化才重新装桶。
  async function readCurrent() {
    const meta = await store.readMetadata(), record = meta.record;
    const current = upgrade(record.state === null ? fresh(record.settings.deviceId || null) : record.state);
    assertLocal(current, false); checkRepository(current);
    if (local && meta.dataVersion === loadedDataVersion && loadedVersion >= 0) current.state = local.state;
    else {
      const snapshot = await store.readBuckets(null, meta.version);
      current.state = { ...current.state, units: Object.fromEntries(Object.values(snapshot.buckets).flatMap(Object.entries)) };
      assertLocal(current); indexState(current.state);
      const hashes = Object.fromEntries((await chunksFor(current.state, new Map())).map(a => [a.chunk.bucket, a.hash]));
      for (const entry of Object.values(current.merged)) for (const name of Object.keys(entry.buckets)) if (current.basis[name] !== hashes[name] || !Object.hasOwn(hashes, name)) delete entry.buckets[name];
      current.basis = hashes;
    }
    return { meta, record, current, full: !(local && current.state === local.state) };
  }
  // 散列在事务外。存储 version 同时保护设置和封套；stale 时从最新版本重放。
  async function mutate(fn, notify = false) {
    return serial(async () => {
      for (;;) {
        try {
          const { meta, record, current, full } = await readCurrent();
          if (local && current.device !== local.device) throw failure('identity', '设备身份已在另一页面改变，请重新载入。');
          const previous = local && local.state, oldState = current.state, oldPending = record.pendingSnapshots;
          const oldIndex = indexState(oldState);
          fn(current, record, meta);
          const nextIndex = indexState(current.state), buckets = {}, deleted = [];
          for (const [name, chunk] of Object.entries(nextIndex.buckets)) if (oldIndex.buckets[name] !== chunk) buckets[name] = chunk.units;
          for (const name of Object.keys(oldIndex.buckets)) if (!nextIndex.buckets[name]) deleted.push(name);
          if (oldState !== current.state || !Object.keys(current.basis).length) {
            const hashes = Object.fromEntries((await chunksFor(current.state, new Map())).map(a => [a.chunk.bucket, a.hash]));
            current.basis = full ? hashes : { ...current.basis, ...hashes };
            for (const name of deleted) delete current.basis[name];
          }
          assertLocal(current, false); current.generation++;
          const saved = await store.writeTransaction({ expectedVersion: meta.version, record: { ...record, state: current }, buckets,
            deleteBuckets: deleted, ...(record.pendingSnapshots !== oldPending ? { pendingSnapshots: record.pendingSnapshots } : {}) });
          // 只有事务完成才推进内存；失败时仍能重新计算同一笔编辑。
          local = { ...saved.record.state, state: current.state }; loadedVersion = saved.version; loadedDataVersion = saved.dataVersion; if (full) unloaded.clear();
          pending = saved.record.pendingSnapshots;
          showLocal();
          if (notify && previous !== local.state && !same(previous, local.state)) emit(local.state);
          return local;
        } catch (error) { if (error.code !== 'stale') throw error; }
      }
    });
  }
  function schedule(at = now() + PUBLISH_INTERVAL) {
    if (disposed || halted || !local || !local.joined) return;
    // 已有定时保持首笔编辑起算；限流时由report先取消再排。
    if (timer !== null) return;
    const due = Math.max(at, blockedUntil, local.lastPublishedAt === null ? 0 : local.lastPublishedAt + PUBLISH_INTERVAL);
    timer = timers.setTimeout(() => { timer = null; return syncNow(); }, Math.max(0, due - now()));
  }
  async function loadInternal(tasksFirst = false, copyResult = true) {
    return serial(async () => {
      cancelTimer();
      for (;;) {
        try {
          // load 是完整验证边界；不信任旧的内存缓存。
          const meta = await store.readMetadata(), record = meta.record;
          const value = upgrade(record.state === null ? fresh(record.settings.deviceId || null) : record.state);
          assertLocal(value, false); checkRepository(value);
          const names = tasksFirst ? meta.buckets.filter(taskBucket) : meta.buckets;
          const snapshot = await store.readBuckets(names, meta.version);
          value.state = { ...value.state, units: Object.fromEntries(Object.values(snapshot.buckets).flatMap(Object.entries)) };
          assertLocal(value, !tasksFirst); indexState(value.state);
          const remaining = new Set(meta.buckets.filter(name => !names.includes(name)));
          if (value.device !== null && record.settings.deviceId && record.settings.deviceId !== value.device) throw failure('identity', '本机设备身份不一致，请先执行恢复流程。');
          const artifacts = await chunksFor(value.state, new Map());
          const buckets = Object.fromEntries(artifacts.map(a => [a.chunk.bucket, a.hash]));
          const unsafe = names.filter(bucket => value.basis[bucket] !== buckets[bucket] || !Object.hasOwn(buckets, bucket));
          // 已落盘哈希证明该桶与上次验证后的字节相同；无凭据/不匹配则完整验证。
          if (tasksFirst && unsafe.length) assertLocal(value);
          for (const entry of Object.values(value.merged)) for (const bucket of Object.keys(entry.buckets)) if (unsafe.includes(bucket) || !meta.buckets.includes(bucket)) delete entry.buckets[bucket];
          // 没有旧哈希的迁移库在此建立真实内容凭据，所有元数据与 generation 同次落盘。
          value.basis = { ...value.basis, ...buckets };
          for (const name of Object.keys(value.basis)) if (!meta.buckets.includes(name) || (names.includes(name) && !Object.hasOwn(buckets, name))) delete value.basis[name];
          const saved = await store.writeTransaction({ expectedVersion: meta.version, record: { ...record, state: value } });
          local = { ...saved.record.state, state: value.state }; pending = saved.record.pendingSnapshots; loadedVersion = saved.version; loadedDataVersion = saved.dataVersion; unloaded = remaining; halted = false;
          syncState.reset(); showLocal();
          if (local.published) syncState.uploaded(local.published.revision);
          if (local.joined && (pending.length || !local.published || !same(local.basis, local.published.buckets))) schedule();
          return copyResult ? clone(local.state) : local.state;
        } catch (error) { if (error.code !== 'stale') throw error; }
      }
    }).catch(error => { report(error); throw error; });
  }
  const taskBucket = name => /^(tasks-\d{2}|projects|settings|indexes|meta|other|countdowns)$/.test(name);
  function load() { return loadInternal(); }
  function loadTasks() { return loadInternal(true, false); }
  function ensureLoaded() { requireLoad(); return unloaded.size ? loadInternal(false, false) : Promise.resolve(local.state); }
  function getState() { requireLoad(); if (unloaded.size) throw failure('loading', '其他内容正在载入，请先等待 ensureLoaded。'); return clone(local.state); }
  function isJoined() { return Boolean(local && local.joined); }
  async function commit(nextState, hint, { rebase, unitsOnly = false } = {}) {
    requireLoad();
    if (!local.joined) throw failure('notjoined', '先在设置里连接并完成第一次同步。');
    const prepared = !unitsOnly && typeof rebase === 'function' ? rebase(local.state) : null;
    if (prepared) { nextState = prepared.state; hint = prepared.keys; }
    // 同步截取输入，调用者随后改对象不能改变排队中的提交。
    // 只克隆与当前状态不同的单元；扫描全部键用于检测 hint 漏报。
    if (!exactKeys(nextState, ['schema', 'units', 'archives']) || nextState.schema !== 1 || !object(nextState.units) || !object(nextState.archives) || Object.keys(nextState.archives).length) throw failure('local', '本机提交状态结构错误。');
    const keys = unitsOnly ? Object.keys(nextState.units).filter(key => !local.state.units[key] || unitText(local.state.units[key]) !== unitText(nextState.units[key])) : changedKeys(local.state, nextState);
    if (keys.some(key => unloaded.has(unitBucket(key)))) throw failure('loading', '这部分内容正在载入，请等待载入完成后再保存。');
    if (hint !== undefined && (!Array.isArray(hint) || hint.some(key => typeof key !== 'string') || keys.some(key => !hint.includes(key)))) throw failure('hint', '改动提示漏报了单元，请保留编辑并重新计算。');
    const edited = emptyState();
    for (const key of keys) if (Object.hasOwn(nextState.units, key)) put(edited.units, key, clone(nextState.units[key]));
    try {
      const saved = await mutate((current, record, metadata) => {
        if (!current.joined) throw failure('notjoined', '先完成第一次同步。');
        // 无 hint 也逐键找出变化；merge 只接收变化单元，哈希只更新对应桶。
        const rebased = typeof rebase === 'function' ? rebase(current.state, { generation: current.generation, revision: current.revision, dataVersion: metadata.dataVersion, settings: { ...record.settings } }) : null;
        if (rebased && (!Array.isArray(rebased.keys) || (unitsOnly ? Object.keys(rebased.state.units).filter(key => current.state.units[key] !== rebased.state.units[key] && (!current.state.units[key] || unitText(current.state.units[key]) !== unitText(rebased.state.units[key]))) : changedKeys(current.state, rebased.state)).some(key => !rebased.keys.includes(key)))) throw failure('hint', '改动提示漏报了单元，请保留编辑并重新计算。');
        if ((rebased ? rebased.keys : keys).some(key => unloaded.has(unitBucket(key)))) throw failure('loading', '这部分内容正在载入，请等待载入完成后再保存。');
        if (rebased) record.settings.taskRevision = (record.settings.taskRevision || 0) + 1;
        const result = mergeChanges(current.state, rebased ? rebased.state : edited, rebased ? rebased.keys : keys);
        if (result !== current.state) { current.state = result; current.revision++; }
      });
      if (!halted) schedule();
      // 返回只读的已提交快照，避免保存后再深拷贝整个库；需要可写副本用 getState()。
      return freeze(saved.state);
    } catch (error) { report(error); throw error; }
  }
  async function list(directory) {
    try {
      const entries = await transport.list(directory);
      if (entries.length >= 1000) throw failure('directory_limit', '清单目录达到1000项，可能列不完整，已停止同步；请保留数据并检查清理。');
      return entries;
    } catch (error) { if (error.code === 'notfound') return []; throw error; }
  }
  async function chunksFor(state, cache) {
    if (!globalThis.crypto?.subtle) throw failure('crypto', '同步出错：浏览器缺少安全散列功能。');
    const index = indexState(state), artifacts = [];
    for (const [bucket, chunk] of Object.entries(index.buckets)) {
      let artifact = index.artifacts.get(bucket);
      if (!artifact) {
        // indexState 只接受已在载入边界验证或 merge 验证过的单元；复用其规范文本。
        // 字段和排序逐字节等同 pack.createChunk，不重复 normalize 整个变化桶。
        const text = '{"bucket":' + canonical(bucket) + ',"format":"yema-chunk","schema":1,"units":{' +
          Object.keys(chunk.units).sort().map(key => canonical(key) + ':' + unitText(chunk.units[key])).join(',') + '}}';
        const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encode(text)));
        const hash = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        artifact = { chunk, text, hash, path: pack.chunkPath(hash) }; index.artifacts.set(bucket, artifact);
      }
      cache.set(artifact.hash, artifact.chunk); artifacts.push(artifact);
    }
    return artifacts;
  }
  async function readComplete(path, cache, available = new Set()) {
    const checked = await pack.verifyManifest(path, decode(await transport.get(path)));
    if (!checked.ok) throw failure('corrupt', checked.reason);
    const chunks = [];
    const remembered = Object.hasOwn(local.merged, checked.manifest.device) ? local.merged[checked.manifest.device] : null;
    const self = Object.hasOwn(local.merged, local.device) ? local.merged[local.device] : null;
    for (const [bucket, hash] of Object.entries(checked.manifest.buckets)) {
      if ((remembered && remembered.buckets[bucket] === hash) || (self && self.buckets[bucket] === hash)) { available.add(hash); continue; }
      let chunk = cache.get(hash);
      if (!chunk) {
        const result = await pack.verifyChunk(pack.chunkPath(hash), decode(await transport.get(pack.chunkPath(hash))));
        if (!result.ok) throw failure('corrupt', result.reason);
        chunk = result.chunk;
        cache.set(hash, chunk); available.add(hash);
      }
      if (chunk.bucket !== bucket) throw failure('corrupt', '清单引用的块与桶名不符。');
      chunks.push(chunk);
    }
    return { ...checked, state: pack.joinChunks(chunks) };
  }
  function candidates(device, entries) {
    const result = [], sequences = new Map();
    for (const entry of entries) {
      const path = pack.ROOT + '/manifests/' + device + '/' + entry.name, header = pack.parseManifestPath(path);
      if (!header) continue;
      if (sequences.has(header.sequence) && sequences.get(header.sequence) !== header.hash) throw failure('identity', '同一设备同一序号出现不同清单，请更换设备身份并保留原文件。');
      sequences.set(header.sequence, header.hash); result.push({ path, ...header });
    }
    return result.sort((a, b) => b.sequence - a.sequence);
  }
  async function readRemote(cache, available) {
    const registry = await list(pack.ROOT + '/devices'), devices = new Set([local.device]);
    for (const entry of registry) {
      const parsed = pack.parseDevicePath(pack.ROOT + '/devices/' + entry.name);
      if (parsed) devices.add(parsed.device);
    }
    const result = [];
    let ownEntries = [];
    let pause = false;
    const activeWarnings = new Set();
    for (const device of [...devices].sort()) {
      const entries = candidates(device, await list(pack.ROOT + '/manifests/' + device));
      if (device === local.device) ownEntries = entries;
      let complete = null;
      for (const entry of entries) {
        try { complete = await readComplete(entry.path, cache, available); break; }
        catch (error) {
          if (!['notfound', 'corrupt'].includes(error.code)) throw error;
          if (entry === entries[0]) {
            activeWarnings.add(device);
            const previous = warnings.get(device);
            if (!previous || previous.path !== entry.path) warnings.set(device, { device, path: entry.path, since: now() });
            if (device === local.device && entry.sequence > (local.published ? local.published.sequence : 0)) pause = true;
          }
        }
      }

      if (complete) result.push(complete);
    }
    for (const device of warnings.keys()) if (!activeWarnings.has(device)) warnings.delete(device);
    // 文字里不放时间：同步模块不使用 Date。起始时刻（UTC 毫秒）放在 details 里，由界面按用户时区显示。
    const warning = warnings.size ? Object.assign(failure('incomplete', [...warnings.values()].map(w => '设备 ' + w.device + ' 的清单缺失或损坏，已保留它上一份完整内容。').join('；')),
      { details: [...warnings.values()].map(w => ({ device: w.device, since: w.since })) }) : null;
    return { result, warning, pause, ownEntries, devices: new Set(registry.map(entry => pack.parseDevicePath(pack.ROOT + '/devices/' + entry.name)?.device).filter(Boolean)) };
  }
  async function validatePending(plan) {
    if (!exactKeys(plan, ['format', 'device', 'revision', 'manifest', 'chunks']) || plan.format !== 'yema-pending-pack' || plan.device !== local.device || !Number.isSafeInteger(plan.revision) || plan.revision < 0 || !Array.isArray(plan.chunks)) throw failure('local', '待上传记录格式错误，请保留本机数据。');
    const m = await pack.verifyManifest(plan.manifest.path, plan.manifest.text);
    if (!m.ok || m.manifest.device !== plan.device || plan.revision > local.revision) throw failure('local', '待上传清单校验失败。');
    const found = new Map();
    for (const a of plan.chunks) {
      const c = await pack.verifyChunk(a.path, a.text);
      if (!c.ok) throw failure('local', '待上传块校验失败。');
      found.set(c.hash, c.chunk.bucket);
    }
    const known = new Set(local.published ? Object.values(local.published.buckets) : []);
    for (const entry of Object.values(local.merged)) for (const hash of Object.values(entry.buckets)) known.add(hash);
    for (const [bucket, hash] of Object.entries(m.manifest.buckets)) if (found.get(hash) !== bucket && !known.has(hash)) throw failure('local', '待上传清单没有对应的已确认块。');
    return m.manifest;
  }
  async function makePending(cache, available) {
    // 散列在事务外，事务内核对状态；编辑同时到达则下一轮重新准备，绝不锁住UI等网络。
    const base = { ...local }, artifacts = await chunksFor(base.state, cache);
    const buckets = Object.fromEntries(artifacts.map(a => [a.chunk.bucket, a.hash]));
    if (base.published && same(base.published.buckets, buckets)) return null;
    const sequence = base.sequence + 1;
    const seen = Object.fromEntries(Object.entries(base.seen).filter(([d]) => d !== base.device));
    const artifact = await pack.createManifest(base.device, sequence, buckets, seen);
    const plan = { format: 'yema-pending-pack', device: base.device, revision: base.revision,
      manifest: { path: artifact.path, text: artifact.text }, chunks: artifacts.filter(a => !available.has(a.hash)).map(a => ({ path: a.path, text: a.text })) };
    let installed = false;
    await mutate((current, record) => {
      if (record.pendingSnapshots.length) return;
      if (current.revision !== base.revision || current.sequence !== base.sequence || (current.state !== base.state && !same(current.state, base.state))) return;
      current.sequence = sequence; record.pendingSnapshots = [plan]; installed = true;
    });
    if (!installed) { schedule(); return null; }
    return plan;
  }
  async function publish(plan, cache, known) {
    const manifest = await validatePending(plan);
    // 不把超过本机预留序号的计划发出去；同路径已存在只允许同字节。
    if (manifest.sequence > local.sequence) throw failure('local', '待上传序号未原子预留。');
    if (!known.devices.has(local.device)) await transport.put(pack.devicePath(local.device), encode(pack.deviceText(local.device)));
    for (const a of plan.chunks) {
      const hash = pack.parseChunkPath(a.path).hash;
      if (known.hashes.has(hash)) continue;
      await transport.put(a.path, encode(a.text));
      known.hashes.add(hash);
    }
    await transport.put(plan.manifest.path, encode(plan.manifest.text));
    await mutate((current, record) => {
      // 旧标签页完成后不能删除另一发布者新排的计划。
      const first = record.pendingSnapshots[0];
      if (!first || first.manifest.path !== plan.manifest.path) {
        if (current.published && current.published.sequence >= manifest.sequence) return;
        throw failure('identity', '待上传计划已改变，请重新读取本机状态。');
      }
      current.published = { sequence: manifest.sequence, revision: plan.revision, buckets: manifest.buckets };
      put(current.merged, manifest.device, { sequence: manifest.sequence, buckets: manifest.buckets });
      current.lastPublishedAt = now();
      if (!current.confirmed.includes(plan.manifest.path)) current.confirmed.push(plan.manifest.path);
      record.pendingSnapshots = [];
    });
    syncState.uploaded(local.published.revision);
  }
  async function cleanup(entries) {
    if (!entries) entries = candidates(local.device, await list(pack.ROOT + '/manifests/' + local.device));
    const present = new Set(entries.map(e => e.path));
    const stale = local.confirmed.filter(path => !present.has(path));
    if (stale.length) await mutate(current => { current.confirmed = current.confirmed.filter(path => !stale.includes(path)); });
    const confirmed = new Set(local.confirmed);
    const known = entries.filter(entry => confirmed.has(entry.path));
    // 未记录的旧清单一律保留；不下载它们的历史块来推测完整性。
    const removed = [];
    for (const entry of known.slice(3)) {
      try { await transport.remove(entry.path); }
      catch (error) { if (!['notfound', 'conflict'].includes(error.code)) throw error; }
      // 冲突可能只是SHA过期，下一轮仍列目录、重试，不能先忘掉这条记录。
      removed.push(entry.path);
    }

  }
  async function readPendingPlan() {
    for (;;) {
      if (!pending.length) return null;
      try { return (await store.readPending(loadedVersion))[0] || null; }
      catch (error) {
        if (error.code !== 'stale') throw error;
        // 另一页面可能刚确认旧计划或预留新计划；先刷新封套再读对应原字节。
        await mutate(() => {});
      }
    }
  }
  async function round(joining) {
    requireLoad();
    if (disposed) return { ok: false, joined: local.joined, code: 'disposed', message: '同步引擎已关闭。' };
    if (now() < blockedUntil) return { ok: false, joined: local.joined, code: 'ratelimit', retryAt: blockedUntil, message: '请等到限流等待时间结束。' };
    if (!local.device) throw failure('identity', '请先分配全新的设备号，再加入同步。');
    await ensureLoaded();
    // 再读事务内最新记录，防止同浏览器另一标签页刚刚完成保存。
    await mutate(() => {});
    const cache = new Map(), available = new Set(local.published ? Object.values(local.published.buckets) : []);
    await chunksFor(local.state, cache);
    const remote = await readRemote(cache, available);
    if (!local.joined && !joining) return { ok: false, joined: false, code: 'notjoined', message: '先在设置里连接并完成第一次同步。' };
    if (!local.joined && !remote.result.some(r => r.manifest.device !== local.device)) {
      syncState.setError(remote.warning);
      return { ok: true, joined: false, warning: remote.warning && remote.warning.message, details: remote.warning ? remote.warning.details : [], message: '仓库尚无其他设备的完整清单，请先在电脑上发布。' };
    }
    await mutate(current => {
      let state = current.state;
      for (const r of remote.result) state = mergeChanges(state, r.state, Object.keys(r.state.units).filter(key => state.units[key] !== r.state.units[key] && (!state.units[key] || unitText(state.units[key]) !== unitText(r.state.units[key]))));
      if (state !== current.state || !current.joined) { current.state = state; current.revision++; }
      current.joined = true;
      for (const r of remote.result) {
        const m = r.manifest;
        put(current.merged, m.device, { sequence: m.sequence, buckets: m.buckets });
        if (m.device === current.device) {
          current.sequence = Math.max(current.sequence, m.sequence);
          // 自愈只认已完整下载的自己的发布；新合并导致的revision不能假报成已上传。
          if (!current.published || m.sequence > current.published.sequence) {
            current.published = { sequence: m.sequence, revision: same(state, r.state) ? current.revision : 0, buckets: m.buckets };
            // 恢复时不知道上次实际提交时刻，保守地从这次确认起再等60秒。
            current.lastPublishedAt = now();
          }
        } else current.seen[m.device] = Math.max(Object.hasOwn(current.seen, m.device) ? current.seen[m.device] : 0, m.sequence);
      }
    }, true);
    syncState.setOffline(false);
    // 只有自己未确认的新清单不完整时暂停发布；别的设备不能阻断本机。
    if (remote.pause) {
      syncState.setError(remote.warning);
      return { ok: true, joined: local.joined, warning: remote.warning.message, details: remote.warning.details };
    }
    const known = { devices: remote.devices, hashes: available };
    if (pending.length > 1) throw failure('local', '存在多个旧格式待发布项，不能自动混用发布队列。');
    let plan = await readPendingPlan();
    if (plan) {
      const m = await validatePending(plan);
      const self = remote.result.find(r => r.manifest.device === local.device);
      if (self && self.manifest.sequence >= m.sequence) {
        // 同序号不同哈希已在目录扫描中拒绝；待发字节仍需核对，防止本地队列回退。
        if (self.manifest.sequence === m.sequence && self.path !== plan.manifest.path) throw failure('identity', '本机待上传清单与已发布清单冲突，请更换设备身份。');
        await mutate((current, record) => {
          if (self.manifest.sequence === m.sequence) current.published = { sequence: m.sequence, revision: plan.revision, buckets: m.buckets };
          record.pendingSnapshots = [];
        });
        plan = null;
      }
    }
    const eligible = local.lastPublishedAt === null || now() >= local.lastPublishedAt + PUBLISH_INTERVAL;
    if (!plan && eligible) plan = await makePending(cache, available);
    if (plan) await publish(plan, cache, known);
    else if (!eligible) {
      const buckets = Object.fromEntries((await chunksFor(local.state, cache)).map(a => [a.chunk.bucket, a.hash]));
      if (!local.published || !same(local.published.buckets, buckets)) schedule(local.lastPublishedAt + PUBLISH_INTERVAL);
    }
    if (plan || remote.ownEntries.length > 3) await cleanup(plan ? null : remote.ownEntries);
    // 网络期间的新编辑已保存，但不属于刚才那份清单。
    const finalBuckets = Object.fromEntries((await chunksFor(local.state, cache)).map(a => [a.chunk.bucket, a.hash]));
    if (!local.published || !same(local.published.buckets, finalBuckets)) schedule();
    if (local.published) {
      syncState.uploaded(local.published.revision);
      for (const r of remote.result) if (r.manifest.device !== local.device && (r.manifest.seen[local.device] || 0) >= local.published.sequence) syncState.peerMerged(local.published.revision);
    }
    syncState.setError(remote.warning);
    return { ok: true, joined: local.joined, warning: remote.warning ? remote.warning.message : null, details: remote.warning ? remote.warning.details : [] };
  }
  function start(joining) {
    if (running) return running;
    cancelTimer(); halted = false;
    running = round(joining).catch(report).finally(() => { running = null; });
    return running;
  }
  function syncNow() { return start(false); }
  function join() { return start(true); }
  async function resetDevice(newId) {
    assertDevice(newId); requireLoad();
    if (newId === local.device) throw failure('identity', '恢复时必须使用全新的设备号。');
    if (running) await running;
    cancelTimer();
    await mutate((current, record) => {
      current.device = newId; current.confirmed = []; current.merged = {}; current.sequence = 0; current.published = null; current.lastPublishedAt = null;
      record.pendingSnapshots = []; record.settings.deviceId = newId;
    });
    halted = false; blockedUntil = 0; syncState.reset(); showLocal();
    if (local.joined) schedule();
  }
  async function rebind(newRepositoryId, newId) {
    if (newRepositoryId !== repositoryId) throw failure('repository', '请先用新仓库的传输和仓库标识创建引擎，再执行重新绑定。');
    assertDevice(newId);
    if (running) await running;
    cancelTimer();
    await serial(async () => {
      for (;;) {
        try {
          const meta = await store.readMetadata(), snapshot = await store.readBuckets(null, meta.version);
          const record = meta.record, current = upgrade(record.state === null ? fresh(record.settings.deviceId || null) : record.state);
          current.state = { ...current.state, units: Object.fromEntries(Object.values(snapshot.buckets).flatMap(Object.entries)) };
          assertLocal(current);
          if (current.device === newId) throw failure('identity', '重新绑定必须使用全新的设备号。');
          current.repositoryId = repositoryId; current.device = newId;
          current.sequence = 0; current.seen = {}; current.confirmed = []; current.merged = {}; current.basis = {}; current.generation++;
          current.published = null; current.lastPublishedAt = null;
          record.state = current; record.settings.deviceId = newId;
          const saved = await store.writeTransaction({ expectedVersion: meta.version, record, pendingSnapshots: [] });
          local = { ...saved.record.state, state: current.state }; pending = []; loadedVersion = saved.version; loadedDataVersion = saved.dataVersion; unloaded.clear(); break;
        } catch (error) { if (error.code !== 'stale') throw error; }
      }
      halted = false; blockedUntil = 0; syncState.reset(); showLocal();
      if (local.joined) schedule();
    });
    return getState();
  }
  return { load, loadTasks, ensureLoaded, getState, isJoined, commit,
    commitUnits: (state, keys, options = {}) => commit(state, keys, { ...options, unitsOnly: true }), syncNow, join, resetDevice, rebind,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; cancelTimer(); listeners.clear(); }
  };
}
