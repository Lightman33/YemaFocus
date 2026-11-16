/** 独立于 DOM 的标签与滚动位置状态；hashchange 同时处理点击和浏览器返回。 */
export class Navigation {
  constructor(initial = 'tasks') {
    this.current = this.valid(initial);
    this.positions = { tasks: 0, review: 0, settings: 0 };
  }
  valid(page) { return ['tasks', 'review', 'settings'].includes(page) ? page : 'tasks'; }
  move(page, scrollTop = 0) {
    this.positions[this.current] = Math.max(0, Number(scrollTop) || 0);
    this.current = this.valid(page);
    return { page: this.current, scrollTop: this.positions[this.current] };
  }
}
