// 只通过来源的公开接口写复盘；不导入 datasource 或同步引擎。
import { ReviewText, reviewModules, findReview, wallTime, trim, toMarkdown, DATA_TITLE } from './review-model.js';

// 对应 PlannerModel.cs:1775–1795 SaveReview / RemoveReview，以及 ReviewView.cs:742–755 的空值、无变化判断。
// fields 可只带 title / score / modules（[标题,正文][]）；只改用户实际编辑的字段。
export function saveReview(planner, period, fields, { now, timeZone, settings = {} }) {
  const old = findReview(planner, period), modules = reviewModules(settings, period.scale);
  const next = old ? { ...old } : { id: period.id, scale: period.scale, start: period.start, end: period.end,
    title: '', content: '', score: 0, created: wallTime(now, timeZone), updated: new Date(now).toISOString() };
  if (fields.title != null) next.title = trim(fields.title);
  if (fields.score != null && fields.score >= 0) next.score = Math.max(0, Math.min(5, Math.trunc(fields.score)));
  if (fields.sections) next.content = ReviewText.compose(fields.sections);
  else if (fields.modules) {
    const sections = ReviewText.ordered(next.content, modules);
    for (const [name, body] of fields.modules) { const entry = sections.find(s => s[0] === name); if (entry) entry[1] = body; else sections.push([name, body]); }
    // 本期数据在普通模块前，未分段文字始终最前。
    const first = sections.filter(s => s[0] === ''), data = sections.filter(s => s[0] === DATA_TITLE), rest = sections.filter(s => s[0] !== '' && s[0] !== DATA_TITLE);
    next.content = ReviewText.compose([...first, ...data, ...rest]);
  } else next.content = ReviewText.compose(ReviewText.ordered(next.content, modules));
  next.title = trim(next.title);
  if (old && next.title === old.title && next.content === old.content && next.score === old.score) return old;
  const empty = !trim(next.content) && !trim(next.title) && !next.score;
  if (!old && empty) return null;
  planner.reviews ||= []; planner.deleted ||= {};
  const index = planner.reviews.findIndex(r => r.id === period.id);
  if (empty) { planner.reviews.splice(index, 1); planner.deleted[period.id] = new Date(now).toISOString(); return null; }
  next.updated = new Date(now).toISOString();
  if (index < 0) planner.reviews.push(next); else planner.reviews[index] = next;
  delete planner.deleted[period.id]; return next;
}

export class ReviewActions {
  constructor(source, { now = () => Date.now() } = {}) { this.source = source; this.now = now; }
  save(period, fields, options = {}) {
    const snapshot = this.source.snapshot();
    if (!snapshot.joined) return Promise.reject(new Error('先在设置里连接并完成第一次同步'));
    const time = this.now();
    return this.source.change('已保存复盘', p => saveReview(p, period, fields, { now: time, timeZone: snapshot.timeZone, settings: snapshot.settings }), { undoable: false, ...options });
  }
  async importData(period, text) {
    const before = ReviewText.get(ReviewText.parse(findReview(this.source.snapshot().planner, period)?.content), DATA_TITLE);
    await this.save(period, { modules: [[DATA_TITLE, text]] });
    return { description: before === null ? '已导入本期数据' : '已刷新本期数据', undo: () => {
      const current = ReviewText.get(ReviewText.parse(findReview(this.source.snapshot().planner, period)?.content), DATA_TITLE);
      if (current !== text) return Promise.reject(new Error('本期数据已有新改动，未覆盖新文字。'));
      return this.save(period, { modules: [[DATA_TITLE, before ?? '']] });
    } };
  }
  async copyAll(period, clipboard = globalThis.navigator?.clipboard) {
    const snapshot = this.source.snapshot(), record = findReview(snapshot.planner, period);
    if (!record) throw new Error('这一期还没有内容。可以先“导入本期数据”');
    const text = toMarkdown(record, reviewModules(snapshot.settings, period.scale), snapshot.timeZone);
    try { if (!clipboard?.writeText) throw new Error(); await clipboard.writeText(text); return { copied: true, text }; }
    catch { return { copied: false, text }; }
  }
  async complete(id) {
    // 仅调用 T15 的公开完成接口；延迟加载，纯模型和写复盘预览不依赖它的内部实现。
    const { TaskActions } = await import('./task-actions.js');
    return new TaskActions(this.source, { now: this.now }).toggle(id);
  }
  resolve(conflict, choice, observed) { return this.source.resolve(conflict.key, { ...choice, observed }); }
}
