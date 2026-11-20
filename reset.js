// 更新网页版：先如实列出各层缓存里的版本（排查用），再按用户点击清除外壳、刷新浏览器缓存并重新打开。
// 只注销本网站范围内的 service worker、只删除名字以 yema-shell: 开头的缓存；
// 不碰 localStorage 和 IndexedDB 里的设置与数据。
const state = document.getElementById('state');
const out = document.getElementById('out');
const button = document.getElementById('reset');
const scope = new URL('./', location.href).href;
const versionOf = text => { const m = /VERSION = '([^']+)'/.exec(text || ''); return m ? m[1] : '读不出'; };

async function readVersion(init) {
  try { return versionOf(await (await fetch('./app/version.js', init)).text()); }
  catch (error) { return '读取失败（' + error.name + '）'; }
}

async function describe() {
  const lines = ['页面时间 ' + new Date().toISOString(), '浏览器 ' + navigator.userAgent];
  if ('serviceWorker' in navigator) {
    const registrations = (await navigator.serviceWorker.getRegistrations()).filter(r => r.scope === scope);
    lines.push('离线外壳登记 ' + registrations.length + ' 个；本页受外壳接管 ' + Boolean(navigator.serviceWorker.controller));
    for (const r of registrations) {
      lines.push('  正在用：' + (r.active ? r.active.state : '无') + '；已装好待切换：' + (r.waiting ? '有' : '无') +
        '；正在安装：' + (r.installing ? r.installing.state : '无'));
    }
  } else lines.push('此浏览器没有离线外壳功能。');
  const names = (await caches.keys()).filter(n => n.startsWith('yema-shell:'));
  lines.push('外壳缓存 ' + (names.length ? names.map(n => n.split(':').pop()).join('、') : '无'));
  for (const name of names) {
    const hit = await (await caches.open(name)).match(new URL('./app/version.js', scope).href);
    lines.push('  ' + name.split(':').pop() + ' 里的 version.js → ' + (hit ? versionOf(await hit.text()) : '没有这个文件'));
  }
  lines.push('A 普通读取 version.js → ' + await readVersion({}));
  lines.push('B 跳过浏览器缓存读取 → ' + await readVersion({ cache: 'no-store' }));
  lines.push('（A 和 B 不同，说明 Safari 自己的网页缓存还存着旧文件）');
  return lines;
}

async function shellFiles() {
  // 外壳文件清单以网上最新的 sw.js 为准，不在这里重复抄一份。
  const text = await (await fetch('./sw.js', { cache: 'reload' })).text();
  const list = [...text.matchAll(/'(\.\/[^']+)'/g)].map(m => m[1]);
  if (!list.includes('./index.html')) throw new Error('读不出外壳文件清单');
  return list;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  out.textContent = '';
  const say = text => { out.textContent += text + '\n'; };
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
    say('1 已清除外壳：登记 ' + removed + ' 个，缓存 ' + deleted + ' 个');
    // cache: 'reload' 会跳过浏览器缓存去网上取，并用新文件替换浏览器缓存里的旧文件。
    const list = await shellFiles();
    let ok = 0;
    for (const path of list) {
      try { const r = await fetch(path, { cache: 'reload' }); if (r.ok) ok++; else say('  ' + path + ' → ' + r.status); }
      catch (error) { say('  ' + path + ' → ' + error.name); }
    }
    say('2 已从网上重新取文件 ' + ok + '/' + list.length + ' 个');
    say('3 现在普通读取 version.js → ' + await readVersion({}));
    say('正在重新打开…');
    setTimeout(() => { location.href = './index.html?r=' + Date.now() + '#settings'; }, 2500);
  } catch (error) {
    say('清除失败：' + error.name + '：' + error.message + '\n请截图发给 Claude。');
    button.disabled = false;
  }
});

describe().then(lines => { state.textContent = lines.join('\n'); button.disabled = false; },
  error => { state.textContent = '读取状态失败：' + error.name + '：' + error.message; button.disabled = false; });
