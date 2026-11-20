import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { awaySummary, durationText, FocusTimer, JOIN_TIP, timerReading } from '../../app/focus-timer.js';
import { focusRecord, MINUTE, recordKey, recordMinutes, taskFocus, todayFocus } from '../../app/focus-records.js';
import { createDataSource } from '../../app/datasource.js';
import { freshRecord, MemoryStore } from '../../app/store.js';
import { unitKey } from '../../sync/canonical.js';
import { bucketOf } from '../../sync/pack.js';
import { updateUnit } from '../../sync/edit.js';
import { plannerToState } from '../../sync/convert.js';

const vectors = JSON.parse(await readFile(new URL('../../../sync-spec/vectors/focus/record-keys.json', import.meta.url)));
const START = Date.parse('2026-11-03T15:55:00.000Z');
async function fixture({ joined = true, start = START } = {}) {
  let now = start, id = 0;
  const initial = plannerToState({ version: 1, tasks: [], projects: [] }, 'pc-test', START);
  const state = updateUnit(initial, unitKey('setting', 'TimeZone'), 'pc-test', 'China Standard Time', { updatedAt: START });
  const store = new MemoryStore({ ...freshRecord(), state, settings: { joined, deviceId: 'phone' } });
  const open = async local => {
    const source = await createDataSource({ store: local, now: () => now });
    const timer = new FocusTimer({ store: local, source, now: () => now, newId: () => 'fiction-session-' + (++id) });
    await timer.refresh();
    return { source, timer };
  };
  return { store, ...await open(store), reopen: () => open(store.reopen()), add: ms => { now += ms; } };
}

test('共用向量固定 C# / JS 记录键和开始月份桶', async () => {
  for (const { label, day, columns, occurrence, id } of vectors) {
    const key = await recordKey(day, columns, occurrence);
    assert.equal(key, unitKey('record', id), label);
    assert.equal(bucketOf(key), 'records-' + day.slice(0, 7), label);
  }
});

test('首次同步前不能开始，修改时长仅写本机设置', async () => {
  const { store, timer } = await fixture({ joined: false });
  await assert.rejects(timer.act('start'), { message: JOIN_TIP });
  const before = (await store.read()).state;
  await timer.saveMinutes(3, 2);
  const saved = await store.read();
  assert.equal(saved.settings.focusTimer.workMinutes, 3);
  assert.equal(saved.settings.focusTimer.breakMinutes, 2);
  assert.deepEqual(saved.state, before);
  assert.throws(() => timer.saveMinutes(0, 5), /整分钟/);
});

test('按真实时间经过后台，暂停期不算专注，跨午夜按开始日期', async () => {
  const { timer, reopen, add } = await fixture();
  await timer.act('start', { subject: '虚构读书' });
  add(2 * MINUTE);
  assert.equal(timerReading(timer.state.session, timer.now()).remaining, 23 * MINUTE);
  await timer.act('pause');
  add(60 * MINUTE);
  const resumed = await reopen();
  assert.equal(timerReading(resumed.timer.state.session, resumed.timer.now()).remaining, 23 * MINUTE);
  assert.equal(await resumed.timer.advance(true), null);
  await resumed.timer.act('resume');
  add(10 * MINUTE);
  assert.equal(timerReading(resumed.timer.state.session, resumed.timer.now()).remaining, 13 * MINUTE);
  add(30 * MINUTE);
  assert.deepEqual(await resumed.timer.advance(true), { automatic: true, message: '专注完成' });
  const [row] = resumed.source.snapshot().records;
  assert.deepEqual(row.columns, ['番茄', '2026-11-03 23:55:00', '2026-11-04 01:20:00', '25', '虚构读书', '完成', '程序关闭期间到点', '']);
  assert.equal(row.day, '2026-11-03');
  assert.equal(resumed.timer.state.offer, true);
  const again = await reopen();
  assert.equal(await again.timer.advance(true), null);
  assert.equal(again.source.snapshot().records.length, 1);
});

test('会话保存失败仍可重试，记录已落盘但未清会话时重开也只记一次', async () => {
  const f = await fixture();
  await f.timer.saveMinutes(1, 5);
  await f.timer.act('start');
  f.add(2 * MINUTE);
  const save = f.source.saveFocusRecord.bind(f.source);
  f.source.saveFocusRecord = (...args) => { f.store.failNextWrite('bucket-1'); return save(...args); };
  await assert.rejects(f.timer.advance(true));
  assert.equal(f.timer.state.session.ending.at, START + MINUTE);
  assert.equal(f.source.snapshot().records.length, 0);
  const retry = await f.reopen();
  const write = retry.source.saveFocusRecord.bind(retry.source);
  retry.source.saveFocusRecord = async (...args) => {
    const result = await write(...args);
    f.store.failNextWrite('before-metadata');
    return result;
  };
  await assert.rejects(retry.timer.advance(true));
  assert.equal(retry.source.snapshot().records.length, 1);
  const reopened = await f.reopen();
  assert.equal((await reopened.timer.advance(true)).message, '专注完成');
  assert.equal(await reopened.timer.advance(true), null);
  assert.equal(reopened.source.snapshot().records.length, 1);
});

test('多个标签页同时开始和到期，只有一轮被保存、只提示一次', async () => {
  const f = await fixture(), second = await f.reopen();
  await Promise.all([f.timer.act('start'), second.timer.act('start')]);
  assert.equal(f.timer.state.session.id, second.timer.state.session.id);
  f.add(30 * MINUTE);
  const results = await Promise.all([f.timer.advance(true), second.timer.advance(true)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await f.reopen()).source.snapshot().records.length, 1);
});

test('真正的同日同内容两轮按序号 0 和 1 存储', async () => {
  const f = await fixture();
  await f.timer.act('start');
  await f.timer.act('abandon');
  await f.timer.act('start');
  await f.timer.act('abandon');
  const rows = f.source.snapshot().records;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].columns, rows[1].columns);
  const expected = await Promise.all([0, 1].map(i => recordKey(rows[0].day, rows[0].columns, i)));
  assert.deepEqual(rows.map(row => unitKey('record', row.id)).sort(), expected.sort());
});

test('提前结束、放弃、自然休息、跳过休息沿用电脑列和值', async () => {
  const f = await fixture({ start: START - 60 * MINUTE });
  const { timer, source, add } = f;
  await timer.act('start', { subject: '　虚构／练习　' }); add(4500);
  await timer.act('early');
  await timer.act('rest'); add(5 * MINUTE); await timer.advance();
  await timer.act('start'); add(30 * 1000); await timer.act('abandon');
  await timer.act('start'); add(120 * 1000); await timer.act('early');
  await timer.act('skip');
  await timer.act('start'); add(10 * 1000); await timer.act('early');
  await timer.act('rest'); add(80 * 1000); await timer.act('skip');
  const rows = source.snapshot().records.map(r => [r.columns[0], r.columns[3], r.columns[4], r.columns[5]]);
  for (const expected of [['番茄', '0.08', '虚构/练习', '完成'], ['番茄', '0.5', '专注', '放弃'],
    ['休息', '5', '短休息', '完成'], ['休息', '0', '短休息', '跳过'], ['休息', '1.33', '短休息', '跳过']])
    assert.ok(rows.some(row => JSON.stringify(row) === JSON.stringify(expected)), expected.join(' '));
  assert.equal(rows.length, 7);
  assert.equal(recordMinutes(900), '0.02');
  assert.equal(recordMinutes(25 * MINUTE), '25');
  const daily = todayFocus(source.snapshot());
  assert.equal(daily.count, 3);
  assert.ok(Math.abs(daily.minutes - 2.25) < 0.0001);
  assert.equal(daily.recent.length, 5);
});

test('关联任务时沿用桌面项目归类和复发系列编号', () => {
  const task = { id: 't1', series: 'original', title: '虚构\n任务', project: 'child' };
  const planner = { projects: [{ id: 'root', name: '虚构项目' }, { id: 'child', name: '小组', parent: 'root' }] };
  assert.deepEqual(taskFocus(planner, task, '不采用的输入'), { subject: '虚构项目/小组', link: 'original|虚构 任务' });
  assert.deepEqual(taskFocus(planner, { ...task, project: '' }), { subject: '无项目任务', link: 'original|虚构 任务' });
  const r = focusRecord({ kind: 'work', startedAt: START, zone: 'UTC', ending: { at: START, elapsed: 0, status: '放弃', note: '' }, ...taskFocus(planner, task) });
  assert.equal(r.columns[7], 'original|虚构 任务');
});

test('保存前事项和关联任务按电脑版规则规范化，保留全角字形', async () => {
  const vector = vectors.find(v => v.rawSubject);
  const [kind, start, end, minutes, , status, note] = vector.columns;
  const startedAt = Date.parse(start.replace(' ', 'T') + 'Z'), at = Date.parse(end.replace(' ', 'T') + 'Z');
  const r = focusRecord({ kind: kind === '番茄' ? 'work' : 'rest', startedAt, zone: 'UTC',
    ending: { at, elapsed: Number(minutes) * MINUTE, status, note }, subject: vector.rawSubject, link: vector.rawLink });
  assert.deepEqual(r, { day: vector.day, columns: vector.columns });
  assert.equal(await recordKey(r.day, r.columns, vector.occurrence), unitKey('record', vector.id));
  const task = { id: 't1', title: '全角Ｂ　 ' };
  const linked = focusRecord({ kind: 'work', startedAt, zone: 'UTC',
    ending: { at, elapsed: at - startedAt, status, note }, ...taskFocus({ projects: [] }, task) });
  assert.equal(linked.columns[7], r.columns[7]);
});

test('旧手机已保存带空格的原始键、尚未清理会话时，升级重开也只记一次', async () => {
  const f = await fixture();
  await f.timer.act('start');
  await f.store.updateMetadata(record => { record.settings.focusTimer.session.link = 't1|全角Ｂ　 '; });
  await f.timer.refresh();
  const save = f.source.saveFocusRecord.bind(f.source);
  f.source.saveFocusRecord = async (session, value) => {
    const columns = [...value.columns];
    columns[7] = session.link;
    const saved = await save(session, { ...value, columns });
    f.store.failNextWrite('before-metadata');
    return saved;
  };
  await assert.rejects(f.timer.act('early'));
  const [old] = f.source.snapshot().records;
  assert.equal(old.columns[7], 't1|全角Ｂ　 ');
  const reopened = await f.reopen();
  assert.equal((await reopened.timer.advance(true)).message, '专注完成');
  assert.deepEqual(reopened.source.snapshot().records.map(row => row.id), [old.id]);
});

test('v3.0.1 番茄中切走：3 秒以上记离开次数和时长，写进记录备注；暂停和休息时不算', async () => {
  const { timer, source, add, reopen } = await fixture();
  assert.equal(durationText(45000), '45 秒');
  assert.equal(durationText(130000), '2 分 10 秒');
  assert.equal(durationText(180000), '3 分钟');
  await timer.act('start', { subject: '虚构读书' });
  add(MINUTE);
  await timer.left();
  add(2 * MINUTE + 10000);
  assert.equal(await timer.advance(true), null);
  assert.equal(timer.state.session.awayCount, 1);
  assert.equal(timer.state.session.awaySince, null);
  assert.equal(timer.notice, '刚才离开了 2 分 10 秒，已记在这个番茄上');
  await timer.left();
  add(2000);
  await timer.advance(true);
  assert.equal(timer.state.session.awayCount, 1, '不足 3 秒不算');
  await timer.act('pause');
  await timer.left();
  assert.equal(timer.state.session.awaySince ?? null, null, '暂停时离开不算');
  add(10 * MINUTE);
  await timer.act('resume');
  // 页面在后台被系统关掉：离开时刻已存盘，重开后照样结算，到点部分只算到截止时刻。
  await timer.left();
  add(60 * MINUTE);
  const again = await reopen();
  assert.deepEqual(await again.timer.advance(true), { automatic: true, message: '专注完成（中途离开 2 次，共 23 分 58 秒）' });
  const row = again.source.snapshot().records.at(-1);
  assert.equal(row.columns[5], '完成');
  assert.equal(row.columns[6], '程序关闭期间到点；中途离开 2 次，共 23 分 58 秒');
  await again.timer.act('rest');
  await again.timer.left();
  assert.equal(again.timer.state.session.awaySince ?? null, null, '休息时离开不算');
  assert.equal(awaySummary(null), '');
  assert.ok(source);
});

test('v3.0.1 离开后放弃，放弃记录也带离开说明', async () => {
  const { timer, source, add } = await fixture();
  await timer.act('start', { subject: '虚构写作' });
  await timer.left();
  add(5 * MINUTE);
  await timer.advance(true);
  assert.deepEqual(await timer.act('abandon'), { automatic: false, message: '已记为放弃（中途离开 1 次，共 5 分钟）' });
  assert.equal(source.snapshot().records.at(-1).columns[6], '中途离开 1 次，共 5 分钟');
});
