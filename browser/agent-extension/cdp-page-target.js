
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEB_STORE_RE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i;
export const drivable = (u) => !!u && (u === 'about:blank' ||
  (!/^(chrome[-a-z]*|devtools|edge[-a-z]*|about|view-source|data|blob|javascript):/i.test(u) && !WEB_STORE_RE.test(u)));

const SESSION_GONE_RE = /not attached|no tab with (given )?id|target closed|detached|cannot access|cannot attach/i;
const ATTACH_FALLBACK_RE = /chrome:\/\/|chrome-extension:\/\/|cannot access|cannot attach|another debugger|no tab with/i;

const MOD_BITS = { alt: 1, control: 2, meta: 4, shift: 8 };

const NAMED_KEYS = {
  Enter:      { code: 'Enter',      keyCode: 13, text: '\r' },
  Tab:        { code: 'Tab',        keyCode: 9 },
  Escape:     { code: 'Escape',     keyCode: 27 },
  Backspace:  { code: 'Backspace',  keyCode: 8 },
  Delete:     { code: 'Delete',     keyCode: 46 },
  Insert:     { code: 'Insert',     keyCode: 45 },
  Space:      { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft:  { code: 'ArrowLeft',  keyCode: 37 },
  ArrowUp:    { code: 'ArrowUp',    keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown:  { code: 'ArrowDown',  keyCode: 40 },
  PageUp:     { code: 'PageUp',     keyCode: 33 },
  PageDown:   { code: 'PageDown',   keyCode: 34 },
  Home:       { code: 'Home',       keyCode: 36 },
  End:        { code: 'End',        keyCode: 35 }
};
for (let i = 1; i <= 12; i++) NAMED_KEYS['F' + i] = { code: 'F' + i, keyCode: 111 + i };

const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

const PUNCT_CODES = {
  ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
  '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period',
  '/': 'Slash', '`': 'Backquote'
};

export function keyEventSpec(key, modifiers = [], { mac = false } = {}) {
  let mods = new Set(modifiers.map((m) => String(m).toLowerCase()));
  const lower = typeof key === 'string' && key.length === 1 ? key.toLowerCase() : null;
  if (mac && lower && MAC_COMMANDS[lower] && mods.has('control') && !mods.has('meta')) {
    mods.delete('control');
    mods.add('meta');
  }
  const bits = [...mods].reduce((b, m) => b | (MOD_BITS[m] || 0), 0);
  const shortcut = mods.has('control') || mods.has('meta') || mods.has('alt');

  let spec;
  if (NAMED_KEYS[key]) {
    spec = { key, ...NAMED_KEYS[key] };
  } else if (lower && /[a-z]/.test(lower)) {
    const upper = lower.toUpperCase();
    const shown = mods.has('shift') ? upper : (key === upper && !shortcut ? upper : lower);
    spec = { key: shown, code: 'Key' + upper, keyCode: upper.charCodeAt(0), text: shown };
  } else if (lower && /[0-9]/.test(lower)) {
    spec = { key, code: 'Digit' + key, keyCode: key.charCodeAt(0), text: key };
  } else if (lower) {
    spec = { key, code: PUNCT_CODES[key] || '', keyCode: 0, text: key };
  } else {
    spec = { key: String(key), code: String(key), keyCode: 0 };
  }

  const text = shortcut && spec.key !== 'Enter' ? undefined : spec.text;
  const commands = [];
  if (mac && lower && mods.has('meta')) {
    if (lower === 'z' && mods.has('shift')) commands.push('redo');
    else if (MAC_COMMANDS[lower]) commands.push(MAC_COMMANDS[lower]);
  }
  const base = {
    modifiers: bits, key: spec.key, code: spec.code,
    windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode
  };
  const down = { type: text ? 'keyDown' : 'rawKeyDown', ...base };
  if (text) { down.text = text; down.unmodifiedText = text; }
  if (commands.length) down.commands = commands;
  return { down, up: { type: 'keyUp', ...base } };
}

export function imageSize(base64) {
  let bytes;
  try {
    const bin = atob(String(base64 || '').slice(0, 80000));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch (_) { return null; }
  const u16 = (i) => (bytes[i] << 8) | bytes[i + 1];
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24) {
    const u32 = (i) => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
    return { width: u32(16), height: u32(20) };
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { width: u16(i + 7), height: u16(i + 5) };
      }
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

async function rememberedWorkTab() {
  const { workTabId } = await chrome.storage.session.get(['workTabId']);
  if (workTabId == null) return null;
  try {
    return await chrome.tabs.get(workTabId);
  } catch (_) {
    await chrome.storage.session.remove('workTabId');
    return null;
  }
}

async function openWorkTab(existing) {
  const tab = existing || await chrome.tabs.create({ url: 'about:blank', active: true });
  await chrome.storage.session.set({ workTabId: tab.id });
  return tab;
}

async function activate(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  return tabId;
}

async function pickTab({ fresh = false } = {}) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && drivable(active.url)) return active.id;

  if (fresh) return (await openWorkTab()).id;

  const mine = await rememberedWorkTab();
  if (mine && drivable(mine.url)) return activate(mine.id);

  const others = await chrome.tabs.query({ currentWindow: true });
  const usable = others.find((t) => drivable(t.url));
  if (usable) return activate(usable.id);

  if (mine) return activate(mine.id);
  const tab = await openWorkTab(others.find((x) => x.url === 'about:blank'));
  return activate(tab.id);
}

const detectMac = () => {
  const nav = globalThis.navigator || {};
  return /mac/i.test((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '');
};

const DEEP_ACTIVE = `(() => {
  let a = document.activeElement;
  for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 12; i++) a = a.shadowRoot.activeElement;
  return a;
})()`;

export class CdpPageTarget {
  constructor({ logger, getTabId, mac = detectMac() } = {}) {
    this.logger = logger || console;
    this._getTabId = getTabId || pickTab;
    this.mac = mac;
    this.tabId = null;
    this._attached = false;
    this.detachReason = null;
    this._onDetach = (source, reason) => {
      if (source.tabId !== this.tabId) return;
      this._attached = false;
      this.detachReason = reason || 'detached';
      this.logger.warn(`[PageTarget] debugger detached from tab ${source.tabId} (${this.detachReason})`);
    };
    chrome.debugger?.onDetach?.addListener(this._onDetach);
  }

  static sigKey(sig) {
    if (!sig) return 'none';
    return [sig.url, sig.title, sig.nodes, sig.textHash, sig.textLen, sig.scrollY,
            sig.vw, sig.vh].join('|');
  }

  async send(method, params = {}) {
    if (!this._attached) throw new Error('debugger not attached');
    try {
      return await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
    } catch (err) {
      const message = (err && err.message) || String(err);
      if (SESSION_GONE_RE.test(message)) {
        this._attached = false;
        this.detachReason = this.detachReason || 'target_closed';
      }
      throw err instanceof Error ? err : new Error(message);
    }
  }

  isAlive() {
    return this._attached && this.tabId != null;
  }

  cancelledByUser() {
    return !this._attached && this.detachReason === 'canceled_by_user';
  }

  async resolve({ force = false, fresh = false } = {}) {
    if (!force && this.isAlive()) return this.tabId;
    const id = await this._getTabId({ fresh });
    if (id == null) { this.logger.error('[PageTarget] no tab to drive'); return null; }
    if (this._attached && this.tabId !== id) await this.detach();
    if (!this._attached) {
      try {
        await this._attach(id);
      } catch (err) {
        if (!ATTACH_FALLBACK_RE.test(err.message || '')) throw err;
        this.logger.warn(`[PageTarget] ${err.message} - opening a fresh tab`);
        const tab = await openWorkTab();
        await this._attach(tab.id);
      }
    }
    await this.refreshInfo();
    return this.tabId;
  }

  async useTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl || '';
    if (url && !drivable(url)) throw new Error(`That tab shows ${url.slice(0, 60)}, which the agent cannot control`);
    if (this._attached && this.tabId === tabId) return tabId;
    await this.detach();
    await this._attach(tabId);
    await this.refreshInfo();
    return tabId;
  }

  async _attach(tabId) {
    await chrome.debugger.attach({ tabId }, '1.3');
    this._attached = true;
    this.tabId = tabId;
    this.detachReason = null;
    this._url = ''; this._title = '';
    await this.send('Page.enable');
    await this._suppressBrowserPrompts();
    this.logger.info(`[PageTarget] attached to tab ${tabId}`);
  }

  async detach() {
    if (!this._attached) return;
    this._attached = false;
    try { await chrome.debugger.detach({ tabId: this.tabId }); } catch (_) {}
  }

  async ensureDisplayed() {
    if (this.tabId == null) return;
    try { await chrome.tabs.update(this.tabId, { active: true }); } catch (_) {}
  }

  async _suppressBrowserPrompts() {
    for (const name of ['geolocation', 'notifications', 'camera', 'microphone', 'midi', 'clipboardReadWrite']) {
      await this.send('Browser.setPermission', { permission: { name }, setting: 'denied' }).catch(() => {});
    }

    if (!CdpPageTarget._dialogHook) {
      CdpPageTarget._dialogHook = (source, method, params) => {
        if (method !== 'Page.javascriptDialogOpening') return;
        chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog',
          { accept: params.type !== 'beforeunload', promptText: '' }).catch(() => {});
      };
      chrome.debugger.onEvent.addListener(CdpPageTarget._dialogHook);
    }
  }

  async executeJS(code, { timeout = 8000 } = {}) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('executeJS timed out')), timeout);
    });
    let res;
    try {
      res = await Promise.race([
        this.send('Runtime.evaluate', {
          expression: code, returnByValue: true, awaitPromise: true, userGesture: true
        }),
        deadline
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (res && res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'evaluate threw');
    }
    return res && res.result ? res.result.value : undefined;
  }

  getURL()   { return this._url || ''; }
  getTitle() { return this._title || ''; }

  async refreshInfo() {
    if (this.tabId == null) return;
    try {
      const tab = await chrome.tabs.get(this.tabId);
      this._url = tab.url || tab.pendingUrl || '';
      this._title = tab.title || '';
    } catch (_) {}
  }

  async signature() {
    await this.refreshInfo();
    if (!this._attached) return null;
    return await this.executeJS(`(() => {
      const t = (document.body && document.body.innerText || '');
      let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
      const ours = document.querySelectorAll('[data-grol-overlay], [data-grol-overlay] *').length;
      return { url: location.href, title: document.title,
               nodes: document.querySelectorAll('*').length - ours,
               textHash: h, textLen: t.length,
               scrollY: Math.round(window.scrollY || 0),
               vw: window.innerWidth, vh: window.innerHeight,
               ready: document.readyState };
    })()`).catch(() => null);
  }

  async metrics() {
    return await this.executeJS(
      `({ w: window.innerWidth, h: window.innerHeight, y: Math.round(window.scrollY||0), dpr: window.devicePixelRatio || 1 })`
    ).catch(() => null);
  }

  async waitForSettle({ timeout = 15000, quietMs = 350, pollMs = 200, softCapMs = 2500 } = {}) {
    const started = Date.now();
    let last = null, quietSince = 0;
    const close = (a, b, floor, pct) => Math.abs(a - b) <= Math.max(floor, Math.max(a, b) * pct);
    const same = (a, b) => a && b && a.url === b.url && a.title === b.title && a.ready === b.ready &&
      close(a.nodes, b.nodes, 25, 0.02) && close(a.textLen, b.textLen, 60, 0.02);
    while (Date.now() - started < timeout) {
      if (!this._attached) return { signature: last, detached: true };
      const sig = await this.signature();
      if (sig && sig.ready !== 'loading') {
        if (same(sig, last)) {
          if (!quietSince) quietSince = Date.now();
          if (Date.now() - quietSince >= quietMs) return { signature: sig };
        } else {
          quietSince = 0;
        }
        if (sig.ready === 'complete' && Date.now() - started >= softCapMs) {
          return { signature: sig, soft: true };
        }
      }
      last = sig;
      await sleep(pollMs);
    }
    return { signature: last, timedOut: true };
  }

  async capture({ format = 'jpeg', quality = 82, timeout = 10000 } = {}) {
    let timer;
    const params = { format, captureBeyondViewport: false };
    if (format === 'jpeg') params.quality = quality;
    const shot = await Promise.race([
      this.send('Page.captureScreenshot', params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('screenshot timed out')), timeout); })
    ]).finally(() => clearTimeout(timer));
    const m = await this.metrics();
    const dpr = (m && Number(m.dpr)) || 1;
    const cssW = m ? m.w : null;
    const cssH = m ? m.h : null;
    const real = imageSize(shot.data);
    const imgW = (real && real.width) || (cssW ? Math.round(cssW * dpr) : null);
    const imgH = (real && real.height) || (cssH ? Math.round(cssH * dpr) : null);
    return {
      dataUrl: `data:image/${format};base64,${shot.data}`,
      mimeType: `image/${format}`,
      cssWidth: cssW,
      cssHeight: cssH,
      imageWidth: imgW,
      imageHeight: imgH,
      bytes: Math.round((shot.data || '').length * 3 / 4),
      scaleX: cssW && imgW ? cssW / imgW : 1 / dpr,
      scaleY: cssH && imgH ? cssH / imgH : 1 / dpr
    };
  }

  async click(x, y, { clickCount = 1 } = {}) {
    const at = { x: Math.round(x), y: Math.round(y) };
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return { success: false, error: 'invalid click position' };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount });
    return { success: true };
  }

  async drag(x0, y0, x1, y1, { steps = 14, stepMs = 16 } = {}) {
    const pt = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt(x0, y0), button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pt(x0, y0), button: 'left', buttons: 1, clickCount: 1 });
    try {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', ...pt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t), button: 'left', buttons: 1
        });
        await sleep(stepMs);
      }
    } finally {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt(x1, y1), button: 'left', buttons: 0, clickCount: 1 })
        .catch(() => {});
    }
    return { success: true };
  }

  async wheel(x, y, deltaX, deltaY) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
      deltaX: Math.round(deltaX), deltaY: Math.round(deltaY)
    });
    return { success: true };
  }

  async pressKey(key, modifiers = []) {
    const { down, up } = keyEventSpec(key, modifiers, { mac: this.mac });
    await this.send('Input.dispatchKeyEvent', down);
    await this.send('Input.dispatchKeyEvent', up);
    return { success: true };
  }

  async typeText(text) {
    const s = String(text ?? '');
    if (s) await this.send('Input.insertText', { text: s });
    return { success: true, typed: s.length };
  }

  async clearField() {
    const cleared = await this.executeJS(`(() => {
      const a = ${DEEP_ACTIVE};
      if (!a || a === document.body || a === document.documentElement) return false;
      if (a.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(a);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        if (!document.execCommand('delete') || a.innerText.trim()) a.textContent = '';
        a.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      if (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA') return false;
      const proto = a.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(a, ''); else a.value = '';
      a.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`).catch(() => false);
    return { success: cleared === true };
  }

  async reviveTab(url) {
    const old = this.tabId;
    if (old == null) return { success: false };
    const answers = () => this.executeJS('1', { timeout: 4000 }).then(() => true, () => false);
    try {
      await chrome.tabs.reload(old);
      await this.waitForSettle({ timeout: 12000 });
      if (await answers()) return { success: true, via: 'reload' };
    } catch (_) {}
    if (!drivable(url)) return { success: false };
    try {
      const tab = await chrome.tabs.create({ url, active: true });
      await this.useTab(tab.id);
      await this.waitForSettle({ timeout: 15000 });
      chrome.tabs.discard?.(old)?.catch?.(() => {});
      return { success: await answers(), via: 'new tab' };
    } catch (_) {
      return { success: false };
    }
  }

  async loadURL(url) {
    if (!drivable(url)) return { success: false, error: `The agent cannot open ${String(url).slice(0, 80)}` };
    const token = 'n' + Math.random().toString(36).slice(2);
    await this.executeJS(`window.__grolNavToken = ${JSON.stringify(token)}`, { timeout: 1500 }).catch(() => null);
    const nav = await this.send('Page.navigate', { url });
    if (nav && nav.errorText) {
      await this.refreshInfo();
      return { success: false, error: `Could not open ${url}: ${nav.errorText}` };
    }
    for (let i = 0; nav && nav.loaderId && i < 40; i++) {
      const old = await this.executeJS(`window.__grolNavToken === ${JSON.stringify(token)}`, { timeout: 1500 }).catch(() => null);
      if (old === false) break;
      await sleep(100);
    }
    await this.waitForSettle({ timeout: 20000 });
    await this.refreshInfo();
    return { success: true };
  }

  async goBack() {
    const h = await this.send('Page.getNavigationHistory');
    if (!h || h.currentIndex <= 0) {
      return { success: false, error: 'There is no previous page to go back to' };
    }
    await this.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
    await this.waitForSettle({ timeout: 20000 });
    return { success: true };
  }
}
