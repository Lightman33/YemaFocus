import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTransport } from '../../transport/memory.js';

const bytes = text => new TextEncoder().encode(text);

test('内存仓库：四项操作、中文路径、同级目录及副本隔离', async () => {
  const repo = new MemoryTransport();
  assert.deepEqual(await repo.list(''), []);
  const input = bytes('虚构数据');
  await repo.put('同步/快照.json', input);
  input.fill(0);
  await repo.put('同步/归档/一.json', bytes('归档'));
  await repo.put('同步2/别的.json', bytes('别的'));
  const entries = await repo.list('同步/');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '快照.json');
  assert.equal(entries[0].size, bytes('虚构数据').length);
  assert.match(entries[0].sha, /^memory-/);
  const downloaded = await repo.get('同步/快照.json');
  downloaded.fill(0);
  assert.deepEqual(await repo.get('同步/快照.json'), bytes('虚构数据'));
  await repo.remove('同步/快照.json');
  assert.deepEqual(await repo.list('同步'), []);
  await assert.rejects(repo.get('同步/快照.json'), { code: 'notfound' });
  await assert.rejects(repo.remove('同步/快照.json'), { code: 'notfound' });
  await assert.rejects(repo.list('不存在'), { code: 'notfound' });
});

test('内存仓库：幂等 put、不覆盖不同内容、空文件', async () => {
  const repo = new MemoryTransport();
  await repo.put('file', bytes('same'));
  await repo.put('file', bytes('same'));
  await assert.rejects(repo.put('file', bytes('diff')), { code: 'collision' });
  assert.deepEqual(await repo.get('file'), bytes('same'));
  await repo.put('empty', new ArrayBuffer(0));
  assert.deepEqual(await repo.get('empty'), new Uint8Array());
  await assert.rejects(repo.put('invalid', '文字'), { code: 'bytes' });
  await assert.rejects(repo.put('../invalid', bytes('x')), { code: 'path' });
});

for (const type of ['offline', 'timeout', 'ratelimit']) {
  test('内存仓库：' + type + ' 故障只在指定操作消费一次，中文错误不改文件', async () => {
    const repo = new MemoryTransport({ now: () => 123_000 });
    await repo.put('file', bytes('old'));
    repo.injectFault({ type, operation: 'put' });
    assert.deepEqual(await repo.get('file'), bytes('old'));
    await assert.rejects(repo.put('new', bytes('new')), error => {
      assert.equal(error.code, type);
      assert.match(error.message, /[\u4e00-\u9fff]/);
      if (type === 'ratelimit') assert.equal(error.retryAt, 183_000);
      return true;
    });
    await assert.rejects(repo.get('new'), { code: 'notfound' });
    await repo.put('new', bytes('new'));
    assert.deepEqual(await repo.get('new'), bytes('new'));
  });
}

for (const committed of [false, true]) {
  test('内存仓库：半途失联，committed=' + committed + '，不会出现半个文件', async () => {
    const repo = new MemoryTransport();
    repo.injectFault({ type: 'partial', operation: 'put', committed });
    await assert.rejects(repo.put('new', bytes('完整内容')), { code: 'offline' });
    if (committed) assert.deepEqual(await repo.get('new'), bytes('完整内容'));
    else await assert.rejects(repo.get('new'), { code: 'notfound' });
    await repo.put('new', bytes('完整内容'));
    assert.deepEqual(await repo.get('new'), bytes('完整内容'));
  });
  test('内存仓库：删除确认丢失，committed=' + committed, async () => {
    const repo = new MemoryTransport();
    await repo.put('old', bytes('内容'));
    repo.injectFault({ type: 'partial', operation: 'remove', committed });
    await assert.rejects(repo.remove('old'), { code: 'offline' });
    if (committed) await assert.rejects(repo.get('old'), { code: 'notfound' });
    else assert.deepEqual(await repo.get('old'), bytes('内容'));
  });
}

test('内存仓库：损坏内容可交由上层哈希检测，但仓库原件不变', async () => {
  const repo = new MemoryTransport();
  await repo.put('file', bytes('original'));
  repo.injectFault({ type: 'corrupt', operation: 'get' });
  assert.notDeepEqual(await repo.get('file'), bytes('original'));
  assert.deepEqual(await repo.get('file'), bytes('original'));
  await repo.put('empty', new Uint8Array());
  repo.injectFault({ type: 'corrupt', operation: 'get' });
  assert.equal((await repo.get('empty')).length, 1);
});

test('内存仓库：连接测试成功与故障都返回结果，不产生写入', async () => {
  const repo = new MemoryTransport();
  assert.equal((await repo.test()).ok, true);
  repo.injectFault({ type: 'offline', operation: 'test' });
  assert.equal((await repo.test()).code, 'offline');
  assert.deepEqual(await repo.list(''), []);
  assert.throws(() => repo.injectFault({ type: 'unknown' }), { code: 'fault' });
});
