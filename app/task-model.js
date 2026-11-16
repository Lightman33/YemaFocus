// 电脑版 PlannerData / PUI 的手机移植。日期运算只接收明确的软件日期。
export const REPEAT_READONLY = '重复任务请先在电脑上完成，后续版本支持';
export const SERIES_READONLY = '这条记录来自重复任务，取消完成请在电脑上操作';
export const PRIORITIES = ['无优先级', '低优先级', '中优先级', '高优先级'];
export const ABANDON_REASONS = ['不适合现在做', '不再需要', '别人做了', '条件变了'];
// PlannerModel.cs Add 的 Trim、电脑版单行标题；T29 明确将换行规整为空格。
export const normalizeTitle = title => String(title || '').replace(/\r\n|[\r\n]/g, ' ').trim();
// 业务 JSON 中允许 -0 等旧数值；用递归副本保留位值，不能借 JSON.stringify 把 -0 改成 0。
export function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)]));
  return value;
}
export function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000')) return false;
  const date = new Date(day + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
export function addDays(day, count) {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}
export function weekStart(day) { return addDays(day, -((new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7)); }
export function nextMonth(day) {
  const d = new Date(day.slice(0, 7) + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function cnNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  const digits = '零一二三四五六七八九';
  if (s === '两') return 2;
  if (s.length === 1) return digits.indexOf(s);
  const ten = s.indexOf('十');
  if (ten < 0) return -1;
  const hi = ten === 0 ? 1 : s[0] === '两' ? 2 : digits.indexOf(s[0]);
  const lo = ten === s.length - 1 ? 0 : digits.indexOf(s[s.length - 1]);
  return hi < 0 || lo < 0 ? -1 : hi * 10 + lo;
}
export function parseTime(text) {
  const m = /^(凌晨|清晨|早上|早晨|上午|中午|下午|午后|傍晚|晚上|晚间|夜里|夜间|早|晚)?([0-9]{1,2}|[零一两二三四五六七八九十]{1,3})(?:[:：]([0-9]{2})|点(?:(半)|(?:([0-9]{1,2}|[零一二三四五六七八九十]{1,3})分?))?|时)$/.exec(text);
  if (!m) return null;
  let h = cnNumber(m[2]); const minute = m[3] ? +m[3] : m[4] ? 30 : m[5] ? cnNumber(m[5]) : 0;
  if (['下午', '午后', '傍晚', '晚上', '晚间', '夜里', '夜间', '晚'].includes(m[1]) && h < 12) h += 12;
  if (m[1] === '中午' && h < 6) h += 12;
  return h >= 0 && h <= 23 && minute >= 0 && minute <= 59 ? String(h).padStart(2, '0') + ':' + String(minute).padStart(2, '0') : null;
}
function normDate(word) {
  const fixed = { 今日: '今天', 今儿: '今天', 今儿个: '今天', 明日: '明天', 明儿: '明天', 明儿个: '明天', 后日: '后天', 后儿: '后天', 后儿个: '后天', 大后日: '大后天' };
  if (fixed[word]) return fixed[word];
  for (const [a, b] of [['下个星期', '下周'], ['下个礼拜', '下周'], ['下个周', '下周'], ['下星期', '下周'], ['下礼拜', '下周'], ['这个星期', '本周'], ['这个礼拜', '本周'], ['这星期', '本周'], ['本星期', '本周'], ['这礼拜', '本周'], ['本礼拜', '本周'], ['这周', '本周'], ['礼拜', '星期']]) {
    if (word.startsWith(a)) { word = b + word.slice(a.length); break; }
  }
  word = word.replace(/周末$/, '周六');
  return word.replace(/((?:周|星期))([1-7])$/, (_m, a, n) => a + '一二三四五六日'[+n - 1]);
}
export function parseDate(word, today) {
  word = normDate(word);
  const mon = weekStart(today), relative = ['今天', '明天', '后天', '大后天'].indexOf(word);
  if (relative >= 0) return { date: addDays(today, relative), weekOf: null };
  if (word === '本周' || word === '下周') return { date: null, weekOf: addDays(mon, word === '下周' ? 7 : 0) };
  let m = /^(\d{1,2})(?:日|号)$/.exec(word);
  if (m) {
    let month = today.slice(0, 7) + '-01';
    for (let i = 0; i < 13; i++, month = nextMonth(month)) {
      const date = month.slice(0, 8) + m[1].padStart(2, '0');
      if (validDay(date) && date >= today) return { date, weekOf: null };
    }
    return null;
  }
  m = /^(\d{1,2})(?:月|\/|-)(\d{1,2})(?:日|号)?$/.exec(word);
  if (m) {
    let date = today.slice(0, 4) + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
    if (!validDay(date)) return null;
    if (date < today) {
      // 对应 DateTime.AddYears：闰日落到非闰年时夹到 2 月 28 日。
      date = String(+today.slice(0, 4) + 1) + date.slice(4);
      if (!validDay(date)) date = date.slice(0, 8) + '28';
    }
    return { date, weekOf: null };
  }
  m = /^(下|本)?(?:周|星期)([一二三四五六日天])$/.exec(word);
  if (m) {
    let date = addDays(mon, (m[2] === '天' ? 6 : '一二三四五六日'.indexOf(m[2])) + (m[1] === '下' ? 7 : 0));
    if (!m[1] && date < today) date = addDays(date, 7);
    return { date, weekOf: null };
  }
  return null;
}
function joinedDay(word) {
  for (const [a, b] of [['今晚', '今天晚上'], ['明晚', '明天晚上'], ['后晚', '后天晚上'], ['今早', '今天早上'], ['明早', '明天早上'], ['今晨', '今天早上'], ['明晨', '明天早上']]) {
    if (word.startsWith(a) && word.length > a.length) return b + word.slice(a.length);
  }
  return word;
}
function dateAndTime(word, today) {
  word = joinedDay(word);
  const date = parseDate(word, today);
  if (date) return { ...date, time: '' };
  for (let i = 1; i < word.length; i++) {
    const time = parseTime(word.slice(i)), day = parseDate(word.slice(0, i), today);
    if (time && day?.date) return { ...day, time };
  }
  return null;
}
export function parseQuick(input, today) {
  if (!validDay(today)) throw new Error('需要明确的今天日期');
  const original = normalizeTitle(input).replace(/[。，！？、]+$/u, '').trim();
  let priority = null;
  // PlannerUI.cs ParsePriority（30–48）只按半角空格切分；每段 Trim，最后一个标记生效。
  // 不把标题紧贴的“!高”或全角空格当作口令边界，避免与电脑版写出不同优先级。
  const kept = original.split(' ').filter(part => {
    const match = /^[!！]([无低中高0-3])$/.exec(part.trim());
    if (!match) return true;
    priority = /[0-3]/.test(match[1]) ? +match[1] : '无低中高'.indexOf(match[1]); return false;
  });
  const text = priority === null ? original : kept.join(' ').trim();
  const words = [...text.matchAll(/[^ 　，,；;、]+/g)].map(m => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
  const between = (start, end) => start < end ? text.slice(words[start].start, words[end - 1].end) : '';
  let title = text, date = null, weekOf = null, time = '';
  if (words.length > 1) {
    const tail = joinedDay(words[words.length - 1].word), head = between(0, words.length - 1);
    const tm = parseTime(tail);
    if (tm) {
      const count = words.length - 1;
      let day = count > 1 ? parseDate(words[count - 1].word, today) : null;
      let fromStart = false;
      if (!day && count > 1) { day = parseDate(words[0].word, today); fromStart = Boolean(day); }
      title = day ? between(fromStart ? 1 : 0, fromStart ? count : count - 1) : head;
      date = day?.date || (day?.weekOf ? null : today); weekOf = day?.weekOf || null; time = weekOf ? '' : tm;
    } else {
      const day = dateAndTime(tail, today);
      if (day) { title = head; ({ date, weekOf, time } = day); }
    }
    if (!date && !weekOf && !time) {
      const first = dateAndTime(words[0].word, today);
      const firstTime = parseTime(words[0].word);
      if (first || firstTime) {
        const day = first || { date: today, weekOf: null, time: firstTime };
        ({ date, weekOf, time } = day);
        let start = 1;
        if (!time && words.length > 2 && parseTime(words[1].word)) { time = weekOf ? '' : parseTime(words[1].word); start++; }
        title = between(start, words.length);
      }
    }
  }
  // 语音输入常不带空格：只扩展句首/句尾的中文日期词，不扫描标题中间。
  // “今天的计划”保留为标题；单独一个“今天”也不会被吃掉。
  if (!date && !weekOf && !time) {
    for (const edge of ['end', 'start']) {
      let found = false;
      for (let n = Math.min(24, title.length - 1); n > 0; n--) {
        const token = (edge === 'start' ? title.slice(0, n) : title.slice(-n)).trim();
        const rawRest = edge === 'start' ? title.slice(n) : title.slice(0, -n);
        const separated = edge === 'start' ? /^[\s，,。；;、！？!?]/u.test(rawRest) : /[\s，,。；;、！？!?]$/u.test(rawRest);
        const rest = (edge === 'start' ? rawRest.replace(/^[\s，,。；;、！？!?]+/u, '') : rawRest.replace(/[\s，,。；;、！？!?]+$/u, '')).trim();
        if (!rest || (edge === 'start' && rest.startsWith('的')) || !/^(?:今|明|后|大后|下|本|这|周|星期|礼拜)/.test(token)) continue;
        const day = dateAndTime(token, today);
        if (day) {
          ({ date, weekOf, time } = day);
          // T29 裁决 3：粘连的纯日期只取安排，不从标题删字；有具体时间或边界才剥离。
          if (day.time || separated) title = rest;
          found = true; break;
        }
      }
      if (found) break;
    }
  }
  return { title: title.trim(), date, weekOf, time, priority };
}
// 对应 PlannerModel.cs PTask.IsRepeating：series 只标明历史记录的来源。
export const repeating = task => Boolean(task.repeat && task.repeat.kind !== 'None');
export const abandoned = task => Boolean(task.done && task.abandoned);
export function monthOf(task) { return !task.date && !task.weekOf && validDay(task.monthOf) ? task.monthOf.slice(0, 7) + '-01' : null; }
export const lastDay = task => task.date ? (validDay(task.endDate) && task.endDate > task.date ? task.endDate : task.date) : null;
export function overdue(task, today) {
  if (task.done) return false;
  if (task.date) return lastDay(task) < today;
  if (task.weekOf) return addDays(task.weekOf, 7) <= today;
  const month = monthOf(task); return Boolean(month && nextMonth(month) <= today);
}
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function sortDay(task) {
  if (task.date) return task.date + 'T00';
  if (task.weekOf) return addDays(task.weekOf, 6) + 'T12';
  const month = monthOf(task); return month ? addDays(nextMonth(month), -1) + 'T12' : '9999-12-31T23';
}
export function compareTasks(a, b) {
  if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
  if (a.done && b.done) return compareText(b.doneAt || '', a.doneAt || '');
  return compareText(sortDay(a), sortDay(b)) || compareText(parseTime(a.time || '') || '99:99', parseTime(b.time || '') || '99:99') ||
    (b.priority || 0) - (a.priority || 0) || (a.order || 0) - (b.order || 0);
}
export function projectTree(projects = []) {
  const ordered = [...projects].sort((a, b) => (a.order || 0) - (b.order || 0) || compareText(a.created || '', b.created || ''));
  const map = new Map(projects.map(p => [p.id, p])), seen = new Set(), result = [];
  function walk(parent, names) {
    for (const p of ordered) {
      if (p.archived || seen.has(p.id)) continue;
      const actualParent = p.parent && map.has(p.parent) && p.parent !== p.id ? p.parent : null;
      if (actualParent !== parent) continue;
      seen.add(p.id); const path = [...names, p.name]; result.push({ ...p, path: path.join(' › ') }); walk(p.id, path);
    }
  }
  walk(null, []); return result;
}
export function groupTasks(planner, today, mode = 'time') {
  const tasks = (planner.tasks || []).filter(t => !t.trashedAt);
  const definitions = mode === 'project' ? [['inbox', '无项目'], ...projectTree(planner.projects).map(p => ['p:' + p.id, p.path])]
    : [['over', '已逾期'], ['today', '今天'], ['tomorrow', '明天'], ['week', '本周'], ['later', '以后'], ['none', '未安排事项']];
  const groups = [...definitions, ['done', '已完成'], ['abandoned', '已放弃']].map(([key, title]) => ({ key, title, defaultCollapsed: ['later', 'done', 'abandoned'].includes(key), tasks: [] }));
  const map = new Map(groups.map(g => [g.key, g])); const mon = weekStart(today);
  for (const task of tasks) {
    let key;
    if (task.done) key = abandoned(task) ? 'abandoned' : 'done';
    else if (mode === 'project') key = map.has('p:' + task.project) ? 'p:' + task.project : 'inbox';
    else if (overdue(task, today)) key = 'over';
    else if (task.date && task.date <= today && lastDay(task) >= today) key = 'today';
    else if (task.date === addDays(today, 1)) key = 'tomorrow';
    else if ((task.date && task.date < addDays(mon, 7)) || (!task.date && task.weekOf === mon)) key = 'week';
    else if (task.date || task.weekOf || monthOf(task)) key = 'later';
    else key = 'none';
    map.get(key).tasks.push(task);
  }
  return groups.filter(g => g.tasks.length).map(g => ({ ...g, tasks: g.tasks.sort(compareTasks) }));
}
export function visibleGroups(groups, expanded = {}, limits = {}) {
  return groups.map(g => ({ ...g, open: expanded[g.key] ?? !g.defaultCollapsed,
    visible: (expanded[g.key] ?? !g.defaultCollapsed) ? g.tasks.slice(0, limits[g.key] || 50) : [] }));
}
// 显示日期只依赖数据来源的软件 today，不读手机系统的“今天”。
export function dateText(day, today, { fullDate = false } = {}) {
  if (!validDay(day)) return '未安排';
  const week = '周' + '日一二三四五六'[new Date(day + 'T12:00:00Z').getUTCDay()];
  const calendar = (day.slice(0, 4) !== today?.slice(0, 4) ? +day.slice(0, 4) + '年' : '') + +day.slice(5, 7) + '月' + +day.slice(8, 10) + '日';
  const distance = validDay(today) ? Math.round((new Date(day + 'T12:00:00Z') - new Date(today + 'T12:00:00Z')) / 86400000) : null;
  const relative = { '-2': '前天', '-1': '昨天', '0': '今天', '1': '明天', '2': '后天' }[distance];
  return relative ? relative + (fullDate ? ' ' + calendar : ' ·') + ' ' + week : calendar + ' ' + week;
}
export function wallText(value, today) {
  if (!value) return '未记录';
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(value);
  return match && validDay(match[1]) ? dateText(match[1], today) + (match[2] ? ' ' + match[2] : '') : value;
}
export function whenText(task, today) {
  const month = monthOf(task);
  let text = task.date ? dateText(task.date, today) :
    task.weekOf ? dateText(task.weekOf, today) + ' 所在周内' : month ? (month.slice(0, 4) !== today?.slice(0, 4) ? +month.slice(0, 4) + '年' : '') + +month.slice(5, 7) + '月内' : '未安排';
  if (task.endDate && task.date) text += ' 至 ' + dateText(task.endDate, today);
  if (task.time) text += ' ' + task.time + (task.endTime ? '–' + task.endTime : '');
  if (overdue(task, today)) text += ' · 已逾期';
  return text;
}
