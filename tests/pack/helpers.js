import { MemoryTransport } from '../../transport/memory.js';
import { MemoryStore, freshRecord } from '../../app/store.js';
import { SyncState } from '../../app/syncstate.js';
import { createEngine } from '../../sync/engine.js';
import { emptyState } from '../../sync/merge.js';

export class Clock {
  value = 1000000;
  next = 1;
  jobs = new Map();
  now = () => this.value;
  timers = {
    setTimeout: (fn, ms) => { const id = this.next++; this.jobs.set(id, { at: this.value + ms, fn }); return id; },
    clearTimeout: id => this.jobs.delete(id)
  };
  async tick(ms) {
    const end = this.value + ms;
    for (;;) {
      const entry = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > end) break;
      this.value = entry[1].at; this.jobs.delete(entry[0]);
      await entry[1].fn();
    }
    this.value = end;
  }
  advance(ms = 60001) { this.value += ms; }
}
export function record(device, state = null) {
  const result = freshRecord();
  result.settings = { deviceId: device, deviceName: '虚构设备', owner: 'fiction', extra: '不能覆盖' };
  result.token = 'fiction-token';
  if (state !== null) result.state = { format: 'yema-engine-local', schema: 1, device, joined: true, state,
    revision: 1, sequence: 0, seen: {}, published: null, lastPublishedAt: null };
  return result;
}
export function harness() {
  const clock = new Clock(), memory = new MemoryTransport({ now: clock.now }), calls = [];
  const transport = {};
  for (const method of ['list', 'get', 'put', 'remove']) transport[method] = async (...args) => {
    calls.push({ method, path: args[0], at: clock.now(), bytes: args[1]?.length || 0 });
    return memory[method](...args);
  };
  async function device(id, state = null, initial = null) {
    const store = new MemoryStore(initial || record(id, state)), syncState = new SyncState();
    const engine = createEngine({ store, syncState, transport, now: clock.now, timers: clock.timers, repositoryId: 'fiction/repo' });
    await engine.load();
    return { engine, store, syncState, id };
  }
  return { clock, memory, transport, calls, device, writes: () => calls.filter(c => ['put', 'remove'].includes(c.method)), emptyState };
}
