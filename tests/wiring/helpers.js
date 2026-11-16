import { harness } from '../pack/helpers.js';
import { MemoryStore, freshRecord } from '../../app/store.js';
import { SyncState } from '../../app/syncstate.js';
import { createEngine } from '../../sync/engine.js';
import { createSyncController } from '../../app/sync-controller.js';
import { createDataSource } from '../../app/datasource.js';
import { plannerToState } from '../../sync/convert.js';
import { updateUnit } from '../../sync/edit.js';
import { unitKey } from '../../sync/canonical.js';
export const config = (repo = 'repo', token = 'fictional-token') => ({ settings: { owner: 'fiction', repo, deviceName: '虚构手机' }, token });
export function seed(now) {
  let state = plannerToState({ projects: [], tasks: [{ id: 't', title: '电脑上的虚构任务', notes: '原备注', done: false, steps: [], date: '2026-11-13', created: '2026-11-13 08:00:00' }],
    reviews: [{ id: 'day:2026-11-13', scale: 'day', start: '2026-11-13', end: '2026-11-13', title: '电脑上的虚构复盘', score: 3, content: '【今日完成】\n原正文', updated: '2026-11-13T08:00:00.000Z' }], habits: [], deleted: {} }, 'computer', now);
  state = updateUnit(state, unitKey('setting', 'TimeZone'), 'computer', 'China Standard Time');
  return updateUnit(state, unitKey('setting', 'ReviewModules.day'), 'computer', '今日完成|收获与亮点');
}
export async function setup({ empty = false } = {}) {
  const h = harness(); h.clock.value = Date.parse('2026-11-13T08:00:00Z');
  h.transport.test = () => h.memory.test();
  let computer = null;
  if (!empty) { computer = await h.device('computer', seed(h.clock.now())); await computer.store.update(r => { r.settings.joined = true; }); await computer.engine.syncNow(); }
  let count = 0;
  async function phone(initial, transport = h.transport) {
    let visible = true, online = true, made = 0;
    const store = new MemoryStore(initial || { ...freshRecord(), ...config(), settings: { ...config().settings, deviceId: 'phone-' + (++count) } });
    const progress = new SyncState(), c = createSyncController({ store, syncState: progress, makeTransport: () => { made++; return transport; }, makeEngine: createEngine,
      now: h.clock.now, timers: h.clock.timers, newDeviceId: () => 'new-phone-' + (++count), isVisible: () => visible, isOnline: () => online });
    await c.init(); const source = await createDataSource({ store, now: h.clock.now }); c.setDataSource(source);
    return { store, source, c, progress, made: () => made, visible: value => { visible = value; }, online: value => { online = value; } };
  }
  const p = await phone();
  const computerSource = computer ? await createDataSource({ store: computer.store, now: h.clock.now }) : null;
  computerSource?.attachEngine(computer.engine);
  return { ...h, phone, p, computer, computerSource };
}
