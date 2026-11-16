// 合并完整的同步状态，保留因果上并发的版本和不可变归档引用。
// 同值版本合为一个显示候选，但保留来源向量，保证三方合并仍满足结合律。
import { canonical, clone, exactKeys, object, own, put } from './canonical.js';
import { assertDevice, assertVV, compare, join } from './vv.js';

export function emptyState() { return { schema: 1, units: {}, archives: {} }; }
const valueKey = version => canonical({ deleted: version.deleted, value: version.value });
export function branchKey(version) { return valueKey(version); }

function assertStamp(stamp) {
  if (!object(stamp) || !Number.isSafeInteger(stamp.updatedAt) || stamp.updatedAt < 0) throw new TypeError('stamp.updatedAt 必须为非负 UTC 毫秒');
  canonical(stamp);
}
function atoms(unit) {
  if (!exactKeys(unit, ['versions']) || !Array.isArray(unit.versions) || !unit.versions.length) throw new TypeError('单元至少需要一个版本');
  const result = [];
  for (const version of unit.versions) {
    if (!exactKeys(version, ['vv', 'deleted', 'value', 'sources']) || typeof version.deleted !== 'boolean' || !Array.isArray(version.sources) || !version.sources.length) throw new TypeError('并存版本格式错误');
    assertVV(version.vv);
    canonical(version.value);
    if (version.deleted && version.value !== null) throw new TypeError('墓碑的 value 必须为 null');
    for (const source of version.sources) {
      if (!exactKeys(source, ['vv', 'stamp'])) throw new TypeError('因果来源格式错误');
      assertVV(source.vv);
      assertStamp(source.stamp);
      result.push({ deleted: version.deleted, value: version.value, vv: source.vv, stamp: source.stamp });
    }
    if (canonical(version.vv) !== canonical(join(...version.sources.map(source => source.vv)))) throw new TypeError('合成向量与来源不符');
  }
  return result;
}

function combineUnits(...units) {
  const unique = new Map();
  for (const atom of units.flatMap(atoms)) {
    const key = canonical(atom.vv), previous = unique.get(key);
    if (previous && valueKey(previous) !== valueKey(atom)) throw new TypeError('同一因果版本含不同取值：设备号可能被复用');
    if (!previous || canonical(atom.stamp) < canonical(previous.stamp)) unique.set(key, atom);
  }
  const candidates = [...unique.values()];
  const maximal = candidates.filter(a => !candidates.some(b => compare(b.vv, a.vv) === 'after'));
  const grouped = new Map();
  for (const atom of maximal) {
    const key = valueKey(atom);
    if (!grouped.has(key)) grouped.set(key, { deleted: atom.deleted, value: atom.value, sources: [] });
    grouped.get(key).sources.push({ vv: atom.vv, stamp: atom.stamp });
  }
  const versions = [...grouped.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, version]) => {
    version.sources.sort((a, b) => canonical(a.vv) < canonical(b.vv) ? -1 : 1);
    return { vv: join(...version.sources.map(source => source.vv)), ...version };
  });
  return { versions };
}

function assertTop(state) {
  if (!exactKeys(state, ['schema', 'units', 'archives']) || state.schema !== 1 || !object(state.units) || !object(state.archives)) throw new TypeError('不支持的状态结构');
  for (const key of Object.keys(state.units)) {
    let path;
    try { path = JSON.parse(key); } catch { throw new TypeError('单元键不是规范数组文本'); }
    if (!Array.isArray(path) || !path.length || path.some(part => typeof part !== 'string') || canonical(path) !== key) throw new TypeError('单元键不是规范字符串数组');
  }
  for (const [name, ref] of Object.entries(state.archives)) {
    assertDevice(ref.device);
    if (!exactKeys(ref, ['hash', 'stateHash', 'year', 'device', 'sequence']) || !/^[0-9a-f]{64}$/.test(ref.hash) || !/^[0-9a-f]{64}$/.test(ref.stateHash) || !/^\d{4}$/.test(ref.year) || ref.year === '0000' || !Number.isSafeInteger(ref.sequence) || ref.sequence < 1) throw new TypeError('归档引用格式错误');
    if (name !== ref.device + '--' + ref.sequence + '--' + ref.hash + '--archive-' + ref.year + '.json') throw new TypeError('归档引用名称不符');
  }
}

export function merge(a, b) {
  assertTop(a); assertTop(b);
  const units = {}, archives = {};
  for (const key of [...new Set([...Object.keys(a.units), ...Object.keys(b.units)])].sort()) {
    const list = [];
    if (own(a.units, key)) list.push(a.units[key]);
    if (own(b.units, key)) list.push(b.units[key]);
    put(units, key, combineUnits(...list));
  }
  for (const key of [...new Set([...Object.keys(a.archives), ...Object.keys(b.archives)])].sort()) {
    if (own(a.archives, key) && own(b.archives, key) && canonical(a.archives[key]) !== canonical(b.archives[key])) throw new TypeError('不可变归档引用被改写');
    put(archives, key, own(a.archives, key) ? a.archives[key] : b.archives[key]);
  }
  return clone({ schema: 1, units, archives });
}
export function normalize(state) { return merge(state, emptyState()); }
export function assertState(state) {
  if (canonical(normalize(state)) !== canonical(state)) throw new TypeError('状态未规范化');
}

// 活值优先于墓碑，其余按含 deleted/value 的规范文本升序。时间不参与排序。
export function unitInfo(unit) {
  if (!unit) return { preferred: null, conflict: false, deleteConflict: false, alternatives: [] };
  const normalized = combineUnits(unit), alternatives = clone(normalized.versions);
  const preferred = alternatives.find(version => !version.deleted) || alternatives[0];
  return { preferred, alternatives, conflict: alternatives.length > 1,
    deleteConflict: alternatives.some(version => version.deleted) && alternatives.some(version => !version.deleted) };
}
export function displayStamp(version) { return clone(version.sources[0].stamp); }
