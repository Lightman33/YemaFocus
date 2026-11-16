// 实际运行规范编码、Web Crypto 和损坏输入校验；不访问网络或 DOM。
// 用归档往返验证旧明细和离线编辑仍可恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { canonical, unitKey } from '../../sync/canonical.js';
import { emptyState, merge } from '../../sync/merge.js';
import { updateUnit, deleteUnit } from '../../sync/edit.js';
import { createSnapshot, verifySnapshot, verifyArchive, hydrateArchive, sha256, hashText, fileName, parseFileName } from '../../sync/snapshot.js';
import { RECORD_WINDOW_KEY, firstRecordDay, partitionRecords } from '../../sync/records.js';
import { parseCsv, stateToCsv } from '../../sync/convert.js';

test('规范序列化是手工规定的码元排序和小写转义，整数不用指数', async () => {
  const data = { '2': 2, '10': 10, a: '中文😀\n"\\\t\b\f', z: 9007199254740991 };
  const expected = '{"10":10,"2":2,"a":"\\u4e2d\\u6587\\ud83d\\ude00\\u000a\\"\\\\\\u0009\\u0008\\u000c","z":9007199254740991}';
  assert.equal(canonical(data), expected);
  assert.equal(await sha256(data), createHash('sha256').update(expected, 'utf8').digest('hex'));
  for (const value of [1.5, -0, NaN, Infinity, undefined, { a: undefined }, 9007199254740992, new Date(0), Array(2)]) assert.throws(() => canonical(value));
  assert.equal(canonical(JSON.parse('{"__proto__":{"x":1},"a":2}')), '{"__proto__":{"x":1},"a":2}');
});
test('快照生成、解析和校验；内容损坏、截断、头不符都拒绝', async () => {
  const state = updateUnit(emptyState(), unitKey('root', 'fiction'), 'pc', { note: '虚构😀' });
  const before = canonical(state), made = await createSnapshot(state, 'pc', 10);
  assert.equal(canonical(state), before);
  assert.equal(made.hash, await hashText(made.text));
  assert.deepEqual(parseFileName(made.fileName), { device: 'pc', sequence: 10, hash: made.hash, year: null });
  assert.equal((await verifySnapshot(made.fileName, made.text)).ok, true);
  assert.equal((await verifySnapshot(made.fileName, made.text.replace('fiction', 'wrong'))).ok, false);
  assert.equal((await verifySnapshot(made.fileName, made.text.slice(0, -2))).ok, false);
  assert.equal((await verifySnapshot(fileName('other', 10, made.hash), made.text)).ok, false);
  const spaced = made.text + '\n';
  assert.equal((await verifySnapshot(fileName('pc', 10, await hashText(spaced)), spaced)).ok, false);
  const duplicate = made.text.replace('"schema":1', '"schema":1,"schema":1');
  assert.equal((await verifySnapshot(fileName('pc', 10, await hashText(duplicate)), duplicate)).ok, false);
  const unsupported = { ...made.snapshot, schema: 99 }, unsupportedText = canonical(unsupported);
  assert.equal((await verifySnapshot(fileName('pc', 10, await hashText(unsupportedText)), unsupportedText)).ok, false);
});
test('文件名参数拒绝路径、超大序号、伪哈希和不规范数字', () => {
  for (const name of ['../pc--1--' + '0'.repeat(64) + '.json', 'PC--1--' + '0'.repeat(64) + '.json', 'pc--01--' + '0'.repeat(64) + '.json', 'pc--9007199254740992--' + '0'.repeat(64) + '.json', 'pc--1--' + 'A'.repeat(64) + '.json']) assert.equal(parseFileName(name), null);
  for (const args of [['pc', 0, '0'.repeat(64)], ['pc', 1.5, '0'.repeat(64)], ['pc', 1, 'bad'], ['../pc', 1, '0'.repeat(64)]]) assert.throws(() => fileName(...args));
  assert.deepEqual(parseFileName(fileName('a--b', 12, '0'.repeat(64))), { device: 'a--b', sequence: 12, hash: '0'.repeat(64), year: null });
});
function record(day, title = '练习') { return { day, columns: ['番茄', day + ' 09:00:00', day + ' 09:25:00', '25', title, '完成', '', ''] }; }
test('90 天主快照、年度归档、懒加载引用、重复发布复用、旧记录后改', async () => {
  let state = updateUnit(emptyState(), RECORD_WINDOW_KEY, 'pc', { asOfDay: '2026-11-13' });
  const oldKey = unitKey('record', 'old'), recentKey = unitKey('record', 'recent');
  state = updateUnit(state, oldKey, 'pc', record('2025-01-01'));
  state = updateUnit(state, recentKey, 'pc', record('2026-11-13'));
  const made = await createSnapshot(state, 'pc', 1);
  assert.equal(made.archives.length, 1); assert.equal(Object.hasOwn(made.snapshot.state.units, oldKey), false);
  assert.equal(Object.hasOwn(made.snapshot.state.units, recentKey), true);
  assert.equal((await verifySnapshot(made.fileName, made.text)).ok, true);
  const archive = made.archives[0], ref = made.snapshot.state.archives[archive.fileName];
  assert.equal((await verifySnapshot(archive.fileName, archive.text)).ok, true);
  const verified = await verifyArchive(archive.fileName, ref, archive.text);
  assert.equal(verified.ok, true);
  const loaded = hydrateArchive(made.snapshot.state, verified);
  assert.deepEqual(loaded.units[oldKey], state.units[oldKey]);
  assert.throws(() => stateToCsv(made.snapshot.state), /全部年度归档/);
  const fullRows = parseCsv(stateToCsv(loaded, { archivesHydrated: true }));
  assert.equal(fullRows.length, 3, '完整导出包含表头、旧明细和新明细');
  assert.ok(fullRows.some(row => row[1] === '2025-01-01 09:00:00'));
  assert.equal((await createSnapshot(loaded, 'pc', 2)).archives.length, 0, '同年相同状态复用已有不可变文件');
  const lazy = await createSnapshot(made.snapshot.state, 'phone', 1);
  assert.deepEqual(lazy.snapshot.state.archives, made.snapshot.state.archives, '未下载归档也必须传递引用');
  const edited = updateUnit(loaded, oldKey, 'phone', record('2025-01-01', '补充后的练习'));
  const next = await createSnapshot(edited, 'phone', 2);
  assert.equal(next.archives.length, 1);
  let restored = next.snapshot.state;
  for (const item of [archive, ...next.archives]) restored = hydrateArchive(restored, await verifyArchive(item.fileName, restored.archives[item.fileName], item.text));
  assert.equal(restored.units[oldKey].versions.length, 1);
  assert.equal(restored.units[oldKey].versions[0].value.columns[4], '补充后的练习');
  assert.equal((await verifyArchive(archive.fileName, ref, archive.text + 'x')).ok, false);
  assert.throws(() => hydrateArchive(state, { ok: false }));
  assert.deepEqual(merge(made.snapshot.state, made.snapshot.state), made.snapshot.state);
});
test('窗口不读时钟，必须显式设置；墓碑与跨年冲突都留主状态', async () => {
  const key = unitKey('record', 'old');
  const raw = updateUnit(emptyState(), key, 'a', record('2025-01-01'));
  assert.throws(() => partitionRecords(raw), /record-window/);
  let base = updateUnit(raw, RECORD_WINDOW_KEY, 'a', { asOfDay: '2026-11-13' });
  const deleted = deleteUnit(base, key, 'a');
  assert.equal(Object.hasOwn(partitionRecords(deleted).recent.units, key), true);
  const a = updateUnit(base, key, 'a', record('2024-01-01')), b = updateUnit(base, key, 'b', record('2025-01-01', '另一份'));
  assert.equal(Object.hasOwn(partitionRecords(merge(a, b)).recent.units, key), true);
  assert.equal(firstRecordDay('2024-03-01'), '2023-12-03');
  assert.equal(firstRecordDay('0001-01-01'), '0001-01-01');
});
test('同步模块仅有本地 ESM 依赖，不引用 DOM、网络、文件和当前时间', async () => {
  const directory = new URL('../../sync/', import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith('.js'));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const text = await readFile(new URL(file, directory), 'utf8');
    assert.doesNotMatch(text, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|indexedDB|document|navigator|process|require)\s*[.(]|\bDate\s*[.(]|Math\s*\.\s*random|node:/, file);
    for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('./'), file + ' 的导入必须本地化');
  }
});
