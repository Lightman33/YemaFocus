/* 每次外壳发布都递增 VERSION。缓存只含此清单，绝不缓存 GitHub 响应或令牌。 */
const VERSION = '3.0.0';
const PREFIX = 'yema-shell:' + self.registration.scope + ':';
const CACHE = PREFIX + VERSION;
const SHELL_FILES = [
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './app/app.js',
  './app/sync-controller.js',
  './app/sim-repo.js',
  './app/sync.css',
  './app/ui.css',
  './app/store.js',
  './app/syncstate.js',
  './app/navigation.js',
  './app/version.js',
  './app/datasource.js',
  './app/demo-data.js',
  './app/task-model.js',
  './app/task-actions.js',
  './app/tasks-view.js',
  './app/habit-model.js',
  './app/habit-actions.js',
  './app/habit-journal.js',
  './app/habits-view.js',
  './app/habits.css',
  './app/focus-items.js',
  './app/focus-fullscreen.js',
  './app/focus-records.js',
  './app/focus-timer.js',
  './app/focus-view.js',
  './app/focus.css',
  './app/goal-sync.js',
  './app/goal-periods.js',
  './app/goals-model.js',
  './app/goals-actions.js',
  './app/goals-view.js',
  './app/goals.css',
  './app/review-model.js',
  './app/review-actions.js',
  './app/review-view.js',
  './app/review.css',
  './app/demo-review-data.js',
  './sync/engine.js',
  './sync/pack.js',
  './sync/snapshot.js',
  './sync/canonical.js',
  './sync/convert.js',
  './sync/edit.js',
  './sync/merge.js',
  './sync/records.js',
  './sync/vv.js',
  './transport/transport.js',
  './transport/github.js',
  './transport/memory.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const files = new Set(SHELL_FILES.map(path => new URL(path, self.registration.scope).href));
const indexURL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  // 新版装完后等用户点击；首次安装没有旧 worker，会自然激活。
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL_FILES.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' })));
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const isShellNavigation = event.request.mode === 'navigate' &&
    (url.pathname === scope.pathname || url.pathname === new URL(indexURL).pathname);
  const key = isShellNavigation ? indexURL : url.href;
  if (!files.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    // 旧 worker 始终用自己的整套资源，避免 HTML 与 JS 混用两个版本。
    return cached || fetch(event.request);
  })());
});
