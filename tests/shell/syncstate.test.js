import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncState } from '../../app/syncstate.js';
import { Navigation } from '../../app/navigation.js';

test('同步状态：四种事实逐步出现，不能用目录读通代替对方确认', () => {
  const state = new SyncState();
  assert.equal(state.snapshot().localSaved, false);
  assert.throws(() => state.uploaded(0), /先保存/);
  assert.throws(() => state.peerMerged(0), /没有/);
  state.localSaved(0);
  assert.equal(state.snapshot().labels[0], '已存本机');
  assert.equal(state.snapshot().uploaded, false);
  state.uploaded(0);
  assert.equal(state.snapshot().labels[1], '已上传');
  assert.equal(state.snapshot().peerMerged, false);
  state.peerMerged(0);
  assert.equal(state.snapshot().labels[2], '对方已合并');
  state.setConflicts(2);
  assert.equal(state.snapshot().labels[3], '有冲突待处理（2 处）');
  assert.equal(state.snapshot().peerMerged, true);
});

test('新本机版本使旧上传/旧确认失效；迟到响应不会把新修改标为已上传', () => {
  const state = new SyncState();
  state.localSaved(1); state.uploaded(1); state.peerMerged(1);
  state.localSaved(2);
  state.uploaded(1); state.peerMerged(1); state.localSaved(0);
  assert.equal(state.snapshot().localRevision, 2);
  assert.equal(state.snapshot().uploaded, false);
  assert.equal(state.snapshot().peerMerged, false);
  state.uploaded(2);
  assert.equal(state.snapshot().peerMerged, false);
  state.peerMerged(2);
  assert.equal(state.snapshot().peerMerged, true);
});

test('离线、错误与冲突独立保留；联网本身不表示上传成功', () => {
  const state = new SyncState();
  state.localSaved(1); state.setConflicts(1);
  state.setOffline(true); state.setError({ code: 'auth', message: '令牌无效' });
  state.setOffline(false);
  assert.equal(state.snapshot().error.code, 'auth');
  assert.equal(state.snapshot().conflicts, 1);
  assert.equal(state.snapshot().uploaded, false);
  state.setError(null);
  assert.equal(state.snapshot().conflicts, 1);
  state.setConflicts(0);
  assert.match(state.snapshot().labels[3], /没有/);
});

test('状态订阅拿到独立副本，退订生效，清空时不残留上传和冲突', () => {
  const state = new SyncState();
  let count = 0;
  const stop = state.subscribe(snapshot => { count++; snapshot.conflicts = 100; snapshot.labels[0] = 'modified'; });
  assert.equal(count, 1);
  state.localSaved(1);
  assert.equal(count, 2);
  assert.equal(state.snapshot().conflicts, 0);
  stop(); state.uploaded(1);
  assert.equal(count, 2);
  state.setOffline(true); state.reset();
  assert.equal(state.snapshot().offline, true);
  assert.equal(state.snapshot().localSaved, false);
  assert.equal(state.snapshot().uploaded, false);
});

test('非法版本和冲突数不会进入状态', () => {
  const state = new SyncState();
  for (const n of [-1, 1.5, NaN, '1']) {
    assert.throws(() => state.localSaved(n), TypeError);
    assert.throws(() => state.setConflicts(n), TypeError);
  }
});

test('标签切换和浏览器返回都可还原各页面滚动位置，非法路由回任务', () => {
  const nav = new Navigation('settings');
  assert.deepEqual(nav.move('tasks', 320), { page: 'tasks', scrollTop: 0 });
  assert.deepEqual(nav.move('review', 40), { page: 'review', scrollTop: 0 });
  assert.deepEqual(nav.move('settings', 80), { page: 'settings', scrollTop: 320 });
  assert.deepEqual(nav.move('review', 500), { page: 'review', scrollTop: 80 });
  assert.deepEqual(nav.move('invalid', 100), { page: 'tasks', scrollTop: 40 });
});
