// 仅虚构仓库。刷新时外壳同时清空 SIM_DATABASE；不接触正式库。
import { MemoryTransport } from '../transport/memory.js';
import { MemoryStore, freshRecord } from './store.js';
import { SyncState } from './syncstate.js';
import { createEngine } from '../sync/engine.js';
import { createDataSource, wallTime } from './datasource.js';
import { createDemoReviewData } from './demo-review-data.js';
import { plannerToState } from './goal-sync.js';
import { addDemoGoals, seedDemoFocusItems } from './demo-data.js';
import { updateUnit } from '../sync/edit.js';
import { encodeLegacy, unitKey } from '../sync/canonical.js';
import { ReviewText } from './review-model.js';
import { HabitActions } from './habit-actions.js';
export const SIM_DATABASE = 'yema-mobile-v29-sim';
export const SIM_SETTINGS = { owner: 'fictional-owner', repo: 'sim-data', deviceName: '虚构手机' };
export const SIM_TOKEN = 'fictional-simulation-token';
export function reviewSeedState(today, now, device = 'sim-computer') {
  const data = createDemoReviewData(today);
  addDemoGoals(data.planner, today);
  let state = seedDemoFocusItems(plannerToState(data.planner, device, now), device, now);
  for (const [key, value] of Object.entries(data.settings)) state = updateUnit(state, unitKey('setting', key), device, encodeLegacy(value), { updatedAt: now });
  for (const r of data.records) state = updateUnit(state, unitKey('record', r.id), device, encodeLegacy({ day: r.day, columns: r.columns }), { updatedAt: now });
  return state;
}
export async function createSimRepository({ now }) {
  let time = now(), offline = false, taskEdits = 0, reviewEdits = 0;
  const today = wallTime(time, 'Asia/Shanghai').slice(0, 10), memory = new MemoryTransport({ now: () => time });
  const initial = freshRecord(); initial.settings = { ...SIM_SETTINGS, deviceId: 'sim-computer', joined: true }; initial.token = SIM_TOKEN;
  initial.state = { format: 'yema-engine-local', schema: 1, device: 'sim-computer', joined: true,
    state: reviewSeedState(today, time), revision: 1, sequence: 0, seen: {}, published: null, lastPublishedAt: null };
  const store = new MemoryStore(initial), syncState = new SyncState();
  const engine = createEngine({ store, syncState, transport: memory, now: () => time,
    timers: { setTimeout: () => 0, clearTimeout() {} }, repositoryId: 'fictional-owner/sim-data' });
  await engine.load(); await engine.syncNow();
  const source = await createDataSource({ store, now: () => time }); source.attachEngine(engine);
  // 持续断网开关；MemoryTransport 的一次性故障不适合 UI 的断网期间。
  const transport = Object.fromEntries(['list', 'get', 'put', 'remove', 'test'].map(method => [method, (...args) => {
    if (offline) { memory.injectFault({ type: 'offline', operation: method }); }
    return memory[method](...args);
  }]));
  async function publish() { const result = await engine.syncNow(); await source.refresh(); return result; }
  return { memory, transport, isOnline: () => !offline, setOffline(value) { offline = Boolean(value); },
    async editTask() {
      time = Math.max(time, now()) + 60001;
      await source.change('模拟电脑修改任务', p => { p.tasks.find(t => t.id === 'demo-task-0').notes = '电脑写下的虚构备注 · ' + (++taskEdits); });
      return publish();
    },
    async editReview() {
      time = Math.max(time, now()) + 60001;
      await source.change('模拟电脑修改复盘', p => {
        const review = p.reviews.find(r => r.id === 'day:' + today);
        const sections = ReviewText.parse(review.content).map(s => [...s]);
        const entry = sections.find(s => s[0] === '收获与亮点'); entry[1] = '电脑补充的虚构复盘 · ' + (++reviewEdits);
        review.content = ReviewText.compose(sections);
      });
      return publish();
    },
    async editHabit() {
      time = Math.max(time, now()) + 60001;
      await new HabitActions(source, { now: () => time }).setCheck('demo-read', today, true);
      return publish();
    },
    dispose() { engine.dispose(); store.close(); }
  };
}
