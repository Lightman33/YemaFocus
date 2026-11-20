import { Period, SCALES, SCALE_NAMES, ReviewText, reviewModules, findReview, defaultWeek, DATA_TITLE, wallTime, trim, computeStats, statsToText, fmtMin, percent } from './review-model.js';
import { ReviewActions } from './review-actions.js';

// 外壳唯一入口。来源仅依赖 snapshot/change/resolve/subscribe；now 返回 Date 或毫秒。
export function mountReview({ root, dataSource, now = () => Date.now(), preferences }) {
  const doc = root.ownerDocument, win = doc.defaultView || globalThis.window;
  const actions = new ReviewActions(dataSource, { now });
  const el = (tag, text = '', className = '') => { const node = doc.createElement(tag); node.textContent = String(text); if (className) node.className = className; return node; };
  const focusedEditor = () => {
    const input = doc.activeElement;
    return input?.tagName === 'TEXTAREA' && root.contains(input) ? input : null;
  };
  const button = (text, name, fn, className = 'secondary') => {
    const b = el('button', text, className); b.type = 'button'; b.setAttribute('aria-label', name || text);
    // 保留原来的焦点直到点击派发，避免键盘先收起、按钮跟着滚动。
    b.addEventListener('mousedown', event => { if (focusedEditor()) event.preventDefault(); });
    b.addEventListener('click', () => {
      const editor = focusedEditor();
      try { Promise.resolve(fn()).catch(showError); } catch (error) { showError(error); }
      if (editor && doc.activeElement === editor) b.focus({ preventScroll: true });
    });
    return b;
  };
  let ui = {};
  try { ui = preferences?.read() || {}; } catch { /* 偏好读取失败不阻止编辑 */ }
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) ui = {};
  const TITLE_FIELD = Symbol('一句话总结');
  let snapshot = dataSource.snapshot(), period = Period.parseId(ui.period), mode = ui.mode === 'stats' ? 'stats' : 'write';
  const initialDay = snapshot.today;
  if (!period && initialDay) period = ui.scale === 'week' ? defaultWeek(initialDay) : Period.of(SCALES.includes(ui.scale) ? ui.scale : 'day', initialDay);
  let destroyed = false, timer = null, flushChain = Promise.resolve(), generation = 0, fields = new Map(), modules = new Map();
  let score = 0, scoreDirty = null, savedMessage = '', messageTimer, undoAction = null, undoUntil = 0, switching = false;
  let expandedDone = false, focusMode = 'task', statsRenderer = null, statistic = null, openImportedData = null;
  const saveUI = () => { try { Promise.resolve(preferences?.write({ scale: period?.scale, period: period?.id, mode })).catch(() => {}); } catch { /* 偏好保存失败不阻止编辑 */ } };
  root.className = (root.className + ' review-page').trim(); root.replaceChildren();
  const heading = el('div', '', 'review-heading'); heading.append(el('h1', '复盘与统计'));
  const status = el('p', '', 'review-save caption'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); heading.append(status);
  const joinTip = el('p', '', 'review-notice'), toolbar = el('div', '', 'review-toolbar');
  const scales = el('div', '', 'review-segments'), scaleButtons = new Map(); scales.setAttribute('aria-label', '复盘尺度');
  SCALES.forEach((scale, i) => { const b = button(SCALE_NAMES[i], SCALE_NAMES[i] + '复盘', () => navigate(() => scale === 'week' ? defaultWeek(snapshot.today) : Period.of(scale, snapshot.today))); scaleButtons.set(scale, b); scales.append(b); });
  const nav = el('div', '', 'review-period');
  const prev = button('◀', '上一期', () => navigate(() => Period.shift(period, -1))), label = el('strong'), next = button('▶', '下一期', () => navigate(() => Period.shift(period, 1)));
  nav.append(prev, label, next);
  const current = button('回到本期', '回到本期', () => navigate(() => Period.of(period.scale, snapshot.today)));
  const modes = el('div', '', 'review-segments');
  const writeButton = button('写复盘', '写复盘', () => switchMode('write')), statsButton = button('看统计', '看统计', () => switchMode('stats')); modes.append(writeButton, statsButton);
  toolbar.append(scales, nav, current, modes);
  const conflictBanner = el('p', '', 'review-notice error-text'), topConflicts = el('div');
  const writer = el('div'), summary = el('p', '', 'review-summary'), scoreConflicts = el('div'), stars = el('div', '', 'review-stars'); stars.setAttribute('aria-label', '复盘评分');
  const starButtons = Array.from({ length: 5 }, (_, i) => { const b = button('☆', '评分 ' + (i + 1) + ' 星，再点同一颗清零', async () => { if (!editable()) return; score = score === i + 1 ? 0 : i + 1; scoreDirty = { value: score, token: snapshot.editToken, rev: ++generation }; savedMessage = ''; updateStars(); await flush(); }); stars.append(b); return b; });
  const titleConflicts = el('div'), titleLabel = el('label', '一句话总结（可选）'), titleInput = el('textarea');
  titleInput.id = 'review-title'; titleInput.rows = 1; titleLabel.setAttribute('for', titleInput.id); titleInput.setAttribute('aria-label', '一句话总结');
  const sectionBox = el('div'), tools = el('div', '', 'review-actions');
  const importButton = button('导入本期数据', '导入本期数据，可撤销', async () => {
    await flush();
    statistic ||= computeStats(snapshot.planner, period, snapshot.records || [], snapshot.today, snapshot.timeZone);
    const importedPeriod = period;
    const receipt = await actions.importData(importedPeriod, statsToText(statistic, snapshot.planner, { now: now(), timeZone: snapshot.timeZone, maxItems: 30 }));
    openImportedData = importedPeriod.id; refresh();
    snack(receipt.description, receipt.undo);
  });
  const copyButton = button('复制全文', '复制全文 Markdown', async () => { await flush(); const result = await actions.copyAll(period); if (result.copied) snack('已复制 Markdown 全文'); else showCopy(result.text); });
  tools.append(importButton, copyButton);
  writer.append(summary, scoreConflicts, stars, titleConflicts, titleLabel, titleInput, sectionBox, tools);
  const statistics = el('div', '', 'review-statistics');
  const snackBar = el('div', '', 'review-snackbar'); snackBar.hidden = true; snackBar.setAttribute('role', 'status');
  const snackText = el('span'), undoButton = button('撤销', '撤销刚才的操作', async () => { if (undoAction && now() <= undoUntil) { await flush(); await undoAction(); snackBar.hidden = true; undoAction = null; refresh(); } });
  snackBar.append(snackText, undoButton);
  root.append(heading, joinTip, toolbar, conflictBanner, topConflicts, writer, statistics, snackBar);
  function editable() { return snapshot.joined && Boolean(snapshot.today && snapshot.timeZone); }
  function showError(error) { if (destroyed) return; savedMessage = ''; status.textContent = '未保存 · ' + (error?.message || '请稍后重试'); status.className = 'review-save error-text'; snack('保存或操作没有完成，输入仍保留。' + (error?.message || '')); }
  function snack(text, undo = null) {
    clearTimeout(messageTimer); snackText.textContent = text; undoAction = undo; undoUntil = +now() + 5000; undoButton.hidden = !undo; snackBar.hidden = false;
    messageTimer = setTimeout(() => { snackBar.hidden = true; undoAction = null; }, 5000); messageTimer.unref?.();
  }
  function resize(input) { if (!input.style) return; input.style.height = 'auto'; input.style.height = Math.max(48, input.scrollHeight || 48) + 'px'; }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => { flush().catch(showError); }, 300); timer.unref?.(); }
  function bindInput(input, key, value) {
    const entry = { input, key, dirty: false, composing: false, token: null, rev: 0 }; fields.set(key, entry); input.value = value || '';
    const dirty = () => { if (!entry.dirty && doc.activeElement !== input) entry.token = snapshot.editToken; entry.dirty = true; entry.rev = ++generation; savedMessage = ''; status.textContent = entry.composing ? '正在输入 · 等待输入结束' : '正在编辑 · 等待自动保存'; resize(input); if (!entry.composing) schedule(); };
    input.addEventListener('input', dirty); input.addEventListener('change', dirty);
    input.addEventListener('compositionstart', () => { entry.composing = true; clearTimeout(timer); });
    input.addEventListener('compositionend', () => { entry.composing = false; dirty(); });
    input.addEventListener('blur', () => { if (!entry.composing) flush().catch(showError); });
    input.addEventListener('focus', () => { if (!entry.dirty) entry.token = snapshot.editToken; });
    resize(input); return entry;
  }
  function updateStars() { starButtons.forEach((b, i) => { b.textContent = i < score ? '★' : '☆'; b.setAttribute('aria-pressed', String(i < score)); b.disabled = !editable() || hasConflict('review-score'); }); }
  function currentConflicts() { return (snapshot.conflicts || []).filter(c => { const p = pathOf(c); return p[0] === 'entity' ? p[1] === 'reviews' && p[2] === period?.id : p[0]?.startsWith('review-') && p[1] === period?.id; }); }
  function pathOf(c) { if (c.path) return c.path; try { return JSON.parse(c.key); } catch { return []; } }
  function hasConflict(kind, name) { return currentConflicts().some(c => { const p = pathOf(c); return p[0] === 'entity' || p[0] === kind && (name === undefined || p[2] === name); }); }
  function conflictCards(box, conflicts) {
    box.replaceChildren();
    for (const conflict of conflicts) {
      const card = el('div', '', 'review-conflict'), observed = snapshot.editToken; card.append(el('h3', conflict.deleteConflict ? '一边删除，一边修改' : '两边都改过，请选保留哪一份'));
      (conflict.candidates || []).forEach((candidate, i) => {
        const version = el('div', '', 'review-version'); version.append(el('strong', '版本 ' + (i + 1)));
        const value = candidate.value;
        version.append(el('pre', candidate.deleted ? '这一份已删除' : typeof value === 'object' ? (value?.raw ?? JSON.stringify(value, null, 2)) : String(value), 'review-fulltext'));
        const b = button(candidate.deleted ? '确认删除' : '保留这一份（版本 ' + (i + 1) + '）', null, () => resolve(conflict, { branch: candidate.branch }, observed)); b.disabled = !editable(); version.append(b); card.append(version);
      });
      const values = (conflict.candidates || []).map(c => c.value), text = values.every(v => typeof v === 'string' || v && typeof v.raw === 'string');
      if (!conflict.deleteConflict && !(conflict.candidates || []).some(c => c.deleted) && text && values.length > 1) {
        const both = button('两段都留着', '两段都留着，按上面的版本顺序各占一段', () => resolve(conflict, { type: 'both' }, observed)); both.disabled = !editable(); card.append(both);
      } else if (pathOf(conflict)[0] === 'review-score') card.append(el('p', '评分只能保留一个数值，请选一份。', 'caption'));
      box.append(card);
    }
  }
  async function resolve(conflict, choice, observed) {
    // 保存输入期间新产生的分支没有在这次比对里展示过；仍用卡片原来的 observed 解决，
    // 让来源保留这些新分支，避免用户没看过的新文字被旧卡片抹掉。
    await flush(); await actions.resolve(conflict, choice, observed);
    refresh(); snack('已处理两边都改过的内容');
  }

  function updateModule(section) {
    const input = section.entry.input, value = input.value, editing = section.open && section.edit;
    section.toggle.textContent = (section.open ? '▼ ' : '▶ ') + (section.name || '其他') + (section.extra ? '（存档模块）' : '');
    section.toggle.setAttribute('aria-expanded', String(section.open)); section.preview.textContent = trim(value).split(/\r?\n/)[0] || '还没写';
    section.preview.hidden = section.open;
    section.read.textContent = value || '还没写'; section.read.hidden = !section.open || section.edit;
    section.editButton.hidden = section.read.hidden;
    // 收起时保留文字框的布局盒，同时退出 Tab 顺序并对读屏隐藏。
    section.editor.setAttribute('aria-hidden', String(!editing)); input.tabIndex = editing ? 0 : -1;
    const canEdit = editable(), conflict = hasConflict('review-module', section.name);
    input.disabled = !canEdit || conflict && doc.activeElement !== input; section.editButton.disabled = !canEdit || conflict;
    if (editing) resize(input);
  }
  function focusModule(input) {
    if (input.disabled) return;
    const end = input.value.length;
    input.setSelectionRange?.(end, end);
    input.focus();
  }
  function addModule(name, value, extra) {
    const card = el('section', '', 'review-module'), conflict = el('div'), preview = el('span', '', 'review-preview caption');
    const body = el('div', '', 'review-module-body'), editor = el('div', '', 'review-module-editor'), input = el('textarea'), read = el('pre', '', 'review-fulltext');
    input.rows = 2; input.setAttribute('aria-label', '复盘模块：' + (name || '其他'));
    const section = { name, extra, card, conflict, preview, editor, read, entry: bindInput(input, name, value), open: false, edit: name !== DATA_TITLE };
    section.toggle = button('', '展开或收起模块：' + (name || '其他'), () => {
      if (section.open && doc.activeElement === input) section.toggle.focus({ preventScroll: true });
      section.open = !section.open; updateModule(section);
      if (section.open && section.edit) focusModule(input);
    }, 'review-module-toggle');
    section.editButton = button('编辑文字', '编辑本期数据文字', () => { section.edit = true; updateModule(section); focusModule(input); });
    editor.append(input); body.append(read, section.editButton, editor); card.append(conflict, section.toggle, preview, body); sectionBox.append(card); modules.set(name, section); return section;
  }
  function syncWriter() {
    const record = findReview(snapshot.planner, period), configured = reviewModules(snapshot.settings, period.scale);
    const title = fields.get(TITLE_FIELD);
    if (!title.dirty && doc.activeElement !== titleInput) titleInput.value = record?.title || '';
    titleInput.disabled = !editable() || hasConflict('review-title') && doc.activeElement !== titleInput; resize(titleInput);
    if (!scoreDirty) score = record?.score || 0; updateStars();
    const sections = ReviewText.ordered(record?.content || '', configured).filter(([name, value]) => name || trim(value));
    for (const c of currentConflicts()) { const p = pathOf(c); if (p[0] === 'review-module' && !sections.some(s => s[0] === p[2])) sections.push([p[2], '']); }
    const wanted = new Set(sections.map(([name]) => name));
    for (const [name, section] of modules) if (!wanted.has(name) && !section.entry.dirty && doc.activeElement !== section.entry.input) { section.card.remove(); fields.delete(name); modules.delete(name); }
    for (const [name, value] of sections) {
      let section = modules.get(name);
      if (!section) section = addModule(name, value, Boolean(name && name !== DATA_TITLE && !configured.includes(name)));
      if (!section.entry.dirty && doc.activeElement !== section.entry.input) section.entry.input.value = value;
      if (name === DATA_TITLE && openImportedData === period.id) section.open = true;
      updateModule(section);
      const cs = currentConflicts().filter(c => pathOf(c)[0] === 'review-module' && pathOf(c)[2] === name);
      conflictCards(section.conflict, cs);
    }
    openImportedData = null;
    // 只有顺序真的变了，且模块里没有焦点时，才移动卡片节点。
    const ordered = sections.map(([name]) => modules.get(name).card);
    if (!sectionBox.contains(doc.activeElement) && ordered.some((card, index) => sectionBox.children[index] !== card)) sectionBox.append(...ordered);
    conflictCards(scoreConflicts, currentConflicts().filter(c => pathOf(c)[0] === 'review-score'));
    conflictCards(titleConflicts, currentConflicts().filter(c => pathOf(c)[0] === 'review-title'));
    importButton.disabled = !editable() || hasConflict('review-module', DATA_TITLE); copyButton.disabled = !editable();
    if (savedMessage) { status.className = 'review-save caption'; status.textContent = savedMessage; }
    else if (![...fields.values()].some(e => e.dirty) && !scoreDirty) status.textContent = record ? snapshot.timeZone && Number.isFinite(new Date(record.updated).getTime()) ? '已存本机 ' + wallTime(new Date(record.updated), snapshot.timeZone).slice(11, 16) : '已有复盘记录' : '还没有记录 · 点开模块说话或打字，会自动保存';
  }
  // 屏幕抬手后还可能先派发兼容鼠标事件，再派发 click。这段时间也保留按钮节点和位置。
  let pointerId = null, pointerTimer = null, refreshQueued = false;
  function refresh() {
    if (pointerId !== null) { refreshQueued = true; return; }
    refreshNow();
  }
  function refreshNow() {
    if (destroyed) return;
    snapshot = dataSource.snapshot(); statistic = null;
    if (!period && snapshot.today) period = Period.of('day', snapshot.today);
    joinTip.hidden = editable(); joinTip.textContent = snapshot.joined ? '请先在设置里选择软件时区。' : '先在设置里连接并完成第一次同步';
    toolbar.hidden = !period; writer.hidden = !period || mode !== 'write'; statistics.hidden = !period || mode !== 'stats';
    if (!period) return;
    for (const [scale, b] of scaleButtons) { b.setAttribute('aria-pressed', String(period.scale === scale)); b.disabled = !snapshot.today; }
    label.textContent = Period.label(period); prev.disabled = next.disabled = !snapshot.today;
    current.hidden = !snapshot.today || Period.contains(period, snapshot.today);
    writeButton.setAttribute('aria-pressed', String(mode === 'write')); statsButton.setAttribute('aria-pressed', String(mode === 'stats'));
    const conflicts = currentConflicts(); conflictBanner.hidden = !conflicts.length; conflictBanner.textContent = '有 ' + conflicts.length + ' 处两边都改过' + (mode === 'stats' ? ' · 在“写复盘”里选择保留的版本' : '');
    conflictCards(topConflicts, conflicts.filter(c => ['entity', 'review-meta'].includes(pathOf(c)[0])));
    syncWriter();
    if (snapshot.today && snapshot.timeZone) {
      statistic = computeStats(snapshot.planner, period, snapshot.records || [], snapshot.today, snapshot.timeZone);
      summary.textContent = statistic.planned || statistic.doneTotal || statistic.recordCount || statistic.habits.length ? '番茄 ' + statistic.pomos + ' 个 · ' + fmtMin(statistic.pomoMin) + ' · 完成 ' + statistic.doneTotal + ' 项 · 习惯 ' + percent(statistic.habitRate) : '这段时间还没有统计记录。点开模块写下复盘。';
    } else summary.textContent = '';
    if (statsRenderer && mode === 'stats') statsRenderer();
  }
  function flush() {
    clearTimeout(timer);
    const execute = async () => {
      if (destroyed) return;
      // 一次提交同一观察分支上的全部输入。尤其是新复盘，不能先建总结，再用旧快照建正文覆盖它。
      // 存盘期间又输入的字继续排队保存；切页必须等到队列排空。
      while (true) {
        const eligible = [...fields.values()].filter(e => e.dirty && !e.composing);
        const pending = eligible.filter(entry => {
          const conflict = hasConflict(entry.key === TITLE_FIELD ? 'review-title' : 'review-module', entry.key === TITLE_FIELD ? undefined : entry.key);
          if (conflict && !entry.token) throw new Error('这处内容两边都改过，请先选择保留的版本。输入仍保留。');
          return true;
        });
        const nextScore = scoreDirty;
        if (!pending.length && !nextScore) break;
        const baseToken = pending.length ? pending[0].token : nextScore.token;
        const batch = pending.filter(e => e.token === baseToken).map(entry => ({ entry, rev: entry.rev, value: entry.input.value }));
        const patch = { modules: [] };
        for (const { entry, value } of batch) { if (entry.key === TITLE_FIELD) patch.title = value; else patch.modules.push([entry.key, value]); }
        const savingScore = nextScore?.token === baseToken ? nextScore : null;
        if (savingScore) patch.score = savingScore.value;
        if (!patch.modules.length) delete patch.modules;
        const receipt = await actions.save(period, patch, { baseToken });
        for (const { entry, rev } of batch) if (entry.rev === rev) entry.dirty = false;
        if (scoreDirty === savingScore) scoreDirty = null;
        if (receipt?.editToken) {
          for (const e of fields.values()) if (e.token === baseToken) e.token = receipt.editToken;
          if (scoreDirty?.token === baseToken) scoreDirty.token = receipt.editToken;
        }
      }
      if ([...fields.values()].some(e => e.composing)) throw new Error('请先完成输入法选词，文字仍保留在当前页。');
      if (!editable()) return;
      savedMessage = '已存本机 ' + wallTime(now(), snapshot.timeZone).slice(11, 16); refresh();
    };
    const pending = flushChain.catch(() => {}).then(execute); flushChain = pending; return pending;
  }
  async function navigate(getPeriod) {
    if (switching || !snapshot.today) return; switching = true;
    try { await flush(); period = getPeriod(); fields = new Map(); modules = new Map(); sectionBox.replaceChildren(); titleInput.value = ''; bindInputReset(); scoreDirty = null; savedMessage = ''; expandedDone = false; refresh(); saveUI(); }
    finally { switching = false; }
  }
  // 总结框的监听只安装一次，切周期仅重新登记其状态。
  const titleEntry = bindInput(titleInput, TITLE_FIELD, '');
  function bindInputReset() { titleEntry.dirty = false; titleEntry.composing = false; titleEntry.token = null; fields.set(TITLE_FIELD, titleEntry); }
  async function switchMode(value) { await flush(); mode = value; saveUI(); refresh(); }
  function showCopy(text) {
    const dialog = el('dialog', '', 'review-copy'), close = button('关闭', '关闭手动复制全文', () => { dialog.close?.(); dialog.remove(); copyButton.focus(); });
    dialog.setAttribute('aria-label', '手动复制全文'); dialog.append(el('h2', '长按下方文字复制全文'), close);
    const area = el('textarea'); area.value = text; area.readOnly = true; area.setAttribute('aria-label', '复盘 Markdown 全文，长按或全选复制'); dialog.append(area); root.append(dialog); if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); area.focus(); area.select?.();
    dialog.addEventListener('close', () => { dialog.remove(); copyButton.focus(); });
  }
  const onHidden = () => { if (doc.visibilityState === 'hidden') flush().catch(showError); }, onPageHide = () => { flush().catch(showError); };
  doc.addEventListener('visibilitychange', onHidden); win?.addEventListener?.('pagehide', onPageHide);
  const onPointerDown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    clearTimeout(pointerTimer); pointerTimer = null; pointerId = event.pointerId;
  };
  const finishPointerAfter = delay => {
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(() => {
      pointerId = null; pointerTimer = null;
      if (refreshQueued) { refreshQueued = false; refresh(); }
    }, delay);
  };
  // 普通点击在 click 处理完后刷新。抬手却没有 click 时，仍会补做刷新。
  const onPointerUp = event => { if (event.pointerId === pointerId) finishPointerAfter(350); };
  const onPointerCancel = event => { if (event.pointerId === pointerId) finishPointerAfter(0); };
  const onClick = () => { if (pointerTimer !== null) finishPointerAfter(0); };
  root.addEventListener?.('pointerdown', onPointerDown, true);
  doc.addEventListener?.('pointerup', onPointerUp, true); doc.addEventListener?.('pointercancel', onPointerCancel, true);
  doc.addEventListener?.('click', onClick, true);
  const unsubscribe = dataSource.subscribe(refresh);
  // 统计视图在同一文件下方安装；不额外暴露页面内部对象。
  installStatistics();
  refresh();
  function installStatistics() {
    const card = (title, container = statistics) => { const node = el('section', '', 'review-card'); node.append(el('h2', title)); container.append(node); return node; };
    const ratioRow = (container, name, value, rate) => {
      const row = el('div', '', 'review-ratio'); row.setAttribute('role', 'img'); row.setAttribute('aria-label', name + '：' + value);
      const text = el('div', '', 'review-ratio-text'); text.append(el('span', name), el('strong', value));
      const track = el('div', '', 'review-track'), fill = el('span');
      fill.setAttribute('style', 'width:' + Math.max(0, Math.min(100, rate * 100)) + '%'); track.setAttribute('aria-hidden', 'true'); track.append(fill); row.append(text, track); container.append(row);
    };
    const metric = (grid, title, value, note) => { const node = el('div', '', 'review-metric'); node.append(el('h3', title), el('strong', value, 'review-number'), el('p', note, 'caption')); grid.append(node); return node; };
    statsRenderer = () => {
      statistics.replaceChildren(); const s = statistic;
      if (!s) { statistics.append(el('p', '连接并选择软件时区后，可以查看统计。', 'review-notice')); return; }
      const hasData = s.planned || s.doneTotal || s.abandonedTotal || s.recordCount || s.habits.length;
      if (!hasData) { statistics.append(el('p', '这段时间还没有记录。电脑同步过来或完成任务后，这里就会显示统计。', 'review-notice')); return; }
      const grid = el('div', '', 'review-metrics'); statistics.append(grid);
      metric(grid, '专注番茄', s.pomos + ' 个', '另有放弃 ' + s.pomosAbandoned + ' 个');
      metric(grid, '专注时长', fmtMin(s.pomoMin), '含正计时 ' + fmtMin(s.stopwatchMin));
      const plan = metric(grid, '计划完成率', percent(s.planRate), s.plannedDone + '/' + s.planned + ' 项' + (period.scale === 'week' ? '，含本周待安排' : '，按安排日期'));
      if (s.planRate >= 0) { const progress = el('progress'); progress.max = 1; progress.value = s.planRate; progress.setAttribute('aria-label', '计划完成率 ' + percent(s.planRate)); plan.append(progress); }
      metric(grid, '共完成', s.doneTotal + ' 项', '计划外 ' + Math.max(0, s.doneTotal - s.plannedDone) + ' 项 · 完成步骤 ' + s.stepsDone + ' 个');
      metric(grid, '习惯完成率', percent(s.habitRate), s.habits.length ? s.habits.length + ' 个习惯的平均完成率' : '没有可统计的习惯');
      const denominator = s.breaksDone + s.breaksSkipped + s.breaksInterrupted;
      metric(grid, '休息与打断', denominator ? '按时 ' + percent(s.breaksDone / denominator) : '尚无休息记录',
        '按时 ' + s.breaksDone + ' · 跳过 ' + s.breaksSkipped + ' · 推迟 ' + s.breaksPostponed + ' · 休息中断 ' + s.breaksInterrupted + '；被打断 ' + s.interruptions + ' 次（外部 ' + s.external + ' · 自己分心 ' + s.self + '）');
      const chart = card('完成与专注 · ' + s.buckets.unit);
      const legend = el('p', '', 'review-legend'); legend.append(el('span', '▰ 完成任务', 'review-done-legend'), el('span', '▥ 专注番茄', 'review-pomo-legend')); chart.append(legend);
      if (!s.doneTotal && !s.pomos) chart.append(el('p', '还没有完成任务或番茄。正计时只计入专注时长。', 'caption'));
      else {
        const selected = el('p', '点柱子查看这一段的具体数字', 'review-chart-detail'); selected.setAttribute('aria-live', 'polite'); chart.append(selected);
        const max = Math.max(1, ...s.doneByBucket, ...s.pomoByBucket), scroller = el('div', '', 'review-chart-scroll');
        const plot = el('div', '', 'review-chart'); plot.setAttribute('aria-label', '完成与专注柱状图，最高刻度 ' + max + '，横向滚动可查看全部时段'); plot.setAttribute('role', 'group');
        plot.setAttribute('style', '--review-columns:' + s.buckets.n); scroller.append(plot);
        s.buckets.names.forEach((name, i) => {
          const speech = name + '：完成 ' + s.doneByBucket[i] + ' 项，番茄 ' + s.pomoByBucket[i] + ' 个';
          const segment = button('', speech, () => { selected.textContent = speech; for (const b of plot.children) b.setAttribute('aria-pressed', String(b === segment)); }, 'review-chart-segment');
          const bars = el('span', '', 'review-bars'); bars.setAttribute('aria-hidden', 'true');
          const done = el('span', '', 'review-bar review-bar-done'), pomo = el('span', '', 'review-bar review-bar-pomo');
          done.setAttribute('style', 'height:' + s.doneByBucket[i] / max * 110 + 'px'); pomo.setAttribute('style', 'height:' + s.pomoByBucket[i] / max * 110 + 'px'); bars.append(done, pomo);
          const axis = el('span', s.buckets.labels[i], 'review-axis'); axis.setAttribute('aria-hidden', 'true'); segment.append(bars, axis); plot.append(segment);
        });
        chart.append(el('p', '纵轴：0–' + max + ' 个/项；较长的图可横向滚动。', 'caption'), scroller);
      }
      const distribution = card('专注时间花在哪'), selector = el('div', '', 'review-segments');
      for (const [key, name] of [['task', '按事项'], ['category', '按大类']]) { const b = button(name, name + '查看专注分布', () => { focusMode = key; statsRenderer(); }); b.setAttribute('aria-pressed', String(focusMode === key)); selector.append(b); } distribution.append(selector);
      const rows = Object.entries(focusMode === 'task' ? s.byTask : s.byCategory).sort((a, b) => b[1][1] - a[1][1]);
      if (!rows.length) distribution.append(el('p', '这段时间没有完成的专注记录。', 'caption'));
      for (const [name, value] of rows) ratioRow(distribution, name, value[0] + ' 个 · ' + fmtMin(value[1]) + ' · ' + percent(s.pomoMin ? value[1] / s.pomoMin : 0), s.pomoMin ? value[1] / s.pomoMin : 0);
      const projects = card('按项目完成情况'), projectRows = Object.entries(s.byProject).sort((a, b) => b[1][0] + b[1][2] - a[1][0] - a[1][2]);
      if (!projectRows.length) projects.append(el('p', '这段时间没有安排或完成的任务。', 'caption'));
      for (const [id, row] of projectRows) ratioRow(projects, (snapshot.planner.projects || []).find(p => p.id === id)?.name || '无项目', row[1] + '/' + row[0] + ' 项' + (row[2] ? '，计划外 +' + row[2] : ''), row[0] ? row[1] / row[0] : row[2] > 0 ? 1 : 0);
      const habits = card('习惯打卡'); if (!s.habits.length) habits.append(el('p', '这段时间没有可统计的习惯。', 'caption'));
      for (const h of s.habits) ratioRow(habits, h.habit.name, h.count + ' 次 · ' + (h.rate < 0 ? '还没有可统计的日期' : percent(h.rate)), h.rate);
      const unfinished = card('未完成清单（' + s.unfinished.length + '）');
      if (!s.unfinished.length) unfinished.append(el('p', '这段时间计划的事都做完了。', 'caption'));
      for (const task of s.unfinished) {
        const row = el('div', '', 'review-task');
        const check = button('○', '完成任务：' + task.title, async () => { await flush(); const receipt = await actions.complete(task.id); snack(receipt?.description || '已完成任务', receipt?.undo); }); check.disabled = !editable();
        row.append(check, el('span', task.title)); unfinished.append(row);
      }
      const completed = card('已完成清单（' + s.completed.length + '）');
      if (!s.completed.length) completed.append(el('p', '这段时间还没有完成的任务。', 'caption'));
      const list = el('ol'); for (const task of (expandedDone ? s.completed : s.completed.slice(0, 5))) list.append(el('li', task.title + (task.doneAt ? ' · ' + task.doneAt.slice(5, 16) : ''))); completed.append(list);
      if (s.completed.length > 5) { const toggle = button(expandedDone ? '收起清单' : '显示全部 ' + s.completed.length + ' 项', null, () => { expandedDone = !expandedDone; statsRenderer(); }); toggle.setAttribute('aria-expanded', String(expandedDone)); completed.append(toggle); }
      const abandoned = card('已放弃清单（' + s.abandonedTotal + '）'); if (!s.abandonedTotal) abandoned.append(el('p', '这段时间没有放弃的任务。', 'caption'));
      for (const task of s.abandoned) abandoned.append(el('p', task.title + ' — ' + (task.abandonReason || '未填写原因')));
    };
  }
  return { refresh, flush, destroy() {
    destroyed = true; unsubscribe?.(); clearTimeout(timer); clearTimeout(messageTimer); clearTimeout(pointerTimer);
    doc.removeEventListener?.('visibilitychange', onHidden); win?.removeEventListener?.('pagehide', onPageHide);
    root.removeEventListener?.('pointerdown', onPointerDown, true);
    doc.removeEventListener?.('pointerup', onPointerUp, true); doc.removeEventListener?.('pointercancel', onPointerCancel, true);
    doc.removeEventListener?.('click', onClick, true);
    root.replaceChildren();
  } };
}
