// 首屏诊断：同一虚构大库，单次拆开引擎与来源阶段。不是 30 次验收表的替代。
// cd web && node tests/perf/measure-startup.js
import { performance } from 'node:perf_hooks';
import { makeBigData } from './bigdata.js';
import { MemoryStore } from '../../app/store.js';
import { createEngine } from '../../sync/engine.js';
import { createDataSource } from '../../app/datasource.js';
import { SyncState } from '../../app/syncstate.js';
import { harness, record } from '../pack/helpers.js';
const data = makeBigData(), h = harness(), initial = record('phone', data.state);
initial.settings.joined = true;
const store = new MemoryStore(initial), timers = { setTimeout() { return 1; }, clearTimeout() {} };
const make = () => createEngine({ store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers, repositoryId: 'fiction/repo' });
const prime = make(); await prime.load(); prime.dispose(); store.resetStats();
const start = performance.now(), engine = make();
await engine.loadTasks(); const engineReady = performance.now(), engineReads = store.stats.bucketReads;
const source = await createDataSource({ store, now: () => 1794528000123, tasksFirst: true }); source.attachEngine(engine);
const first = source.snapshot(), sourceReady = performance.now();
console.log(JSON.stringify({ n: 1, engineTasksMs: engineReady - start, sourceInitMs: sourceReady - engineReady, totalMs: sourceReady - start,
  tasks: first.planner.tasks.length, loadedUnits: Object.keys(source.record.state.units).length, loading: first.loading,
  engineBucketReads: engineReads, sourceBucketReads: store.stats.bucketReads - engineReads,
  readDeferredBuckets: store.calls.filter(c => c.operation === 'read' && /^bucket:(reviews-|habits|records-)/.test(c.key)).length }, null, 2));
engine.dispose();
