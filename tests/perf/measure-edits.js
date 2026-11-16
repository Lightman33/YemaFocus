// 收尾改动后的定向复测：只重跑受影响的两种编辑，各30次；完整硬门槛仍在perf.bench.js。
import { performance } from 'node:perf_hooks';
import { makeBigData } from './bigdata.js';
import { harness } from '../pack/helpers.js';
import { createDataSource } from '../../app/datasource.js';
import { TaskActions } from '../../app/task-actions.js';
const { state, taskId, reviewId } = makeBigData(), h = harness(), d = await h.device('phone', state);
await d.store.updateMetadata(r => { r.settings.joined = true; });
const now = () => 1794528000123, source = await createDataSource({ store: d.store, now }); source.attachEngine(d.engine);
const actions = new TaskActions(source, { now });
async function measure(label, fn) {
  const times = [];
  for (let i = 0; i < 30; i++) { const start = performance.now(); await fn(i); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  console.log(label + ' median=' + ((times[14] + times[15]) / 2).toFixed(3) + 'ms max=' + times[29].toFixed(3) + 'ms');
}
await measure('勾完成任务总耗时', () => actions.toggle(taskId));
await measure('改复盘一个模块总耗时', i => source.change('虚构复盘', p => { const row = p.reviews.find(r => r.id === reviewId); row.content = row.content.replace(/这是[^\n]*/, '这是虚构改动' + i); }));
d.engine.dispose();
