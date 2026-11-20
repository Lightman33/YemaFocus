import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument } from '../tasks/dom-double.js';
import { FocusFullscreen } from '../../app/focus-fullscreen.js';
import { FocusView } from '../../app/focus-view.js';
import { FocusTimer } from '../../app/focus-timer.js';
import { createDataSource } from '../../app/datasource.js';
import { freshRecord, MemoryStore } from '../../app/store.js';
import { emptyState } from '../../sync/merge.js';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const fallback = /这台手机不能保持常亮，请在 设置→显示与亮度→自动锁定 里调整/;
function fixture() {
  const document = parseDocument(html), get = name => document.getElementById('focus-' + name);
  document.getElementById('page-focus').hidden = false;
  return { document, get };
}
class Lock extends EventTarget {
  released = false;
  async release() {
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

test('T46-2 全屏长按两秒退出，短按提示，两秒内拖动或取消保持全屏', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { document, get } = fixture(), full = new FocusFullscreen(document, get, {});
  t.after(() => full.destroy());
  const button = get('fullscreen-exit');
  const pointer = { pointerId: 1, button: 0, clientX: 100, clientY: 50 };
  full.open('14:09', '虚构/长期事项');
  assert.equal(document.activeElement, get('fullscreen-time'));
  assert.equal(get('fullscreen-time').getAttribute('aria-label'), '剩余 14 分 9 秒');
  assert.match(button.textContent, /长按两秒退出全屏/);
  assert.match(get('fullscreen-wake').textContent, fallback);
  assert.equal(button.emit('click').defaultPrevented, true);
  assert.equal(get('fullscreen').emit('cancel').defaultPrevented, true);
  for (const [event, data] of [
    ['pointerup', pointer], ['pointercancel', pointer], ['pointermove', { ...pointer, clientX: 125 }], ['pointerleave', pointer]
  ]) {
    button.emit('pointerdown', pointer);
    t.mock.timers.tick(500);
    assert.equal(button.getAttribute('data-holding'), '');
    button.emit(event, data);
    if (event === 'pointerup') assert.equal(get('fullscreen-exit-message').textContent, '请按住满 2 秒退出');
    t.mock.timers.tick(2000);
    assert.equal(button.getAttribute('data-holding'), null);
    assert.equal(full.active, true);
  }

  button.emit('keydown', { key: ' ' });
  button.emit('keyup', { key: ' ' });
  t.mock.timers.tick(2000);
  assert.equal(full.active, true);
  button.emit('pointerdown', pointer);
  t.mock.timers.tick(1999);
  assert.equal(full.active, true);
  t.mock.timers.tick(1);
  assert.equal(full.active, false);

  full.open('14:05', '虚构/长期事项');
  button.emit('keydown', { key: 'Enter' });
  t.mock.timers.tick(2000);
  assert.equal(full.active, false);
});

test('T46-2 减弱动态效果显示文字倒数，辅助退出按钮须明确确认', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { document, get } = fixture();
  document.defaultView = { matchMedia: query => ({ matches: query === '(prefers-reduced-motion: reduce)' }) };
  const full = new FocusFullscreen(document, get, {}), hold = get('fullscreen-exit');
  const alternate = get('fullscreen-alt-exit'), confirm = get('fullscreen-exit-confirm'), message = get('fullscreen-exit-message');
  t.after(() => full.destroy());
  full.open('06:00', '虚构事项');
  hold.emit('keydown', { key: ' ' });
  assert.match(message.textContent, /还剩 2 秒/);
  t.mock.timers.tick(1000);
  assert.match(message.textContent, /还剩 1 秒/);
  hold.emit('keyup', { key: ' ' });
  assert.equal(full.active, true);
  assert.match(message.textContent, /请按住满 2 秒退出/);
  t.mock.timers.tick(2500);
  assert.equal(message.textContent, '');

  assert.equal(get('fullscreen-exit-actions').hidden, true);
  alternate.emit('click', { detail: 0 });
  assert.equal(full.active, true);
  assert.equal(get('fullscreen-exit-actions').hidden, false);
  assert.equal(document.activeElement, confirm);
  get('fullscreen-exit-cancel').emit('click');
  assert.equal(full.active, true);
  assert.equal(document.activeElement, alternate);
  alternate.emit('click', { detail: 0 });
  confirm.emit('click', { detail: 0 });
  assert.equal(full.active, false);
  const css = await readFile(new URL('../../app/focus.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.focus-fullscreen-ring\s*\{[^}]*display:\s*none/);
});

test('T46-1 放弃和提前结束三秒内分别确认，超时或执行暂停恢复原文案', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { document, get } = fixture();
  let now = Date.parse('2026-11-03T04:00:00Z');
  const store = new MemoryStore({ ...freshRecord(), state: emptyState(), settings: { joined: true, deviceId: 'phone' } });
  const source = await createDataSource({ store, now: () => now });
  const timer = new FocusTimer({ store, source, now: () => now });
  const view = new FocusView({ document, source, timer, onNotice() {}, armBell() {}, playBell() {} });
  t.after(() => view.destroy());
  await view.entered();
  get('start').emit('click');
  await view.pending;
  assert.equal(get('fullscreen-open').className, 'primary');
  get('abandon').emit('click');
  assert.equal(get('abandon').textContent, '再点一次确认放弃');
  assert.equal(source.snapshot().records.length, 0);
  now += 3000;
  t.mock.timers.tick(3000);
  assert.equal(get('abandon').textContent, '放弃');
  get('abandon').emit('click');
  assert.equal(source.snapshot().records.length, 0);
  get('early').emit('click');
  assert.equal(get('early').textContent, '确认结束');
  assert.equal(get('abandon').textContent, '放弃');
  get('pause').emit('click');
  await view.pending;
  assert.equal(get('resume').className, 'primary');
  assert.equal(get('early').textContent, '提前结束');
  assert.equal(source.snapshot().records.length, 0);
  get('abandon').emit('click');
  get('abandon').emit('click');
  await view.pending;
  assert.equal(source.snapshot().records[0].columns[5], '放弃');

  now += 60000;
  get('start').emit('click');
  await view.pending;
  now += 120000;
  get('early').emit('click');
  assert.equal(source.snapshot().records.length, 1);
  get('early').emit('click');
  await view.pending;
  assert.equal(source.snapshot().records.at(-1).columns[5], '完成');
  const css = await readFile(new URL('../../app/focus.css', import.meta.url), 'utf8');
  assert.match(css, /#focus-fullscreen-open, #focus-abandon\s*\{[^}]*grid-column:\s*1/);
  assert.match(css, /#focus-pause, #focus-early\s*\{[^}]*grid-column:\s*2/);
  assert.match(css, /#focus-abandon, #focus-early\s*\{[^}]*grid-row:\s*2/);
});

test('返回前台重新申请常亮，迟到的旧请求、退出和系统释放都能正确处理', async t => {
  const { document, get } = fixture(), requests = [];
  const full = new FocusFullscreen(document, get, { wakeLock: {
    request(type) {
      assert.equal(type, 'screen');
      return new Promise(resolve => requests.push(resolve));
    }
  } });
  t.after(() => full.destroy());
  full.open('01:00', '虚构事项');
  assert.equal(requests.length, 1);
  document.hidden = true; document.emit('visibilitychange');
  document.hidden = false; document.emit('visibilitychange');
  assert.equal(requests.length, 2);
  const late = new Lock(), current = new Lock();
  requests[0](late); requests[1](current);
  await Promise.resolve();
  assert.equal(late.released, true);
  assert.equal(current.released, false);
  assert.equal(get('fullscreen-wake').hidden, true);
  await current.release();
  assert.match(get('fullscreen-wake').textContent, fallback);
  document.hidden = true; document.emit('visibilitychange');
  document.hidden = false; document.emit('visibilitychange');
  assert.equal(requests.length, 3);
  const next = new Lock();
  requests[2](next);
  await Promise.resolve();
  full.close();
  assert.equal(next.released, true);
});

test('不可用或被拒绝时提示自动锁定，iOS 旧主屏幕模式不误认凭据', async t => {
  const { document, get } = fixture();
  let called = 0;
  const old = new FocusFullscreen(document, get, {
    standalone: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X)',
    wakeLock: { async request() { called++; return new Lock(); } }
  });
  t.after(() => old.destroy());
  old.open('04:00', '虚构事项');
  assert.equal(called, 0);
  assert.match(get('fullscreen-wake').textContent, fallback);
  old.close();

  const safari = new FocusFullscreen(document, get, {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X)',
    wakeLock: { async request() { called++; throw new Error('NotAllowedError'); } }
  });
  t.after(() => safari.destroy());
  safari.open('04:00', '虚构事项');
  await Promise.resolve();
  assert.equal(called, 1);
  assert.equal(get('fullscreen-wake').hidden, false);
  assert.match(get('fullscreen-wake').textContent, fallback);
  safari.close();

  const homeScreen = new FocusFullscreen(document, get, {
    standalone: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)',
    wakeLock: { async request() { called++; return new Lock(); } }
  });
  t.after(() => homeScreen.destroy());
  homeScreen.open('04:00', '虚构事项');
  await Promise.resolve();
  assert.equal(called, 2);
  assert.equal(get('fullscreen-wake').hidden, true);
});

test('全屏期间沿用真实时间，暂停与结束按钮受保护，到点照常记录并显示完成', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { document, get } = fixture();
  let now = Date.parse('2026-11-03T04:00:00Z'), bells = 0;
  const store = new MemoryStore({ ...freshRecord(), state: emptyState(), settings: { joined: true, deviceId: 'phone' } });
  const source = await createDataSource({ store, now: () => now });
  const timer = new FocusTimer({ store, source, now: () => now });
  const view = new FocusView({ document, source, timer, onNotice() {}, armBell() {}, playBell() { bells++; } });
  t.after(() => view.destroy());
  await view.entered();
  await timer.saveMinutes(1, 5);
  get('item').value = '虚构练习';
  get('start').emit('click');
  await view.pending;
  get('fullscreen-open').emit('click');
  assert.equal(get('fullscreen').open, true);
  for (const action of ['pause', 'early', 'abandon']) get(action).emit('click');
  assert.equal(view.pending, null);
  now += 19000;
  t.mock.timers.tick(1000);
  assert.equal(get('fullscreen-time').textContent, '00:41');
  now += 50000;
  t.mock.timers.tick(1000);
  await view.pending;
  assert.equal(get('fullscreen').open, false);
  assert.equal(get('message').textContent, '专注完成');
  assert.equal(get('fullscreen-open').hidden, true);
  assert.equal(document.activeElement, get('rest'));
  assert.equal(source.snapshot().records.length, 1);
  assert.equal(source.snapshot().records[0].columns[2], '2026-11-03 12:01:00');
  assert.equal(bells, 1);
});
