export const PAGES = { tasks: '任务', habits: '习惯', focus: '专注', goals: '目标', review: '复盘', settings: '设置' };
/** 独立于 DOM 的标签与滚动位置状态；hashchange 同时处理点击和浏览器返回。 */
export class Navigation {
  constructor(initial = 'tasks') {
    this.current = this.valid(initial);
    this.positions = Object.fromEntries(Object.keys(PAGES).map(page => [page, 0]));
  }
  valid(page) { return Object.hasOwn(PAGES, page) ? page : 'tasks'; }
  move(page, scrollTop = 0) {
    this.positions[this.current] = Math.max(0, Number(scrollTop) || 0);
    this.current = this.valid(page);
    return { page: this.current, scrollTop: this.positions[this.current] };
  }
}
