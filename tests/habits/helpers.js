import { MemoryStore, freshRecord } from '../../app/store.js';
import { createDataSource } from '../../app/datasource.js';
import { HabitActions } from '../../app/habit-actions.js';
import { plannerToState, stateToPlanner } from '../../sync/convert.js';
import { readFile } from 'node:fs/promises';
import { parseDocument } from '../tasks/dom-double.js';
import { HabitsView } from '../../app/habits-view.js';

export const TODAY = '2026-11-13';
export const NOW = Date.parse('2026-11-13T04:30:00.000Z');
export const habit = (fields = {}) => ({ id: 'h', name: '虚构阅读', color: 1, kind: 'Daily', weekMask: 127, perWeek: 3,
  start: '2026-10-01', end: null, archived: false, order: 1, note: '', checks: [], checkEdits: {},
  journal: { '2026-11-12': { note: '虚构旧感想', photos: ['fiction.jpg'], future: { keep: 1.25 } } }, updated: '2026-11-12T00:00:00.000Z', ...fields });
export const planner = (habits = [habit()]) => ({ version: 1, projects: [], tasks: [], habits, weekNotes: [], deleted: {} });
export async function fixture({ state = plannerToState(planner(), 'computer', NOW), joined = true, tasksFirst = false, store } = {}) {
  const clock = { value: NOW, now() { return this.value; }, advance(ms = 1000) { this.value += ms; } };
  store ||= new MemoryStore({ ...freshRecord(), state, settings: { joined, deviceId: 'phone' } });
  const source = await createDataSource({ store, now: () => clock.now(), tasksFirst });
  const actions = new HabitActions(source, { now: () => clock.now() });
  return { store, source, actions, clock };
}
export const row = (source, id = 'h') => source.snapshot().planner.habits.find(h => h.id === id);
export async function savedState(store) {
  const r = await store.read(); return r.state?.format === 'yema-engine-local' ? r.state.state : r.state;
}
export async function savedPlanner(store) { return stateToPlanner(await savedState(store), { allowConflicts: true }); }
export const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
export function mount(f, t) {
  const document = parseDocument(html), root = document.getElementById('habits-root');
  const view = new HabitsView({ document, root, source: f.source, now: () => f.clock.now() });
  t.after(() => view.destroy()); return { document, root, view };
}
