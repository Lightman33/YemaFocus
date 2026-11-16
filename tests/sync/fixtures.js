// 全部为虚构资料，覆盖电脑版写出的字段、未知扩展和旧版可省略字段。
// 测试不读取任何用户数据目录。
export function fakePlanner() {
  return {
    version: 1, customRoot: { nested: ['甲', { flag: true, decimal: 0.125 }], '$sync': '普通未知键' },
    projects: [{ id: 'p-fiction', name: '纸飞机计划', color: 2, archived: false, order: 0.5,
      created: '2026-01-01 08:00:00', updated: '2026-01-01T00:00:00.000Z', parent: null, sections: [{ id: 'section-a', name: '准备' }], unknown: { enabled: true } }],
    tasks: [{ id: 't-fiction', project: 'p-fiction', title: '整理虚构卡片', notes: '中文😀\n引号"与反斜杠\\',
      date: '2026-11-13', weekOf: null, monthOf: '2026-11-01', time: '09:00', endTime: '10:00',
      remindTime: '08:50', remindOffset: 0, remindedAt: '', priority: 2, done: true, doneAt: '2026-11-13 10:00:00',
      created: '2026-01-01 08:00:00', series: null, order: 1.25, updated: '2026-11-13T02:00:00.000Z',
      repeat: { kind: 'Daily', interval: 1, weekMask: 0, anchorDay: 0, anchorMonth: 0, until: null, count: 4, doneCount: 1, futureRule: { x: 1.5 } },
      abandoned: true, abandonedAt: '2026-11-13T02:00:00.000Z', abandonReason: '计划变了',
      abandonHistory: [{ action: 'abandoned', at: '2026-11-13T02:00:00.000Z', reason: '计划变了', future: '保留' }],
      abandonPrevious: { tasks: [{ id: 't-fiction', title: '整理虚构卡片', done: false }], unknown: 7 },
      steps: [{ id: 's-fiction', text: '先分颜色', done: false, date: null, remindTime: '', remindedAt: '', futureStep: ['值', 0.25] }],
      unknownTask: { '$sync': 'number', bits: '不是标记' } },
    { id: 't-trash', title: '同名任务', trashedAt: '2026-11-12 09:00:00', steps: [] }],
    habits: [{ id: 'h-fiction', name: '观察云朵', kind: 'Daily', color: 1, weekMask: 127, perWeek: 3,
      start: '2026-01-01', end: null, archived: false, order: 1, note: '', updated: '2026-11-13T00:00:00.000Z',
      checks: ['2026-11-12', '2026-11-13'], checkEdits: { '2026-11-11': '2026-11-12T00:00:00.000Z', '2026-11-13': '2026-11-13T00:00:00.000Z' },
      journal: { '2026-11-12': { note: '像一只纸船', photos: ['fiction.jpg'], future: { caption: '虚构附件名' } } }, futureHabit: [1, false] }],
    weekNotes: [{ monday: '2026-11-09', good: '按计划练习', improve: '早点收尾', next: '继续练习', updated: '2026-11-13T00:00:00.000Z', futureWeek: '未知字段' }],
    reviews: [{ id: 'day:2026-11-13', scale: 'day', start: '2026-11-13', end: '2026-11-13', title: '平静的一天', score: 4,
      content: '  序言\r\n\r\n【做得好的】\r\n完成纸飞机\r\n\r\n【自定义模块】\n😀\n【自定义模块】\n第二段\n\n【空段】\n  ',
      created: '2026-11-13 08:00:00', updated: '2026-11-13T00:00:00.000Z', futureReview: { nested: true } }],
    countdowns: [{ id: 'c-fiction', title: '虚构展览', date: '2027-01-01', repeat: 'year', color: 2, pinned: true,
      archived: false, note: '带纸飞机', created: '2026-01-01 08:00:00', updated: '2026-11-13T00:00:00.000Z', remindBefore: 2, remindTime: '09:00', remindedFor: '', futureCountdown: '保留' }],
    deleted: { 'old-fiction': '2026-11-12T00:00:00.000Z' }
  };
}
