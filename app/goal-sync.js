// 九宫格在应用层适配，沿用格式 1 的 other 桶。
import { plannerToState as importLegacy, stateToPlanner as projectLegacy, readEntity as readLegacy, applyEntityChange as editLegacy } from '../sync/convert.js';
import { canonical, decodeLegacy, encodeLegacy, unitKey } from '../sync/canonical.js';
import { emptyState, unitInfo } from '../sync/merge.js';
import { deleteUnit, updateUnit } from '../sync/edit.js';
import { planId, readPlanId, validGoalPeriod, yearId } from './goal-periods.js';

export { yearId };

export const goalCollections = { goals: 'goal', goalYears: 'goal-year', goalPlans: 'goal-plan', goalPlanLocks: 'goal-plan-lock' };
const collectionsByKind = new Map(Object.entries(goalCollections).map(([collection, kind]) => [kind, collection]));
export const goalUnitKinds = [...collectionsByKind.keys(), 'task-goal'];
export const taskGoalKey = id => unitKey('task-goal', id);

const withoutLink = ({ goalId, ...task }) => task;
export function legacyGoalProjection({ goals, goalYears, goalPlans, goalPlanLocks, ...planner }) {
  if (planner.tasks) planner.tasks = planner.tasks.map(task => Object.hasOwn(task, 'goalId') ? withoutLink(task) : task);
  return planner;
}

export function goalRowId(row, collection) {
  if (collection === 'goals') return row.id;
  if (collection === 'goalYears') return validGoalPeriod(1, row.year) ? yearId(row.year) : '';
  return row.span !== 1 && validGoalPeriod(row.span, row.year) ? planId(row.span, row.year) : '';
}

function importRows(state, rows, collection, device, updatedAt) {
  const seen = new Set();
  for (const row of rows || []) {
    const id = goalRowId(row, collection);
    if (typeof id !== 'string' || !id || seen.has(id)) throw new TypeError('目标或宫格编号无效或重复。');
    seen.add(id);
    state = updateUnit(state, unitKey(goalCollections[collection], id), device, encodeLegacy(row), { updatedAt });
  }
  return state;
}

export function plannerToState(planner, device, updatedAt = 0) {
  const state = importLegacy(legacyGoalProjection(planner), device, updatedAt);
  let extension = emptyState();
  for (const collection of Object.keys(goalCollections)) extension = importRows(extension, planner[collection], collection, device, updatedAt);
  for (const task of planner.tasks || []) if (typeof task.goalId === 'string' && task.goalId) {
    extension = updateUnit(extension, taskGoalKey(task.id), device, task.goalId, { updatedAt });
  }
  return { ...state, units: { ...state.units, ...extension.units } };
}

function read(state, key, { allowConflicts = false } = {}) {
  const { preferred, conflict } = unitInfo(state.units[key]);
  if (conflict && !allowConflicts) throw new TypeError('尚有未解决的冲突：' + key);
  if (preferred && !preferred.deleted) return decodeLegacy(preferred.value);
}

function readGoalRow(state, collection, id, options) {
  const identity = collection === 'goals' ? { id } : collection === 'goalYears' ?
    /^\d{4}$/.test(id) && validGoalPeriod(1, Number(id)) && { year: Number(id) } : readPlanId(id);
  if (!identity) return;
  const row = read(state, unitKey(goalCollections[collection], id), options);
  if (row) return { ...row, ...identity };
}

function projectLink(state, task, options) {
  const goalId = read(state, taskGoalKey(task.id), options);
  const row = Object.hasOwn(task, 'goalId') ? withoutLink(task) : task;
  return typeof goalId === 'string' && goalId ? { ...row, goalId } : row;
}

export function stateToPlanner(state, options) {
  const planner = projectLegacy(state, options);
  if (planner.tasks) planner.tasks = planner.tasks.map(task => projectLink(state, task, options));
  const rows = {};
  for (const key of Object.keys(state.units)) {
    if (!key.startsWith('["goal')) continue;
    const [kind, id, ...rest] = JSON.parse(key);
    const collection = collectionsByKind.get(kind);
    if (!collection || id === undefined || rest.length) continue;
    const row = readGoalRow(state, collection, id, options);
    if (row) (rows[collection] ||= []).push(row);
  }
  for (const [collection, entries] of Object.entries(rows)) {
    planner[collection] = entries.sort(collection === 'goals' ?
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : (a, b) => a.year - b.year || (a.span ?? 1) - (b.span ?? 1));
  }
  return planner;
}

export function readEntity(state, collection, id, options) {
  if (Object.hasOwn(goalCollections, collection)) return readGoalRow(state, collection, id, options);
  const row = readLegacy(state, collection, id, options);
  return collection === 'tasks' && row ? projectLink(state, row, options) : row;
}

function write(state, key, value, device, stamp) {
  const one = emptyState();
  if (Object.hasOwn(state.units, key)) one.units[key] = state.units[key];
  const edited = value === undefined ? deleteUnit(one, key, device, stamp) : updateUnit(one, key, device, encodeLegacy(value), stamp);
  return { ...state, units: { ...state.units, ...edited.units } };
}

export function applyEntityChange(state, collection, id, before, after, device, updatedAt) {
  if (Object.hasOwn(goalCollections, collection)) {
    if (after && goalRowId(after, collection) !== id) throw new TypeError('目标或宫格编号不能改变。');
    const current = readGoalRow(state, collection, id);
    if (current === after || (current && after && canonical(encodeLegacy(current)) === canonical(encodeLegacy(after)))) return { state, keys: [] };
    const key = unitKey(goalCollections[collection], id);
    return { state: write(state, key, after, device, { updatedAt }), keys: [key] };
  }
  if (collection !== 'tasks') return editLegacy(state, collection, id, before, after, device, updatedAt);
  const result = editLegacy(state, collection, id, before && withoutLink(before), after && withoutLink(after), device, updatedAt);
  if (!after || before?.goalId === after.goalId) return result; // 删除任务时保留关联单元。
  const key = taskGoalKey(id), entity = unitKey('entity', 'tasks', id);
  result.state = write(result.state, key, after.goalId || undefined, device, { updatedAt });
  result.keys.push(key);
  if (!result.keys.includes(entity)) {
    result.state = write(result.state, entity, true, device, { updatedAt, ...(Object.hasOwn(after, 'updated') ? { legacyUpdated: encodeLegacy(after.updated) } : {}) });
    result.keys.push(entity);
  }
  return result;
}
