// 复盘纯模型。日期运算采用 UTC 容器表示“日历日期”，不把电脑的本地时间误当 UTC。
export const SCALES = ['day', 'week', 'month', 'quarter', 'year'];
export const SCALE_NAMES = ['日', '周', '月', '季', '年'];
export const WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const DATA_TITLE = '本期数据';
const MS_DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const dateOf = s => new Date(s.slice(0, 10) + 'T00:00:00Z');
const dayOf = d => d.toISOString().slice(0, 10);
export const addDays = (s, n) => dayOf(new Date(dateOf(s).getTime() + n * MS_DAY));
const diff = (b, a) => (dateOf(b) - dateOf(a)) / MS_DAY;
export const weekStart = s => addDays(s, -((dateOf(s).getUTCDay() + 6) % 7));
const monthAdd = (s, n) => { const d = dateOf(s); d.setUTCMonth(d.getUTCMonth() + n); return dayOf(d); };
const year = s => +s.slice(0, 4), month = s => +s.slice(5, 7), day = s => +s.slice(8, 10);
export function validDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !s.startsWith('0000') && !Number.isNaN(dateOf(s).getTime()) && dayOf(dateOf(s)) === s; }
const md = s => month(s) + '月' + day(s) + '日';
const shortDay = s => month(s) + '/' + day(s);
const range = (a, b) => md(a) + '–' + (a.slice(0, 7) === b.slice(0, 7) ? day(b) + '日' : md(b));
export function isoWeek(s) {
  const thu = addDays(weekStart(s), 3), y = year(thu);
  return { year: y, week: Math.floor(diff(thu, y + '-01-01') / 7) + 1 };
}
// source/ReviewModel.cs: Period.Of / Id / Label / Shift / Buckets（第 31–165 行）。
export const Period = {
  of(scale, d) {
    if (!SCALES.includes(scale) || !validDay(d)) throw new RangeError('无效的复盘周期');
    let start = d, end = d;
    if (scale === 'week') { start = weekStart(d); end = addDays(start, 6); }
    if (scale === 'month' || scale === 'quarter') {
      const m = scale === 'quarter' ? Math.floor((month(d) - 1) / 3) * 3 + 1 : month(d);
      start = d.slice(0, 4) + '-' + pad(m) + '-01'; end = addDays(monthAdd(start, scale === 'quarter' ? 3 : 1), -1);
    }
    if (scale === 'year') { start = d.slice(0, 4) + '-01-01'; end = d.slice(0, 4) + '-12-31'; }
    return { scale, start, end, id: scale + ':' + start };
  },
  parseId(id) { const m = /^(day|week|month|quarter|year):(\d{4}-\d{2}-\d{2})$/.exec(id || ''); if (!m || !validDay(m[2])) return null; const p = Period.of(m[1], m[2]); return p.start === m[2] ? p : null; },
  days: p => diff(p.end, p.start) + 1,
  contains: (p, d) => d.slice(0, 10) >= p.start && d.slice(0, 10) <= p.end,
  shift(p, n) {
    return Period.of(p.scale, ['day', 'week'].includes(p.scale) ? addDays(p.start, n * (p.scale === 'week' ? 7 : 1)) : monthAdd(p.start, n * ({ month: 1, quarter: 3, year: 12 }[p.scale])));
  },
  label(p) {
    const y = year(p.start), m = month(p.start);
    if (p.scale === 'day') return y + '年' + md(p.start) + ' ' + WEEK_NAMES[(dateOf(p.start).getUTCDay() + 6) % 7];
    if (p.scale === 'week') { const w = isoWeek(p.start); return w.year + '年第' + w.week + '周（' + range(p.start, p.end) + '）'; }
    if (p.scale === 'month') return y + '年' + m + '月';
    if (p.scale === 'quarter') return y + '年第' + (Math.floor((m - 1) / 3) + 1) + '季度（' + m + '–' + month(p.end) + '月）';
    return y + '年';
  },
  buckets(p) {
    const a = p.start, days = Period.days(p);
    if (p.scale === 'day') return { n: 24, labels: Array.from({ length: 24 }, (_, i) => i % 3 === 0 ? i + '时' : ''), names: Array.from({ length: 24 }, (_, i) => i + '时'), unit: '每小时', of: x => x.slice(0, 10) === a ? +(x.slice(11, 13) || 0) : -1 };
    if (p.scale === 'year') return { n: 12, labels: Array.from({ length: 12 }, (_, i) => i + 1 + '月'), names: Array.from({ length: 12 }, (_, i) => i + 1 + '月'), unit: '每月', of: x => year(x) === year(a) ? month(x) - 1 : -1 };
    if (p.scale === 'week') return { n: 7, labels: [...WEEK_NAMES], names: [...WEEK_NAMES], unit: '每天', of: x => Math.floor(diff(x.slice(0, 10), a)) };
    if (p.scale === 'quarter') {
      const a0 = weekStart(a), n = Math.ceil((diff(p.end, a0) + 1) / 7), every = Math.max(1, Math.ceil(n / 10));
      const names = Array.from({ length: n }, (_, i) => shortDay(addDays(a0, i * 7)) + '起的一周');
      return { n, names, labels: names.map((_, i) => i % every === 0 ? shortDay(addDays(a0, i * 7)) : ''), unit: '每周', of: x => Math.floor(diff(x.slice(0, 10), a0) / 7) };
    }
    const every = Math.max(1, Math.ceil(days / 10));
    return { n: days, names: Array.from({ length: days }, (_, i) => shortDay(addDays(a, i))), labels: Array.from({ length: days }, (_, i) => i % every === 0 || i === days - 1 ? String(i + 1) : ''), unit: '每天', of: x => Math.floor(diff(x.slice(0, 10), a)) };
  }
};
// 函数实际位于 source/Encourage.cs:449–455（ReviewFlow.DefaultWeek）。
export function defaultWeek(today) { const p = Period.of('week', today); return diff(today, p.start) <= 2 ? Period.shift(p, -1) : p; }

// .NET String.Trim 的空白集合与 JS trim 不同（例如 U+0085、U+FEFF）。
const whitespace = '[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
export const trim = s => String(s ?? '').replace(new RegExp('^' + whitespace + '+|' + whitespace + '+$', 'g'), '');
const trimChars = (s, chars) => s.replace(new RegExp('^[' + chars + ']+|[' + chars + ']+$', 'g'), '');
// source/ReviewModel.cs:189–251。只用数组 [标题, 正文]；重复标题 Parse 保留，Get/Ordered 取第一次。
export const ReviewText = {
  parse(content) {
    const result = []; let title = null, body = '';
    const flush = () => { const value = trimChars(body, '\\n\\r '); if (title === null && !trim(value)) return; result.push([title ?? '', value]); };
    for (const raw of String(content ?? '').replace(/\r\n/g, '\n').split('\n')) {
      const line = trim(raw);
      if (line.length > 2 && line.startsWith('【') && line.endsWith('】') && line.indexOf('】') === line.length - 1) { flush(); title = trim(line.slice(1, -1)); body = ''; }
      else body += raw + '\n';
    }
    flush(); return result;
  },
  get(sections, title) { return sections.find(s => s[0] === title)?.[1] ?? null; },
  compose(sections) { return sections.flatMap(([title, value]) => { const body = trimChars(String(value ?? '').replace(/\r\n/g, '\n'), '\\n '); return trim(body) ? [(title ? '【' + title + '】\n' : '') + body] : []; }).join('\n\n'); },
  ordered(content, modules) {
    const parsed = ReviewText.parse(content); if (modules == null) return parsed;
    const result = [], seen = new Set();
    for (const special of ['', DATA_TITLE]) { const value = ReviewText.get(parsed, special); if (value !== null) { result.push([special, value]); seen.add(special); } }
    for (const name of modules) if (!seen.has(name)) { result.push([name, ReviewText.get(parsed, name) ?? '']); seen.add(name); }
    for (const pair of parsed) if (!seen.has(pair[0])) { result.push(pair); seen.add(pair[0]); }
    return result;
  }
};
export const DEFAULT_MODULES = {
  day: '今日完成|收获与亮点|问题与卡点|明日最重要的三件事', week: '本周完成|收获与亮点|问题与卡点|下周最重要的三件事',
  month: '本月完成|收获与亮点|问题与卡点|下月重点', quarter: '本季完成|收获与亮点|问题与卡点|下季重点', year: '今年完成|收获与亮点|问题与卡点|明年方向'
};
// source/Core.cs:338–370 ReviewModules / CleanModule，显式空字符串表示没有模块。
export function reviewModules(settings, scale) {
  const raw = settings?.['ReviewModules.' + scale] ?? DEFAULT_MODULES[scale];
  return [...new Set(String(raw).split('|').map(x => trim(trim(x.replace(/\|/g, ' ').replace(/[【】\r\n]/g, '')).replace(/^#+/, '')).slice(0, 30)).filter(Boolean))];
}
export function wallTime(now, timeZone) {
  if (!timeZone) throw new Error('请先在设置里选择软件时区。');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}
export const findReview = (planner, p) => (planner.reviews || []).find(r => r.id === (typeof p === 'string' ? p : p.id)) || null;
// source/ReviewModel.cs:255–278 ToMarkdown，Windows 剪贴板使用 CRLF，包含空的配置模块。
export function toMarkdown(r, modules, timeZone) {
  const p = Period.parseId(r.id) || Period.of(r.scale, r.start), score = Math.max(0, Math.min(5, r.score || 0));
  let text = '# ' + SCALE_NAMES[SCALES.indexOf(p.scale)] + '复盘 · ' + Period.label(p) + '\n\n';
  text += '- 周期：' + p.start + (p.end !== p.start ? ' ～ ' + p.end : '') + '\n';
  if (score > 0) text += '- 自评：' + '★'.repeat(score) + '☆'.repeat(5 - score) + '（' + score + '/5）\n';
  if (trim(r.title)) text += '- 一句话总结：' + trim(r.title) + '\n';
  text += '- 更新于：' + wallTime(new Date(r.updated), timeZone).slice(0, 16) + '\n- 来源：野马专注与健康助手\n';
  for (const [title, value] of ReviewText.ordered(r.content, modules)) {
    let body = value.replace(/\r\n/g, '\n').replace(new RegExp(whitespace + '+$'), '');
    if (title === DATA_TITLE) body = body.split('\n').map(line => line.startsWith('■ ') ? '### ' + line.slice(2) : line).join('\n');
    text += '\n## ' + (title || '其他') + '\n\n' + body + '\n';
  }
  return text.replace(/\n/g, '\r\n');
}

// Math.Round(double) 默认“中点取偶”，与 JS Math.round 的 .5 规则不同。
export function roundEven(value) { const floor = Math.floor(value), fraction = value - floor; return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value); }
export const percent = rate => rate < 0 ? '—' : roundEven(rate * 100) + '%';
export function fmtMin(minutes) { const t = roundEven(minutes); return t < 60 ? t + ' 分钟' : Math.floor(t / 60) + ' 小时' + (t % 60 > 0 ? ' ' + t % 60 + ' 分' : ''); }
export const normalizeTask = task => trim(task || '').replace(/[／\\]/g, '/').split('/').map(trim).filter(Boolean).join('/');
export const topLevel = task => normalizeTask(task).split('/')[0] || '未分类';

// source/Core.cs:810–841 RecordStore.ParseInto / TryDate；列为 类型/开始/结束/分钟/事项/状态/备注/关联任务。
// 支持存档标准格式及 Fmts 列出的数字年月日；不猜 Windows 当前文化特有的含糊日期。
export function recordDate(value) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trim(value));
  if (!m) return null;
  const date = m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
  return validDay(date) && +m[4] < 24 && +m[5] < 60 && +(m[6] || 0) < 60 ? date + ' ' + pad(+m[4]) + ':' + m[5] + ':' + (m[6] || '00') : null;
}
export function parseRecord(record) {
  const c = record.columns || []; if (c.length < 6) return null;
  const start = recordDate(c[1]), end = recordDate(c[2]); if (!start || !end) return null;
  const raw = trim(c[3]), numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) ? Number(raw) : NaN;
  const minutes = Math.max(0, Number.isFinite(numeric) ? numeric : (Date.parse(end.replace(' ', 'T') + 'Z') - Date.parse(start.replace(' ', 'T') + 'Z')) / 60000);
  return { kind: trim(c[0]), start, end, minutes, task: normalizeTask(c[4]), status: trim(c[5]), note: c[6] || '', link: trim(c[7]) };
}
// source/PlannerModel.cs:692–735 Habit.Rate / CountIn。周 N 次按区间内周天数折算；今天没打卡不计每日分母。
export function habitRate(h, from, to, today) {
  const a = from < h.start ? h.start : from, b = [to, today, h.end || '9999-12-31'].sort()[0];
  if (b < a) return -1;
  const checks = new Set(h.checks || []);
  if (h.kind === 'TimesPerWeek') {
    let got = 0, need = 0;
    for (let w = weekStart(a); w <= b; w = addDays(w, 7)) {
      let n = 0, days = 0;
      for (let i = 0; i < 7; i++) { const d = addDays(w, i); if (d < a || d > b) continue; days++; if (checks.has(d)) n++; }
      const target = (h.perWeek ?? 3) * days / 7; need += target; got += Math.min(n, target);
    }
    return need <= 0 ? -1 : got / need;
  }
  let scheduled = 0, done = 0;
  for (let d = a; d <= b; d = addDays(d, 1)) {
    if (h.kind === 'Weekdays' && !((h.weekMask ?? 127) & 1 << ((dateOf(d).getUTCDay() + 6) % 7))) continue;
    if (d === today && !checks.has(d)) continue;
    scheduled++; if (checks.has(d)) done++;
  }
  return scheduled === 0 ? -1 : done / scheduled;
}
// source/PlannerModel.cs:1650–1663 Compare；未完成排序：日期/周末中午/月末中午、时间、优先级、顺序。
function compareTask(a, b) {
  const dateKey = t => t.date ? t.date + ' 00:00' : t.weekOf ? addDays(t.weekOf, 6) + ' 12:00' : t.monthOf ? addDays(monthAdd(t.monthOf.slice(0, 7) + '-01', 1), -1) + ' 12:00' : '9999-12-31 23:59';
  const compare = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  const timeKey = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t.time || ''); return m && +m[1] < 24 && +m[2] < 60 ? pad(+m[1]) + ':' + m[2] : '99:99'; };
  return compare(dateKey(a), dateKey(b)) || compare(timeKey(a), timeKey(b)) || (b.priority || 0) - (a.priority || 0) || (a.order || 0) - (b.order || 0);
}
export function rootProject(planner, id) {
  const projects = new Map((planner.projects || []).map(p => [p.id, p]));
  let p = projects.get(id), root = p; const seen = new Set();
  while (p && !seen.has(p.id)) { seen.add(p.id); root = p; const parent = projects.get(p.parent); p = parent === p ? null : parent; }
  return root || null;
}
export function computeStats(planner, period, records = [], today, timeZone = 'Asia/Shanghai') {
  const buckets = Period.buckets(period), end = addDays(period.end, 1), inRange = value => value && value >= period.start && value < end;
  const s = { period, buckets, planned: 0, plannedDone: 0, doneTotal: 0, stepsDone: 0, abandonedTotal: 0, planRate: -1,
    unfinished: [], completed: [], abandoned: [], byProject: Object.create(null), doneByBucket: Array(buckets.n).fill(0),
    pomos: 0, pomoMin: 0, stopwatchMin: 0, stopwatchCount: 0, pomosAbandoned: 0, pomoByHour: Array(24).fill(0), pomoByBucket: Array(buckets.n).fill(0),
    byTask: Object.create(null), byCategory: Object.create(null), breaksDone: 0, breaksSkipped: 0, breaksPostponed: 0, breaksInterrupted: 0,
    interruptions: 0, external: 0, self: 0, interruptionHours: Array(24).fill(0), habits: [], habitRate: -1, recordCount: 0, badRecords: 0 };
  // PlannerModel.cs:1670–1713 Summarize。计划按开始日期，按计划完成不限定 doneAt；共完成才限定 doneAt。
  for (const t of planner.tasks || []) {
    if (t.trashedAt) continue; // 同源码 FromJson:2153，垃圾桶不进入 Tasks。
    const abandoned = Boolean(t.done && t.abandoned);
    if (abandoned) {
      const utc = typeof t.abandonedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{0,3})?Z$/.test(t.abandonedAt) && Number.isFinite(Date.parse(t.abandonedAt));
      const at = utc ? wallTime(new Date(t.abandonedAt), timeZone) : t.doneAt;
      if (inRange(at)) s.abandoned.push(t);
    }
    const planned = inRange(t.date) || period.scale === 'week' && !t.date && t.weekOf === weekStart(period.start);
    const key = rootProject(planner, t.project)?.id || t.project || '', row = s.byProject[key] || [0, 0, 0];
    if (planned) { s.planned++; row[0]++; if (t.done) { if (!abandoned) { s.plannedDone++; row[1]++; } } else s.unfinished.push(t); }
    const doneIn = t.done && !abandoned && inRange(t.doneAt);
    if (doneIn) { s.doneTotal++; s.completed.push(t); if (!planned) row[2]++; const i = buckets.of(t.doneAt); if (i >= 0 && i < buckets.n) s.doneByBucket[i]++; }
    if (planned || doneIn) s.byProject[key] = row;
    for (const step of t.steps || []) if (!abandoned && step.done && (planned || doneIn)) s.stepsDone++;
  }
  s.abandonedTotal = s.abandoned.length; s.planRate = s.planned ? s.plannedDone / s.planned : -1;
  s.unfinished.sort(compareTask); s.completed.sort((a, b) => a.doneAt < b.doneAt ? -1 : a.doneAt > b.doneAt ? 1 : 0);
  // ReviewModel.cs:350–381 PeriodStats.Compute；正计时不计柱状图番茄数，放弃分钟不计专注。
  for (const input of records || []) {
    const r = parseRecord(input); if (!r) { s.badRecords++; continue; } if (!inRange(r.start)) continue; s.recordCount++;
    if ((r.kind === '番茄' || r.kind === '正计时') && r.status === '完成') {
      s.pomoMin += r.minutes;
      const key = r.task || '（未选事项）', v = s.byTask[key] ||= [0, 0]; v[1] += r.minutes;
      const cat = s.byCategory[topLevel(r.task)] ||= [0, 0]; cat[1] += r.minutes;
      if (r.kind === '番茄') { s.pomos++; v[0]++; cat[0]++; s.pomoByHour[+r.start.slice(11, 13)]++; const i = buckets.of(r.start); if (i >= 0 && i < buckets.n) s.pomoByBucket[i]++; }
      else { s.stopwatchMin += r.minutes; s.stopwatchCount++; }
    } else if (r.kind === '番茄' && r.status === '放弃') s.pomosAbandoned++;
    else if (r.kind === '休息') {
      if (r.status === '完成') s.breaksDone++; else if (r.status === '跳过') s.breaksSkipped++; else if (r.status === '推迟') s.breaksPostponed++;
      else if (r.status === '中断') s.breaksInterrupted++; // source/Stats.cs:186–191。
    } else if (r.kind === '打断') {
      // source/StatsForm.cs:337–349 Interruptions；不同于“休息中断”。外部以外都计自己分心。
      s.interruptions++; if (r.status === '外部') s.external++; else s.self++; s.interruptionHours[+r.start.slice(11, 13)]++;
    }
  }
  let sum = 0, count = 0;
  // ReviewModel.cs:383–394；存档习惯在本期有打卡仍纳入，完成率对可统计习惯取平均，非总次数相除。
  for (const h of planner.habits || []) {
    const checks = new Set(h.checks || []), n = [...checks].filter(d => d >= period.start && d <= period.end).length;
    if (h.archived && n === 0 || h.start > period.end || h.end && h.end < period.start && n === 0) continue;
    const rate = habitRate(h, period.start, period.end, today); if (rate >= 0) { sum += rate; count++; } s.habits.push({ habit: h, rate, count: n });
  }
  s.habitRate = count ? sum / count : -1;
  return s;
}
// source/ReviewModel.cs:411–520 PeriodStats.ToText，顺序/标点/空行逐项保持；当前时间显式注入便于对拍。
export function statsToText(s, planner, { now, timeZone = 'Asia/Shanghai', maxItems = 30 }) {
  const p = s.period, L = [], extra = Math.max(0, s.doneTotal - s.plannedDone);
  const project = id => (planner.projects || []).find(p => p.id === id), proj = t => project(t.project) ? ' · ' + project(t.project).name : '';
  L.push('（' + Period.label(p) + ' · ' + wallTime(now, timeZone).slice(5, 16) + ' 导入）', '', '■ 概览');
  L.push(s.planned > 0 ? '- 计划完成：' + percent(s.plannedDone / s.planned) + ' · ' + s.plannedDone + '/' + s.planned + ' 项' : '- 完成任务：' + s.doneTotal + ' 项 · 没有提前计划');
  L.push('- 专注番茄：' + s.pomos + ' 个 · ' + (s.pomoMin > 0 ? fmtMin(s.pomoMin) : '0 分钟'));
  if (s.breaksDone + s.breaksSkipped > 0) L.push('- 按时休息：' + s.breaksDone + ' 次 · ' + (s.breaksSkipped > 0 ? '跳过 ' + s.breaksSkipped + ' 次' : '没有跳过'));
  if (s.habits.length) L.push('- 习惯打卡：' + percent(s.habitRate) + ' · ' + s.habits.length + ' 个习惯');
  L.push('', '■ 任务');
  if (s.planned > 0) L.push('- 计划：' + s.planned + ' 项，完成 ' + s.plannedDone + ' 项（' + percent(s.plannedDone / s.planned) + '）' + (s.unfinished.length ? '，未完成 ' + s.unfinished.length + ' 项' : ''));
  L.push('- 共完成：' + s.doneTotal + ' 项' + (extra > 0 ? '（其中计划外 ' + extra + ' 项）' : '') + (s.stepsDone > 0 ? '，另完成步骤 ' + s.stepsDone + ' 个' : ''));
  L.push('- 放弃了 ' + s.abandonedTotal + ' 件');
  const projects = Object.entries(s.byProject).sort((a, b) => b[1][1] + b[1][2] - a[1][1] - a[1][2]);
  if (projects.length > 1 || projects.length === 1 && projects[0][0]) { L.push('', '■ 按项目（完成/计划）'); for (const [id, row] of projects) L.push('- ' + (project(id)?.name || '无项目') + '：' + row[1] + '/' + row[0] + (row[2] > 0 ? '，计划外 +' + row[2] : '')); }
  if (s.abandonedTotal > 0) { L.push('', '■ 已放弃'); for (const t of s.abandoned) L.push(t.title + ' — ' + (t.abandonReason || '未填写原因')); }
  if (s.pomos > 0 || s.pomosAbandoned > 0 || s.stopwatchCount > 0) {
    L.push('', '■ 专注');
    if (s.pomos > 0 || s.pomosAbandoned > 0) { const pm = s.pomoMin - s.stopwatchMin; L.push('- 番茄：' + s.pomos + ' 个' + (s.pomos > 0 ? '，共 ' + fmtMin(pm) + '，平均每个 ' + roundEven(pm / s.pomos) + ' 分钟' : '') + (s.pomosAbandoned > 0 ? '；中途放弃 ' + s.pomosAbandoned + ' 个' : '')); }
    if (s.stopwatchCount > 0) L.push('- 正计时：' + s.stopwatchCount + ' 次，共 ' + fmtMin(s.stopwatchMin));
    if (s.stopwatchCount > 0 && s.pomos > 0) L.push('- 合计专注：' + fmtMin(s.pomoMin));
    let bestH = -1, bestN = 0;
    for (let h = 0; h < 24; h++) { const value = s.pomoByHour[h] + (h < 23 ? s.pomoByHour[h + 1] : 0); if (value > bestN) { bestN = value; bestH = h; } }
    if (bestH >= 0 && s.pomos >= 3) L.push('- 最专注时段：' + bestH + '–' + (bestH + 2) + ' 点（开始了 ' + bestN + ' 个番茄）');
    const tasks = Object.entries(s.byTask).sort((a, b) => b[1][1] - a[1][1]);
    if (tasks.length) { L.push('', '■ 专注分布（按事项）'); for (const [name, v] of tasks) L.push('- ' + name + '：' + (v[0] > 0 ? v[0] + ' 个番茄，' : '') + fmtMin(v[1])); }
  }
  if (s.breaksDone + s.breaksSkipped + s.breaksPostponed > 0) { L.push('', '■ 休息'); L.push('- 按时休息：' + s.breaksDone + ' 次' + (s.breaksSkipped > 0 ? '，跳过 ' + s.breaksSkipped + ' 次' : '') + (s.breaksPostponed > 0 ? '，推迟 ' + s.breaksPostponed + ' 次' : '')); }
  if (s.habits.length) { L.push('', '■ 习惯'); for (const h of s.habits) L.push('- ' + h.habit.name + '：' + h.count + ' 次' + (h.rate >= 0 ? '（' + percent(h.rate) + '）' : '')); if (s.habits.length > 1 && s.habitRate >= 0) L.push('- 平均完成率：' + percent(s.habitRate)); }
  if (s.completed.length) {
    L.push('', '■ 已完成（' + s.completed.length + '）');
    s.completed.slice(0, maxItems).forEach((t, i) => { const when = t.doneAt ? (p.scale === 'day' ? t.doneAt.slice(11, 16) : shortDay(t.doneAt)) + ' ' : ''; L.push(i + 1 + '. ' + when + t.title + proj(t)); });
    if (s.completed.length > maxItems) L.push('…… 另 ' + (s.completed.length - maxItems) + ' 项');
  }
  if (s.unfinished.length) {
    L.push('', '■ 未完成（' + s.unfinished.length + '）');
    s.unfinished.slice(0, maxItems).forEach((t, i) => L.push(i + 1 + '. ' + t.title + proj(t) + (t.date ? '（原定 ' + shortDay(t.date) + '）' : '')));
    if (s.unfinished.length > maxItems) L.push('…… 另 ' + (s.unfinished.length - maxItems) + ' 项');
  }
  return L.join('\n');
}
