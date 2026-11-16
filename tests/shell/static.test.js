import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, dirname } from 'node:path';
import vm from 'node:vm';
import { VERSION } from '../../app/version.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFile(resolve(ROOT, path), 'utf8');
async function files(directory) {
  const entries = await readdir(resolve(ROOT, directory), { withFileTypes: true });
  const children = await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(directory + '/' + entry.name) : [directory + '/' + entry.name]));
  return children.flat();
}

async function cacheList() {
  const source = await read('sw.js');
  const context = { self: { registration: { scope: 'https://api.github.com/fictional-preview/project/' }, addEventListener() {} }, URL, Set };
  vm.runInNewContext(source + '\nglobalThis.list = SHELL_FILES; globalThis.version = VERSION;', context);
  return { list: Array.from(context.list), version: context.version };
}

test('外壳资源和所有模块引用都用相对路径，无第三方脚本、字体或图片，无运行时外部地址', async () => {
  const runtimeFiles = ['index.html', 'sw.js', ...(await files('app')), ...(await files('transport'))];
  for (const path of runtimeFiles) {
    const source = await read(path);
    const withoutAPI = source.replaceAll('https://api.github.com', '');
    assert.doesNotMatch(withoutAPI, /https?:\/\//i, path + ' 出现了外部网址');
    assert.doesNotMatch(source, /(?:src|href)\s*=\s*["'](?:\/|https?:)/i, path);
    assert.doesNotMatch(source, /(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\()/, path);
    assert.doesNotMatch(source, /(?:localStorage|sessionStorage)/, path + ' 不应另存令牌');
    if (path.endsWith('.js')) {
      for (const match of source.matchAll(/(?:from\s*|import\s*\()["']([^"']+)["']/g)) {
        assert.match(match[1], /^\.{1,2}\//, path + ' 存在非相对导入');
        assert.ok((await stat(resolve(ROOT, dirname(path), match[1]))).isFile());
      }
    }
  }
  const html = await read('index.html');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (match[1].startsWith('#')) continue;
    assert.match(match[1], /^\.\//);
    assert.ok((await stat(resolve(ROOT, match[1]))).isFile(), match[1]);
  }
  assert.doesNotMatch(await read('app/ui.css'), /@import|url\s*\(/i);
});

test('离线清单与实际外壳文件完全一致，版本一致，排除测试、工具和独立预览', async () => {
  const { list, version } = await cacheList();
  const expected = ['index.html', 'sw.js', 'manifest.webmanifest', ...(await files('app')), ...(await files('transport')), ...(await files('icons')), ...['canonical', 'convert', 'edit', 'merge', 'records', 'vv', 'engine', 'pack', 'snapshot'].map(name => 'sync/' + name + '.js')].map(path => './' + path).sort();
  assert.deepEqual([...list].sort(), expected);
  assert.equal(new Set(list).size, list.length);
  assert.equal(version, VERSION);
  // 任务界面离线也需要转换器及其完整依赖；引擎代码也必须离线可读；仓库响应不进缓存。
  for (const name of ['engine', 'pack', 'snapshot']) assert.ok(list.includes('./sync/' + name + '.js'));
  assert.ok(!list.includes('./review-preview.html'));
  assert.match(await read('index.html'), new RegExp(VERSION.replaceAll('.', '\\.')));
  assert.equal(await read('.nojekyll'), '');
  const walk = async path => {
    for (const m of (await read(path)).matchAll(/from\s*['"]([^'"]+)['"]/g)) {
      const dependency = relative(ROOT, resolve(ROOT, dirname(path), m[1])).replaceAll('\\', '/');
      assert.ok(list.includes('./' + dependency), path + ' 的离线依赖遗漏：' + dependency);
    }
  };
  for (const path of list.filter(p => p.endsWith('.js'))) await walk(path.slice(2));
  for (const path of list) assert.ok((await stat(resolve(ROOT, path))).isFile());
  for (const match of (await read('sw.js')).matchAll(/['"]([^'"]+)['"]/g)) {
    assert.doesNotMatch(match[1], /^\.\/(?:tests|tools)\//);
  }
});

test('iPhone 安装、内容安全策略、可缩放和无障碍标签静态检查', async () => {
  const html = await read('index.html');
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.start_url, './index.html');
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180"/);
  assert.match(html, /viewport-fit=cover/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=/i);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(html, /\son\w+\s*=/);
  assert.match(html, /<html lang="zh-CN">/);
  for (const id of ['owner', 'repo', 'token', 'device-name']) assert.match(html, new RegExp('<label for="' + id + '">'));
  assert.match(html, /role="status"/);
  assert.match(html, /<nav[^>]+aria-label="主导航"/);
  assert.match(html, /aria-labelledby="clear-title"/);
  const css = await read('app/ui.css');
  for (const edge of ['top', 'right', 'bottom', 'left']) assert.match(css, new RegExp('safe-area-inset-' + edge));
  assert.match(css, /font-size: max\(1rem, 16px\)/);
  assert.match(css, /touch-action: manipulation/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /min-height: 48px/);
  assert.match(css, /min-width: 44px/);
});

function luminance(hex) {
  const channels = hex.match(/[a-f0-9]{2}/gi).map(part => parseInt(part, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + .05) / (values[0] + .05);
}

test('明暗两套颜色的正文/次要文字/彩色文字/按钮文字均达到 4.5:1，输入边框达到 3:1', async () => {
  const css = await read('app/ui.css');
  const palettes = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map(match => Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*(#[a-f0-9]{6})/gi)].map(item => [item[1], item[2]])));
  assert.equal(palettes.length, 2);
  for (const palette of palettes) {
    for (const foreground of ['ink', 'caption', 'accent', 'blue', 'danger']) {
      for (const background of ['bg', 'panel', 'surface', 'hover']) {
        assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, foreground + '/' + background + ' 对比不足：' + contrast(palette[foreground], palette[background]));
      }
    }
    assert.ok(contrast(palette['button-ink'], palette.accent) >= 4.5);
    assert.ok(contrast(palette.border, palette.surface) >= 3);
  }
});

test('主屏幕 PNG 图标是真实 PNG，三种尺寸及 manifest 指向一致', async () => {
  for (const size of [180, 192, 512]) {
    const image = await readFile(resolve(ROOT, 'icons/icon-' + size + '.png'));
    assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
  }
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) assert.ok((await stat(resolve(ROOT, icon.src))).isFile());
});

test('预览工具也不包含任何外部资源地址，仅允许 localhost 网址字符串', async () => {
  const source = await read('tools/serve.js');
  assert.doesNotMatch(source.replaceAll('http://localhost:8765', '').replaceAll('http://localhost', ''), /https?:\/\//);
  // Windows 上相对路径用反斜杠，先统一成正斜杠再比较（Claude 2026-11-13 在 Windows 上实跑时发现）
  assert.ok(relative(ROOT, resolve(ROOT, 'tools/serve.js')).replaceAll('\\', '/').startsWith('tools/'));
});
