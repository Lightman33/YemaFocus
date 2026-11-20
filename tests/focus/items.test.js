import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setup } from '../wiring/helpers.js';
import { parseDocument } from '../tasks/dom-double.js';
import { createDataSource } from '../../app/datasource.js';
import { freshRecord, MemoryStore } from '../../app/store.js';
import { FocusTimer } from '../../app/focus-timer.js';
import { FocusView } from '../../app/focus-view.js';
import { focusItemsKey, readFocusItems } from '../../app/focus-items.js';
import { recordKey } from '../../app/focus-records.js';
import { emptyState, merge } from '../../sync/merge.js';
import { updateUnit } from '../../sync/edit.js';
import { unitKey } from '../../sync/canonical.js';
import { bucketOf } from '../../sync/pack.js';

const vector = JSON.parse(await readFile(new URL('../../../sync-spec/vectors/focus/long-term-items.json', import.meta.url)));
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const { device, initial, changed } = vector, key = focusItemsKey(device);

test('旧电脑提示升级，首次发布、改名、删除和空列表即时更新选择', async t => {
  const h = await setup();
  t.after(() => { h.p.c.dispose(); h.computer.engine.dispose(); });
  assert.equal((await h.p.c.join()).ok, true);
  const document = parseDocument(html), get = name => document.getElementById('focus-' + name);
  document.getElementById('page-focus').hidden = false;
  const timer = new FocusTimer({ store: h.p.store, source: h.p.source, now: h.clock.now });
  const view = new FocusView({ document, source: h.p.source, timer, onNotice() {}, playBell() {}, armBell() {} });
  t.after(() => view.destroy());
  await view.entered();
  const select = get('task');
  const groups = () => select.querySelectorAll('optgroup').map(node => [node.getAttribute('label'), node.children.map(option => option.textContent)]);
  assert.equal(h.p.source.snapshot().longTermItems, null);
  assert.deepEqual(groups(), [['今天的任务', ['电脑上的虚构任务']], ['长期事项', ['电脑升级到 v3.0 后显示']]]);
  assert.equal(select.querySelectorAll('option').at(-1).disabled, true);

  async function publish(list) {
    await h.computer.engine.commit(updateUnit(h.computer.engine.getState(), key, device, list, { updatedAt: h.clock.now() }));
    h.clock.advance();
    assert.equal((await h.computer.engine.syncNow()).ok, true);
    assert.equal((await h.p.c.syncNow()).ok, true);
    await h.p.source.refresh();
    assert.deepEqual(h.p.source.snapshot().longTermItems, list);
  }
  assert.equal(key, vector.key);
  assert.equal(bucketOf(key), vector.bucket);
  await publish(initial.items);
  assert.deepEqual(groups(), [
    ['今天的任务', ['电脑上的虚构任务']], ['长期事项 · 虚构研究', ['航海图,校注', '图集/草稿']],
    ['长期事项 · 阅读', ['札记']], ['长期事项 · 无大类', ['纸模']]
  ]);
  select.value = 'item:' + initial.items[0];
  select.emit('change');
  assert.equal(get('custom').hidden, true);
  get('start').emit('click');
  await view.pending;
  assert.equal(timer.state.session.subject, initial.items[0]);
  assert.equal(timer.state.session.link, '');

  await publish(changed.items);
  assert.equal(timer.state.session.subject, initial.items[0]);
  get('abandon').emit('click');
  get('abandon').emit('click');
  await view.pending;
  assert.equal(select.value, '');
  assert.equal(get('custom').hidden, false);
  assert.deepEqual(groups(), [
    ['今天的任务', ['电脑上的虚构任务']], ['长期事项 · 虚构研究', ['星图', '图集/草稿']], ['长期事项 · 阅读', ['札记']]
  ]);
  await assert.rejects(timer.act('start', { longTermItem: initial.items[0] }), /已改名或删除/);
  await assert.rejects(h.p.source.resolve(key, {}), /在电脑上修改/);
  await publish([]);
  assert.deepEqual(groups().at(-1), ['长期事项', ['暂无长期事项']]);
});

test('T46-11 今天的未完成任务排在长期事项之前，刷新保留选择和手写文字', async t => {
  const document = parseDocument(html), get = name => document.getElementById('focus-' + name);
  document.getElementById('page-focus').hidden = false;
  const store = new MemoryStore({ ...freshRecord(), state: emptyState(), settings: { joined: true, deviceId: 'phone' } });
  const source = await createDataSource({ store });
  const timer = new FocusTimer({ store, source });
  const view = new FocusView({ document, source, timer, onNotice() {}, playBell() {}, armBell() {} });
  t.after(() => view.destroy());
  const select = get('task'), item = get('item'), today = '2026-11-20';
  const tasks = [
    { id: 'future', title: 'A', date: '2026-11-21' },
    { id: 'today', title: 'B', date: today },
    { id: 'range', title: 'C', date: '2026-11-19', endDate: '2026-11-21' },
    { id: 'completed', title: 'D', date: today, done: true }
  ];
  const snapshot = { today, planner: { tasks }, longTermItems: ['虚构大类/长期事项'] };
  assert.equal(document.querySelector('[for="focus-task"]').textContent, '选择任务或长期事项（选填）');
  view.renderTasks(snapshot);
  assert.equal(select.children[0].textContent, '不选（自己写事项）');
  const groups = () => select.querySelectorAll('optgroup').map(group => [
    group.getAttribute('label'), group.children.map(option => option.value)
  ]);
  assert.deepEqual(groups(), [
    ['今天的任务', ['task:today', 'task:range']], ['其他未完成任务', ['task:future']],
    ['长期事项 · 虚构大类', ['item:虚构大类/长期事项']]
  ]);
  select.value = 'task:range';
  item.value = '虚构手写事项';
  view.renderTasks({ ...snapshot, today: '2026-11-21' });
  assert.deepEqual(groups()[0], ['今天的任务', ['task:future', 'task:range']]);
  assert.equal(select.value, 'task:range');
  assert.equal(item.value, '虚构手写事项');
});

test('同一长期事项的正常完成、提前结束、放弃与电脑八列和记录键相同', async () => {
  const state = updateUnit(emptyState(), key, device, initial.items);
  for (const { action, startUtc, finishUtc, day, columns, recordId } of vector.records) {
    let now = Date.parse(startUtc);
    const store = new MemoryStore({ ...freshRecord(), state, settings: { joined: true, deviceId: 'phone' } });
    const source = await createDataSource({ store, now: () => now });
    const timer = new FocusTimer({ store, source, now: () => now });
    await timer.refresh();
    await timer.act('start', { longTermItem: columns[4] });
    now = Date.parse(finishUtc);
    if (action === 'normal') await timer.advance();
    else await timer.act(action);
    assert.deepEqual(source.snapshot().records, [{ day, columns, id: recordId }]);
    assert.equal(await recordKey(day, columns, 0), unitKey('record', recordId));
    assert.deepEqual((await store.read()).state.units[key], state.units[key]);
  }
});

test('多个设备号都发布过时只取最近发布的那份（电脑重新开启同步会换设备号）', () => {
  const first = updateUnit(emptyState(), key, device, initial.items, { updatedAt: 1000 });
  const other = 'pc-2';
  const second = updateUnit(emptyState(), focusItemsKey(other), other, [initial.items[0], '另一台/虚构', initial.items[0]], { updatedAt: 2000 });
  // 新设备号较晚发布：旧设备号里电脑已删掉的事项不再出现，重名去重
  assert.deepEqual(readFocusItems(merge(first, second)), [initial.items[0], '另一台/虚构']);
  // 旧设备号又较晚发布（例如另一台电脑）：以它为准
  assert.deepEqual(readFocusItems(updateUnit(merge(first, second), key, device, ['较晚/虚构'], { updatedAt: 3000 })), ['较晚/虚构']);
  // 最近发布的是空列表：手机不显示长期事项，但仍算“电脑已发布”
  assert.deepEqual(readFocusItems(updateUnit(merge(first, second), key, device, [], { updatedAt: 3000 })), []);
});
