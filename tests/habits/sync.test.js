import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../wiring/helpers.js';
import { fixture, habit, row, mount, savedState, TODAY, NOW, planner } from './helpers.js';
import { HabitActions } from '../../app/habit-actions.js';
import { createDataSource } from '../../app/datasource.js';
import { createEngine } from '../../sync/engine.js';
import { SyncState } from '../../app/syncstate.js';
import { stateToPlanner, plannerToState } from '../../sync/convert.js';
import { unitInfo } from '../../sync/merge.js';
import { unitKey, canonical } from '../../sync/canonical.js';
import { harness } from '../pack/helpers.js';

async function connected(t) {
  const h = await setup();
  t.after(() => { h.p.c.dispose(); h.computer.engine.dispose(); });
  h.clock.advance();
  await h.computerSource.change('虚构习惯种子', p => { p.habits.push(habit()); });
  await h.computer.engine.syncNow(); await h.p.c.join();
  return { ...h, mobile: new HabitActions(h.p.source, { now: h.clock.now }), desktop: new HabitActions(h.computerSource, { now: h.clock.now }) };
}
test('真实同步引擎 + 内存仓库：离线打卡先存本机，失败/重新读入不丢，恢复后电脑读到 checks/checkEdits', async t => {
  const h = await connected(t); h.p.online(false); h.clock.advance();
  await h.mobile.toggle('h', TODAY); assert.deepEqual(row(h.p.source).checks, [TODAY]);
  await h.p.c.syncNow();
  const restarted = await createDataSource({ store: h.p.store, now: h.clock.now });
  assert.deepEqual(row(restarted).checks, [TODAY]); assert.equal(row(restarted).checkEdits[TODAY], new Date(h.clock.now()).toISOString());
  h.p.online(true); h.clock.advance(); await h.p.c.syncNow(); await h.computer.engine.syncNow(); await h.computerSource.refresh();
  assert.deepEqual(row(h.computerSource).checks, [TODAY]); assert.equal(row(h.computerSource).checkEdits[TODAY], row(h.p.source).checkEdits[TODAY]);
  h.clock.advance(); await h.mobile.toggle('h', TODAY); await h.p.c.syncNow(); await h.computer.engine.syncNow(); await h.computerSource.refresh();
  assert.deepEqual(row(h.computerSource).checks, []);
  assert.equal(unitInfo(h.computer.engine.getState().units[unitKey('habit-check', 'h', TODAY)]).preferred.value, false);
});
test('真实同步引擎 + 模拟 DOM：电脑打卡与手机取消并发→显示两份→明确选择→两设备一致', async t => {
  const h = await connected(t), f = { source: h.p.source, clock: { now: h.clock.now } }, { root, view } = mount(f, t);
  h.clock.advance(); await h.mobile.toggle('h', TODAY); h.clock.advance(); await h.mobile.toggle('h', TODAY); await h.desktop.toggle('h', TODAY);
  await h.computer.engine.syncNow(); await h.p.c.syncNow();
  const conflict = h.p.source.snapshot().conflicts.find(c => c.path[0] === 'habit-check'); assert.ok(conflict);
  const card = root.querySelector('.conflict-card'); assert.match(card.textContent, /已打卡/); assert.match(card.textContent, /已取消/);
  card.querySelectorAll('button').find(b => b.textContent === '保留这一份：未打卡（已取消）').emit('click'); await view.flush();
  assert.equal(h.p.source.snapshot().conflicts.length, 0); assert.deepEqual(row(h.p.source).checks, []);
  h.clock.advance(); await h.p.c.syncNow(); await h.computer.engine.syncNow(); await h.computerSource.refresh();
  assert.deepEqual(row(h.computerSource).checks, []);
  assert.equal(canonical(await savedState(h.p.store)), canonical(h.computer.engine.getState()));
});
test('真实桶事务：同设备两个引擎并发补不同日期，未知感想/照片引用不丢，重载后一致', async t => {
  const h = harness(); h.clock.value = NOW;
  const a = await h.device('phone', plannerToState(planner(), 'computer', NOW)); await a.store.update(r => { r.settings.joined = true; });
  const b = createEngine({ store: a.store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers: h.clock.timers, repositoryId: 'fiction/repo' }); await b.load();
  t.after(() => { a.engine.dispose(); b.dispose(); });
  const one = await createDataSource({ store: a.store, now: h.clock.now }), two = await createDataSource({ store: a.store, now: h.clock.now });
  one.attachEngine(a.engine); two.attachEngine(b);
  await Promise.all([new HabitActions(one, { now: h.clock.now }).toggle('h', TODAY), new HabitActions(two, { now: h.clock.now }).toggle('h', '2026-11-12')]);
  await one.refresh(); const saved = stateToPlanner(await savedState(a.store));
  assert.deepEqual(saved.habits[0].checks, ['2026-11-12', TODAY]); assert.equal(Object.keys(saved.habits[0].checkEdits).length, 2);
  assert.deepEqual(saved.habits[0].journal, habit().journal); assert.deepEqual(one.snapshot().planner, saved);
});
