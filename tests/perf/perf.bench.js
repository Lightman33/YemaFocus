// 六项大数据验收目标，全部各30次，保留硬断言；不进入日常 node --test。
// cd web && node --test tests/perf/perf.bench.js
// 完整冷转换/引擎载入的历史诊断见 T28 交接；首屏阶段诊断见 measure-startup.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBigData } from './bigdata.js';
import { MemoryStore } from '../../app/store.js';
import { createDataSource } from '../../app/datasource.js';
import { TaskActions } from '../../app/task-actions.js';
import { createEngine } from '../../sync/engine.js';
import { SyncState } from '../../app/syncstate.js';
import { harness, record } from '../pack/helpers.js';
const now = () => 1794528000123;
const timers = { setTimeout() { return 1; }, clearTimeout() {} };
test('T28 大数据性能（六项各30次，中位数及最大值；内存仓库无网络延迟）', { timeout: 3600000 }, async t => {
  const data = makeBigData(), results = {}, resultFile = join(tmpdir(), 'yema-t28-perf-after.json');
  t.diagnostic('虚构单元数 ' + Object.keys(data.state.units).length + '；JSON字节 ' + Buffer.byteLength(JSON.stringify(data.state)));
  async function measure(label, fn) {
    const times = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); await fn(i); times.push(performance.now() - start); }
    times.sort((a, b) => a - b);
    const median = (times[14] + times[15]) / 2, max = times[29];
    results[label] = { median, max, n: 30 };
    t.diagnostic(label + ' median=' + median.toFixed(3) + 'ms max=' + max.toFixed(3) + 'ms');
    // 部分 Node 隔离模式只输出文件级结果，另留本机临时 JSON；不含业务正文。
    writeFileSync(resultFile, JSON.stringify(results, null, 2));
    return median;
  }
  const h = harness(), store = new MemoryStore(record('phone', data.state));
  const engine = createEngine({ store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers, repositoryId: 'fiction/repo' });
  await engine.load(); await store.updateMetadata(r => { r.settings.joined = true; });
  const source = await createDataSource({ store, now }); source.attachEngine(engine);
  const actions = new TaskActions(source, { now });
  try {
    const snapshotTime = await measure('snapshot后续', () => source.snapshot());
    const toggleTime = await measure('勾完成任务总耗时', () => actions.toggle(data.taskId));
    const reviewTime = await measure('改复盘一个模块总耗时', i => source.change('虚构复盘编辑', p => {
      const row = p.reviews.find(r => r.id === data.reviewId); row.content = row.content.replace(/这是[^\n]*/, '这是虚构改动' + i);
    }));
    const storageTime = await measure('存储空修改（元数据事务）', () => store.updateMetadata(() => {}));
    // 库已是此前正常存好的分桶格式；一次性旧库转换不混进日常启动门槛。
    const startupTime = await measure('打开到任务数据可用', async () => {
      const first = createEngine({ store, transport: h.transport, syncState: new SyncState(), now: h.clock.now, timers, repositoryId: 'fiction/repo' });
      try {
        await first.loadTasks();
        const early = await createDataSource({ store, now, tasksFirst: true }); early.attachEngine(first);
        assert.equal(early.snapshot().planner.tasks.length, 3000); assert.equal(early.snapshot().loading.reviews, true);
      } finally { first.dispose(); }
    });
    assert.equal((await engine.syncNow()).ok, true);
    const syncTime = await measure('无变化syncNow', async () => { h.clock.advance(); assert.equal((await engine.syncNow()).ok, true); });
    await t.test('后续snapshot中位数≤5ms', () => assert.ok(snapshotTime <= 5, '实际 ' + snapshotTime));
    await t.test('勾完成中位数≤40ms', () => assert.ok(toggleTime <= 40, '实际 ' + toggleTime));
    await t.test('改模块中位数≤40ms', () => assert.ok(reviewTime <= 40, '实际 ' + reviewTime));
    await t.test('打开到任务数据可用中位数≤1000ms', () => assert.ok(startupTime <= 1000, '实际 ' + startupTime));
    await t.test('无变化同步中位数≤300ms', () => assert.ok(syncTime <= 300, '实际 ' + syncTime));
    await t.test('空存储事务中位数≤5ms', () => assert.ok(storageTime <= 5, '实际 ' + storageTime));
  } finally { engine.dispose(); }
});
