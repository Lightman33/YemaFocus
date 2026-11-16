import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonical, unitKey as K } from '../../sync/canonical.js';
import { emptyState } from '../../sync/merge.js';
import { createUnit, updateUnit } from '../../sync/edit.js';
import * as pack from '../../sync/pack.js';

const vectors = name => readFile(new URL('../../../sync-spec/pack-vectors/' + name, import.meta.url), 'utf8').then(JSON.parse);

test('每种单元键、UTF-16、非法/未知键有固定分桶向量', async () => {
  for (const row of await vectors('bucket-vectors.json')) assert.equal(pack.bucketOf(row.key), row.bucket, row.description);
  for (const key of ['bad', '{}', '["task-content", 2]', '[ "root", "x" ]']) assert.equal(pack.bucketOf(key), 'other');
});
test('固定状态逐字节拆块、清单、独立SHA及往返', async () => {
  const v = await vectors('state-vectors.json');
  assert.equal(canonical(v.state), v.stateCanonical);
  assert.equal(createHash('sha256').update(v.stateCanonical, 'ascii').digest('hex'), v.stateSha256);
  const chunks = pack.splitState(v.state), artifacts = [];
  for (const expected of v.chunks) {
    const got = await pack.createChunk(chunks[expected.chunk.bucket]);
    assert.deepEqual(got, expected);
    assert.equal(createHash('sha256').update(got.text, 'ascii').digest('hex'), expected.hash);
    assert.equal((await pack.verifyChunk(got.path, got.text)).ok, true);
    artifacts.push(got);
  }
  const manifest = await pack.createManifest(v.manifest.manifest.device, v.manifest.manifest.sequence,
    Object.fromEntries(artifacts.map(a => [a.chunk.bucket, a.hash])), v.manifest.manifest.seen);
  assert.deepEqual(manifest, v.manifest);
  assert.equal((await pack.verifyManifest(manifest.path, manifest.text)).ok, true);
  assert.equal(canonical(pack.joinChunks(artifacts.map(a => a.chunk))), v.stateCanonical);
});
test('不同设备拆相同状态得到同一块；改一任务只改一桶；不修改入参', async () => {
  let state = createUnit(emptyState(), K('task-content', 't1'), 'a', { title: '虚构甲' });
  state = createUnit(state, K('task-content', 't2'), 'a', { title: '虚构乙' });
  const before = canonical(state), parts = pack.splitState(state);
  assert.equal(canonical(pack.joinChunks(Object.values(parts))), before);
  const changed = pack.splitState(updateUnit(state, K('task-content', 't1'), 'b', { title: '虚构改' }));
  const hashes = async obj => Object.fromEntries(await Promise.all(Object.entries(obj).map(async ([k, c]) => [k, (await pack.createChunk(c)).hash])));
  const a = await hashes(parts), b = await hashes(changed);
  assert.equal(Object.keys(a).filter(k => a[k] !== b[k]).length, 1);
  assert.deepEqual(await hashes(pack.splitState(structuredClone(state))), a);
  assert.equal(canonical(state), before);
  assert.deepEqual(pack.joinChunks([]), emptyState());
});
test('路径严格解析，错误前缀/头/序号/归属/空桶/未知字段/archives拒绝', async () => {
  const v = await vectors('state-vectors.json'), a = v.chunks[0], m = v.manifest;
  assert.equal(pack.parseChunkPath(a.path).hash, a.hash);
  assert.equal(pack.parseManifestPath(m.path).sequence, 7);
  for (const path of [a.path.replace('/chunks/', '/chunks/../'), a.path.replace('/' + a.hash.slice(0, 2) + '/', '/zz/'), a.path.toUpperCase()]) assert.equal(pack.parseChunkPath(path), null);
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => pack.manifestPath('a', sequence, a.hash));
  assert.equal(pack.parseManifestPath(m.path.replace('/7--', '/07--')), null);
  assert.equal(pack.parseManifestPath(m.path.replace('/7--', '/9007199254740992--')), null);
  for (const text of [a.text + '\n', a.text.replace('schema', 'broken'), '\ufeff' + a.text]) assert.equal((await pack.verifyChunk(a.path, text)).ok, false);
  assert.equal((await pack.verifyManifest(m.path, m.text + ' ')).ok, false);
  await assert.rejects(pack.createManifest('a', 1, {}, { a: 1 }));
  await assert.rejects(pack.createManifest('a', 1, { evil: a.hash }));
  await assert.rejects(pack.createChunk({ ...a.chunk, extra: true }));
  await assert.rejects(pack.createChunk({ ...a.chunk, bucket: 'other' }));
  await assert.rejects(pack.createChunk({ ...a.chunk, units: {} }));
  assert.throws(() => pack.joinChunks([a.chunk, a.chunk]));
  assert.throws(() => pack.splitState({ ...v.state, archives: { bad: {} } }));
  assert.equal(pack.parseDevicePath(pack.devicePath('a--b')).device, 'a--b');
});
test('重新哈希也不能让非规范文本、错头和重复键过关', async () => {
  const { hashText } = await import('../../sync/snapshot.js');
  const v = await vectors('state-vectors.json'), a = v.chunks[0], m = v.manifest;
  for (const text of [a.text + '\n', a.text.replace('"schema":1', '"schema":1,"schema":1')]) {
    assert.equal((await pack.verifyChunk(pack.chunkPath(await hashText(text)), text)).ok, false);
  }
  assert.equal((await pack.verifyManifest(pack.manifestPath('wrong', 7, m.hash), m.text)).ok, false);
});

test('有效旧归档引用也明确拒绝，不能以清空archives悄悄迁移', () => {
  const hash = '0'.repeat(64), name = 'a--1--' + hash + '--archive-2025.json';
  const state = { schema: 1, units: {}, archives: { [name]: { device: 'a', sequence: 1, year: '2025', hash, stateHash: hash } } };
  assert.throws(() => pack.splitState(state), /不接受年度归档引用/);
});
