import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { harness, record } from '../pack/helpers.js';
import { SyncState } from '../../app/syncstate.js';
import { readFocusItems } from '../../app/focus-items.js';
import { updateUnit } from '../../sync/edit.js';

const vector = JSON.parse(await readFile(new URL('../../../sync-spec/vectors/focus/long-term-items.json', import.meta.url)));
const legacyRoot = process.env.T41_LEGACY_ROOT;
const legacy = path => import(legacyRoot ? pathToFileURL(resolve(legacyRoot, path)).href : '../../' + path);

const client = legacyRoot ? 'v2.9 网页' : '共享引擎的旧日程投影';
test(client + '接收长期事项，再编辑普通日程并发布，全新设备仍取回原单元', async t => {
  const h = harness(), { device, key, bucket, initial, changed } = vector;
  const [{ createEngine }, convert, pack, { MemoryStore }] = await Promise.all([
    legacy('sync/engine.js'), legacy('sync/convert.js'), legacy('sync/pack.js'), legacy('app/store.js')
  ]);
  const planner = { tasks: [{ id: 'fake-task', title: '虚构待办', done: false }] };
  const oldPhone = 'old-phone';
  const store = new MemoryStore(record(oldPhone, convert.plannerToState(planner, oldPhone)));
  const phone = createEngine({ store, syncState: new SyncState(), transport: h.transport,
    repositoryId: 'fiction/repo', now: h.clock.now, timers: h.clock.timers });
  t.after(() => phone.dispose());
  await phone.load();
  assert.equal((await phone.syncNow()).ok, true);
  const pc = await h.device(device);
  t.after(() => pc.engine.dispose());
  assert.equal((await pc.engine.join()).ok, true);
  for (const list of [initial.items, changed.items]) {
    await pc.engine.commit(updateUnit(pc.engine.getState(), key, device, list, { updatedAt: h.clock.now() }));
    h.clock.advance();
    assert.equal((await pc.engine.syncNow()).ok, true);
    assert.equal((await phone.syncNow()).ok, true);
    assert.deepEqual(phone.getState().units[key], pc.engine.getState().units[key]);
  }
  const state = phone.getState(), expected = state.units[key];
  assert.equal(pack.bucketOf(key), bucket);
  const before = convert.stateToPlanner(state);
  assert.deepEqual(before, planner);
  const after = { tasks: [{ ...before.tasks[0], title: '旧手机改过的虚构待办' }] };
  await phone.commit(convert.applyPlannerChanges(state, before, after, oldPhone, h.clock.now()));
  h.clock.advance();
  assert.equal((await phone.syncNow()).ok, true);

  const manifests = h.writes().filter(call => call.method === 'put' && call.path.includes('/manifests/' + device + '/'));
  assert.ok(manifests.length);
  for (const { path } of manifests) await h.memory.remove(path);
  const reader = await h.device('fresh-reader');
  t.after(() => reader.engine.dispose());
  assert.equal((await reader.engine.join()).ok, true);
  const published = reader.engine.getState();
  assert.deepEqual(published.units[key], expected);
  assert.deepEqual(readFocusItems(published), changed.items);
  assert.equal(convert.stateToPlanner(published).tasks[0].title, after.tasks[0].title);
});
