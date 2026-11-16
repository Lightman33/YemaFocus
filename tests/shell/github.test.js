import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubTransport } from '../../transport/github.js';
import { TransportError, encodeBase64, MAX_FILE_BYTES } from '../../transport/transport.js';

const TOKEN = 'test-only-DO-NOT-USE-token';
const SHA = '1'.repeat(40);
const bytes = value => new TextEncoder().encode(value);
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const file = value => ({ type: 'file', sha: SHA, size: bytes(value).length, content: encodeBase64(bytes(value)), encoding: 'base64' });
const entry = (name = '快照.json') => ({ type: 'file', name, sha: SHA, size: 20 });

function fixture(replies, options = {}) {
  const calls = [];
  const queue = [...replies];
  const transport = new GitHubTransport({ owner: 'fictional-owner', repo: 'fictional-private', token: TOKEN }, {
    ...options,
    fetch: async (url, init) => {
      assert.ok(!url.includes(TOKEN), '令牌不得进入网址');
      assert.equal(init.headers.Authorization, 'Bearer ' + TOKEN);
      assert.equal(init.credentials, 'omit');
      assert.equal(init.mode, 'cors');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      assert.deepEqual(Object.keys(init.headers).sort(), init.body ? ['Accept', 'Authorization', 'Content-Type'] : ['Accept', 'Authorization']);
      calls.push({ url, init });
      assert.ok(queue.length, '出现了未预期的网络请求');
      const reply = queue.shift();
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(url, init) : reply;
    }
  });
  return { transport, calls, queue };
}

async function failure(promise, code, phrase) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.code, code);
    assert.match(error.message, phrase || /[\u4e00-\u9fff]/);
    assert.ok(!String(error).includes(TOKEN));
    assert.ok(!JSON.stringify(error).includes(TOKEN));
    return true;
  });
}

test('列目录：只列直接子文件，保留中文、字节大小和 sha，逐段编码路径', async () => {
  const { transport, calls } = fixture([json([entry(), { type: 'dir' }, { type: 'symlink' }, { ...entry('module'), submodule_git_url: 'ignored' }])]);
  assert.deepEqual(await transport.list('yema-sync/中文 空格/#?%/'), [{ name: '快照.json', size: 20, sha: SHA }]);
  assert.equal(calls[0].url, 'https://api.github.com/repos/fictional-owner/fictional-private/contents/yema-sync/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC/%23%3F%25');
});

test('读取：中文 UTF-8、二进制和空文件均不改动', async () => {
  for (const value of ['中文内容\n', '\u0000\u00ff', '']) {
    const { transport } = fixture([json(file(value))]);
    assert.deepEqual(await transport.get('yema-sync/中文.json'), bytes(value));
  }
});

test('新路径：直接 PUT 不带 sha，提交仅包含固定文字和 Base64 字节', async () => {
  const { transport, calls } = fixture([json({ content: { sha: SHA } }, 201)]);
  assert.equal(await transport.put('yema-sync/new.json', bytes('测试')), undefined);
  assert.equal(calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].init.body), { message: '发布设备快照', content: encodeBase64(bytes('测试')) });
  assert.equal(calls.length, 1);
});

test('同路径同字节重复 put 冲突后读取，不生成第二次提交', async () => {
  const { transport, calls } = fixture([json({}, 422), json(file('同一内容'))]);
  await transport.put('same', bytes('同一内容'));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.init.method), ['PUT', 'GET']);
});

test('同路径不同内容拒绝覆盖，即使长度相同', async () => {
  const { transport, calls } = fixture([json({}, 409), json(file('ABC'))]);
  await failure(transport.put('same', bytes('XYZ')), 'collision', /拒绝覆盖/);
  assert.equal(calls.length, 2);
});

for (const status of [409, 422]) {
  test(status + ' 并发创建：读回相同字节才算成功', async () => {
    const { transport, calls } = fixture([json({ message: TOKEN }, status), json(file('same'))]);
    await transport.put('new', bytes('same'));
    assert.equal(calls.filter(call => call.init.method === 'PUT').length, 1);
  });
  test(status + ' 并发创建：读回不同字节报文件名冲突', async () => {
    const { transport } = fixture([json({}, status), json(file('other'))]);
    await failure(transport.put('new', bytes('mine')), 'collision');
  });
  test(status + ' 无同名文件时保留原始失败分类，绝不当成功', async () => {
    const { transport } = fixture([json({ message: TOKEN }, status), json({}, 404)]);
    await failure(transport.put('new', bytes('mine')), status === 409 ? 'conflict' : 'validation');
  });
}

test('remove 读取当前 sha 后 DELETE；没有更新 PUT', async () => {
  const { transport, calls } = fixture([json(file('old')), json({ content: null })]);
  await transport.remove('old');
  assert.equal(calls[1].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].init.body), { message: '清理设备旧快照', sha: SHA });
});

for (const [status, code, phrase] of [
  [401, 'auth', /无效或已过期/], [403, 'forbidden', /没有权限/],
  [404, 'notfound', /不存在/], [409, 'conflict', /冲突/],
  [422, 'validation', /拒绝/], [413, 'too_large', /过大/],
  [500, 'server', /服务器/], [503, 'server', /服务器/], [418, 'http', /失败/]
]) {
  test('HTTP ' + status + '：中文分类且不泄漏服务端回显的令牌', async () => {
    const { transport } = fixture([json({ message: 'secret: ' + TOKEN }, status)]);
    await failure(transport.get('file'), code, phrase);
  });
}

test('非 JSON 的服务端错误页仍按 HTTP 状态分类', async () => {
  const { transport } = fixture([new Response(TOKEN, { status: 500 })]);
  await failure(transport.list('dir'), 'server');
});

test('403 主限流：返回再试时间，并在恢复前禁止额外请求', async () => {
  const now = 1_800_000_000_000;
  let clock = now;
  const { transport, calls } = fixture([
    json({ message: TOKEN }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 90_000) / 1000) }),
    json([])
  ], { now: () => clock });
  await assert.rejects(transport.list('dir'), error => error.code === 'ratelimit' && error.retryAt === now + 90_000 && /之后再试/.test(error.message));
  await failure(transport.list('dir'), 'ratelimit');
  assert.equal(calls.length, 1);
  clock += 90_001;
  assert.deepEqual(await transport.list('dir'), []);
});

test('429 Retry-After 和 403 次级限流都说明何时再试', async () => {
  const now = 1_800_000_000_000;
  for (const [status, headers, message, delay] of [
    [429, { 'retry-after': '120' }, TOKEN, 120_000],
    [403, {}, 'secondary rate limit: ' + TOKEN, 60_000],
    [429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'NaN' }, '', 60_000],
    [403, { 'retry-after': '30', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 100_000) / 1000) }, '', 100_000]
  ]) {
    const { transport } = fixture([json({ message }, status, headers)], { now: () => now });
    await assert.rejects(transport.get('x'), error => {
      assert.equal(error.code, 'ratelimit'); assert.equal(error.retryAt, now + delay);
      assert.match(error.message, /之后再试/); assert.ok(!error.message.includes(TOKEN)); return true;
    });
  }
});

test('断网与底层异常：只显示固定中文，不传播异常中的令牌', async () => {
  const { transport } = fixture([new TypeError('fetch failed ' + TOKEN)]);
  await failure(transport.get('file'), 'offline', /没联网/);
});

test('超时包括 fetch 不响应的情况，并发出 AbortSignal', async () => {
  let signal;
  const { transport } = fixture([(_url, init) => { signal = init.signal; return new Promise(() => {}); }], { timeoutMs: 15 });
  await failure(transport.get('x'), 'timeout', /超时/);
  assert.equal(signal.aborted, true);
});

test('超时覆盖响应体读取，不只覆盖请求头', async () => {
  const response = { ok: true, headers: new Headers(), json: () => new Promise(() => {}) };
  const { transport } = fixture([response], { timeoutMs: 15 });
  await failure(transport.get('x'), 'timeout');
});

test('响应体下载中途断网与 JSON 格式损坏分开说明', async () => {
  const { transport } = fixture([{ ok: true, headers: new Headers(), json: async () => { throw new TypeError(TOKEN); } }]);
  await failure(transport.get('x'), 'offline', /下载途中/);
});

test('上传确认丢失：保留未知结果，重试同路径读回相同内容即可成功', async () => {
  const { transport, calls } = fixture([new TypeError(TOKEN), json({}, 422), json(file('published'))]);
  await failure(transport.put('snapshot', bytes('published')), 'offline');
  await transport.put('snapshot', bytes('published'));
  assert.equal(calls.filter(call => call.init.method === 'PUT').length, 2);
});

test('大于 1 MB：元数据 encoding none 时，同域 raw 获取原始字节', async () => {
  const payload = new Uint8Array(1_000_001).fill(0x81);
  const { transport, calls } = fixture([
    json({ type: 'file', sha: SHA, size: payload.length, content: '', encoding: 'none' }),
    new Response(payload)
  ]);
  assert.deepEqual(await transport.get('large'), payload);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[1].init.headers.Accept, 'application/vnd.github.raw+json');
});

test('大于 100 MB 在获取 raw 前明确拒绝；不截断', async () => {
  const { transport, calls } = fixture([json({ type: 'file', sha: SHA, size: MAX_FILE_BYTES + 1, encoding: 'none' })]);
  await failure(transport.get('large'), 'too_large', /没有截断/);
  assert.equal(calls.length, 1);
});

test('超大上传在网络请求前拒绝，不创建部分文件', async () => {
  const { transport, calls } = fixture([]);
  await failure(transport.put('large', new Uint8Array(MAX_FILE_BYTES + 1)), 'too_large');
  assert.equal(calls.length, 0);
});

test('raw 提前结束或多出字节都拒绝；长度头超过上限也拒绝', async () => {
  for (const response of [new Response(bytes('ab')), new Response(bytes('abcd')), new Response(bytes('abc'), { headers: { 'content-length': String(MAX_FILE_BYTES + 1) } })]) {
    const { transport } = fixture([json({ type: 'file', sha: SHA, size: 3, encoding: 'none' }), response]);
    await failure(transport.get('raw'), response.headers.has('content-length') ? 'too_large' : 'corrupt');
  }
});

for (const [name, broken] of [
  ['非法 Base64', { ...file('abc'), content: '!!!!' }],
  ['Base64 非规范尾位', { ...file('a'), content: 'YR==' }],
  ['长度不符', { ...file('abc'), size: 4 }],
  ['负数大小', { ...file('abc'), size: -1 }],
  ['大小不是数字', { ...file('abc'), size: '3' }],
  ['目录冒充文件', { ...file('abc'), type: 'dir' }],
  ['缺 sha', { ...file('abc'), sha: '' }],
  ['未知 encoding', { ...file('abc'), encoding: 'html' }],
  ['缺 Base64 内容', { ...file('abc'), content: null }]
]) {
  test('损坏回应：' + name, async () => {
    const { transport } = fixture([json(broken)]);
    await failure(transport.get('bad'), 'corrupt');
  });
}

test('成功状态但 JSON 损坏时拒绝', async () => {
  const { transport } = fixture([new Response(TOKEN)]);
  await failure(transport.get('bad'), 'corrupt');
});

test('Base64 中的 GitHub 换行可以正常解码', async () => {
  const { transport } = fixture([json({ ...file('abcd'), content: 'YWJj\nZA==\n' })]);
  assert.deepEqual(await transport.get('x'), bytes('abcd'));
});

test('达到 1000 项拒绝可能不完整的清单；999 项可读', async () => {
  for (const count of [999, 1000, 1001]) {
    const { transport } = fixture([json(Array.from({ length: count }, (_, index) => entry(String(index))))]);
    if (count < 1000) assert.equal((await transport.list('dir')).length, count);
    else await failure(transport.list('dir'), 'directory_limit', /可能不完整/);
  }
});

test('目录形状损坏、重复名字及错误文件元数据都拒绝', async () => {
  for (const contents of [{ entries: [] }, [null], [entry(), entry()], [{ ...entry(), name: '../x' }], [{ ...entry(), size: -1 }]]) {
    const { transport } = fixture([json(contents)]);
    await failure(transport.list('dir'), 'corrupt');
  }
});

test('路径拒绝上级、绝对路径、空层级、控制字符及令牌，错误不回显', async () => {
  const { transport, calls } = fixture([]);
  for (const path of ['../x', '/x', 'x/../y', 'x//y', '', 'x\\y', 'x\u0000y', 'x/' + TOKEN]) {
    await failure(transport.get(path), 'path');
  }
  assert.equal(calls.length, 0);
});

test('构造配置不能把 token 填入 owner / repo，自定义报错不泄漏配置', () => {
  for (const config of [
    { owner: TOKEN, repo: 'x', token: TOKEN },
    { owner: 'fake', repo: TOKEN, token: TOKEN },
    { owner: 'fake', repo: '../x', token: TOKEN },
    { owner: 'fake', repo: 'x', token: '' }
  ]) assert.throws(() => new GitHubTransport(config), error => error.code === 'config' && !error.message.includes(TOKEN));
});

test('只读连接测试：私有仓库需能读根目录；不宣称写入已验证', async () => {
  const { transport, calls } = fixture([json({ private: true }), json([])]);
  const result = await transport.test();
  assert.equal(result.ok, true);
  assert.match(result.message, /尚未验证/);
  assert.ok(calls.every(call => call.init.method === 'GET'));
});

test('公开仓库不能误报为可用的私有数据仓库', async () => {
  const { transport, calls } = fixture([json({ private: false })]);
  assert.equal((await transport.test()).code, 'public_repo');
  assert.equal(calls.length, 1);
});

test('连接测试返回中文失败结果，包含无权限、过期和空仓库', async () => {
  for (const status of [401, 403, 404, 409, 500]) {
    const { transport } = fixture([json({ message: TOKEN }, status)]);
    const result = await transport.test();
    assert.equal(result.ok, false);
    assert.match(result.message, /[\u4e00-\u9fff]/);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
  const { transport } = fixture([json({ private: true }), json({}, 404)]);
  assert.equal((await transport.test()).ok, false);
});

test('同一实例并发操作会串行，两次写入至少隔一秒；失败不堵死队列', async () => {
  let now = 1000;
  const sleeps = [];
  let active = 0;
  let maximum = 0;
  const replies = [json({ content: { sha: SHA } }, 201), json({ content: { sha: SHA } }, 201), json({}, 500), json([])];
  const { transport, calls } = fixture(replies.map(response => async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--; return response;
  }), { now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  const input = bytes('old');
  const one = transport.put('one', input);
  input[0] = 0;
  const two = transport.put('two', bytes('two'));
  await Promise.all([one, two]);
  assert.equal(maximum, 1);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(JSON.parse(calls[0].init.body).content, encodeBase64(bytes('old')));
  await failure(transport.list('dir'), 'server');
  assert.deepEqual(await transport.list('dir'), []);
});

test('真实浏览器的 fetch 不接受调用者对象：必须以无 this 的方式调用', async () => {
  // 模拟浏览器行为：this 不是 undefined 或全局对象就抛 TypeError（Illegal invocation）。
  function strictFetch(url, init) {
    'use strict';
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(json({ private: true }));
  }
  const transport = new GitHubTransport({ owner: 'fictional-owner', repo: 'fictional-private', token: TOKEN }, { fetch: strictFetch });
  const result = await transport.test();
  assert.notEqual(result.code, 'offline', '不能把调用方式错误报成没联网');
});
