import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, IndexedDBStore, openStore, freshRecord, requestPersistence } from '../../app/store.js';

// 仅为事务事件模拟器，绝不称为浏览器 IndexedDB 实测。
// put 请求成功后还能模拟提交失败，专门检查实现有没有过早报告保存成功。
export function fakeDatabase(initial = freshRecord()) {
  let committed = new Map([['root', structuredClone(initial)]]), queue = Promise.resolve();
  const control = { failCommit: false, failStage: null, putSucceeded: false, beforeCommit: null, closed: false };
  const db = {
    close() { control.closed = true; },
    transaction(_name, mode) {
      if (control.closed) throw new Error('closed');
      const requests = []; let aborted = false, draft, writes = 0;
      const txn = {
        objectStore() { return {
          get(key) { const request = {}; requests.push(() => { request.result = structuredClone(draft.get(key)); request.onsuccess?.(); }); return request; },
          put(value, key) { control.putSucceeded = true; const copy = structuredClone(value); requests.push(() => {
            if (key === 'meta' && control.failStage === 'before-metadata') { aborted = true; control.failStage = null; }
            draft.set(key, copy);
            if ((key.startsWith('bucket:') && control.failStage === 'bucket-' + (++writes)) || (key === 'meta' && control.failStage === 'after-metadata')) { aborted = true; control.failStage = null; }
          }); return {}; },
          delete(key) { requests.push(() => draft.delete(key)); }
        }; },
        abort() { aborted = true; }
      };
      queue = queue.then(async () => {
        draft = new Map(committed);
        while (requests.length && !aborted) requests.shift()();
        await new Promise(resolve => setImmediate(resolve));
        if (control.beforeCommit && mode === 'readwrite') await control.beforeCommit();
        if (aborted || (control.failCommit && mode === 'readwrite')) {
          control.failCommit = false; txn.onabort();
        } else { if (mode === 'readwrite') committed = draft; txn.oncomplete(); }
      });
      return txn;
    }
  };
  return { db, control, rows: () => structuredClone(committed), current: () => structuredClone(committed.get('root') || committed.get('meta').record) };
}

for (const kind of ['memory', 'indexeddb-double']) {
  function setup() {
    if (kind === 'memory') {
      const store = new MemoryStore();
      return { store, fail: () => store.failNextWrite() };
    }
    const fake = fakeDatabase();
    return { store: new IndexedDBStore(fake.db), fail: () => { fake.control.failCommit = true; } };
  }

  test(kind + '：不透明状态、待上传、设置及令牌可同次完整保存，副本隔离', async () => {
    const { store } = setup();
    const patch = { state: { unknown: ['虚构', { a: 1 }] }, pendingSnapshots: [{ path: 'test', body: '虚构快照' }], settings: { owner: 'fictional', deviceId: 'device-test' }, token: 'fake-token' };
    assert.deepEqual(await store.read(), freshRecord());
    await store.write(patch);
    patch.state.unknown[1].a = 9;
    const result = await store.read();
    assert.equal(result.state.unknown[1].a, 1);
    result.pendingSnapshots.length = 0;
    assert.equal((await store.read()).pendingSnapshots.length, 1);
    await store.write({ settings: { deviceName: '虚构设备' } });
    assert.equal((await store.read()).token, 'fake-token');
  });

  test(kind + '：模拟提交失败不留下部分状态或待上传项，恢复后可写', async () => {
    const { store, fail } = setup();
    await store.write({ state: { n: 1 }, pendingSnapshots: [{ id: 1 }], token: 'before' });
    const before = await store.read();
    fail();
    await assert.rejects(store.write({ state: { n: 2 }, pendingSnapshots: [{ id: 2 }], token: 'after' }), { code: 'write' });
    assert.deepEqual(await store.read(), before);
    await store.write({ state: { n: 3 }, pendingSnapshots: [{ id: 3 }] });
    assert.equal((await store.read()).state.n, 3);
  });

  test(kind + '：并发 update 不丢改动', async () => {
    const { store } = setup();
    await store.write({ state: { count: 0 } });
    await Promise.all(Array.from({ length: 10 }, () => store.update(record => { record.state.count++; })));
    assert.equal((await store.read()).state.count, 10);
  });

  test(kind + '：无效 JSON 与异步 mutation 均不改变原数据', async () => {
    const { store } = setup();
    await store.write({ state: { n: 1 } });
    const before = await store.read();
    const cycle = {}; cycle.self = cycle;
    for (const patch of [{ state: cycle }, { state: { x: undefined } }, { state: NaN }, { token: null }, { pendingSnapshots: {} }, { unexpected: true }]) {
      await assert.rejects(store.write(patch), { code: 'invalid' });
      assert.deepEqual(await store.read(), before);
    }
    await assert.rejects(store.update(async record => { record.state.n = 7; }), { code: 'invalid' });
    await assert.rejects(store.update(record => { record.state.n = 8; throw new Error(); }), { code: 'write' });
    assert.deepEqual(await store.read(), before);
  });

  test(kind + '：clear 原子清除所有记录，失败保留全部数据', async () => {
    const { store, fail } = setup();
    await store.write({ state: { n: 1 }, pendingSnapshots: [1], settings: { owner: 'fake' }, token: 'fake-token' });
    const before = await store.read();
    fail();
    await assert.rejects(store.clear(), { code: 'write' });
    assert.deepEqual(await store.read(), before);
    await store.clear();
    assert.deepEqual(await store.read(), freshRecord());
    store.close();
    await assert.rejects(store.read(), { code: 'unavailable' });
  });
}

test('IndexedDB：put 事件成功仍不能提前 resolve，必须等待事务提交', async () => {
  const fake = fakeDatabase();
  const store = new IndexedDBStore(fake.db); await store.initialize();
  let release;
  let reached;
  const atCommit = new Promise(resolve => { reached = resolve; });
  fake.control.beforeCommit = async () => { reached(); await new Promise(resolve => { release = resolve; }); };
  let resolved = false;
  const write = store.write({ state: { n: 9 } }).then(() => { resolved = true; });
  await atCommit;
  assert.equal(fake.control.putSucceeded, true);
  assert.equal(resolved, false);
  assert.deepEqual(fake.current(), freshRecord());
  release();
  await write;
  assert.equal(fake.current().state.n, 9);
});

test('IndexedDB：不可用、同步异常、打开失败、被占用、超时都明确失败，无内存降级', async () => {
  await assert.rejects(openStore({ indexedDB: null }), /这个浏览器模式下无法保存数据/);
  await assert.rejects(openStore({ indexedDB: { open() { throw new Error('denied'); } } }), { code: 'unavailable' });
  for (const event of ['onerror', 'onblocked']) {
    const request = {};
    const opening = openStore({ indexedDB: { open: () => request } });
    request[event]();
    await assert.rejects(opening, { code: event === 'onblocked' ? 'blocked' : 'unavailable' });
  }
  const request = {};
  let closed = false;
  const opening = openStore({ indexedDB: { open: () => request }, timeoutMs: 10 });
  await assert.rejects(opening, { code: 'unavailable' });
  request.result = { close() { closed = true; } };
  request.onsuccess();
  assert.equal(closed, true);
});

test('IndexedDB：建立对象库并在数据库版本变化时关闭', async () => {
  const fake = fakeDatabase();
  const request = {};
  let created;
  fake.db.objectStoreNames = { contains: () => false };
  fake.db.createObjectStore = name => { created = name; };
  const opening = openStore({ indexedDB: { open: () => request } });
  request.result = fake.db;
  request.onupgradeneeded();
  request.onsuccess();
  const store = await opening;
  assert.equal(created, 'records');
  fake.db.onversionchange();
  await assert.rejects(store.read(), { code: 'unavailable' });
});

test('持久化：启动申请保护；已保护不重复申请；拒绝/不支持不能假称成功', async () => {
  let requested = 0;
  const allowed = await requestPersistence({ persisted: async () => false, persist: async () => { requested++; return true; } });
  assert.equal(requested, 1);
  assert.equal(allowed.message, '本机数据已受保护');
  await requestPersistence({ persisted: async () => true, persist: async () => { throw new Error(); } });
  for (const storage of [null, {}, { persist: async () => false }, { persisted: async () => { throw new Error(); } }]) {
    const result = await requestPersistence(storage);
    assert.equal(result.protected, false);
    assert.equal(result.message, '系统可能在空间不足时清除');
  }
});

const bucketRecord = () => ({ ...freshRecord(), state: { schema: 1, units: {
  '["task-status","a"]': { value: '虚构旧任务' },
  '["project","p"]': { value: '虚构旧项目' }
}, archives: {} }, settings: { joined: true, deviceId: 'fiction-phone', reviewUI: { tab: 'day' } }, token: 'fiction-token', pendingSnapshots: [{
  format: 'yema-pending-pack', device: 'fiction-phone', revision: 1,
  manifest: { path: 'fiction-manifest', text: '虚构清单原字节', fictionalExtension: { keep: true } }, chunks: [{ path: 'fiction-chunk', text: '虚构块原字节', fictionalExtension: '保留未知字段' }]
}] });
for (const kind of ['memory', 'indexeddb-double']) {
  test(kind + '：旧记录含业务、加入、计划、设置、令牌，转换逐项相同且元数据不含正文', async () => {
    const initial = bucketRecord(), fake = kind === 'memory' ? null : fakeDatabase(initial);
    const store = fake ? new IndexedDBStore(fake.db) : new MemoryStore(initial);
    const meta = await store.readMetadata();
    assert.deepEqual(await store.read(), initial);
    assert.deepEqual(meta.record.state.units, {});
    assert.equal(JSON.stringify(meta).includes('原字节'), false);
    assert.deepEqual(await store.readPending(), initial.pendingSnapshots);
    if (fake) { assert.equal(fake.rows().has('root'), false); assert.equal(fake.rows().has('bucket:tasks-33'), true); }
  });
  for (const stage of ['bucket-1', 'bucket-2', 'before-metadata', 'after-metadata', 'commit']) {
    test(kind + '：迁移在 ' + stage + ' 失败保留完整旧记录，重新打开可转换', async () => {
      const initial = bucketRecord(), fake = kind === 'memory' ? null : fakeDatabase(initial);
      const store = fake ? new IndexedDBStore(fake.db) : new MemoryStore(initial);
      if (fake) { if (stage === 'commit') fake.control.failCommit = true; else fake.control.failStage = stage; }
      else store.failNextWrite(stage);
      await assert.rejects(store.initialize(), { code: 'write' });
      if (fake) { assert.deepEqual(fake.rows().get('root'), initial); assert.equal(fake.rows().has('meta'), false); }
      const reopened = fake ? new IndexedDBStore(fake.db) : store.reopen();
      assert.deepEqual(await reopened.read(), initial);
    });
    test(kind + '：分桶事务在 ' + stage + ' 失败，重开仍是完整旧状态', async () => {
      const initial = bucketRecord(), fake = kind === 'memory' ? null : fakeDatabase(initial);
      const store = fake ? new IndexedDBStore(fake.db) : new MemoryStore(initial);
      const meta = await store.readMetadata();
      if (fake) { if (stage === 'commit') fake.control.failCommit = true; else fake.control.failStage = stage; }
      else store.failNextWrite(stage);
      await assert.rejects(store.writeTransaction({ expectedVersion: meta.version, record: { ...meta.record, token: 'fiction-new-token' },
        buckets: { 'tasks-33': { '["task-status","a"]': { value: '虚构新任务' } }, projects: { '["project","p"]': { value: '虚构新项目' } } }, pendingSnapshots: [] }), { code: 'write' });
      const reopened = fake ? new IndexedDBStore(fake.db) : store.reopen();
      assert.deepEqual(await reopened.read(), initial);
    });
  }
  test(kind + '：两个页面从同一版本写，后一页明确 stale；重读后保留前一页', async () => {
    const initial = bucketRecord(), fake = kind === 'memory' ? null : fakeDatabase(initial);
    const one = fake ? new IndexedDBStore(fake.db) : new MemoryStore(initial);
    const two = fake ? new IndexedDBStore(fake.db) : one.reopen();
    const [a, b] = await Promise.all([one.readMetadata(), two.readMetadata()]);
    await one.writeTransaction({ expectedVersion: a.version, record: { ...a.record, token: 'fiction-new-token' }, buckets: { 'tasks-33': { '["task-status","a"]': { value: '虚构新任务' } } } });
    await assert.rejects(two.writeTransaction({ expectedVersion: b.version, record: b.record, buckets: { projects: {} } }), { code: 'stale' });
    await two.updateMetadata(r => { r.settings.extra = '虚构新设置'; });
    const saved = await one.read();
    assert.equal(saved.token, 'fiction-new-token'); assert.equal(saved.state.units['["task-status","a"]'].value, '虚构新任务');
    assert.equal(saved.settings.extra, '虚构新设置'); assert.deepEqual(saved.pendingSnapshots, initial.pendingSnapshots);
  });
}

test('内存计数：指定桶写入与空元数据事务不读取其他桶或待发布正文', async () => {
  const store = new MemoryStore(bucketRecord()); await store.initialize(); store.resetStats();
  const meta = await store.readMetadata();
  await store.writeTransaction({ expectedVersion: meta.version, record: meta.record, buckets: { 'tasks-33': { '["task-status","a"]': { value: '虚构修改' } } } });
  assert.equal(store.stats.bucketReads, 0); assert.equal(store.stats.bucketWrites, 1);
  assert.equal(store.stats.pendingReads, 0); assert.equal(store.stats.pendingWrites, 0);
  store.resetStats(); await store.updateMetadata(() => {});
  assert.equal(store.stats.bucketReads + store.stats.bucketWrites + store.stats.pendingReads + store.stats.pendingWrites, 0);
});

for (const kind of ['memory', 'indexeddb-double']) {
  test(kind + '：真实协议的已加入旧封套（seen/merged/basis/发布计数/计划原字节）迁移逐项不变', async () => {
    const { plannerToState } = await import('../../sync/convert.js');
    const pack = await import('../../sync/pack.js');
    const state = plannerToState({ tasks: [{ id: 't', title: '虚构任务', done: false }], projects: [{ id: 'p', name: '虚构项目' }] }, 'fiction-desktop', 1);
    const chunks = await Promise.all(Object.values(pack.splitState(state)).map(pack.createChunk));
    const hashes = Object.fromEntries(chunks.map(c => [c.chunk.bucket, c.hash]));
    const manifest = await pack.createManifest('fiction-phone', 7, hashes, { 'fiction-desktop': 4 });
    const initial = { ...freshRecord(), settings: { joined: true, deviceId: 'fiction-phone', taskUI: { mode: 'project' }, reviewUI: { tab: 'week' } }, token: 'fiction-token',
      state: { format: 'yema-engine-local', schema: 1, device: 'fiction-phone', joined: true, state, revision: 9, sequence: 7, seen: { 'fiction-desktop': 4 },
        published: { sequence: 6, revision: 8, buckets: hashes }, lastPublishedAt: 1, confirmed: [], repositoryId: 'fiction/repo', merged: { 'fiction-desktop': { sequence: 4, buckets: hashes } }, basis: hashes, generation: 12 },
      pendingSnapshots: [{ format: 'yema-pending-pack', device: 'fiction-phone', revision: 9, manifest: { path: manifest.path, text: manifest.text }, chunks: chunks.map(c => ({ path: c.path, text: c.text })) }] };
    const fake = kind === 'memory' ? null : fakeDatabase(initial), store = fake ? new IndexedDBStore(fake.db) : new MemoryStore(initial);
    await store.initialize(); assert.deepEqual(await store.read(), initial);
    const meta = await store.readMetadata(); assert.deepEqual(meta.record.state.state.units, {}); assert.equal(meta.record.state.joined, true);
    assert.equal(JSON.stringify(meta).includes(manifest.text), false);
    await store.updateMetadata(r => { r.settings.extra = '虚构设置'; });
    assert.deepEqual(await store.readPending(), initial.pendingSnapshots);
  });
}

test('不透明旧数据的原型同名单元键也原样保留，不因字典拼装丢失或改变原型', async () => {
  const state = { schema: 1, units: JSON.parse('{"__proto__":{"fiction":true},"constructor":{"fiction":"保留"}}'), archives: {} };
  const store = new MemoryStore({ ...freshRecord(), state });
  const saved = await store.read(); assert.deepEqual(saved.state, state);
  assert.equal(Object.hasOwn(saved.state.units, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(saved.state.units), Object.prototype); assert.equal({}.fiction, undefined);
});

test('IndexedDB 打开版本2以关闭旧客户端连接，已有records不重建，仍完整转换root', async () => {
  const initial = bucketRecord(), fake = fakeDatabase(initial), request = {}; let version, created = false;
  fake.db.objectStoreNames = { contains: name => name === 'records' };
  fake.db.createObjectStore = () => { created = true; throw new Error('不应重建已有对象库'); };
  const opening = openStore({ indexedDB: { open(_name, number) { version = number; return request; } } });
  request.result = fake.db; request.onupgradeneeded(); request.onsuccess();
  const store = await opening; assert.equal(version, 2); assert.equal(created, false); assert.deepEqual(await store.read(), initial);
  assert.equal(fake.rows().has('root'), false); assert.equal(fake.rows().has('meta'), true);
});

test('dataVersion只随业务桶/业务头变化，同步确认/设置递增version但不伪装业务变化', async () => {
  const initial = bucketRecord(); initial.state = { format: 'yema-engine-local', state: initial.state, generation: 0, published: null };
  const store = new MemoryStore(initial), before = await store.readMetadata();
  const nextRecord = { ...before.record, state: { ...before.record.state, generation: 1, published: { sequence: 1 } } };
  const after = await store.writeTransaction({ expectedVersion: before.version, record: nextRecord });
  assert.ok(after.version > before.version); assert.equal(after.dataVersion, before.dataVersion);
  const changed = await store.writeTransaction({ expectedVersion: after.version, record: after.record, buckets: { 'tasks-33': { '["task-status","a"]': { value: '虚构修改' } } } });
  assert.ok(changed.dataVersion > after.dataVersion);
});
