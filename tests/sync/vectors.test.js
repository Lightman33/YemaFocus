// 向量的期望状态和哈希是静态跨语言夹具，测试逐个读取。
// SHA-256 同时用独立的 Node 标准实现核对 Web Crypto 的结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonical, clone } from '../../sync/canonical.js';
import { merge, assertState, unitInfo } from '../../sync/merge.js';
import { sha256 } from '../../sync/snapshot.js';
import { resolveUnit, updateUnit, deleteUnit } from '../../sync/edit.js';
import { partitionSummary } from '../../sync/records.js';

// 当前测试位于 web/tests/sync，向量位于仓库根的 sync-spec。
const vectorsDirectory = new URL('../../../sync-spec/vectors/', import.meta.url);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
test('跨语言共用向量', async t => {
const names = (await readdir(vectorsDirectory)).filter(name => name.endsWith('.json')).sort();
assert.ok(names.length >= 31, '必须实际加载全部向量');
for (const name of names) {
  const vector = JSON.parse(await readFile(new URL(name, vectorsDirectory), 'utf8'));
  await t.test('向量 ' + name + '：' + vector.name, async () => {
    vector.inputs.forEach(assertState); assertState(vector.expected);
    const inputs = freeze(clone(vector.inputs));
    let result = inputs.reduce(merge);
    assert.deepEqual(result, vector.expected);
    assert.equal(canonical(result), vector.expectedCanonical);
    assert.equal(await sha256(result), vector.expectedSha256);
    assert.equal(createHash('sha256').update(vector.expectedCanonical, 'utf8').digest('hex'), vector.expectedSha256);
    assert.deepEqual(inputs, vector.inputs);
    assert.deepEqual(merge(inputs[1], inputs[0]), merge(inputs[0], inputs[1]));
    assert.deepEqual(merge(result, result), result);
    if (inputs.length === 3) {
      for (const [a, b, c] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        assert.deepEqual(merge(merge(inputs[a], inputs[b]), inputs[c]), vector.expected);
        assert.deepEqual(merge(inputs[a], merge(inputs[b], inputs[c])), vector.expected);
      }
    }
    if (vector.partition) assert.deepEqual(partitionSummary(result), vector.partition);
    if (vector.preferred) for (const [key, expected] of Object.entries(vector.preferred)) {
      const info = unitInfo(result.units[key]);
      assert.deepEqual({ value: info.preferred.value, deleted: info.preferred.deleted, conflict: info.conflict, deleteConflict: info.deleteConflict }, expected);
    }
    if (vector.edit) {
      const operation = { resolve: resolveUnit, update: updateUnit, delete: deleteUnit }[vector.edit.operation];
      const { key, device, value, stamp, options } = vector.edit;
      const execute = () => vector.edit.operation === 'delete' ? operation(result, key, device, stamp, options) : operation(result, key, device, value, stamp, options);
      if (vector.edit.expectedError) {
        assert.throws(execute, error => error.message.includes(vector.edit.expectedError));
        assert.deepEqual(result, vector.expected);
        return;
      }
      result = execute();
      assert.deepEqual(result, vector.edit.expected);
      assert.equal(await sha256(result), vector.edit.expectedSha256);
    }
  });
}
});
