const HOLD_MS = 2000;
const MOVE_PIXELS = 16;
const UNAVAILABLE = '这台手机不能保持常亮，请在 设置→显示与亮度→自动锁定 里调整';

function wakeLockAvailable(navigator) {
  if (typeof navigator?.wakeLock?.request !== 'function') return false;
  // iOS 旧版的主屏幕应用有时会返回锁定凭据，但屏幕仍会熄灭（WebKit 254545）。
  const version = navigator.standalone && /CPU (?:iPhone )?OS (\d+)_(\d+)/.exec(navigator.userAgent);
  if (!version) return true;
  const major = Number(version[1]), minor = Number(version[2]);
  return major > 18 || (major === 18 && minor >= 4);
}

export class FocusFullscreen {
  constructor(document, get, navigator = document.defaultView?.navigator ?? globalThis.navigator) {
    this.document = document;
    this.navigator = navigator;
    this.dialog = get('fullscreen');
    this.button = get('fullscreen-exit');
    this.altExit = get('fullscreen-alt-exit');
    this.exitActions = get('fullscreen-exit-actions');
    this.exitConfirm = get('fullscreen-exit-confirm');
    this.exitCancel = get('fullscreen-exit-cancel');
    this.exitMessage = get('fullscreen-exit-message');
    this.openButton = get('fullscreen-open');
    this.time = get('fullscreen-time');
    this.subject = get('fullscreen-subject');
    this.wakeMessage = get('fullscreen-wake');
    this.arc = get('fullscreen-arc');
    this.head = get('fullscreen-head');
    this.away = get('fullscreen-away');
    this.requestId = 0;
    this.visibilityChanged = () => {
      if (!this.active) return;
      if (document.hidden) {
        this.cancelHold();
        this.releaseWakeLock();
      } else this.requestWakeLock();
    };
    document.addEventListener('visibilitychange', this.visibilityChanged);
    this.dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (!this.exitActions.hidden) this.hideExitConfirmation(true);
    });
    this.altExit.addEventListener('click', () => {
      if (!this.active) return;
      this.cancelHold();
      this.showExitMessage('');
      this.exitActions.hidden = false;
      this.altExit.hidden = true;
      this.exitConfirm.focus();
    });
    this.exitCancel.addEventListener('click', () => this.hideExitConfirmation(true));
    this.exitConfirm.addEventListener('click', () => { if (!this.exitActions.hidden) this.close(); });
    this.button.addEventListener('click', event => event.preventDefault());
    this.button.addEventListener('contextmenu', event => event.preventDefault());
    this.button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      this.beginHold({ pointer: event.pointerId, x: event.clientX, y: event.clientY });
    });
    this.button.addEventListener('pointermove', event => {
      if (this.hold?.pointer === event.pointerId &&
          Math.hypot(event.clientX - this.hold.x, event.clientY - this.hold.y) > MOVE_PIXELS) this.cancelHold();
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'lostpointercapture']) {
      this.button.addEventListener(type, event => {
        if (this.hold?.pointer === event.pointerId) this.cancelHold(type === 'pointerup');
      });
    }
    this.button.addEventListener('keydown', event => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (!event.repeat) this.beginHold({ key: event.key });
    });
    this.button.addEventListener('keyup', event => {
      if (this.hold?.key === event.key) this.cancelHold(true);
    });
    this.button.addEventListener('blur', () => this.cancelHold());
  }

  get active() { return this.dialog.open; }

  // fraction：剩余占整轮的比例（1 → 0），圆环随之变短；away：本轮离开过的说明。
  update(clock, subject, fraction = 1, away = '') {
    const left = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 1));
    // 页面的安全策略（CSP style-src 'self'）不允许写 style 属性，只能经 CSSOM 设置。
    this.arc?.style?.setProperty('stroke-dashoffset', (1000 * (1 - left)).toFixed(1));
    this.head?.style?.setProperty('transform', 'rotate(' + (360 * left).toFixed(2) + 'deg)');
    if (this.away && this.away.textContent !== away) { this.away.textContent = away; this.away.hidden = !away; }
    this.time.textContent = clock;
    const [minutes, seconds] = clock.split(':').map(Number);
    this.time.setAttribute('aria-label', '剩余 ' + minutes + ' 分 ' + seconds + ' 秒');
    if (this.subject.textContent !== subject) this.subject.textContent = subject;
  }

  open(clock, subject, fraction = 1, away = '') {
    if (this.active) return;
    this.dialog.removeAttribute('data-animate');
    this.update(clock, subject, fraction, away);
    this.dialog.showModal();
    // 先画到当前位置再打开过渡，避免打开时圆环从满圈转过来。
    clearTimeout(this.animateTimer);
    this.animateTimer = setTimeout(() => { if (this.active) this.dialog.setAttribute('data-animate', ''); }, 100);
    this.time.focus({ preventScroll: true });
    this.requestWakeLock();
  }

  close() {
    if (!this.active) return;
    clearTimeout(this.animateTimer);
    this.cancelHold();
    this.showExitMessage('');
    this.hideExitConfirmation();
    this.releaseWakeLock();
    this.dialog.close();
    if (!this.openButton.hidden && !this.openButton.disabled) this.openButton.focus({ preventScroll: true });
  }

  destroy() {
    this.close();
    this.document.removeEventListener?.('visibilitychange', this.visibilityChanged);
  }

  beginHold(hold) {
    if (!this.active || this.document.hidden || this.hold) return;
    this.hideExitConfirmation();
    this.showExitMessage('');
    this.hold = hold;
    this.button.setAttribute('data-holding', '');
    if (this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      this.showExitMessage('按住中…还剩 2 秒');
      this.countdownTimer = setTimeout(() => this.showExitMessage('按住中…还剩 1 秒'), HOLD_MS / 2);
    }
    this.holdTimer = setTimeout(() => {
      if (!this.document.hidden) this.close();
      else this.cancelHold();
    }, HOLD_MS);
  }

  cancelHold(shortPress = false) {
    if (!this.hold) return;
    clearTimeout(this.holdTimer);
    clearTimeout(this.countdownTimer);
    this.hold = null;
    this.button.removeAttribute('data-holding');
    this.showExitMessage(shortPress ? '请按住满 2 秒退出' : '');
    if (shortPress) this.hintTimer = setTimeout(() => this.showExitMessage(''), 2500);
  }

  showExitMessage(message) {
    clearTimeout(this.hintTimer);
    this.exitMessage.textContent = message;
  }

  hideExitConfirmation(returnFocus = false) {
    this.exitActions.hidden = true;
    this.altExit.hidden = false;
    if (returnFocus) this.altExit.focus();
  }

  showWakeMessage(message) {
    this.wakeMessage.textContent = message;
    this.wakeMessage.hidden = !message;
  }

  async requestWakeLock() {
    if (!this.active || this.document.hidden || this.lock || this.requesting) return;
    if (!wakeLockAvailable(this.navigator)) { this.showWakeMessage(UNAVAILABLE); return; }
    this.showWakeMessage('');
    const id = ++this.requestId;
    this.requesting = true;
    try {
      const lock = await this.navigator.wakeLock.request('screen');
      if (id !== this.requestId) { await lock.release(); return; }
      if (lock.released) { this.showWakeMessage(UNAVAILABLE); return; }
      this.lock = lock;
      lock.addEventListener('release', () => {
        if (this.lock !== lock) return;
        this.lock = null;
        if (this.active && !this.document.hidden) this.showWakeMessage(UNAVAILABLE);
      }, { once: true });
    } catch {
      if (id === this.requestId) this.showWakeMessage(UNAVAILABLE);
    } finally {
      if (id === this.requestId) this.requesting = false;
    }
  }

  releaseWakeLock() {
    ++this.requestId;
    this.requesting = false;
    const lock = this.lock;
    this.lock = null;
    if (lock) lock.release().catch(() => {});
  }
}
