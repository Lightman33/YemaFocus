import {
  TransportError, normalizePath, copyBytes, checkSize, equalBytes, collisionError
} from './transport.js';

/** 假仓库不保存半个文件；partial 可模拟“未提交”或“已完整提交但确认丢失”。 */
export class MemoryTransport {
  #files = new Map();
  #faults = [];
  #now;

  constructor({ now = Date.now } = {}) { this.#now = now; }

  /** fault: { type: offline|timeout|partial|corrupt|ratelimit, operation?: list|get|put|remove|test, committed?: boolean, retryAt?: number }，消费一次。 */
  injectFault(fault) {
    if (!['offline', 'timeout', 'partial', 'corrupt', 'ratelimit'].includes(fault?.type)) {
      throw new TransportError('fault', '未知的模拟故障类型。');
    }
    this.#faults.push({ ...fault });
    return this;
  }

  #fault(operation) {
    const index = this.#faults.findIndex(fault => !fault.operation || fault.operation === operation);
    if (index < 0) return null;
    const fault = this.#faults.splice(index, 1)[0];
    if (fault.type === 'offline') throw new TransportError('offline', '没联网，模拟仓库暂时无法连接。');
    if (fault.type === 'timeout') throw new TransportError('timeout', '连接超时，请稍后重试。');
    if (fault.type === 'ratelimit') {
      const retryAt = fault.retryAt || this.#now() + 60_000;
      throw new TransportError('ratelimit', '触到频率限制，请在 ' + new Date(retryAt).toLocaleString('zh-CN', { hour12: false }) + ' 之后再试。', { retryAt });
    }
    return fault;
  }

  // 仅作稳定的测试用标识，不冒充 GitHub blob SHA 或协议层内容哈希。
  #sha(bytes) {
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return 'memory-' + hash.toString(16) + '-' + bytes.length;
  }

  async list(directory) {
    this.#fault('list');
    const path = normalizePath(directory, true);
    const prefix = path ? path + '/' : '';
    const result = [];
    let found = !path;
    for (const [key, bytes] of this.#files) {
      if (!key.startsWith(prefix)) continue;
      found = true;
      const name = key.slice(prefix.length);
      if (!name.includes('/')) result.push({ name, size: bytes.length, sha: this.#sha(bytes) });
    }
    if (!found) throw new TransportError('notfound', '模拟仓库中没有这个目录。');
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(path) {
    const fault = this.#fault('get');
    const bytes = this.#files.get(normalizePath(path));
    if (!bytes) throw new TransportError('notfound', '模拟仓库中没有这个文件。');
    const result = bytes.slice();
    if (fault?.type === 'corrupt') {
      if (!result.length) return new Uint8Array([255]);
      result[0] ^= 255;
    }
    return result;
  }

  async put(path, value) {
    const fault = this.#fault('put');
    const key = normalizePath(path);
    const bytes = copyBytes(value);
    checkSize(bytes.length);
    const existing = this.#files.get(key);
    if (existing && !equalBytes(existing, bytes)) throw collisionError();
    if (fault?.type !== 'partial' || fault.committed) this.#files.set(key, bytes);
    if (fault?.type === 'partial') throw new TransportError('offline', '上传途中连接断开，结果未知，请用同路径同内容重试。');
  }

  async remove(path) {
    const fault = this.#fault('remove');
    const key = normalizePath(path);
    if (!this.#files.has(key)) throw new TransportError('notfound', '模拟仓库中没有这个文件。');
    if (fault?.type !== 'partial' || fault.committed) this.#files.delete(key);
    if (fault?.type === 'partial') throw new TransportError('offline', '删除途中连接断开，结果未知，请重新列出文件确认。');
  }

  async test() {
    try { this.#fault('test'); return { ok: true, code: 'ok', message: '连接成功：这是仅在内存中的模拟仓库。' }; }
    catch (error) { return { ok: false, code: error.code, message: error.message, retryAt: error.retryAt }; }
  }
}
