// 连接诊断：逐项改变 fetch 选项，找出哪一项让手机浏览器连不上 api.github.com。
// 只用假仓库名和假令牌，不读取本机保存的任何设置。
const API = 'https://api.github.com';
const REPO = API + '/repos/example-owner-test/example-repo-test';
const JSON_TYPE = 'application/vnd.github+json';
const FAKE = 'Bearer ghp_FAKE_TOKEN_FOR_DIAG_0000';
const out = document.getElementById('out');
const button = document.getElementById('run');
const full = { mode: 'cors', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' };
const without = key => { const copy = { ...full }; delete copy[key]; return copy; };

const cases = [
  ['1 最简单的请求 /zen', API + '/zen', {}, '200'],
  ['2 /zen 加跨域和不缓存', API + '/zen', { mode: 'cors', cache: 'no-store', credentials: 'omit' }, '200'],
  ['3 /zen 用软件的全部选项', API + '/zen', full, '200'],
  ['4 假仓库 不带令牌', REPO, { ...full, headers: { Accept: JSON_TYPE } }, '404'],
  ['5 假仓库 带假令牌 全部选项', REPO, { ...full, headers: { Accept: JSON_TYPE, Authorization: FAKE } }, '401'],
  ['6 同5 去掉 不缓存', REPO, { ...without('cache'), headers: { Accept: JSON_TYPE, Authorization: FAKE } }, '401'],
  ['7 同5 去掉 禁止跳转', REPO, { ...without('redirect'), headers: { Accept: JSON_TYPE, Authorization: FAKE } }, '401'],
  ['8 同5 去掉 不带来源', REPO, { ...without('referrerPolicy'), headers: { Accept: JSON_TYPE, Authorization: FAKE } }, '401'],
  ['9 同5 只带令牌 不带Accept', REPO, { ...full, headers: { Authorization: FAKE } }, '401'],
  ['10 同5 加可取消信号', REPO, { ...full, headers: { Accept: JSON_TYPE, Authorization: FAKE }, signal: 'abort' }, '401']
];

function line(text) { out.textContent += text + '\n'; }

async function one(name, url, options, expected) {
  const started = performance.now();
  const init = { method: 'GET', ...options };
  let timer;
  if (init.signal === 'abort') {
    const controller = new AbortController();
    init.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), 20000);
  }
  try {
    const response = await fetch(url, init);
    const ms = Math.round(performance.now() - started);
    line((String(response.status) === expected ? '通 ' : '异 ') + name + ' → ' + response.status + '（预期 ' + expected + '，' + ms + ' 毫秒）');
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    line('败 ' + name + ' → ' + (error && error.name) + '：' + (error && error.message) + '（' + ms + ' 毫秒）');
  } finally { clearTimeout(timer); }
}

button.addEventListener('click', async () => {
  button.disabled = true;
  out.textContent = '';
  line('时间 ' + new Date().toISOString());
  line('浏览器 ' + navigator.userAgent);
  line('联网标志 ' + navigator.onLine + '；离线外壳接管 ' + Boolean(navigator.serviceWorker && navigator.serviceWorker.controller) +
    '；主屏幕模式 ' + (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true));
  line('');
  for (const [name, url, options, expected] of cases) await one(name, url, options, expected);
  line('');
  line('完成。“通”是正常，“败”和“异”是有问题。');
  button.disabled = false;
});
