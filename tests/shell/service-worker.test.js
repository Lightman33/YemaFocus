import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
const scope = 'https://api.github.com/fictional-pages/project/';

function worker({ failAsset = false } = {}) {
  const handlers = new Map();
  const cached = new Map();
  const state = { network: true, skipped: 0, claimed: 0, requests: [], deleted: [] };
  const fetcher = async request => {
    const url = typeof request === 'string' ? request : request.url;
    state.requests.push(url);
    if (!state.network || (failAsset && url.endsWith('/app/store.js'))) throw new TypeError('模拟断网');
    return new Response('fixture:' + url);
  };
  const caches = {
    async open(name) {
      if (!cached.has(name)) cached.set(name, new Map());
      const entries = cached.get(name);
      return {
        async addAll(requests) {
          const responses = await Promise.all(requests.map(async request => [request.url, await fetcher(request)]));
          for (const [url, response] of responses) entries.set(url, response);
        },
        async match(request) { return entries.get(typeof request === 'string' ? request : request.url)?.clone(); }
      };
    },
    async keys() { return Array.from(cached.keys()); },
    async delete(name) { state.deleted.push(name); return cached.delete(name); }
  };
  const self = {
    registration: { scope },
    addEventListener(name, handler) { handlers.set(name, handler); },
    async skipWaiting() { state.skipped++; },
    clients: { async claim() { state.claimed++; } }
  };
  vm.runInNewContext(source + '\nglobalThis.cacheName = CACHE; globalThis.shellFiles = SHELL_FILES;', { self, caches, fetch: fetcher, URL, Request, Set });
  async function lifecycle(name, data) {
    let pending;
    handlers.get(name)({ data, waitUntil(promise) { pending = promise; } });
    if (pending) await pending;
  }
  async function fetchEvent(path, { mode = 'cors', method = 'GET' } = {}) {
    let pending;
    const url = new URL(path, scope).href;
    handlers.get('fetch')({ request: { url, mode, method }, respondWith(promise) { pending = promise; } });
    return pending ? await pending : undefined;
  }
  return { lifecycle, fetchEvent, state, cached };
}

test('离线模拟：首次安装完整外壳，子路径根目录和 index 导航离线都能读取', async () => {
  const app = worker();
  await app.lifecycle('install');
  assert.equal(app.state.skipped, 0, '安装时不能强制更新');
  await app.lifecycle('activate');
  assert.equal(app.state.claimed, 1);
  app.state.network = false;
  assert.match(await (await app.fetchEvent('./', { mode: 'navigate' })).text(), /index\.html/);
  assert.match(await (await app.fetchEvent('./index.html?launch=1', { mode: 'navigate' })).text(), /index\.html/);
  const before = app.state.requests.length;
  for (const name of ['./app/app.js', './app/store.js', './app/ui.css', './transport/github.js', './icons/icon-180.png']) {
    assert.ok((await app.fetchEvent(name)).ok, name);
  }
  assert.equal(app.state.requests.length, before, '离线缓存命中不能发请求');
});

test('缓存不拦 GitHub、其他站点、其他子路径、用户数据或非 GET 请求', async () => {
  const app = worker();
  await app.lifecycle('install');
  for (const [path, options] of [
    ['https://api.github.com/repos/fictional/data', {}],
    ['../other/index.html', { mode: 'navigate' }],
    ['./yema-sync/private.json', {}],
    ['./sync/model.js', {}],
    ['./app/app.js', { method: 'PUT' }]
  ]) assert.equal(await app.fetchEvent(path, options), undefined);
});

test('更新：只有收到点击消息后才跳过等待，激活只删自己子路径的旧版本', async () => {
  const app = worker();
  await app.lifecycle('install');
  const current = Array.from(app.cached.keys())[0];
  const old = 'yema-shell:' + scope + ':old-version';
  const other = 'yema-shell:https://api.github.com/other-project/:old';
  app.cached.set(old, new Map());
  app.cached.set(other, new Map());
  await app.lifecycle('message', { type: 'UNKNOWN' });
  assert.equal(app.state.skipped, 0);
  await app.lifecycle('message', { type: 'ACTIVATE_UPDATE' });
  assert.equal(app.state.skipped, 1);
  await app.lifecycle('activate');
  assert.deepEqual(app.state.deleted, [old]);
  assert.ok(app.cached.has(current));
  assert.ok(app.cached.has(other));
});

test('安装缺一项资源就失败，不激活不完整的新外壳', async () => {
  const app = worker({ failAsset: true });
  await assert.rejects(app.lifecycle('install'), /模拟断网/);
  assert.equal(app.state.skipped, 0);
  assert.equal(app.state.claimed, 0);
  assert.equal(Array.from(app.cached.values())[0].size, 0);
});
