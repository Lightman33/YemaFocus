// 版本向量只描述因果关系，不使用设备时钟。
// 缺项等于零；规范格式不写零项，防止一种向量出现多种文本。
import { object, own } from './canonical.js';

export function assertDevice(device) {
  if (typeof device !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(device)) throw new TypeError('设备号须为 1–64 位小写字母、数字或连字符');
}
export function assertVV(vv) {
  if (!object(vv) || !Object.keys(vv).length) throw new TypeError('单元版本向量不能为空');
  for (const [device, count] of Object.entries(vv)) {
    assertDevice(device);
    if (!Number.isSafeInteger(count) || count <= 0) throw new TypeError('版本计数必须是正安全整数');
  }
}
export function contains(a, b) {
  return Object.keys(b).every(device => (own(a, device) ? a[device] : 0) >= b[device]);
}
export function compare(a, b) {
  const ab = contains(a, b), ba = contains(b, a);
  return ab && ba ? 'equal' : ab ? 'after' : ba ? 'before' : 'concurrent';
}
export function join(...vectors) {
  const result = {};
  for (const vv of vectors) for (const [device, count] of Object.entries(vv)) {
    Object.defineProperty(result, device, { value: Math.max(own(result, device) ? result[device] : 0, count), enumerable: true, writable: true, configurable: true });
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
