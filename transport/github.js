import {
  TransportError, MAX_FILE_BYTES, DIRECTORY_LIMIT, normalizePath, copyBytes,
  checkSize, equalBytes, encodeBase64, decodeBase64, corruptError, collisionError
} from './transport.js';

const API = 'https://api.github.com';
const JSON_TYPE = 'application/vnd.github+json';
const OBJECT_TYPE = 'application/vnd.github.object+json';
const RAW_TYPE = 'application/vnd.github.raw+json';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const validSha = sha => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha);

export class GitHubTransport {
  #token;
  #fetch;
  #base;
  #queue = Promise.resolve();
  #lastWriteAt = -Infinity;
  #blockedUntil = 0;
  #timeout;
  #now;
  #sleep;
  #writeGap;

  constructor({ owner, repo, token }, {
    fetch: fetcher = globalThis.fetch, timeoutMs = 20_000,
    now = Date.now, sleep = wait, writeGapMs = 1000
  } = {}) {
    // 不允许自定义主机，令牌只进入 Authorization；报错不引用任何配置值。
    if (!owner || !repo || !token || !/^[A-Za-z0-9-]+$/.test(owner) ||
        !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..' ||
        !/^[\x21-\x7e]+$/.test(token) || owner.includes(token) || repo.includes(token)) {
      throw new TransportError('config', '请填写有效的仓库所有者、仓库名和令牌（填名称，不填网址）。');
    }
    if (typeof fetcher !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TransportError('config', '当前环境无法连接，或网络超时设置不正确。');
    }
    this.#token = token;
    this.#fetch = fetcher;
    this.#base = API + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
    this.#timeout = timeoutMs;
    this.#now = now;
    this.#sleep = sleep;
    this.#writeGap = Math.max(1000, writeGapMs);
  }

  #serial(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  #path(path, directory = false) {
    const normalized = normalizePath(path, directory);
    if (normalized.includes(this.#token)) {
      throw new TransportError('path', '认证信息不能用作仓库路径。');
    }
    return '/contents/' + normalized.split('/').map(encodeURIComponent).join('/');
  }

  async #failure(response) {
    let reason = '';
    // 仅用于分类，绝不把服务端原文（可能回显敏感信息）交给调用者。
    try { reason = String((await response.json()).message || ''); } catch { /* 错误页也可分类 */ }
    const status = response.status;
    if (status === 401) return new TransportError('auth', '令牌无效或已过期，请在设置中更换令牌。', { status });
    if (status === 429 || (status === 403 && (
      response.headers.get('x-ratelimit-remaining') === '0' ||
      response.headers.get('retry-after') !== null || /rate limit|abuse|secondary/i.test(reason)))) {
      const now = this.#now();
      const retry = response.headers.get('retry-after');
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      let retryAt = now + 60_000;
      if (retry !== null && /^\d+(\.\d+)?$/.test(retry)) retryAt = now + Number(retry) * 1000;
      if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > now) {
        retryAt = Math.max(retry !== null ? retryAt : now, reset);
      }
      retryAt = Math.max(now + 1000, retryAt);
      this.#blockedUntil = retryAt;
      return new TransportError('ratelimit', this.#rateMessage(retryAt), { status, retryAt });
    }
    if (status === 403) return new TransportError('forbidden', '没有权限：请检查令牌是否只授权了正确的仓库，以及 Contents 是否为读写；仓库规则也可能禁止写入。', { status });
    if (status === 404) return new TransportError('notfound', '仓库或路径不存在，或令牌未获准访问这个私有仓库。请检查设置；GitHub 会用同一个 404 隐藏未授权的私有资源。', { status });
    if (status === 409) return new TransportError('conflict', 'GitHub 提交发生冲突，或仓库还是空仓库。没有覆盖文件，请稍后用原路径重试。', { status });
    if (status === 422) return new TransportError('validation', 'GitHub 拒绝了请求：路径、文件参数或仓库规则不满足要求，也可能触发防滥用限制。没有覆盖已有文件。', { status });
    if (status === 413) return new TransportError('too_large', 'GitHub 拒绝了过大的文件，请拆分归档后再试；没有截断文件。', { status });
    if (status >= 500) return new TransportError('server', 'GitHub 服务器暂时出错，请稍后重试。', { status });
    return new TransportError('http', 'GitHub 请求失败，请检查仓库设置后重试。', { status });
  }

  #rateMessage(retryAt) {
    return '触到 GitHub 频率限制，请在 ' + new Date(retryAt).toLocaleString('zh-CN', { hour12: false }) + ' 之后再试。';
  }

  async #request(suffix, { method = 'GET', accept = JSON_TYPE, body, rawSize } = {}) {
    if (this.#now() < this.#blockedUntil) {
      throw new TransportError('ratelimit', this.#rateMessage(this.#blockedUntil), { retryAt: this.#blockedUntil });
    }
    if (method !== 'GET') {
      const delay = this.#writeGap - (this.#now() - this.#lastWriteAt);
      if (delay > 0) await this.#sleep(delay);
      this.#lastWriteAt = this.#now();
    }
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TransportError('timeout', '连接 GitHub 超时，请检查网络后重试；上传可能已经成功，请沿用原文件路径。'));
      }, this.#timeout);
    });
    const operation = async () => {
      const headers = { Accept: accept, Authorization: 'Bearer ' + this.#token };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response;
      try {
        response = await this.#fetch(this.#base + suffix, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal, mode: 'cors', cache: 'no-store', credentials: 'omit',
          redirect: 'error', referrerPolicy: 'no-referrer'
        });
      } catch {
        throw new TransportError('offline', '没联网或无法连接 GitHub（网络可能被拦截），请检查网络后再试。');
      }
      if (!response.ok) throw await this.#failure(response);
      try {
        if (rawSize !== undefined) return await this.#readRaw(response, rawSize);
        return await response.json();
      } catch (error) {
        if (error instanceof TransportError) throw error;
        if (error instanceof TypeError) {
          throw new TransportError('offline', '下载途中网络断开或连接被拦截，请重新连接后下载完整文件。');
        }
        throw corruptError();
      }
    };
    try { return await Promise.race([operation(), timeout]); }
    finally { clearTimeout(timer); }
  }

  async #readRaw(response, expected) {
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > MAX_FILE_BYTES) {
      await response.body?.cancel();
      checkSize(Number(length));
    }
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== expected) throw corruptError();
      return bytes;
    }
    const reader = response.body.getReader();
    const pieces = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_FILE_BYTES || total > expected) {
          await reader.cancel();
          if (total > MAX_FILE_BYTES) checkSize(total);
          throw corruptError();
        }
        pieces.push(value);
      }
    } finally { reader.releaseLock(); }
    if (total !== expected) throw corruptError();
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
    return bytes;
  }

  async #metadata(path) {
    const file = await this.#request(this.#path(path), { accept: OBJECT_TYPE });
    if (!file || file.type !== 'file' || file.submodule_git_url || !validSha(file.sha)) throw corruptError();
    checkSize(file.size);
    return file;
  }

  async #get(path) {
    const meta = await this.#metadata(path);
    let bytes;
    if (meta.encoding === 'base64') {
      // 防止畸形服务端响应让 Base64 解码分配超出元数据的内存。
      if (typeof meta.content !== 'string' || meta.content.replace(/\s/g, '').length > Math.ceil(meta.size / 3) * 4) throw corruptError();
      bytes = decodeBase64(meta.content);
    } else if (meta.encoding === 'none') {
      bytes = await this.#request(this.#path(path), { accept: RAW_TYPE, rawSize: meta.size });
    } else { throw corruptError(); }
    if (bytes.length !== meta.size) throw corruptError();
    // 文件名内容哈希由协议层校验；这里只保证字节完整和 Base64 严格合法。
    return bytes;
  }

  list(directory) {
    return this.#serial(async () => {
      const entries = await this.#request(this.#path(directory, true));
      if (!Array.isArray(entries)) throw corruptError();
      if (entries.length >= DIRECTORY_LIMIT) {
        throw new TransportError('directory_limit', '目录达到 1,000 项，GitHub 清单可能不完整，已停止同步。请由同步程序分目录或安全清理旧快照。');
      }
      const names = new Set();
      const files = [];
      for (const file of entries) {
        if (!file || !['file', 'dir', 'symlink', 'submodule'].includes(file.type)) throw corruptError();
        if (file.type !== 'file' || file.submodule_git_url) continue;
        if (typeof file.name !== 'string' || !file.name || /[/\\\x00-\x1f]/.test(file.name) || !validSha(file.sha) || names.has(file.name)) throw corruptError();
        if (!Number.isSafeInteger(file.size) || file.size < 0) throw corruptError();
        names.add(file.name);
        files.push({ name: file.name, size: file.size, sha: file.sha });
      }
      return files;
    });
  }

  get(path) { return this.#serial(() => this.#get(path)); }

  put(path, value) {
    // 调用时复制，排队期间调用者改原数组不会改变待上传内容。
    let bytes;
    try { bytes = copyBytes(value); checkSize(bytes.length); }
    catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const suffix = this.#path(path);
      try {
        // 无 sha：只新建。绝不以 sha 重试 PUT，避免覆盖另一次发布的快照。
        const result = await this.#request(suffix, {
          method: 'PUT', body: { message: '发布设备快照', content: encodeBase64(bytes) }
        });
        if (!result?.content || !validSha(result.content.sha)) throw corruptError();
      } catch (error) {
        if (!['conflict', 'validation'].includes(error.code)) throw error;
        // 另一请求可能抢先创建了同路径；也可能只是无关的 422，不能当成功。
        let existing;
        try { existing = await this.#get(path); }
        catch (readError) { if (readError.code === 'notfound') throw error; throw readError; }
        if (!equalBytes(existing, bytes)) throw collisionError();
      }
    });
  }

  remove(path) {
    return this.#serial(async () => {
      const meta = await this.#metadata(path);
      await this.#request(this.#path(path), {
        method: 'DELETE', body: { message: '清理设备旧快照', sha: meta.sha }
      });
    });
  }

  test() {
    return this.#serial(async () => {
      try {
        const repo = await this.#request('');
        if (!repo || typeof repo.private !== 'boolean') throw corruptError();
        if (!repo.private) return { ok: false, code: 'public_repo', message: '连接到了公开仓库。同步数据需要私有仓库，请检查仓库名和可见性。' };
        const contents = await this.#request('/contents/');
        if (!Array.isArray(contents)) throw corruptError();
        return { ok: true, code: 'ok', message: '连接成功：令牌可读取这个私有仓库。测试没有写入文件，尚未验证 Contents 写权限或分支规则，请确认令牌选择了读写。' };
      } catch (error) {
        // 空仓库没有目录可列：不能假称已验证内容可读。
        return { ok: false, code: error.code || 'http', message: error instanceof TransportError ? error.message : '连接检查失败，请稍后重试。', retryAt: error.retryAt || null };
      }
    });
  }
}
