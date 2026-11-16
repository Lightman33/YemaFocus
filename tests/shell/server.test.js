import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../../tools/serve.js';

test('实际 HTTP：静态服务器能打开首页、全部外壳资源及正确 MIME，并拒绝越界路径', async t => {
  const server = createPreviewServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.match(await index.text(), /野马专注与健康助手/);
  for (const [path, type] of [
    ['/app/app.js', 'text/javascript'], ['/app/ui.css', 'text/css'],
    ['/sw.js', 'text/javascript'], ['/manifest.webmanifest', 'application/manifest+json'],
    ['/icons/icon-180.png', 'image/png'], ['/transport/github.js', 'text/javascript']
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith(type));
    await response.arrayBuffer();
  }
  assert.equal((await fetch(base + '/source/Theme.cs')).status, 404);
  assert.equal((await fetch(base + '/.git/config')).status, 403);
  assert.equal((await fetch(base + '/tests/shell/github.test.js')).status, 403);
  assert.equal((await fetch(base + '/tools/serve.js')).status, 403);
  assert.equal((await fetch(base + '/%2e%2e%5csource%5cCore.cs')).status, 403);
  assert.equal((await fetch(base + '/does-not-exist')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  const head = await fetch(base + '/app/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
