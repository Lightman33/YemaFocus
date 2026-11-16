// 更新网页版：先如实列出离线外壳的状态（排查用），再按用户点击清除外壳并重新打开。
// 只注销本网站范围内的 service worker、只删除名字以 yema-shell: 开头的缓存；
// 不碰 localStorage 和 IndexedDB 里的设置与数据。
const state = document.getElementById('state');
const out = document.getElementById('out');
const button = document.getElementById('reset');
const scope = new URL('./', location.href).href;
const versionOf = name => name.split(':').pop();

async function describe() {
  const lines = ['页面时间 ' + new Date().toISOString(), '浏览器 ' + navigator.userAgent];
  if (!('serviceWorker' in navigator)) { lines.push('此浏览器没有离线外壳功能。'); return lines; }
  const registrations = (await navigator.serviceWorker.getRegistrations()).filter(r => r.scope === scope);
  lines.push('离线外壳登记 ' + registrations.length + ' 个');
  for (const r of registrations) {
    lines.push('  正在用的：' + (r.active ? r.active.state : '无') +
      '；已装好等待切换：' + (r.waiting ? r.waiting.state : '无') +
      '；正在安装：' + (r.installing ? r.installing.state : '无'));
  }
  const names = (await caches.keys()).filter(n => n.startsWith('yema-shell:'));
  lines.push('外壳缓存版本 ' + (names.length ? names.map(versionOf).join('、') : '无'));
  try {
    const live = await fetch('./app/version.js', { cache: 'no-store' }).then(r => r.text());
    const m = live.match(/VERSION = '([^']+)'/);
    lines.push('网上最新版本 ' + (m ? m[1] : '读不出'));
  } catch (error) { lines.push('网上最新版本 读取失败：' + error.name); }
  for (const r of registrations) {
    try { await r.update(); lines.push('检查更新 已发出（结果：' + (r.installing ? '正在安装新版' : r.waiting ? '新版已装好等待切换' : '没有发现新版') + '）'); }
    catch (error) { lines.push('检查更新 失败：' + error.name + '：' + error.message); }
  }
  return lines;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  out.textContent = '';
  try {
    let removed = 0, deleted = 0;
    if ('serviceWorker' in navigator) {
      for (const r of await navigator.serviceWorker.getRegistrations()) {
        if (r.scope === scope && await r.unregister()) removed++;
      }
    }
    for (const name of await caches.keys()) {
      if (name.startsWith('yema-shell:') && await caches.delete(name)) deleted++;
    }
    out.textContent = '已清除：外壳登记 ' + removed + ' 个，缓存 ' + deleted + ' 个。正在重新打开…';
    setTimeout(() => { location.href = './index.html#settings'; }, 1200);
  } catch (error) {
    out.textContent = '清除失败：' + error.name + '：' + error.message + '\n请截图发给 Claude。';
    button.disabled = false;
  }
});

describe().then(lines => { state.textContent = lines.join('\n'); button.disabled = false; },
  error => { state.textContent = '读取状态失败：' + error.name + '：' + error.message; button.disabled = false; });
