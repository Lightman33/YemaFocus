import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freshRecord } from '../../app/store.js';
import { ElementDouble, parseDocument } from '../tasks/dom-double.js';
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
export function browserDouble(initial = freshRecord(), { noStorage = false, serviceWorker = false, hash = '' } = {}) {
  // 只模拟 DOM 事件与事务，不模拟 Safari 渲染、真实 IndexedDB 或 PWA 安装。
  const document = parseDocument(html);
  const nodes = new Map(document.querySelectorAll('[id]').map(node => [node.id, node]));
  const tabs = ['tasks', 'review', 'settings'].map(page => { const tab = new ElementDouble(); tab.dataset.page = page; return tab; });
  const skip = new ElementDouble();
  const settingsControls = ['owner', 'repo', 'token', 'device-name', 'toggle-token', 'save-settings', 'test-connection', 'sync-now'].map(id => nodes.get(id));
  nodes.get('settings-form').querySelectorAll = () => settingsControls;
  nodes.get('settings-form').reportValidity = () => ['owner', 'repo', 'token', 'device-name'].every(id => nodes.get(id).value.trim());
  const staticNode = id => nodes.get(id);
  document.getElementById = id => staticNode(id) || queryAll('#' + id)[0];
  const queryAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = query => query === '[data-page]' ? tabs : queryAll(query);
  const query = document.querySelector.bind(document);
  document.querySelector = selector => selector === '.skip' ? skip : query(selector);
  const window = new ElementDouble();
  const removeListener = function(name, fn) { this.handlers.set(name, (this.handlers.get(name) || []).filter(f => f !== fn)); };
  for (const node of [document, window, ...nodes.values()]) node.removeEventListener = removeListener;
  const location = { hash, reloaded: 0, reload() { this.reloaded++; } };
  const history = { scrollRestoration: 'auto', replaceState(_state, _unused, hash) { location.hash = hash; } };
  let rows = new Map([['root', structuredClone(initial)]]);
  let transactionQueue = Promise.resolve();
  const database = {
    objectStoreNames: { contains: () => true }, close() {},
    transaction(_name, mode) {
      const requests = []; let draft, aborted = false;
      const transaction = {
        objectStore: () => ({
          get(key) { const request = {}; requests.push(() => { request.result = structuredClone(draft.get(key)); request.onsuccess(); }); return request; },
          put(value, key) { const copy = structuredClone(value); requests.push(() => draft.set(key, copy)); },
          delete(key) { requests.push(() => draft.delete(key)); }
        }), abort: () => { aborted = true; }
      };
      transactionQueue = transactionQueue.then(async () => {
        draft = new Map(rows);
        while (requests.length && !aborted) requests.shift()();
        await new Promise(resolve => setImmediate(resolve));
        if (aborted) transaction.onabort();
        else { if (mode === 'readwrite') rows = draft; transaction.oncomplete(); }
      });
      return transaction;
    }
  };
  function currentRecord() {
    if (rows.has('root')) return structuredClone(rows.get('root'));
    const meta = structuredClone(rows.get('meta')), record = meta.record;
    const state = record.state?.format === 'yema-engine-local' ? record.state.state : record.state;
    if (state?.units) for (const name of meta.buckets) Object.assign(state.units, structuredClone(rows.get('bucket:' + name)));
    record.pendingSnapshots = record.pendingSnapshots.map(entry => Object.hasOwn(entry, 'localItem') ? structuredClone(rows.get('pending:' + entry.localItem)) : {
      ...entry, manifest: { ...entry.manifest, text: rows.get('pending:' + entry.manifest.path) }, chunks: entry.chunks.map(c => ({ ...c, text: rows.get('pending:' + c.path) }))
    });
    return record;
  }
  const openedNames = [];
  const indexedDB = { open(name) { openedNames.push(name); const request = {}; queueMicrotask(() => { request.result = database; request.onsuccess(); }); return request; } };
  const requests = [];
  let nextStatus = 200;
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (nextStatus !== 200) { const status = nextStatus; nextStatus = 200; return new Response(JSON.stringify({ message: 'fake-test-token' }), { status }); }
    if (url.includes('/contents/yema-sync/')) return new Response('{}', { status: 404 });
    const data = url.endsWith('/contents/yema-sync') ? [{ type: 'file', name: 'fictional.json', sha: '1'.repeat(40), size: 8 }]
      : url.endsWith('/contents/') ? [] : { private: true };
    return new Response(JSON.stringify(data));
  };
  const navigator = { onLine: true, storage: { persisted: async () => false, persist: async () => true } };
  let messages = [];
  let registration;
  if (serviceWorker) {
    registration = new ElementDouble();
    registration.waiting = { postMessage: message => messages.push(message) };
    registration.update = async () => {};
    navigator.serviceWorker = new ElementDouble();
    navigator.serviceWorker.controller = {};
    navigator.serviceWorker.register = async (path, options) => {
      assert.equal(path, './sw.js'); assert.equal(options.scope, './'); return registration;
    };
    navigator.serviceWorker.ready = Promise.resolve(registration);
  }
  return {
    globals: { window, document, location, history, navigator, indexedDB: noStorage ? undefined : indexedDB, fetch: fetcher },
    node: id => nodes.get(id), window, location, navigator, tabs, skip, requests, openedNames,
    record: currentRecord, setStatus: status => { nextStatus = status; }, messages
  };
}

export function globalsFor(t, values) {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}
export async function until(condition) {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('界面模拟的预期状态没有出现');
}
let instance = 0;
export const start = async () => import('../../app/app.js?dom-double=' + (++instance));

