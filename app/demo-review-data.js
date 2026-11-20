// 全部内容均为虚构；日期相对传入今天生成。内存来源仅供独立验收页使用。
import { Period, addDays, weekStart, ReviewText, DEFAULT_MODULES, DATA_TITLE, findReview, wallTime, validDay } from './review-model.js';
const clone = value => structuredClone(value);
export function createDemoReviewData(today) {
  if (!validDay(today)) throw new Error('示例日期无效');
  const planner = { version: 1, tasks: [], projects: [{ id: 'demo-study', name: '虚构学习计划', color: 0 }, { id: 'demo-life', name: '虚构生活计划', color: 1 }], habits: [], reviews: [], weekNotes: [], deleted: {} }, records = [];
  const makeReview = (p, n, extra = false) => {
    const names = DEFAULT_MODULES[p.scale].split('|'), sections = [[names[0], '整理了虚构读书卡片，完成一小段练习。'],[names[1], '把大任务拆成两步后，更容易开始。'],[names[2], n % 3 ? '' : '桌面有点杂，下次开始前先收拾两分钟。'],[names[3], '读两页示例书，整理一条虚构笔记。']];
    if (extra) sections.push(['旧版小记', '这是存档中的额外模块，继续保留在末尾。']);
    return { id: p.id, scale: p.scale, start: p.start, end: p.end, title: '慢慢完成，也在前进（虚构示例）', score: 3 + n % 3, content: ReviewText.compose(sections), created: p.start + ' 19:30:00', updated: p.start + 'T11:30:00.000Z' };
  };
  const addRecord = (kind, date, hour, minute, duration, status, task = '') => {
    const start = date + ' ' + String(hour).padStart(2,'0') + ':' + String(minute).padStart(2,'0') + ':00';
    const total = hour * 60 + minute + duration, end = date + ' ' + String(Math.floor(total / 60)).padStart(2,'0') + ':' + String(total % 60).padStart(2,'0') + ':00';
    records.push({ id: 'demo-record-' + records.length, day: date, columns: [kind, start, end, String(duration), task, status, '', ''] });
  };
  for (let i = 20; i >= 0; i--) {
    const d = addDays(today, -i), p = Period.of('day', d), id = 'demo-task-' + i;
    planner.reviews.push(makeReview(p, i, i === 1));
    planner.tasks.push({ id, title: '整理虚构笔记 ' + (21 - i), project: 'demo-study', date: d, done: i % 4 !== 0, doneAt: i % 4 !== 0 ? d + ' 18:20:00' : null, time: '', priority: i % 3, order: i, created: d + ' 08:00:00', updated: d + 'T10:20:00.000Z', steps: [{ id: id + '-step', text: '摘录一条虚构段落', done: true }] });
    if (i % 5 === 0) planner.tasks.push({ id: id + '-abandon', title: '整理旧版虚构目录', project: 'demo-life', date: d, done: true, doneAt: d + ' 18:00:00', abandoned: true, abandonedAt: d + 'T10:00:00.000Z', abandonReason: '不再需要：已并入新目录', steps: [] });
    addRecord('番茄', d, 9, 0, 25, '完成', '学习/阅读'); addRecord('番茄', d, 15, 0, 25, '完成', '生活/整理');
    if (i % 3 === 0) { addRecord('正计时', d, 16, 0, 18, '完成', '学习/练习'); addRecord('番茄', d, 16, 30, 7, '放弃', '学习/练习'); }
    addRecord('休息', d, 9, 25, 5, '完成');
    addRecord('休息', d, 15, 25, 5, ['跳过', '推迟', '中断'][i % 3]);
    if (i % 2 === 0) addRecord('打断', d, 14, 0, 8, i % 4 === 0 ? '外部' : '分心');
  }
  for (let i = 0; i < 3; i++) planner.reviews.push(makeReview(Period.of('week', addDays(weekStart(today), -7 * i)), i));
  planner.reviews.push(makeReview(Period.of('month', today), 0));
  planner.tasks.push({ id: 'demo-repeat', title: '每周虚构整理（重复任务只读）', date: today, done: false, doneAt: null, repeat: { kind: 'Weekly', interval: 1, weekMask: 127 }, steps: [] });
  planner.habits = [
    { id: 'demo-read', name: '示例阅读', kind: 'Daily', start: addDays(today, -25), checks: Array.from({ length: 21 }, (_, i) => addDays(today, -i)).filter((_, i) => i % 4 !== 0),
      journal: { [addDays(today, -1)]: { note: '读了两页虚构故事，记下一句话。', photos: ['fictional-book.jpg'], futureCaption: '虚构照片引用，不包含照片文件' }, [addDays(today, -3)]: { note: '今天的示例小记：慢慢读也很好。', photos: [] } } },
    { id: 'demo-stretch', name: '示例伸展练习', kind: 'TimesPerWeek', perWeek: 3, start: addDays(today, -25), checks: Array.from({ length: 21 }, (_, i) => addDays(today, -i)).filter((_, i) => i % 2 === 0) },
    { id: 'demo-walk', name: '示例午后散步', color: 1, kind: 'Weekdays', weekMask: 31, start: addDays(today, -25), checks: [addDays(weekStart(today), -7), addDays(weekStart(today), -5)] },
    { id: 'demo-garden', name: '示例周末照料植物', color: 2, kind: 'Weekdays', weekMask: 96, start: addDays(today, -25), checks: [addDays(weekStart(today), -2)] }
  ];
  const reviewId = Period.of('day', today).id, title = '收获与亮点', path = ['review-module', reviewId, title, '0'];
  const conflicts = [{ key: JSON.stringify(path), path, deleteConflict: false, both: true, candidates: [
    { branch: 'demo-a', deleted: false, value: { title, raw: '【收获与亮点】\n把大任务拆成两步后，更容易开始。' } },
    { branch: 'demo-b', deleted: false, value: { title, raw: '【收获与亮点】\n先做五分钟的虚构练习，找回了节奏。' } }
  ] }];
  return { joined: true, demo: true, planner, conflicts, today, timeZone: 'Asia/Shanghai', settings: { ...Object.fromEntries(Object.entries(DEFAULT_MODULES).map(([key,value]) => ['ReviewModules.' + key, value])), TimeZone: 'China Standard Time' }, records };
}
export function createDemoReviewSource(today, { now = () => Date.now(), initial } = {}) {
  let state = clone(initial || createDemoReviewData(today)), token = Object.freeze({}), listeners = new Set();
  const publish = () => { token = Object.freeze({}); for (const fn of listeners) fn(); };
  const source = {
    snapshot() { return { ...clone(state), editToken: token }; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async change(description, mutator) {
      if (!state.joined) throw new Error('先在设置里连接并完成第一次同步');
      const before = clone(state.planner), next = clone(state.planner); mutator(next); state.planner = next; publish();
      return { description, editToken: token, undo: async () => { state.planner = before; publish(); } };
    },
    async resolve(key, choice) {
      if (!state.joined) throw new Error('先在设置里连接并完成第一次同步');
      const c = state.conflicts.find(c => c.key === key); if (!c) throw new Error('这处冲突已经改变，请重新查看。');
      const path = c.path || JSON.parse(c.key), record = findReview(state.planner, path[0] === 'entity' ? path[2] : path[1]);
      const selected = choice.type === 'both' ? null : c.candidates.find(c => c.branch === choice.branch);
      if (choice.type !== 'both' && !selected) throw new Error('所选版本不存在');
      if (path[0] === 'entity' && selected.deleted) { state.planner.reviews = state.planner.reviews.filter(r => r !== record); state.planner.deleted[path[2]] = new Date(now()).toISOString(); }
      else if (record) {
        if (path[0] === 'review-module') {
          const name = path[2], texts = (choice.type === 'both' ? c.candidates : [selected]).filter(c => !c.deleted).map(c => {
            const raw = typeof c.value === 'string' ? c.value : c.value.raw;
            return ReviewText.get(ReviewText.parse(raw), name) ?? raw;
          });
          const sections = ReviewText.ordered(record.content, DEFAULT_MODULES[record.scale].split('|')), entry = sections.find(s => s[0] === name);
          if (entry) entry[1] = texts.join('\n\n'); else sections.push([name, texts.join('\n\n')]); record.content = ReviewText.compose(sections);
        } else if (path[0] === 'review-title') record.title = choice.type === 'both' ? c.candidates.map(c => c.value).join('\n\n') : selected.value;
        else if (path[0] === 'review-score') record.score = selected.value;
        record.updated = new Date(now()).toISOString();
      }
      state.conflicts = state.conflicts.filter(item => item !== c); publish();
    }
  };
  return source;
}
