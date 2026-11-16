// 定义跨语言唯一的 JSON 文本，并保留旧数据中的小数。
// 只使用 ECMAScript 内置能力；同步格式中的数字一律是安全整数。
export function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('同步数字必须是安全整数，不能是负零');
    return String(value);
  }
  if (typeof value === 'string') {
    let result = '"';
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92) result += '\\' + value[i];
      else if (code < 32 || code > 126) result += '\\u' + code.toString(16).padStart(4, '0');
      else result += value[i];
    }
    return result + '"';
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('不允许稀疏数组或数组附加字段');
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(key => canonical(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new TypeError('仅接受 JSON 值');
}

export function clone(value) { return JSON.parse(canonical(value)); }
export function unitKey(...parts) {
  if (!parts.length || parts.some(part => typeof part !== 'string')) throw new TypeError('单元键必须由字符串组成');
  return canonical(parts);
}
export function own(object, key) { return Object.hasOwn(object, key); }
export function put(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}
export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exactKeys(value, keys) {
  return object(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}

// 所有含 $sync 的旧对象都转义，避免把用户的未知字段误当数字标记。
export function encodeLegacy(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('旧数据含非有限数字');
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    let bits = '';
    for (let i = 0; i < 8; i++) bits += view.getUint8(i).toString(16).padStart(2, '0');
    return { $sync: 'number', bits };
  }
  if (Array.isArray(value)) return value.map(encodeLegacy);
  if (object(value)) {
    const entries = Object.keys(value).sort().map(key => [key, encodeLegacy(value[key])]);
    return own(value, '$sync') ? { $sync: 'object', entries } : Object.fromEntries(entries);
  }
  canonical(value);
  return value;
}
export function decodeLegacy(value) {
  if (Array.isArray(value)) return value.map(decodeLegacy);
  if (object(value)) {
    if (value.$sync === 'number' && exactKeys(value, ['$sync', 'bits'])) {
      if (typeof value.bits !== 'string' || !/^[0-9a-f]{16}$/.test(value.bits)) throw new TypeError('小数位模式错误');
      const view = new DataView(new ArrayBuffer(8));
      for (let i = 0; i < 8; i++) view.setUint8(i, parseInt(value.bits.slice(2 * i, 2 * i + 2), 16));
      const result = view.getFloat64(0, false);
      if (!Number.isFinite(result)) throw new TypeError('非有限旧数字');
      return result;
    }
    if (value.$sync === 'object' && exactKeys(value, ['$sync', 'entries'])) {
      if (!Array.isArray(value.entries) || value.entries.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string')) throw new TypeError('转义对象错误');
      if (new Set(value.entries.map(row => row[0])).size !== value.entries.length) throw new TypeError('转义对象有重复键');
      return Object.fromEntries(value.entries.map(([key, child]) => [key, decodeLegacy(child)]));
    }
    if (own(value, '$sync')) throw new TypeError('未知旧数据转义类型');
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeLegacy(child)]));
  }
  return value;
}
