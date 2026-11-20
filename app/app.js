import { openStore, requestPersistence, StoreError } from './store.js';
import { SyncState } from './syncstate.js';
import { Navigation, PAGES } from './navigation.js';
import { GitHubTransport } from '../transport/github.js';
import { TransportError } from '../transport/transport.js';
import { createEngine } from '../sync/engine.js';
import { createSyncController } from './sync-controller.js';
import { VERSION } from './version.js';
import { createDataSource, wallTime } from './datasource.js';
import { seedDemo, DEMO_DATABASE } from './demo-data.js';
import { createSimRepository, SIM_DATABASE, SIM_SETTINGS, SIM_TOKEN } from './sim-repo.js';
import { TasksView } from './tasks-view.js';
import { HabitsView } from './habits-view.js';
import { FocusTimer } from './focus-timer.js';
import { FocusView, focusBell } from './focus-view.js';
import { GoalsView } from './goals-view.js';
import { mountReview } from './review-view.js';

const $ = id => document.getElementById(id);
export const syncState = new SyncState();
const demoMode = /^#demo(?:\/|$)/.test(location.hash), simMode = /^#sim(?:\/|$)/.test(location.hash);
const prefix = demoMode ? 'demo/' : simMode ? 'sim/' : '';
export let dataSource, controller;
let tasksView, habitsView, focusView, goalsView, reviewView, sim, reviewLoading, reviewUI = {}, appDisposed = false;
let store, saved, busy = false, storageReady = false, dirty = false, registration, updating = false;
let navigationQueue = Promise.resolve();
const main = $('main');
const route = () => location.hash.replace(/^#(?:demo|sim)\/?/, '#').slice(1) || 'tasks';
const navigation = new Navigation(route());
function renderFocusNotice(message = focusView?.timer.notice || '') {
  const title = (message ? message + ' · ' : '') + PAGES[navigation.current] + ' · 野马';
  if (document.title !== title) document.title = title;
  const completion = $('focus-completion');
  const text = message ? message + '，查看专注页' : '', hidden = !message || navigation.current === 'focus';
  if (completion.textContent !== text) completion.textContent = text;
  if (completion.hidden !== hidden) completion.hidden = hidden;
}
$('focus-completion').addEventListener('click', () => changePage('focus'));
for (const link of document.querySelectorAll('[data-page]')) {
  link.setAttribute('href', '#' + prefix + link.dataset.page);
  link.addEventListener('click', event => { event.preventDefault(); changePage(link.dataset.page); });
}
function renderPage(page, focus = true) {
  const previous = navigation.current;
  const target = navigation.move(page, main.scrollTop);
  // 提示已在专注页看过（或就是在专注页上点的放弃）：离开专注页即清掉，不再挂在别的页面顶上
  if (previous === 'focus' && target.page !== 'focus' && focusView && focusView.timer.notice) focusView.timer.notice = '';
  for (const name of Object.keys(PAGES)) $('page-' + name).hidden = name !== target.page;
  for (const link of document.querySelectorAll('[data-page]')) {
    if (link.dataset.page === target.page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  renderFocusNotice();
  if (focus) $('title-' + target.page).focus({ preventScroll: true });
  main.scrollTop = target.scrollTop;
  if (tasksView && target.page === 'tasks' && previous !== 'tasks') tasksView.entered();
  if (target.page === 'review') reviewView?.refresh();
  if (target.page === 'goals') goalsView?.enter();
}
export async function disposeApp() { appDisposed = true; tasksView?.destroy(); habitsView?.destroy(); focusView?.destroy(); goalsView?.destroy(); reviewView?.destroy(); await controller?.dispose(); sim?.dispose(); }
export async function flushViews() { await tasksView?.flush(); await habitsView?.flush(); await focusView?.pending; await goalsView?.flush(); await reviewView?.flush(); }
export function changePage(page, fromHash = false) {
  navigationQueue = navigationQueue.catch(() => {}).then(async () => {
    if (page === navigation.current) return true;
    const previousPage = navigation.current;
    try {
      await flushViews();
      if (navigation.current === 'tasks' && tasksView && !(await tasksView.leave())) throw new StoreError('write');
      if (navigation.current === 'habits') await habitsView?.leave();
      if (navigation.current === 'goals') await goalsView?.leave();
      renderPage(page);
      if (page === 'habits') await prepareHabits();
      if (page === 'focus') { await focusView?.entered(); await dataSource?.ensureLoaded(); }
      if (page === 'goals') await dataSource?.ensureLoaded();
      if (page === 'review') await prepareReview();
      const setRoute = fromHash ? history.replaceState.bind(history) : (history.pushState || history.replaceState).bind(history);
      setRoute(null, '', '#' + prefix + navigation.current);
      return true;
    } catch (error) {
      if (navigation.current !== previousPage) renderPage(previousPage, false);
      history.replaceState(null, '', '#' + prefix + navigation.current);
      $('offline-ready').textContent = '尚未切页：' + (error.message || '请先完成输入并保存。');
      return false;
    }
  });
  return navigationQueue;
}
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.addEventListener('hashchange', async () => {
  const nextMode = /^#demo(?:\/|$)/.test(location.hash) ? 'demo/' : /^#sim(?:\/|$)/.test(location.hash) ? 'sim/' : '';
  if (nextMode !== prefix) {
    // 模式切换必须重新打开对应的库，不能把正式来源留在 #demo 或 #sim 下。
    try { await flushViews(); await goalsView?.leave(); await disposeApp(); location.reload(); }
    catch (error) { history.replaceState(null, '', '#' + prefix + navigation.current); $('offline-ready').textContent = '尚未切换模式：' + error.message; }
    return;
  }
  changePage(route(), true);
});
renderPage(navigation.current, false);
document.querySelector('.skip').addEventListener('click', event => { event.preventDefault(); main.focus({ preventScroll: true }); });
function formatted(time, full = false) {
  if (time === null || time === undefined) return '尚无';
  const zone = dataSource?.snapshot().timeZone;
  if (!zone) return '请先选择软件时区';
  const value = wallTime(time, zone);
  return full ? value.slice(5, 10).replace('-', '月') + '日 ' + value.slice(11, 16) : value.slice(11, 16);
}
function renderStatus() {
  const facts = syncState.snapshot(), status = controller?.snapshot();
  const visibleError = status?.error || (facts.error && !['ratelimit', 'incomplete'].includes(facts.error.code) ? facts.error : null);
  $('network-status').textContent = facts.offline ? '离线' : '';
  let text = '未加入 · 在设置里从电脑加入';
  if (demoMode) text = '示例数据 · 修改仅存本机';
  else if (visibleError) text = '同步出错，点此查看';
  else if (status?.retryAt) text = '请求过多，' + formatted(status.retryAt) + '后重试';
  else if (status?.offline || facts.offline) text = status?.joined ? '离线，已存本机' : '离线，尚未加入';
  else if (facts.conflicts) text = '有 ' + facts.conflicts + ' 处两边都改过';
  else if (status?.details.length) text = '数据有警告，点此查看';
  else if (status?.busy) text = '正在同步…';
  else if (status?.pending) text = '有 ' + status.pending + ' 处修改待上传';
  else if (status?.lastSuccess) text = '已同步 ' + formatted(status.lastSuccess);
  $('sync-facts').textContent = text;
  $('sync-error').hidden = !visibleError;
  $('error-title').textContent = visibleError ? '同步出错原因' : '同步状态';
  $('error-detail').textContent = visibleError?.message || status?.message || '';
  $('sync-full').textContent = facts.labels.join('\n') + '\n上次同步成功：' + formatted(status?.lastSuccess, true) +
    (status?.retryAt ? '\n请求过多，' + formatted(status.retryAt, true) + '后自动重试' : '') +
    (status?.offline ? '\n离线，联网后自动同步' : '');
  $('sync-warning').textContent = (status?.details || []).map(d => '设备 ' + d.device + ' 的数据从 ' + formatted(d.since, true) + ' 起不完整，已使用它上一份完整数据').join('\n');
  $('retry-sync').hidden = demoMode || !status?.joined;
  $('sync-now').textContent = status?.joined ? '立即同步' : '从电脑加入';
  $('sync-summary').textContent = demoMode ? '示例模式，数据与正式库隔离。' :
    (status?.joined ? '已加入' : '未加入') + '\n绑定的仓库：' + (status?.repository || '尚未绑定') + '\n上次同步成功：' + formatted(status?.lastSuccess, true) +
    '\n' + (status?.pending ? '有 ' + status.pending + ' 处修改待上传' : status?.joined ? '全部已上传' : '加入后才可编辑');
  if (status?.deviceId) $('device-id').textContent = status.deviceId;
}
syncState.subscribe(renderStatus);
function networkChanged() {
  syncState.setOffline(!(navigator.onLine && (!sim || sim.isOnline())));
  controller?.networkChanged().catch(showError);
}
window.addEventListener('online', networkChanged); window.addEventListener('offline', networkChanged); networkChanged();
for (const id of ['sync-error', 'sync-facts']) $(id).addEventListener('click', () => { renderStatus(); $('error-dialog').showModal(); });
$('close-error').addEventListener('click', () => $('error-dialog').close());
$('retry-sync').addEventListener('click', async () => { try { await flushViews(); await controller?.syncNow(); } catch (e) { showError(e); } });
$('app-version').textContent = VERSION;
function controls() {
  for (const element of $('settings-form').querySelectorAll('input, button')) element.disabled = !storageReady || busy || demoMode;
  $('clear-data').disabled = !storageReady || busy;
}
function configuration() {
  return { settings: { owner: $('owner').value.trim(), repo: $('repo').value.trim(), deviceName: $('device-name').value.trim() }, token: $('token').value.trim() };
}
function fillSettings() {
  $('owner').value = saved.settings.owner || ''; $('repo').value = saved.settings.repo || ''; $('token').value = saved.token;
  $('device-name').value = saved.settings.deviceName || '我的手机'; $('device-id').textContent = saved.settings.deviceId;
  $('setup-guide').hidden = demoMode; $('setup-guide').open = !saved.settings.joined;
  if (demoMode) $('connection-result').textContent = '示例模式只使用独立的本机虚构数据，不连接仓库。';
  if (simMode || demoMode) { $('demo-badge').hidden = false; $('demo-badge').textContent = simMode ? '模拟仓库（仅供验收）' : '示例数据'; }
  $('sim-controls').hidden = !simMode; renderStatus();
}
function showError(error, target = 'connection-result') {
  const safe = error instanceof TransportError || error instanceof StoreError ? error : { code: 'unknown', message: '操作没有完成，请稍后重试。' };
  $(target).textContent = safe.message;
  // 同步停机由控制器保持；普通界面保存失败不会抹掉它。
}
function dialogChoice(id, choices, cancelValue = null) {
  return new Promise(resolve => {
    const dialog = $(id), handlers = [];
    const finish = value => { for (const [node, type, handler] of handlers) node.removeEventListener(type, handler); dialog.close(); resolve(value); };
    for (const [buttonId, value] of Object.entries(choices)) { const fn = () => finish(value); $(buttonId).addEventListener('click', fn); handlers.push([$(buttonId), 'click', fn]); }
    const cancel = event => { event.preventDefault(); finish(cancelValue); }; dialog.addEventListener('cancel', cancel); handlers.push([dialog, 'cancel', cancel]);
    dialog.showModal();
  });
}
async function saveSettings() {
  const config = configuration();
  let result = await controller.saveConfiguration(config);
  if (result.needsChoice) {
    const choice = await dialogChoice('repository-dialog', { 'repository-move': 'move', 'repository-replace': 'replace', 'repository-cancel': null });
    if (!choice) return false;
    result = await controller.saveConfiguration(config, { choice });
    if (result.needsDiscard) {
      $('discard-explanation').textContent = '将放弃这台手机现有的任务、复盘、习惯、番茄记录和同步状态。其中有 ' + result.pending + ' 处尚未上传的修改，清除后无法从旧仓库找回；已上传的数据仍在旧仓库。';
      const confirmed = await dialogChoice('discard-dialog', { 'discard-confirm': true, 'discard-cancel': false }, false);
      if (!confirmed) return false;
      result = await controller.saveConfiguration(config, { choice: 'replace', confirmDiscard: true });
    }
  }
  saved = (await store.readMetadata()).record; dirty = false; $('setup-guide').open = !saved.settings.joined;
  $('save-result').textContent = '设置已保存到本机。';
  if (result.replaced) await controller.join(); else if (result.moved) await controller.syncNow();
  renderStatus(); return true;
}
$('settings-form').addEventListener('input', () => { dirty = true; $('save-result').textContent = '设置有改动，请点击“保存设置”。'; });
$('toggle-token').addEventListener('click', () => {
  const visible = $('token').type === 'password'; $('token').type = visible ? 'text' : 'password';
  $('toggle-token').textContent = visible ? '隐藏令牌' : '显示令牌'; $('toggle-token').setAttribute('aria-pressed', String(visible));
});
async function background() {
  tasksView?.savePosition();
  try { await flushViews(); } catch (error) { $('offline-ready').textContent = '输入仍保留，尚未保存：' + error.message; }
}
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    focusView?.stopTicks();
    focusView?.left();
    $('token').type = 'password'; $('toggle-token').textContent = '显示令牌'; $('toggle-token').setAttribute('aria-pressed', 'false');
    await background();
  } else {
    focusView?.entered();
    try { await dataSource?.refresh(); await controller?.foreground(); reviewView?.refresh(); } catch (e) { showError(e); }
    registration?.update().catch(() => {});
  }
});
window.addEventListener('pageshow', event => { if (event.persisted) focusView?.entered(); });
window.addEventListener('beforeunload', event => {
  // 浏览器不等待 beforeunload 的 Promise；启动 flush，并在有待保存输入时请求保留页面。
  if (dirty || tasksView?.pending.size || tasksView?.hasStepDraft() || habitsView?.busy || habitsView?.journal.dirty || goalsView?.pending || goalsView?.hasDraft() || document.activeElement?.tagName === 'TEXTAREA') { event.preventDefault(); event.returnValue = ''; }
  flushViews().catch(e => { $('offline-ready').textContent = '输入仍保留：' + e.message; });
});
async function run(action) {
  if (!storageReady || busy) return;
  if (demoMode) { $('connection-result').textContent = '示例模式只使用独立的本机虚构数据，不连接仓库。'; return; }
  if (!$('settings-form').reportValidity()) return;
  busy = true; controls();
  try { await flushViews(); await action(); } catch (error) { showError(error); } finally { busy = false; controls(); }
}
$('settings-form').addEventListener('submit', event => { event.preventDefault(); run(saveSettings); });
$('test-connection').addEventListener('click', () => run(async () => {
  if (!(await saveSettings())) return;
  $('connection-result').textContent = '正在测试连接…';
  const result = await controller.testConnection(); $('connection-result').textContent = result.message;
  syncState.setError(result.ok ? null : result);
}));
$('sync-now').addEventListener('click', () => run(async () => {
  if (!(await saveSettings())) return;
  $('connection-result').textContent = '正在同步…';
  const result = controller.snapshot().joined ? await controller.syncNow() : await controller.join();
  $('connection-result').textContent = result.message || (result.ok ? '同步完成。' : '同步尚未完成。');
  if (result.joined && result.ok) $('setup-guide').open = false;
}));
$('clear-data').addEventListener('click', () => { $('clear-result').textContent = ''; $('clear-dialog').showModal(); });
$('cancel-clear').addEventListener('click', () => $('clear-dialog').close());
$('confirm-clear').addEventListener('click', async () => {
  if (busy) return; busy = true; controls(); $('confirm-clear').disabled = true;
  try {
    await flushViews();
    if (controller) await controller.clear(); else await store.clear();
    await controller?.dispose(); habitsView?.destroy(); focusView?.destroy(); goalsView?.destroy(); reviewView?.destroy(); dirty = false; store.close(); location.reload();
  } catch (e) { showError(e, 'clear-result'); busy = false; controls(); $('confirm-clear').disabled = false; }
});
for (const [id, method] of [['sim-task', 'editTask'], ['sim-review', 'editReview'], ['sim-habit', 'editHabit']]) $(id).addEventListener('click', async () => {
  if (!sim || busy) return; busy = true; $(id).disabled = true;
  try { const result = await sim[method](); $('sim-result').textContent = result.ok ? '模拟电脑已发布；回到前台或点“立即同步”读取。' : result.message; }
  catch { $('sim-result').textContent = '模拟电脑无法修改这处冲突，请先在手机解决，再同步。'; }
  finally { busy = false; $(id).disabled = false; }
});
$('sim-network').addEventListener('click', () => { if (!sim) return; sim.setOffline(sim.isOnline()); $('sim-network').textContent = sim.isOnline() ? '模拟断网' : '恢复网络'; networkChanged(); });
function newDeviceId() { const bytes = crypto.getRandomValues(new Uint8Array(16)); return 'phone-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
async function prepareHabits() {
  if (!dataSource || appDisposed) return;
  try { await dataSource.ensureLoaded(); }
  catch (error) { habitsView?.snack('习惯尚未载入：' + error.message); throw error; }
}
// 复盘页保持原接口；内容齐全前用外壳占位，不把未载入误当成空数据。
async function prepareReview() {
  if (reviewView || !dataSource || appDisposed) return;
  if (!reviewLoading) reviewLoading = (async () => {
    $('task-loading').textContent = '专注统计及其他内容正在载入…';
    $('review-root').textContent = '正在载入…'; $('review-root').setAttribute('aria-busy', 'true');
    await dataSource.ensureLoaded();
    if (appDisposed) return;
    $('review-root').textContent = ''; $('review-root').setAttribute('aria-busy', 'false');
    reviewView = mountReview({ root: $('review-root'), dataSource, now: () => Date.now(), preferences: {
      read: () => reviewUI, write: async patch => { await store.updateMetadata(r => { r.settings.reviewUI = patch; }); reviewUI = patch; }
    } });
  })().catch(error => { $('review-root').textContent = '载入失败：' + error.message; $('review-root').setAttribute('aria-busy', 'false'); $('task-loading').textContent = '其他内容尚未载入：' + error.message; throw error; }).finally(() => { reviewLoading = null; });
  return reviewLoading;
}
async function startStorage() {
  requestPersistence().then(result => { if ($('storage-error').hidden) $('persistence-status').textContent = result.message; });
  try {
    store = await openStore(demoMode ? { name: DEMO_DATABASE } : simMode ? { name: SIM_DATABASE } : {});
    if (simMode) {
      await store.clear(); sim = await createSimRepository({ now: () => Date.now() });
      await store.updateMetadata(r => { r.settings = { ...SIM_SETTINGS, deviceId: newDeviceId() }; r.token = SIM_TOKEN; });
    }
    if (demoMode) {
      await store.updateMetadata(r => { if (!r.settings.deviceId) r.settings.deviceId = newDeviceId(); });
      await seedDemo(store, Date.now());
    } else {
      controller = createSyncController({ store, syncState, makeTransport: config => simMode ? sim.transport : new GitHubTransport(config),
        makeEngine: createEngine, now: () => Date.now(), timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) },
        newDeviceId, tasksFirst: true, isVisible: () => !document.hidden, isOnline: () => navigator.onLine && (!sim || sim.isOnline()) });
      await controller.init();
    }
    saved = (await store.readMetadata()).record; dataSource = await createDataSource({ store, demo: demoMode, tasksFirst: !demoMode }); controller?.setDataSource(dataSource);
    tasksView = new TasksView({ document, source: dataSource, main, onSaved: () => { renderStatus(); } });
    habitsView = new HabitsView({ document, root: $('habits-root'), source: dataSource, onSaved: renderStatus });
    focusView = new FocusView({ document, source: dataSource, timer: new FocusTimer({ store, source: dataSource, newId: newDeviceId }),
      onNotice: renderFocusNotice, ...focusBell(window) });
    await focusView.entered();
    goalsView = new GoalsView({ document, root: $('goals-root'), source: dataSource, main,
      openTask: async id => { if (await changePage('tasks')) await tasksView.openDetail(id); }, onSaved: renderStatus });
    if (navigation.current === 'goals') goalsView.enter();
    reviewUI = saved.settings.reviewUI || {};
    if (navigation.current === 'habits') await prepareHabits();
    if (!dataSource.snapshot().loadingBuckets.length || ['review', 'focus', 'goals'].includes(navigation.current)) await prepareReview();
    else {
      $('task-loading').textContent = '专注统计及其他内容正在载入…';
    $('review-root').textContent = '正在载入…'; $('review-root').setAttribute('aria-busy', 'true');
      const idle = () => { if (!appDisposed) prepareReview().catch(error => showError(error)); };
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(idle);
      else setTimeout(idle, 0);
    }
    const loadingNotice = snapshot => { $('task-loading').hidden = !snapshot.loadingBuckets.length; };
    loadingNotice(dataSource.snapshot());
    dataSource.subscribe(snapshot => { loadingNotice(snapshot); syncState.setConflicts(snapshot.conflicts.filter(c => !c.hiddenByDeletion).length); renderStatus(); });
    if (controller) controller.subscribe(renderStatus); else syncState.localSaved(0);
    syncState.setConflicts(dataSource.snapshot().conflicts.filter(c => !c.hiddenByDeletion).length);
    if (navigation.current === 'tasks') tasksView.entered();
    storageReady = true; fillSettings(); controls();
    if (!demoMode && !saved.settings.joined && !['habits', 'focus', 'goals'].includes(navigation.current)) { history.replaceState(null, '', '#' + prefix + 'settings'); renderPage('settings', false); }
    if (controller?.snapshot().message) $('connection-result').textContent = controller.snapshot().message;
    if (saved.settings.joined && !demoMode) await controller.foreground();
  } catch (error) {
    storageReady = false; controls(); $('storage-error').hidden = false;
    $('storage-error').textContent = '这个浏览器模式下无法保存数据。' + (error instanceof StoreError ? error.message : '请使用普通浏览模式重试。');
    $('persistence-status').textContent = '本机存储不可用。'; history.replaceState(null, '', '#' + prefix + 'settings'); renderPage('settings', false);
  }
}

async function startOffline() {
  if (!('serviceWorker' in navigator)) {
    $('offline-ready').textContent = '此浏览器不支持离线外壳，请使用 Safari 并通过安全网址打开。';
    return;
  }
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    const offerUpdate = () => { if (registration.waiting && navigator.serviceWorker.controller) $('update-app').hidden = false; };
    offerUpdate();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') offerUpdate(); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updating) { dirty = false; location.reload(); }
      else $('offline-ready').textContent = '离线外壳已就绪。';
    });
    navigator.serviceWorker.ready.then(() => { $('offline-ready').textContent = '离线外壳已就绪。'; });
    registration.update().catch(() => {});
  } catch {
    $('offline-ready').textContent = '离线外壳尚未准备好，请联网后刷新；首次加载完成前不能保证离线打开。';
  }
}
$('update-app').addEventListener('click', async () => {
  if (dirty) {
    $('save-result').textContent = '请先保存设置，再点击更新。';
    await changePage('settings');
    return;
  }
  try { await flushViews(); } catch { return; }
  if (registration?.waiting) {
    updating = true;
    registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  }
});

window.addEventListener('pagehide', background);
startStorage();
startOffline();
