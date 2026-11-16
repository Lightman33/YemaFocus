import { bucketOf, validBucket } from '../sync/pack.js';

/**
 * 按桶本机存储：readMetadata / readBuckets(names?, expectedVersion?) / readPending。
 * writeTransaction({expectedVersion,record,buckets,deleteBuckets,pendingSnapshots?}) 一次原子提交。
 * record 是不含业务 units/待发正文的小封套；返回 {version,dataVersion,record,buckets,pendingKeys,...}。
 * updateMetadata 同步重放设置/令牌修改。read/write/update 保留全量兼容语义，不用于普通编辑。
 * IndexedDB 不可用时明确报错，不降级内存；MemoryStore 只供故障注入和测试。
 */
export class StoreError extends Error {
  constructor(code = 'unavailable') {
    super(code === 'invalid' ? '保存失败：数据必须是完整的 JSON，旧数据没有改变。' :
      code === 'stale' ? '另一页面已保存，请重新读取再试。' :
      code === 'blocked' ? '本机数据库正被另一个页面占用，请关闭其他野马页面后重试。' :
        code === 'write' ? '本机保存失败，旧数据没有改变。请检查剩余空间；不要关闭尚未保存的页面。' :
          '这个浏览器模式下无法保存数据，请使用普通浏览模式并允许网站存储。');
    this.name = 'StoreError';
    this.code = code;
  }
}

export const freshRecord = () => ({ state: null, pendingSnapshots: [], settings: {}, token: '' });

export function cloneJSON(value) {
  try {
    return JSON.parse(JSON.stringify(value, function (_key, entry) {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' ||
          typeof entry === 'bigint' || (typeof entry === 'number' && !Number.isFinite(entry))) throw new Error();
      return entry;
    }));
  } catch { throw new StoreError('invalid'); }
}

function validate(record) {
  const copy = cloneJSON(record);
  const keys = ['state', 'pendingSnapshots', 'settings', 'token'];
  if (!copy || keys.some(key => !Object.hasOwn(copy, key)) || Object.keys(copy).some(key => !keys.includes(key)) ||
      !Array.isArray(copy.pendingSnapshots) || !copy.settings || typeof copy.settings !== 'object' ||
      Array.isArray(copy.settings) || typeof copy.token !== 'string') throw new StoreError('invalid');
  return copy;
}

function applyMutation(current, mutator) {
  const draft = validate(current);
  let result;
  try { result = mutator(draft); }
  catch (error) { throw error instanceof StoreError ? error : new StoreError('write'); }
  if (result && typeof result.then === 'function') {
    // 消费错误，防止调用者误传 async 函数产生未处理的拒绝。
    Promise.resolve(result).catch(() => {});
    throw new StoreError('invalid');
  }
  return validate(result === undefined ? draft : result);
}

function patchMutation(patch) {
  const copy = cloneJSON(patch);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new StoreError('invalid');
  return current => Object.assign(current, copy);
}

// records 对象库中的三个命名空间：meta、bucket:<桶名>、pending:<内容路径>。
// version 覆盖所有写入（也包括设置），与引擎 generation 一起防止多页面覆盖。
const META = 'meta', ROOT = 'root';
const bucketKey = name => 'bucket:' + name;
const pendingKey = name => 'pending:' + name;
const freshMetadata = () => ({ format: 'yema-bucket-store', schema: 1, version: 0, dataVersion: 0, record: freshRecord(), buckets: [], pendingKeys: [] });
function business(record) { return record.state?.format === 'yema-engine-local' ? record.state.state : record.state; }
function skeleton(record) {
  const state = business(record);
  if (!state || !state.units || typeof state.units !== 'object' || Array.isArray(state.units)) return record;
  const header = { ...state, units: {} };
  return { ...record, state: record.state?.format === 'yema-engine-local' ? { ...record.state, state: header } : header };
}
function partition(record) {
  const buckets = {}, units = business(record)?.units;
  if (!units || typeof units !== 'object' || Array.isArray(units)) return buckets;
  for (const [key, unit] of Object.entries(units)) {
    const name = bucketOf(key);
    if (!Object.hasOwn(buckets, name)) Object.defineProperty(buckets, name, { value: {}, enumerable: true, writable: true });
    Object.defineProperty(buckets[name], key, { value: unit, enumerable: true, writable: true, configurable: true });
  }
  return buckets;
}
function install(record, buckets) {
  const state = business(record);
  if (state?.units && typeof state.units === 'object' && !Array.isArray(state.units)) {
    const units = Object.fromEntries(Object.values(buckets).flatMap(Object.entries));
    const full = { ...state, units };
    record.state = record.state?.format === 'yema-engine-local' ? { ...record.state, state: full } : full;
  }
  return record;
}
function pendingParts(plans) {
  if (!Array.isArray(plans)) throw new StoreError('invalid');
  const bodies = {}, indexes = [], keys = [];
  const save = (key, value) => {
    if (typeof key !== 'string' || !key.length || value === undefined) throw new StoreError('invalid');
    if (Object.hasOwn(bodies, key)) { if (JSON.stringify(bodies[key]) !== JSON.stringify(value)) throw new StoreError('invalid'); }
    else Object.defineProperty(bodies, key, { value, enumerable: true });
    keys.push(key);
  };
  plans.forEach((plan, i) => {
    if (plan?.format === 'yema-pending-pack' && plan.manifest && Array.isArray(plan.chunks)) {
      const entry = { ...plan, manifest: { ...plan.manifest }, chunks: plan.chunks.map(a => ({ ...a })) };
      delete entry.manifest.text; for (const chunk of entry.chunks) delete chunk.text;
      save(plan.manifest.path, plan.manifest.text);
      for (const chunk of plan.chunks) save(chunk.path, chunk.text);
      indexes.push(entry);
    } else { const key = 'item-' + i; save(key, plan); indexes.push({ localItem: key }); }
  });
  return { bodies, indexes, keys: [...new Set(keys)] };
}
function expandPending(indexes, bodies) {
  return indexes.map(entry => Object.hasOwn(entry, 'localItem') ? bodies[entry.localItem] : {
    ...entry, manifest: { ...entry.manifest, text: bodies[entry.manifest.path] },
    chunks: entry.chunks.map(a => ({ ...a, text: bodies[a.path] }))
  });
}
function metadata(value) {
  if (!value || value.format !== 'yema-bucket-store' || value.schema !== 1 || !Number.isSafeInteger(value.version) || value.version < 0 ||
      !Array.isArray(value.buckets) || value.buckets.some(b => !validBucket(b)) || new Set(value.buckets).size !== value.buckets.length || !Array.isArray(value.pendingKeys)) throw new StoreError('invalid');
  validate(value.record);
  const units = business(value.record)?.units;
  if (units && typeof units === 'object' && !Array.isArray(units) && Object.keys(units).length) throw new StoreError('invalid');
  return value;
}
function splitRecord(record, version = 0) {
  const buckets = partition(record), pending = pendingParts(record.pendingSnapshots);
  const meta = { ...freshMetadata(), version, record: { ...skeleton(record), pendingSnapshots: pending.indexes }, buckets: Object.keys(buckets), pendingKeys: pending.keys };
  return { meta, buckets, pending };
}

// 所有回调在请求成功事件内继续排请求，不在 IndexedDB 活跃事务中 await。
class BucketStore {
  async initialize() {
    if (!this.ready) this.ready = this.transaction('readwrite', (rows, done) => {
      rows.get(META, found => {
        if (found !== undefined) { metadata(found); done(); return; }
        rows.get(ROOT, legacy => {
          const parts = splitRecord(legacy === undefined ? freshRecord() : validate(legacy));
          for (const [name, units] of Object.entries(parts.buckets)) rows.put(bucketKey(name), units);
          for (const [key, body] of Object.entries(parts.pending.bodies)) rows.put(pendingKey(key), body);
          rows.put(META, parts.meta);
          // 删除也属于同一个事务，事务失败时旧 root 完整保留。
          rows.delete(ROOT); done();
        });
      });
    }).catch(error => { this.ready = null; throw error; });
    await this.ready; return this;
  }
  async readMetadata() {
    await this.initialize();
    return this.transaction('readonly', (rows, done) => rows.get(META, value => done(metadata(value))));
  }
  async readBuckets(names = null, expectedVersion = undefined) {
    await this.initialize();
    return this.transaction('readonly', (rows, done) => rows.get(META, value => {
      const meta = metadata(value);
      if (expectedVersion !== undefined && meta.version !== expectedVersion) throw new StoreError('stale');
      const selected = names === null ? meta.buckets : [...new Set(names)], buckets = {};
      let left = selected.length;
      if (!left) { done({ metadata: meta, buckets }); return; }
      for (const name of selected) {
        if (!validBucket(name)) throw new StoreError('invalid');
        if (!meta.buckets.includes(name)) { if (!--left) done({ metadata: meta, buckets }); continue; }
        rows.get(bucketKey(name), units => {
          if (units === undefined && meta.buckets.includes(name)) throw new StoreError('invalid');
          if (units !== undefined) Object.defineProperty(buckets, name, { value: units, enumerable: true });
          if (!--left) done({ metadata: meta, buckets });
        });
      }
    }));
  }
  async readPending(expectedVersion = undefined) {
    await this.initialize();
    return this.transaction('readonly', (rows, done) => rows.get(META, value => {
      const meta = metadata(value), bodies = {};
      if (expectedVersion !== undefined && meta.version !== expectedVersion) throw new StoreError('stale');
      let left = meta.pendingKeys.length;
      if (!left) { done([]); return; }
      for (const key of meta.pendingKeys) rows.get(pendingKey(key), body => {
        if (body === undefined) throw new StoreError('invalid');
        Object.defineProperty(bodies, key, { value: body, enumerable: true });
        if (!--left) done(expandPending(meta.record.pendingSnapshots, bodies));
      });
    }));
  }
  async writeTransaction({ expectedVersion, record, buckets = {}, deleteBuckets = [], pendingSnapshots }) {
    await this.initialize();
    // 只验证/复制将写入的桶，绝不为了校验读取其他桶。
    if (!record || typeof record !== 'object' || Array.isArray(record) || !buckets || typeof buckets !== 'object' || Array.isArray(buckets) || !Array.isArray(deleteBuckets) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new StoreError('invalid');
    const header = validate({ ...skeleton(record), pendingSnapshots: [] });
    const writes = cloneJSON(buckets), removes = [...new Set(deleteBuckets)];
    for (const [name, units] of Object.entries(writes)) {
      if (!validBucket(name) || !units || typeof units !== 'object' || Array.isArray(units) || Object.keys(units).some(key => bucketOf(key) !== name)) throw new StoreError('invalid');
    }
    if (removes.some(name => !validBucket(name)) || removes.some(name => Object.hasOwn(writes, name))) throw new StoreError('invalid');
    const pending = pendingSnapshots === undefined ? null : pendingParts(cloneJSON(pendingSnapshots));
    return this.transaction('readwrite', (rows, done) => rows.get(META, value => {
      const old = metadata(value);
      if (old.version !== expectedVersion) throw new StoreError('stale');
      const names = new Set(old.buckets);
      for (const [name, units] of Object.entries(writes)) { rows.put(bucketKey(name), units); names.add(name); }
      for (const name of removes) { rows.delete(bucketKey(name)); names.delete(name); }
      if (pending) {
        for (const key of old.pendingKeys) if (!pending.keys.includes(key)) rows.delete(pendingKey(key));
        for (const [key, body] of Object.entries(pending.bodies)) rows.put(pendingKey(key), body);
      }
      const next = { ...old, version: old.version + 1, dataVersion: (old.dataVersion || 0) + Number(Object.keys(writes).length > 0 || removes.length > 0 || JSON.stringify(business(header)) !== JSON.stringify(business(old.record))), record: { ...header, pendingSnapshots: pending ? pending.indexes : old.record.pendingSnapshots },
        buckets: [...names], pendingKeys: pending ? pending.keys : old.pendingKeys };
      rows.put(META, next); done(next);
    }));
  }
  // 兼容旧调用；全量接口成本明确，编辑热路径应使用上面的分桶接口。
  async read() {
    for (;;) {
      const { metadata: meta, buckets } = await this.readBuckets();
      try { return { ...install(meta.record, buckets), pendingSnapshots: await this.readPending(meta.version) }; }
      catch (error) { if (error.code !== 'stale') throw error; }
    }
  }
  async update(mutator) {
    for (;;) {
      const { metadata: meta, buckets } = await this.readBuckets();
      try {
        const current = { ...install(meta.record, buckets), pendingSnapshots: await this.readPending(meta.version) };
        const next = applyMutation(current, mutator), parts = splitRecord(next);
        await this.writeTransaction({ expectedVersion: meta.version, record: next, buckets: parts.buckets,
          deleteBuckets: meta.buckets.filter(name => !Object.hasOwn(parts.buckets, name)), pendingSnapshots: next.pendingSnapshots });
        return next;
      } catch (error) { if (error.code !== 'stale') throw error; }
    }
  }
  write(patch) { try { return this.update(patchMutation(patch)); } catch (error) { return Promise.reject(error); } }
  async updateMetadata(mutator) {
    for (;;) {
      const meta = await this.readMetadata(), draft = cloneJSON(meta.record);
      // 此接口只能改设置、令牌等小字段。业务状态改变必须显式提交桶。
      const oldState = JSON.stringify(draft.state), oldPending = JSON.stringify(draft.pendingSnapshots);
      let value;
      try { value = mutator(draft); } catch (error) { throw error instanceof StoreError ? error : new StoreError('write'); }
      if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); throw new StoreError('invalid'); }
      const next = value === undefined ? draft : value;
      if (JSON.stringify(next.state) !== oldState || JSON.stringify(next.pendingSnapshots) !== oldPending) throw new StoreError('invalid');
      try { return (await this.writeTransaction({ expectedVersion: meta.version, record: next })).record; }
      catch (error) { if (error.code !== 'stale') throw error; }
    }
  }
  async clear() {
    for (;;) {
      const meta = await this.readMetadata();
      try { await this.writeTransaction({ expectedVersion: meta.version, record: freshRecord(), deleteBuckets: meta.buckets, pendingSnapshots: [] }); return freshRecord(); }
      catch (error) { if (error.code !== 'stale') throw error; }
    }
  }
}

export class IndexedDBStore extends BucketStore {
  #db; #closed = false;
  constructor(database) { super(); this.#db = database; database.onversionchange = () => this.close(); }
  transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      if (this.#closed) { reject(new StoreError()); return; }
      let tx, result, failure;
      const abort = error => { failure = error instanceof StoreError ? error : new StoreError(mode === 'readonly' ? 'unavailable' : 'write'); try { tx.abort(); } catch { reject(failure); } };
      try {
        tx = this.#db.transaction('records', mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || new StoreError(mode === 'readonly' ? 'unavailable' : 'write'));
        tx.onerror = () => {};
        const records = tx.objectStore('records');
        operation({
          get(key, callback) { const request = records.get(key); request.onsuccess = () => { try { callback(request.result); } catch (error) { abort(error); } }; },
          put(key, value) { records.put(value, key); }, delete(key) { records.delete(key); }
        }, value => { result = value; });
      } catch (error) { if (tx) abort(error); else reject(new StoreError()); }
    });
  }
  close() { this.#closed = true; this.#db.close(); }
}

export function openStore({ indexedDB = globalThis.indexedDB, name = 'yema-mobile-v29', timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new StoreError()); return; }
    let request, finished = false;
    const timer = setTimeout(() => fail(new StoreError()), timeoutMs);
    function fail(error) { if (finished) return; finished = true; clearTimeout(timer); reject(error); }
    try {
      request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        try { if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records'); }
        catch { fail(new StoreError()); request.transaction.abort(); }
      };
      request.onsuccess = () => {
        if (finished) { request.result.close(); return; }
        const store = new IndexedDBStore(request.result);
        store.initialize().then(() => {
          if (finished) { store.close(); return; }
          finished = true; clearTimeout(timer); resolve(store);
        }, error => { store.close(); fail(error); });
      };
      request.onerror = () => fail(new StoreError());
      request.onblocked = () => fail(new StoreError('blocked'));
    } catch { fail(new StoreError()); }
  });
}

export class MemoryStore extends BucketStore {
  #shared; #closed = false;
  constructor(initial = freshRecord(), shared = null) {
    super();
    this.#shared = shared || { rows: new Map([[ROOT, validate(initial)]]), queue: Promise.resolve(), failure: null };
    this.resetStats();
  }
  reopen() { return new MemoryStore(undefined, this.#shared); }
  failNextWrite(stage = 'commit') { this.#shared.failure = stage; }
  resetStats() { this.stats = { metadataReads: 0, metadataWrites: 0, bucketReads: 0, bucketWrites: 0, pendingReads: 0, pendingWrites: 0 }; this.calls = []; }
  transaction(mode, operation) {
    const task = this.#shared.queue.then(() => {
      if (this.#closed) throw new StoreError();
      const draft = new Map(this.#shared.rows);
      let result, bucketWrites = 0;
      const checkpoint = stage => {
        if (mode === 'readwrite' && this.#shared.failure === stage) { this.#shared.failure = null; throw new StoreError('write'); }
      };
      const count = (key, write) => {
        const type = key === META ? 'metadata' : key.startsWith('bucket:') ? 'bucket' : key.startsWith('pending:') ? 'pending' : null;
        if (type) this.stats[type + (write ? 'Writes' : 'Reads')]++;
        this.calls.push({ operation: write ? 'write' : 'read', key });
      };
      operation({
        get: (key, cb) => { count(key, false); cb(draft.has(key) ? JSON.parse(JSON.stringify(draft.get(key))) : undefined); },
        put: (key, value) => {
          if (key === META) checkpoint('before-metadata');
          count(key, true); draft.set(key, JSON.parse(JSON.stringify(value)));
          if (key.startsWith('bucket:')) checkpoint('bucket-' + (++bucketWrites));
          if (key === META) checkpoint('after-metadata');
        },
        delete: key => { count(key, true); draft.delete(key); }
      }, value => { result = value; });
      checkpoint('commit');
      if (mode === 'readwrite') this.#shared.rows = draft;
      return result;
    });
    this.#shared.queue = task.catch(() => {}); return task;
  }
  close() { this.#closed = true; }
}

export async function requestPersistence(storage = globalThis.navigator?.storage) {
  let protectedData = false;
  try {
    protectedData = Boolean(await storage?.persisted?.());
    if (!protectedData && storage?.persist) protectedData = Boolean(await storage.persist());
  } catch { /* 不支持或拒绝时明确显示风险，不伪称持久化已获准 */ }
  return {
    protected: protectedData,
    message: protectedData ? '本机数据已受保护' : '系统可能在空间不足时清除'
  };
}
