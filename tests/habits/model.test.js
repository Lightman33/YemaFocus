import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduled, frequencyText, checksInWeek, weekProgress, groupHabits, weekDays, inPlan, weekIndex, checkDayIssue } from '../../app/habit-model.js';
import { habit, TODAY } from './helpers.js';

test('Habit.Scheduled / FreqText：每天和缺省类型', () => {
  for (const kind of ['Daily', undefined, 'unknown']) {
    const h = habit({ kind });
    for (const day of weekDays(TODAY)) assert.equal(scheduled(h, day), true);
    assert.equal(frequencyText(h), '每天'); assert.equal(weekProgress(h, TODAY).target, 7);
  }
});
test('RepeatRule.Bit：周一为第 0 位、周日为第 6 位；逐星期、掩码组合对照', () => {
  const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];
  for (let mask = 0; mask < 128; mask++) for (let i = 0; i < 7; i++) {
    assert.equal(weekIndex(days[i]), i);
    assert.equal(scheduled(habit({ kind: 'Weekdays', weekMask: mask }), days[i]), Boolean(mask & (1 << i)));
  }
  for (const [weekMask, expected] of [[127, '每天'], [31, '周一至周五'], [21, '每周一、三、五'], [96, '每周六、日'], [0, '每周']]) {
    assert.equal(frequencyText(habit({ kind: 'Weekdays', weekMask })), expected);
  }
  assert.equal(frequencyText(habit({ kind: 'Weekdays', weekMask: undefined })), '每天');
});
test('Habit.WeekUnit / ChecksInWeek：每周 N 次达标后仍每天 Scheduled，不把周末当下一周', () => {
  const h = habit({ kind: 'TimesPerWeek', perWeek: 3, checks: ['2026-11-08', '2026-11-09', '2026-11-11', '2026-11-12', '2026-11-15', '2026-11-16'] });
  assert.equal(frequencyText(h), '每周 3 次'); assert.equal(checksInWeek(h, '2026-11-09'), 4);
  assert.deepEqual(weekProgress(h, TODAY), { done: 4, target: 3, text: '本周 4/3' });
  assert.equal(scheduled(h, TODAY), true); assert.equal(groupHabits([h], TODAY).due.length, 1);
  assert.equal(weekProgress(habit({ kind: 'TimesPerWeek', perWeek: undefined }), TODAY).target, 3);
});
test('Habit.Scheduled / Start / Ended：起止含当天；Scheduled 不检查 Start，由列表入口检查', () => {
  const h = habit({ start: TODAY, end: '2026-11-15' });
  assert.equal(scheduled(h, '2026-11-12'), true); assert.equal(inPlan(h, '2026-11-12'), false);
  assert.equal(inPlan(h, TODAY), true); assert.equal(inPlan(h, '2026-11-15'), true); assert.equal(inPlan(h, '2026-11-16'), false);
  assert.equal(weekProgress(habit({ end: '2026-11-11' }), TODAY).target, 3);
  // DrawTrend 原规则不裁掉 Start 之前的周目标。
  assert.equal(weekProgress(h, TODAY).target, 7);
});
test('HabitSummary.Compute：归档不参与；不用打卡组包含未来开始、已结束、当天非指定星期', () => {
  const habits = [habit({ id: 'a', archived: true }), habit({ id: 'd', order: 3 }), habit({ id: 'b', kind: 'Weekdays', weekMask: 1 }),
    habit({ id: 'c', start: '2026-11-14' }), habit({ id: 'e', end: '2026-11-12' })];
  const groups = groupHabits(habits, TODAY);
  assert.deepEqual(groups.due.map(h => h.id), ['d']); assert.deepEqual(groups.other.map(h => h.id), ['b', 'c', 'e']);
});
test('PlannerData.WeekStart 对照：一周中任一天都取同一周一，覆盖闰年跨月与跨年周日', () => {
  const leapWeek = ['2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02', '2028-03-03', '2028-03-04', '2028-03-05'];
  for (const day of leapWeek) assert.deepEqual(weekDays(day), leapWeek);
  assert.equal(weekDays('2027-01-03')[0], '2026-12-28');
  assert.equal(weekDays('2027-01-03')[6], '2027-01-03');
  assert.equal(weekDays('2027-01-04')[0], '2027-01-04');
});
test('打卡边界：对照电脑周卡的未来、开始前和非排程日，加上手机结束日与六天窗口', () => {
  const h = habit({ start: '2026-11-08', end: '2026-11-12', kind: 'Weekdays', weekMask: 1 });
  assert.match(checkDayIssue(h, '2026-11-14', TODAY), /未来/);
  assert.match(checkDayIssue(h, '2026-11-07', TODAY), /尚未开始/);
  assert.equal(checkDayIssue(h, '2026-11-08', TODAY), '');
  assert.equal(checkDayIssue(h, '2026-11-12', TODAY), '');
  assert.match(checkDayIssue(h, TODAY, TODAY), /结束/);
  assert.equal(checkDayIssue(habit(), TODAY, TODAY), '');
  assert.equal(checkDayIssue(habit(), '2026-11-07', TODAY), '');
  assert.equal(checkDayIssue(habit(), '2026-11-06', TODAY), ''); // v3.0：照电脑，无天数上限
  assert.match(checkDayIssue(h, '2026-02-30', TODAY), /无效/);
});
