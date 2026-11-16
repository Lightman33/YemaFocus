// 仅规范化契约明确不保留顺序的集合，步骤和复盘正文仍严格比较。
export function comparablePlanner(planner) {
  const copy = structuredClone(planner);
  for (const name of ['projects', 'tasks', 'habits', 'weekNotes', 'reviews', 'countdowns']) if (Object.hasOwn(copy, name)) {
    const field = name === 'weekNotes' ? 'monday' : 'id';
    copy[name].sort((a, b) => a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0);
  }
  for (const habit of copy.habits || []) if (Object.hasOwn(habit, 'checks')) habit.checks.sort();
  return copy;
}

export function editPlannerFixture() {
  const updated = '2026-11-13T00:00:00.000Z';
  return { version: 1, deleted: {},
    tasks: [{ id: 'keep', title: '虚构任务', notes: '', done: false, doneAt: null, pinned: true, updated, steps: [] }],
    projects: [{ id: 'p', name: '虚构项目', updated }],
    habits: [{ id: 'h', name: '虚构习惯', updated, checks: [], checkEdits: {}, journal: {} }],
    reviews: [{ id: 'r', title: '', content: '【收获】\n原文\n【问题】\n原问题', score: 0, updated }],
    weekNotes: [{ monday: '2026-11-09', good: '', updated }],
    countdowns: [{ id: 'c', title: '虚构倒数日', updated }] };
}

export function editRandomPlanner(after, iteration, next, counts) {
  const operation = next(16), tasks = after.tasks, task = tasks[next(tasks.length)];
  const millis = 1794528000000 + iteration * 1000 + 123, updated = new Date(millis).toISOString();
  const text = String(iteration), steps = task.steps;
  counts[operation]++;
  function step() {
    if (!steps.length) steps.push({ id: 's' + text, text: '新步骤' + text, done: false });
    return steps[next(steps.length)];
  }
  let target = task;
  switch (operation) {
    case 0: task.title = '标题' + text; break;
    case 1: task.notes = '备注😀' + text; break;
    case 2: task.done = !task.done; task.doneAt = task.done ? '2026-11-13 08:00:00' : null; break;
    case 3:
      if (!task.abandoned) {
        task.abandonPrevious = { pinned: task.pinned }; task.abandoned = true; task.done = true;
        task.pinned = false; task.abandonReason = '原因' + text; task.abandonedAt = updated;
      } else {
        task.pinned = task.abandonPrevious.pinned; task.abandoned = false; task.done = false;
        delete task.abandonPrevious; delete task.abandonedAt;
      }
      task.abandonHistory = [...(task.abandonHistory || []), { action: task.abandoned ? 'abandoned' : 'restored', at: updated }]; break;
    case 4: steps.push({ id: 's' + text, text: '步骤' + text, done: false }); break;
    case 5: if (steps.length) steps.splice(next(steps.length), 1); break;
    case 6: step().text = '改步骤' + text; break;
    case 7: { const s = step(); s.done = !s.done; break; }
    case 8: target = after.reviews[0]; target.content = target.content.replace(/原文\d*/, '原文' + text); break;
    case 9: target = after.reviews[0]; target.score = next(6); break;
    case 10: {
      target = after.habits[0]; const day = '2026-11-' + String(1 + next(28)).padStart(2, '0');
      target.checks = target.checks.includes(day) ? target.checks.filter(x => x !== day) : [...target.checks, day];
      target.checkEdits[day] = updated; break;
    }
    case 11:
      if (tasks.length > 1) { const index = task.id === 'keep' ? 1 : tasks.indexOf(task); after.deleted[tasks[index].id] = updated; tasks.splice(index, 1); }
      target = tasks[0]; break;
    case 12:
      target = { id: 't' + text, title: '新任务' + text, notes: '', done: false, doneAt: null, pinned: true, steps: [] };
      tasks.push(target); break;
    case 13: steps.reverse(); break;
    case 14: break; // 只改实体显示时间。
    case 15: {
      const collection = ['projects', 'weekNotes', 'habits', 'countdowns'][next(4)]; target = after[collection][0];
      target[collection === 'weekNotes' ? 'good' : collection === 'countdowns' ? 'title' : 'name'] = '字段' + text; break;
    }
  }
  target.updated = updated;
  return millis;
}
