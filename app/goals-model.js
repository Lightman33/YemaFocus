import { parseRecord } from './review-model.js';
import { goalSpan, rangeLabel, samePeriod, spanLabel, validGoalPeriod } from './goal-periods.js';

export const DEFAULT_DOMAINS = Object.freeze(['学习·成长', '体验·突破', '休闲·放松', '家庭·生活', '工作·事业', '人际·社群', '财务·理财', '健康·身体']);
export function domainNames(planner, year) {
  const entries = planner.goalYears || [];
  return [...(entries.find(y => y.year === year)?.names || entries.find(y => y.year === year - 1)?.names || DEFAULT_DOMAINS)];
}

const byOrder = (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function goalsInDomain(planner, year, domain, span = 1) {
  return (planner.goals || []).filter(g => samePeriod(g, span, year) && g.domain === domain).sort(byOrder);
}

export const findGoalPlan = (planner, span, year) => planner.goalPlans?.find(row => samePeriod(row, span, year));
export const planNames = (planner, span, year) => [...(findGoalPlan(planner, span, year)?.names || domainNames(planner, year))];

export function planLocked(planner, span, year) {
  return Boolean(findGoalPlan(planner, span, year)?.vision?.trim() ||
    planner.goalPlanLocks?.some(row => samePeriod(row, span, year)) ||
    planner.goals?.some(goal => samePeriod(goal, span, year)));
}

export function savedPlanStarts(planner, span) {
  const rows = [...(planner.goalPlans || []), ...(planner.goalPlanLocks || []), ...(planner.goals || [])];
  return [...new Set(rows.filter(row => goalSpan(row) === span).map(row => row.year))].sort((a, b) => a - b);
}

export function legalGoalParent(child, parent) {
  if (!child || !parent || child.id && child.id === parent.id) return false;
  const span = goalSpan(child), upper = goalSpan(parent);
  return validGoalPeriod(span, child.year) && validGoalPeriod(upper, parent.year) &&
    upper > span && parent.year <= child.year && parent.year + upper >= child.year + span;
}

export function parentGoal(planner, child) {
  const parent = child.parentId && planner.goals?.find(goal => goal.id === child.parentId);
  return legalGoalParent(child, parent) ? parent : null;
}

export function parentGroups(planner, child) {
  const choices = (planner.goals || []).filter(goal => legalGoalParent(child, goal));
  return [3, 5, 10].flatMap(span => {
    const goals = choices.filter(goal => goalSpan(goal) === span).sort((a, b) => a.year - b.year || a.domain - b.domain || byOrder(a, b));
    return goals.length ? [{ label: spanLabel(span), goals }] : [];
  });
}

export function childGoals(planner, parent) {
  return (planner.goals || []).filter(goal => goal.parentId === parent.id && legalGoalParent(goal, parent))
    .sort((a, b) => a.year - b.year || goalSpan(a) - goalSpan(b) || a.domain - b.domain || byOrder(a, b));
}

export function childGroups(children) {
  const groups = new Map();
  for (const goal of children) {
    const span = goalSpan(goal), label = span === 1 ? goal.year + ' 年度' : rangeLabel(goal.year, span) + ' · ' + spanLabel(span);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(goal);
  }
  return groups;
}

export function goalGroups(planner) {
  const years = [...new Set((planner.goals || []).filter(g => goalSpan(g) === 1).map(g => g.year))].sort((a, b) => b - a);
  return years.flatMap(year => domainNames(planner, year).flatMap((name, domain) => {
    const goals = goalsInDomain(planner, year, domain);
    return goals.length ? [{ label: year + ' · ' + name, goals }] : [];
  }));
}

export const tasksForGoal = (planner, id) => (planner.tasks || []).filter(task => task.goalId === id && !task.trashedAt);

export function longGoalPomoStats(planner, goal, records) {
  const annual = new Set();
  const visit = parent => {
    for (const child of childGoals(planner, parent)) {
      if (goalSpan(child) === 1) annual.add(child.id);
      else visit(child);
    }
  };
  visit(goal);
  const tasks = (planner.tasks || []).filter(task => annual.has(task.goalId) && !task.trashedAt);
  return goalPomoStats(tasks, records, goal.year, goalSpan(goal));
}

export function goalPomoStats(tasks, records, year, span = 1) {
  const ids = new Set(tasks.map(task => task.series || task.id));
  const seen = new Set();
  let count = 0, minutes = 0;
  if (ids.size) for (const raw of records || []) {
    const record = parseRecord(raw);
    if (!record || record.kind !== '番茄' || record.status !== '完成') continue;
    const recordYear = +record.start.slice(0, 4);
    if (recordYear < year || recordYear >= year + span) continue;
    const at = record.link.indexOf('|');
    if (at <= 0 || !ids.has(record.link.slice(0, at))) continue;
    const key = raw.id ?? raw;
    if (span > 1 && seen.has(key)) continue;
    if (span > 1) seen.add(key);
    count++;
    minutes += record.minutes;
  }
  return { count, minutes };
}
