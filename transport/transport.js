/**
 * 可替换的字节传输接口，所有方法返回 Promise，不解析快照或决定合并、清理策略：
 * list(directory) -> Array<{ name: string, size: number, sha: string }>（仅直接子文件）
 * get(path) -> Uint8Array（返回独立副本）
 * put(path, Uint8Array | ArrayBuffer) -> void（只新建；同路径同字节幂等，不同则拒绝）
 * remove(path) -> void（缺失文件也报 notfound，不擅自忽略权限问题）
 * test() -> { ok: boolean, code: string, message: string }（中文，只读连接检查）
 *
 * 失败抛 TransportError：code 为稳定机器码，message 为可显示中文，
 * status 为 HTTP 状态（没有则 0），retryAt 为允许再试的 UTC 毫秒（没有则 null）。
 * 不回传服务端原始文字、令牌、请求对象。调用者不得将认证信息写入路径。
 * list 不递归；不存在的目录报 notfound；可能截断的清单报 directory_limit。
 * 超时/断线时写入是否成功未知，请用同路径同字节重试，绝不能另取文件名。
 */
export class TransportError extends Error {
  constructor(code, message, { status = 0, retryAt = null } = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

// 两处官方文档分别使用 MB / MiB；采用较小的十进制值作为客户端保护上限。
export const MAX_FILE_BYTES = 100_000_000;
export const DIRECTORY_LIMIT = 1000;

export function normalizePath(path, directory = false) {
  if (typeof path !== 'string' || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith('/')) {
    throw new TransportError('path', '路径格式不正确，请使用仓库内的相对路径。');
  }
  const value = directory ? path.replace(/\/+$/, '') : path;
  if ((!directory && !value) || value.split('/').some(part => part === '.' || part === '..' || (!part && value))) {
    throw new TransportError('path', '路径格式不正确，不能包含空层级或上级目录。');
  }
  return value;
}

export function copyBytes(value) {
  if (value instanceof Uint8Array) { checkSize(value.byteLength); return value.slice(); }
  if (value instanceof ArrayBuffer) { checkSize(value.byteLength); return new Uint8Array(value.slice(0)); }
  throw new TransportError('bytes', '文件内容必须是字节，不能直接传入文字或对象。');
}

export function checkSize(size) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TransportError('corrupt', 'GitHub 返回的文件大小不正确，已停止读取。');
  }
  if (size > MAX_FILE_BYTES) {
    throw new TransportError('too_large', '文件超过本传输层的 100 MB 上限，请拆分归档后再试；没有截断文件。');
  }
}

export function equalBytes(a, b) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(content) {
  if (typeof content !== 'string') throw corruptError();
  const plain = content.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(plain)) throw corruptError();
  try {
    const bytes = Uint8Array.from(atob(plain), char => char.charCodeAt(0));
    if (encodeBase64(bytes) !== plain) throw corruptError();
    return bytes;
  } catch { throw corruptError(); }
}

export function corruptError() {
  return new TransportError('corrupt', '返回的文件内容或格式损坏，已停止读取，请稍后重新下载。');
}

export function collisionError() {
  return new TransportError('collision', '这个路径已有不同内容，已拒绝覆盖。快照文件名规则可能被破坏，请保留本机数据并检查同步程序。');
}
