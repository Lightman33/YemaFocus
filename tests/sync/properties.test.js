// 固定种子模拟多设备编辑、断续互传和冲突选择。
// 检查代数性质、最后收敛、编辑可追溯以及重复冲突的空间上界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, clone, unitKey } from '../../sync/canonical.js';
import { branchKey, emptyState, merge, normalize, unitInfo } from '../../sync/merge.js';
import { createUnit, updateUnit, deleteUnit, resolveUnit } from '../../sync/edit.js';
import { assertVV, compare, contains, join } from '../../sync/vv.js';

function generator(seed) {
  let value = seed >>> 0;
  return max => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return Math.floor((value >>> 0) / 4294967296 * max);
  };
}
function equal(a, b, context) { assert.equal(canonical(a), canonical(b), context); }
const keys = Array.from({ length: 5 }, (_, i) => unitKey('fiction', String(i)));

test('500 组固定种子随机历史：可交换、可结合、幂等、收敛、编辑不丢失', t => {
  const random = generator(0x291113);
  let editCount = 0, mergeCount = 0, explicitChoices = 0;
  for (let trial = 0; trial < 500; trial++) {
    const count = 2 + random(2), devices = ['a', 'b', 'c'].slice(0, count);
    const replicas = devices.map(() => emptyState()), events = [];
    for (let step = 0; step < 24; step++) {
      const index = random(count), device = devices[index];
      if (random(4) === 0) {
        const other = (index + 1 + random(count - 1)) % count;
        replicas[index] = merge(replicas[index], replicas[other]); mergeCount++;
      } else {
        const key = keys[random(keys.length)], old = replicas[index], info = unitInfo(old.units[key]);
        const stamp = { updatedAt: random(100000) }, operation = random(8);
        const value = { text: ['甲', '乙', '丙', '相同'][random(4)], amount: random(4), unknown: { future: random(3) } };
        const options = info.conflict ? { base: info.alternatives[random(info.alternatives.length)].vv } : {};
        try {
          if (operation === 0) replicas[index] = deleteUnit(old, key, device, stamp, options);
          else if (operation === 1 && info.conflict) replicas[index] = resolveUnit(old, key, device, value, stamp);
          else replicas[index] = updateUnit(old, key, device, value, stamp, options);
        } catch (error) {
          // 模拟界面收到拒绝后明确选择解决，不把拒绝当成成功编辑。
          assert.equal(error.message, '此编辑会覆盖未选择的来源，请明确解决冲突');
          replicas[index] = resolveUnit(old, key, device, operation === 0 ? null : value, stamp, { deleted: operation === 0 });
          explicitChoices++;
        }
        const versions = replicas[index].units[key].versions;
        const maxOwn = Math.max(...versions.flatMap(version => version.sources.map(source => source.vv[device] || 0)));
        const version = versions.find(version => version.sources.some(source => source.vv[device] === maxOwn));
        const source = version.sources.find(source => source.vv[device] === maxOwn);
        events.push({ key, vv: source.vv, value: version.value, deleted: version.deleted }); editCount++;
      }
      if (step % 6 === 0) {
        const [a, b, c = emptyState()] = replicas;
        const saved = replicas.map(canonical);
        equal(merge(a, b), merge(b, a), '交换律，第 ' + trial + ' 组');
        equal(merge(merge(a, b), c), merge(a, merge(b, c)), '结合律，第 ' + trial + ' 组');
        equal(merge(a, a), a, '幂等律，第 ' + trial + ' 组');
        assert.deepEqual(replicas.map(canonical), saved, '不修改输入');
      }
    }
    const [a, b, c = emptyState()] = replicas;
    equal(merge(a, b), merge(b, a), '最终交换律');
    equal(merge(merge(a, b), c), merge(a, merge(b, c)), '最终结合律');
    replicas.forEach(replica => equal(merge(replica, replica), replica, '最终幂等律'));
    const all = replicas.reduce(merge);
    for (let i = 0; i < count; i++) {
      let result = replicas[i];
      for (let j = count - 1; j >= 0; j--) result = merge(result, replicas[j]);
      equal(result, all, '最终互传收敛');
    }
    for (const event of events) {
      const survivors = all.units[event.key].versions.flatMap(version => version.sources.map(source => ({ ...source, value: version.value, deleted: version.deleted })));
      assert.ok(survivors.some(source => contains(source.vv, event.vv) &&
        (canonical(source.vv) !== canonical(event.vv) || (source.deleted === event.deleted && canonical(source.value) === canonical(event.value)))),
      '编辑必须仍可见、在冲突中或被因果更新覆盖');
    }
  }
  assert.ok(editCount >= 7500); assert.ok(mergeCount >= 1500);
  t.diagnostic('500 组；随机编辑 ' + editCount + ' 次；随机单向合并 ' + mergeCount + ' 次；额外明确选择 ' + explicitChoices + ' 次');
});

test('同一冲突重传一百次：两个候选，快照逐字节不变', () => {
  const key = keys[0], a = updateUnit(emptyState(), key, 'a', '甲'), b = updateUnit(emptyState(), key, 'b', '乙');
  let result = merge(a, b); const original = canonical(result);
  for (let i = 0; i < 100; i++) {
    result = merge(merge(result, a), b);
    assert.equal(result.units[key].versions.length, 2);
    assert.equal(canonical(result), original);
  }
});

test('未解决的两个分支各续写一百次：只保留最新的两份', () => {
  const key = keys[0];
  let a = updateUnit(emptyState(), key, 'a', '甲'), b = updateUnit(emptyState(), key, 'b', '乙');
  let largest = 0;
  for (let i = 0; i < 100; i++) {
    a = updateUnit(a, key, 'a', '甲'); b = updateUnit(b, key, 'b', '乙');
    const result = merge(a, b);
    assert.equal(result.units[key].versions.length, 2);
    assert.equal(result.units[key].versions.flatMap(version => version.sources).length, 2);
    largest = Math.max(largest, canonical(result).length);
  }
  assert.ok(largest < 500, '大小只因计数位数多出几个字节，不积累百次历史');
});

test('相同值两个来源重传一百次：只有一个显示候选', () => {
  const key = keys[0], a = updateUnit(emptyState(), key, 'a', '相同'), b = updateUnit(emptyState(), key, 'b', '相同');
  let result = merge(a, b); const original = canonical(result);
  for (let i = 0; i < 100; i++) result = merge(merge(result, a), b);
  assert.equal(canonical(result), original);
  assert.equal(result.units[key].versions.length, 1);
  assert.equal(result.units[key].versions[0].sources.length, 2);
});
test('冲突每次传到两端后各改原分支一百次：仍只保留两份', () => {
  const key = keys[0];
  let current = merge(updateUnit(emptyState(), key, 'a', '甲'), updateUnit(emptyState(), key, 'b', '乙'));
  for (let i = 0; i < 100; i++) {
    const versions = current.units[key].versions;
    const a = updateUnit(current, key, 'a', '甲', { updatedAt: 0 }, { base: branchKey(versions.find(version => version.value === '甲')) });
    const b = updateUnit(current, key, 'b', '乙', { updatedAt: 0 }, { base: branchKey(versions.find(version => version.value === '乙')) });
    current = merge(a, b);
    assert.equal(current.units[key].versions.length, 2);
    assert.equal(current.units[key].versions.flatMap(version => version.sources).length, 2);
    assert.ok(canonical(current).length < 500);
  }
});
test('同值合成上下文不能在普通编辑时悄悄覆盖另一候选', () => {
  const key = keys[0];
  const version = (value, vectors) => ({ value, deleted: false, vv: Object.fromEntries(['a', 'b'].map(device => [device, Math.max(...vectors.map(vv => vv[device] || 0))]).filter(([, count]) => count > 0)), sources: vectors.map(vv => ({ vv, stamp: { updatedAt: 0 } })) });
  const state = normalize({ schema: 1, archives: {}, units: { [key]: { versions: [version('甲', [{ a: 2 }, { b: 2 }]), version('乙', [{ a: 1, b: 1 }])] } } });
  const base = branchKey(state.units[key].versions.find(version => version.value === '甲'));
  assert.throws(() => updateUnit(state, key, 'c', '甲续写', { updatedAt: 0 }, { base }), /未选择/);
  assert.equal(resolveUnit(state, key, 'c', '明确选甲').units[key].versions.length, 1);
});

test('防止无意解决冲突、重用设备版本或清空墓碑', () => {
  const key = keys[0], a = createUnit(emptyState(), key, 'a', '甲'), b = createUnit(emptyState(), key, 'b', '乙'), both = merge(a, b);
  assert.throws(() => updateUnit(both, key, 'a', '丙'), /分支/);
  assert.throws(() => deleteUnit(both, key, 'a'), /分支/);
  assert.throws(() => updateUnit(both, key, 'a', '丙', { updatedAt: 0 }, { base: { a: 900 } }), /变化/);
  assert.throws(() => createUnit(a, key, 'a', '别的'), /已存在/);
  assert.throws(() => merge(a, createUnit(emptyState(), key, 'a', '不合法分叉')), /设备号/);
  const dead = deleteUnit(a, key, 'a');
  equal(merge(dead, a), dead, '旧值不能复活');
  assert.throws(() => createUnit(dead, key, 'b', '复活'), /已存在/);
  assert.equal(unitInfo(updateUnit(dead, key, 'a', '明确恢复').units[key]).preferred.value, '明确恢复');
  const saved = clone(both); resolveUnit(both, key, 'c', '选定'); assert.deepEqual(both, saved);
});
test('向量缺项、逐项取大、非法计数和安全整数上界', () => {
  assert.equal(compare({ a: 1 }, { a: 1 }), 'equal');
  assert.equal(compare({ a: 2, b: 1 }, { a: 1 }), 'after');
  assert.equal(compare({ a: 1 }, { b: 1 }), 'concurrent');
  assert.deepEqual(join({ a: 2 }, { a: 1, b: 4 }), { a: 2, b: 4 });
  for (const vv of [{}, { a: 0 }, { a: -1 }, { a: 0.5 }, { a: 9007199254740992 }, { 'bad/device': 1 }]) assert.throws(() => assertVV(vv));
  const key = keys[0], state = updateUnit(emptyState(), key, 'a', '甲');
  state.units[key].versions[0].vv.a = Number.MAX_SAFE_INTEGER;
  state.units[key].versions[0].sources[0].vv.a = Number.MAX_SAFE_INTEGER;
  assert.throws(() => updateUnit(state, key, 'a', '乙'), /计数用尽/);
});
