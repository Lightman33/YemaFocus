// 最小 DOM 事件模拟；不宣称覆盖真实浏览器排版、焦点或 IndexedDB。
export class ElementDouble {
  constructor(id = '', tag = 'div', ownerDocument = null) {
    this.id = id; this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument;
    this.handlers = new Map(); this.attributes = new Map(); this.children = []; this.parentNode = null;
    this.value = ''; this._text = ''; this.disabled = false; this.hidden = false; this.scrollTop = 0;
    this.dataset = {}; this.className = ''; this.open = false; this.tabIndex = 0;
  }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : this.tagName === '#DOCUMENT'; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(text) { this._text = String(text); this.replaceChildren(); }
  addEventListener(name, handler) { if (!this.handlers.has(name)) this.handlers.set(name, []); this.handlers.get(name).push(handler); }
  emit(name, values = {}) {
    const event = { target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values };
    for (const handler of this.handlers.get(name) || []) handler(event);
    return event;
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'type') this.type = String(value);
    if (key === 'tabindex') this.tabIndex = +value;
    if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
    if (key === 'disabled') this.disabled = true;
    if (key === 'hidden') this.hidden = true;
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  append(...nodes) {
    for (const node of nodes) { if (node.parentNode) node.remove(); this.children.push(node); node.parentNode = this; }
  }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
  remove() { if (!this.parentNode) return; const parent = this.parentNode; parent.children = parent.children.filter(c => c !== this); this.parentNode = null; }
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
  focus() {
    if (this.disabled) return;
    this.focused = true;
    const doc = this.ownerDocument;
    if (doc && doc.activeElement !== this) { const old = doc.activeElement; doc.activeElement = this; old?.emit('blur'); this.emit('focus'); }
  }
  blur() { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null; this.emit('blur'); }
  showModal() { this.open = true; this.querySelector('button')?.focus(); }
  close() { this.open = false; this.emit('close'); }
  scrollIntoView(options) { this.scrolledIntoView = options; }
  matches(query) {
    if (query.startsWith('#')) return this.id === query.slice(1);
    if (query.startsWith('.')) return this.className.split(/\s+/).includes(query.slice(1));
    if (query.startsWith('[')) {
      const match = /^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/.exec(query);
      return Boolean(match && this.attributes.has(match[1]) && (match[2] === undefined || this.attributes.get(match[1]) === match[2]));
    }
    return this.tagName.toLowerCase() === query;
  }
  querySelectorAll(query) {
    const choices = query.split(',').map(s => s.trim()), found = [];
    const walk = node => { for (const child of node.children) { if (choices.some(q => child.matches(q))) found.push(child); walk(child); } };
    walk(this); return found;
  }
  querySelector(query) { return this.querySelectorAll(query)[0] || null; }
}
export function parseDocument(html) {
  const document = new ElementDouble('', '#document'); document.ownerDocument = document;
  document.createElement = tag => new ElementDouble('', tag, document);
  document.getElementById = id => document.querySelector('#' + id);
  document.activeElement = null;
  const stack = [document], voids = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1)._text += token.trim(); continue; }
    const match = /^<([\w-]+)([^>]*)>/.exec(token); if (!match) continue;
    const node = document.createElement(match[1]);
    for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '');
    stack.at(-1).append(node); if (!voids.has(match[1])) stack.push(node);
  }
  return document;
}
export async function until(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('DOM 模拟没有到达预期状态');
}
