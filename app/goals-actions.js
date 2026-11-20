import { DataError } from './datasource.js';
import { newId } from './task-actions.js';
import { domainNames, findGoalPlan, goalsInDomain, legalGoalParent, planLocked, savedPlanStarts } from './goals-model.js';
import { goalSpan, lastGoalStart, samePeriod, validGoalPeriod } from './goal-periods.js';

function requireGoal(planner, id) {
  const goal = planner.goals?.find(row => row.id === id);
  if (!goal) throw new DataError('这条目标已删除，请重新查看。');
  return goal;
}

function ensurePlan(planner, span, year) {
  let row = findGoalPlan(planner, span, year);
  if (!row) {
    (planner.goalPlans ||= []).push({ span, year, vision: '', names: domainNames(planner, year) });
    row = findGoalPlan(planner, span, year);
  }
  return row;
}

function lockPlan(planner, span, year) {
  if (!planner.goalPlanLocks?.some(row => samePeriod(row, span, year))) {
    (planner.goalPlanLocks ||= []).push({ span, year });
  }
}

export class GoalActions {
  constructor(source, { id = newId } = {}) { this.source = source; this.id = id; }

  ensureYear(year) {
    return this.source.change('已初始化年度领域', planner => {
      if (planner.goalYears?.some(row => row.year === year)) return;
      const names = domainNames(planner, year);
      (planner.goalYears ||= []).push({ year, names });
    }, { undoable: false });
  }

  rename(year, domain, name, baseToken, span = 1) {
    name = name.trim();
    if (!name) throw new DataError('请填写领域名称。');
    return this.source.change('已更新领域名称', planner => {
      const row = span === 1 ? planner.goalYears?.find(entry => entry.year === year) : ensurePlan(planner, span, year);
      if (!row) throw new DataError('请等待年度领域初始化。');
      row.names[domain] = name;
    }, { baseToken, undoable: false });
  }

  changeStart(span, year, next, currentYear, baseToken) {
    if (span === 1 || !validGoalPeriod(span, next) || next > lastGoalStart(span, currentYear)) throw new DataError('请输入有效的起始年份。');
    if (year === next) return;
    const validate = planner => {
      if (planLocked(planner, span, year)) throw new DataError('有过目标或愿景后，起始年份固定。');
      if (savedPlanStarts(planner, span).includes(next)) throw new DataError('该时段已有宫格，请从已保存时段打开。');
    };
    validate(this.source.snapshot().planner);
    return this.source.change('已调整起始年份', planner => {
      validate(planner);
      const row = findGoalPlan(planner, span, year);
      if (row) {
        row.year = next;
      } else {
        ensurePlan(planner, span, next);
      }
    }, { baseToken, undoable: false });
  }

  saveVision(span, year, vision, baseToken) {
    vision = vision.trim().replace(/\r\n?/g, '\n');
    return this.source.change('已保存愿景', planner => {
      if (!vision && !findGoalPlan(planner, span, year)) return;
      const previous = ensurePlan(planner, span, year);
      if (vision || previous.vision.trim()) lockPlan(planner, span, year);
      previous.vision = vision;
    }, { baseToken, undoable: false });
  }

  save(year, domain, { id, title, notes = '', span = 1, parentId }, baseToken) {
    title = title.trim();
    if (!title) throw new DataError('请填写目标标题。');
    if (!validGoalPeriod(span, year)) throw new DataError('目标时段无效。');
    if (parentId) {
      const currentGoals = this.source.snapshot().planner.goals || [];
      const current = currentGoals.find(goal => goal.id === id);
      if (current?.parentId !== parentId && !legalGoalParent({ id, span, year }, currentGoals.find(goal => goal.id === parentId))) {
        throw new DataError('请选择跨度更长、覆盖本时段且仍存在的上级目标。');
      }
    }
    notes = notes.replace(/\r\n?/g, '\n');
    const goalId = id || this.id();
    return this.source.change(id ? '已保存目标' : '已添加目标', planner => {
      const goal = id ? requireGoal(planner, id) : {
        id: goalId, year, domain, order: goalsInDomain(planner, year, domain, span).reduce((max, item) => Math.max(max, item.order), 0) + 1,
        done: false, doneOn: null, ...(span === 1 ? {} : { span })
      };
      if (parentId !== undefined && parentId !== goal.parentId) {
        const parent = (planner.goals || []).find(row => row.id === parentId);
        if (parentId && !legalGoalParent(goal, parent)) throw new DataError('上级目标必须跨度更长，并覆盖本目标的时段。');
        if (parentId) goal.parentId = parentId; else delete goal.parentId;
      }
      Object.assign(goal, { title, notes });
      if (!id) {
        if (span !== 1) {
          ensurePlan(planner, span, year);
          lockPlan(planner, span, year);
        }
        (planner.goals ||= []).push(goal);
      }
    }, { baseToken, undoable: false });
  }

  async toggle(id, done, doneOn, baseToken) {
    const nextDate = done ? doneOn : null;
    let previous;
    const receipt = await this.source.change(done ? '已勾选目标' : '已取消勾选', planner => {
      const goal = requireGoal(planner, id);
      previous = { done: goal.done, doneOn: goal.doneOn };
      Object.assign(goal, { done, doneOn: nextDate });
    }, { baseToken, undoable: false });
    if (!receipt) return null;
    return { ...receipt, undo: async () => {
      await this.source.refresh();
      const snapshot = this.source.snapshot();
      if (!snapshot.timeZone) throw new DataError('请先在设置里选择软件时区。');
      const current = requireGoal(snapshot.planner, id);
      if (current.done !== done || (current.doneOn ?? null) !== (nextDate ?? null) ||
          snapshot.conflicts.some(c => c.path[0] === 'goal' && c.path[1] === id)) {
        throw new DataError('这条目标已有新改动，请重新查看。');
      }
      return this.source.change('已撤销目标勾选变更', planner => {
        const goal = requireGoal(planner, id);
        goal.done = previous.done;
        if (previous.doneOn === undefined) delete goal.doneOn;
        else goal.doneOn = previous.doneOn;
      }, { baseToken: snapshot.editToken, undoable: false });
    } };
  }

  remove(id, baseToken) {
    return this.source.change('已删除目标', planner => {
      requireGoal(planner, id);
      planner.goals = planner.goals.filter(goal => goal.id !== id);
    }, { baseToken, undoable: false });
  }

  move(id, shift, baseToken) {
    return this.source.change('已调整顺序', planner => {
      const goal = requireGoal(planner, id);
      const ordered = goalsInDomain(planner, goal.year, goal.domain, goalSpan(goal));
      const index = ordered.findIndex(row => row.id === id), dest = index + shift;
      if (dest < 0 || dest >= ordered.length) return;
      ordered.splice(index, 1);
      const lower = ordered[dest - 1]?.order, upper = ordered[dest]?.order;
      const order = lower === undefined ? upper - 1 : upper === undefined ? lower + 1 : lower / 2 + upper / 2;
      if (Number.isFinite(order) && (lower === undefined || lower < order) && (upper === undefined || order < upper)) {
        goal.order = order;
      } else {
        // 并发添加可能占同一顺序值，此时按显示顺序重新编号。
        ordered.splice(dest, 0, goal);
        ordered.forEach((row, i) => { row.order = i + 1; });
      }
    }, { baseToken, undoable: false });
  }
}
