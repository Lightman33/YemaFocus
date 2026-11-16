// 本机编辑与合并分开：调用方提供设备号、时间和取值。
// 未解决的冲突需要明确选择分支；只有 resolveUnit 会覆盖全部已知分支。
import { canonical, clone, own, put, unitKey } from './canonical.js';
import { branchKey, emptyState, normalize, unitInfo } from './merge.js';
import { assertDevice, contains, join } from './vv.js';

function edit(state, key, device, value, stamp, options) {
  assertDevice(device);
  if (typeof key !== 'string' || !key.length) throw new TypeError('单元键不能为空');
  const result = normalize(state), current = own(result.units, key) ? result.units[key] : null, info = unitInfo(current);
  let selected;
  if (options.resolve) selected = info.alternatives;
  else if (options.base !== undefined) {
    selected = info.alternatives.filter(version => typeof options.base === 'string' ? branchKey(version) === options.base : canonical(version.vv) === canonical(options.base));
    if (selected.length !== 1) throw new TypeError('所选分支已经变化，请重新读取');
  } else {
    if (info.conflict) throw new TypeError('请先选择编辑分支或明确解决冲突');
    selected = info.alternatives;
  }
  const observed = join(...info.alternatives.map(version => version.vv));
  const vv = join(...selected.map(version => version.vv));
  const next = (own(observed, device) ? observed[device] : 0) + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError('设备计数用尽，请更换设备号');
  vv[device] = next;
  if (!options.resolve && info.alternatives.some(version => !selected.includes(version) && version.sources.some(source => contains(vv, source.vv)))) throw new TypeError('此编辑会覆盖未选择的来源，请明确解决冲突');
  const version = { vv, deleted: options.deleted === true, value: options.deleted ? null : clone(value), sources: [{ vv: clone(vv), stamp: clone(stamp) }] };
  put(result.units, key, { versions: [...(current ? current.versions : []), version] });
  return normalize(result);
}
export function createUnit(state, key, device, value, stamp = { updatedAt: 0 }) {
  if (Object.hasOwn(state.units, key)) throw new TypeError('单元已存在（含墓碑），请使用修改或恢复操作');
  return edit(state, key, device, value, stamp, {});
}
export function updateUnit(state, key, device, value, stamp = { updatedAt: 0 }, options = {}) {
  return edit(state, key, device, value, stamp, options);
}
export function deleteUnit(state, key, device, stamp = { updatedAt: 0 }, options = {}) {
  return edit(state, key, device, null, stamp, { ...options, deleted: true });
}
export function resolveUnit(state, key, device, value, stamp = { updatedAt: 0 }, options = {}) {
  if (!Object.hasOwn(state.units, key)) throw new TypeError('不能解决不存在的单元');
  return edit(state, key, device, value, stamp, { ...options, resolve: true });
}
export function derivedId(kind, ...parts) {
  // 编号不能含 |，因为电脑版番茄关联格式是 id|标题。
  // 规范文本全为 ASCII，十六进制编码可逆且无分隔歧义。
  return 'd1-' + Array.from(unitKey('derived', kind, ...parts), character => character.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
export function occurrenceId(series, day) { return derivedId('occurrence', series, day); }
export { emptyState };
