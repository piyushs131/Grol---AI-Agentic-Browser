// Carries out one planner action on the page: resolves where to aim, moves the
// visible cursor, dispatches real input, and falls back to the DOM helpers in
// page-scripts.js when real input does not land.

import { CdpPageTarget } from './cdp-page-target.js';
import { SOM_SCRIPT, CURSOR_SCRIPT } from './page-scripts.js';
import { matchMarksByText, parseKeyChord, normalizeNavUrl, valueMatches } from './vision-helpers.js';

const arg = JSON.stringify;
const sigKey = CdpPageTarget.sigKey;
const POST_ACTION_SETTLE_MS = 12000;

// Target calls made after an action was cancelled (deadline passed, task
// stopped) throw instead of acting on a page the loop has moved on from.
function cancellable(target, isCancelled) {
  return new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (isCancelled()) return Promise.reject(new Error('action cancelled'));
        return value.apply(obj, args);
      };
    }
  });
}

export class ActionExecutor {
  constructor({ target, logger, run }) {
    this.target = target;
    this.logger = logger;
    this.run = run;
  }

  // Starts an action; cancel() stops it touching the page any further.
  start(action, view) {
    const token = { cancelled: false };
    const scoped = Object.create(this);
    scoped.target = cancellable(this.target, () => token.cancelled || this.run.aborted);
    return {
      promise: scoped._execute(action, view),
      cancel: () => { token.cancelled = true; }
    };
  }

  sleep(ms) { return this.run.sleep(ms); }

  async _execute(action, view) {
    try {
      switch (action.action) {
        case 'navigate': {
          const url = normalizeNavUrl(action.url);
          if (!url) return { success: false, error: `"${String(action.url).slice(0, 80)}" is not a web address the agent can open` };
          return await this.target.loadURL(url);
        }
        case 'back': return await this.target.goBack();
        case 'click_text': return await this._clickText(action, view);
        case 'click': return await this._click(action, view);
        case 'select_option': return await this._selectOption(action);
        case 'type': return await this._type(action, view);
        case 'set_range': return await this._setRange(action);
        case 'scroll': return await this._scroll(action.direction, action.amount, view);
        case 'key': {
          const { key, modifiers } = parseKeyChord(action.key);
          return await this.target.pressKey(key, modifiers);
        }

        case 'find_text': {
          const res = await this._som(`findText(${arg(String(action.text ?? ''))})`);
          if (res && res.found) return { success: true, scrolledTo: action.text };
          return { success: false, error: `"${action.text}" is not on this page` };
        }

        case 'wait': {
          const ms = Math.min(8000, Math.max(0, Number(action.ms) || 1000));
          await this.sleep(ms);
          return { success: true, waited: ms };
        }

        case 'remember': {
          const note = String(action.note || '').trim();
          if (!note) return { success: false, error: 'remember needs a note' };
          const notes = this.run.task.notes;
          if (!notes.includes(note)) notes.push(note);
          if (notes.length > 40) notes.shift();
          this.logger?.info('[Agent] noted: ' + note.slice(0, 140));
          return { success: true, remembered: note.length };
        }

        case 'open_tab': {
          const url = normalizeNavUrl(action.url);
          if (!url) return { success: false, error: `"${String(action.url).slice(0, 80)}" is not a web address the agent can open` };
          const res = await this._openTab(url);
          if (res.success) return res;
          this.logger?.warn('[Agent] could not open a tab - navigating in place instead: ' + res.error);
          return await this.target.loadURL(url);
        }

        case 'switch_tab': return await this._switchTab(action.index);

        default:
          return { success: false, error: 'Unsupported action: ' + action.action };
      }
    } catch (err) {
      this.logger?.error('[Agent] execute failed: ' + err.message);
      return { success: false, error: err.message };
    }
  }

  // Call a window.__grolSoM helper in the page; `fallback` if missing or failing.
  _som(call, fallback = null) {
    return this.target
      .executeJS(`window.__grolSoM ? window.__grolSoM.${call} : ${arg(fallback)}`)
      .catch(() => fallback);
  }

  // Activate an element through the DOM; the result only if it succeeded.
  async _domActivate(call) {
    const forced = await this._som(call);
    return forced && forced.success ? forced : null;
  }

  // Pointer click; if the page does not change and the click never reached
  // the intended control, retry via the DOM. Covers clicks on the dead centre
  // of a wrapper whose handler sits on an inner control. A click that did
  // arrive is never repeated, even if nothing visible changed.
  async _clickOrActivate(x, y, domCall, reachCall) {
    if (domCall) await this._som('armClick()');
    const before = sigKey(await this.target.signature());
    const res = await this.target.click(x, y);
    if (!domCall || !res.success) return { res, forced: null };
    await this.sleep(450);
    if (sigKey(await this.target.signature()) !== before) return { res, forced: null };
    if (await this._som(reachCall, true) !== false) return { res, forced: null };
    return { res, forced: await this._domActivate(domCall) };
  }

  // Where to aim, in CSS pixels. Marks resolve live; pixel coordinates from
  // the model are image pixels and are scaled by the shot's CSS/image ratio.
  async resolveTarget(action, view) {
    if (typeof action.mark === 'number') {
      const max = (view.marks || []).length;
      if (!Number.isInteger(action.mark) || action.mark < 1 || action.mark > max) {
        throw new Error(
          `There is no element [${action.mark}] on this page. ` +
          `Valid numbers are 1 to ${max}. Pick one from the numbered list, ` +
          `or use click_text with the button's visible label.`
        );
      }
      // Live rect at action time; the cached one only if the node is gone
      // from the same document (a re-render), never after a navigation.
      const resolved = await this._som(`resolveMark(${action.mark})`);
      if (resolved && Number.isFinite(resolved.x) && Number.isFinite(resolved.y)) {
        return { x: resolved.x, y: resolved.y, via: 'mark ' + action.mark, meta: resolved };
      }
      const docId = await this._som('docId');
      if (!view.docId || docId !== view.docId) {
        throw new Error('The page changed since the screenshot, so element numbers no longer apply. Look again.');
      }
      this.logger?.warn(`[Agent] mark ${action.mark} no longer resolvable - using its last position`);
      const listed = (view.marks || []).find((m) => m.mark === action.mark);
      if (listed) return { x: listed.x, y: listed.y, via: 'mark ' + action.mark + ' (cached)', meta: listed };
    }

    if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
      if (action.x < 0 || action.y < 0) return null;
      const x = Math.round(action.x * (view.shot?.scaleX ?? 1));
      const y = Math.round(action.y * (view.shot?.scaleY ?? 1));
      const w = view.shot?.cssWidth ?? view.viewport?.w ?? Infinity;
      const h = view.shot?.cssHeight ?? view.viewport?.h ?? Infinity;
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      return { x, y, via: `pixel ${action.x},${action.y}`, meta: null };
    }

    return null;
  }

  async pointAt(x, y) {
    try {
      await this.target.executeJS(CURSOR_SCRIPT, { timeout: 3000 });
      const glide = await this.target.executeJS(`window.__grolCursor.moveTo(${x}, ${y}, 380)`, { timeout: 2000 });
      // moveTo returns immediately (CSS transition); wait out the glide so the
      // user sees the cursor travel before the click lands.
      await this.sleep(glide && glide.duration ? glide.duration : 380);
      await this.target.executeJS('window.__grolCursor.pulse()', { timeout: 2000 });
    } catch (err) {
      this.logger?.warn('[Agent] cursor animation skipped: ' + err.message);
    }
  }

  async _clickText(action, view) {
    // Several controls can share the label ("Add to cart" on every result).
    // Picking one by geometry looks deliberate and is arbitrary, so refuse and
    // list the candidates for the next turn to name a mark.
    const rivals = matchMarksByText(view.marks, action.text);
    if (rivals.length > 1) {
      const opts = rivals.slice(0, 8)
        .map((m) => `[${m.mark}] "${(m.name || '').slice(0, 72)}"`)
        .join('\n  ');
      return {
        success: false,
        ambiguous: true,
        error: `"${action.text}" matches ${rivals.length} different controls ` +
               `on this page, so I will not guess which one you mean. ` +
               `Click one by its number instead:\n  ${opts}`
      };
    }
    if (rivals.length === 1) {
      return this._click({ ...action, action: 'click', mark: rivals[0].mark }, view);
    }

    // Marks only cover the viewport; the wanted button (Continue, Place Order)
    // is usually further down. Search the whole document before calling it absent.
    const text = arg(String(action.text ?? ''));
    const swept = await this._som(`findActionable(${text})`);
    if (swept && swept.found && !swept.disabled) {
      this.logger?.info(`[Agent] "${action.text}" was off screen - scrolled ${swept.scrolledBy}px to reach <${swept.tag}>`);
      await this.pointAt(swept.x, swept.y);
      const onTarget = swept.hitsTarget === false
        ? false
        : await this._som(`pointHits(${swept.x}, ${swept.y}, ${text})`, true);
      if (onTarget === false) {
        const forced = await this._domActivate(`activateText(${text})`);
        if (forced) {
          this.logger?.info(`[Agent] scrolled ${swept.scrolledBy}px; point lands on a wrapper - activated <${forced.tag}> through the DOM`);
          return { success: true, via: 'scrolled + dom', scrolled: swept.scrolledBy };
        }
      }
      const { res, forced } = await this._clickOrActivate(swept.x, swept.y, `activateText(${text})`, `clickReached(-1, ${text})`);
      if (forced) {
        this.logger?.info(`[Agent] scrolled-to click did nothing - activated <${forced.tag}> via the DOM instead`);
        return { success: true, via: 'scrolled + dom', scrolled: swept.scrolledBy };
      }
      return { ...res, via: 'scrolled to it', scrolled: swept.scrolledBy };
    }

    const near = (view.marks || [])
      .filter((m) => m.name && !m.disabled && !m.covered)
      .slice(0, 14)
      .map((m) => `[${m.mark}] "${m.name.slice(0, 34)}"`)
      .join(', ');
    return {
      success: false,
      error: `Nothing labelled "${action.text}" exists anywhere on this ` +
             `page - I searched the whole document, not just the visible ` +
             `part, so scrolling will not reveal it. What IS here: ${near}`
    };
  }

  async _click(action, view) {
    const point = await this.resolveTarget(action, view);
    if (!point) return { success: false, error: 'Could not resolve a click target' };

    const meta = point.meta || {};
    const hasMark = typeof action.mark === 'number';
    const label = String(action.text || meta.name || '').slice(0, 60);
    const activateMark = `activateMark(${action.mark}, ${arg(label)})`;
    const elementName = (meta.name || 'that element').slice(0, 60);

    if (meta.disabled) {
      return { success: false, error: `"${elementName}" is disabled - something else has to be done first` };
    }
    // A native dropdown opens as browser UI the screenshot never shows.
    if (meta.tag === 'SELECT' || meta.role === 'select') {
      const options = Array.isArray(meta.options) && meta.options.length ? ` Options: ${meta.options.join(' / ')}` : '';
      return { success: false, error: `"${elementName}" is a dropdown - use select_option with the option text.${options}` };
    }
    if (meta.covered) {
      // elementFromPoint often reports a control's own menu container or a
      // decorative sibling as "on top". A real modal covers a big slab of the
      // screen; a small blocker is a hit-test artifact, so go through the DOM.
      const pct = typeof meta.blockerPct === 'number' ? meta.blockerPct : 100;
      if (pct < 25 && hasMark) {
        const forced = await this._domActivate(activateMark);
        if (forced) {
          this.logger?.info(`[Agent] "${label}" reported covered by a ${pct}% node - treated as a hit-test artifact and activated <${forced.tag}> via the DOM`);
          return { success: true, via: 'dom (covered artifact)', forcedActivation: true };
        }
      }
      return {
        success: false,
        covered: true,
        error: `"${elementName}" is underneath ` +
               (meta.blockedBy ? `"${meta.blockedBy}"` : 'an overlay') +
               ' - close what is on top of it first'
      };
    }

    // The point lands on an ancestor wrapper: events bubble up, never down, so
    // a pointer click would never reach the target's handler.
    if (meta.hitsTarget === false && hasMark) {
      await this.pointAt(point.x, point.y);
      const forced = await this._domActivate(activateMark);
      if (forced) {
        this.logger?.info(`[Agent] the click point lands on a wrapper, not "${label}" - activated <${forced.tag}> (${forced.via}) through the DOM`);
        return { success: true, via: 'dom (point missed target)', forcedActivation: true };
      }
    }

    await this.pointAt(point.x, point.y);

    // Lazy-loading pages reflow during the cursor glide; hit-test again right
    // before dispatch so the click cannot land on whatever moved in.
    if (hasMark && label) {
      const stillThere = await this._som(`pointHits(${point.x}, ${point.y}, ${arg(label)})`, true);
      if (stillThere === false) {
        const forced = await this._domActivate(activateMark);
        if (forced) {
          this.logger?.info(`[Agent] the page moved under the cursor - "${label}" is no longer at that point; activated <${forced.tag}> through the DOM`);
          return { success: true, via: 'dom (point went stale)', forcedActivation: true };
        }
      }
    }

    const domCall = hasMark ? activateMark : (label ? `activateText(${arg(label)})` : null);
    const reachCall = `clickReached(${hasMark ? action.mark : -1}, ${arg(label)})`;
    const { res, forced } = await this._clickOrActivate(point.x, point.y, domCall, reachCall);
    if (forced) {
      this.logger?.info(`[Agent] pointer click did nothing - activated <${forced.tag}> (${forced.via}) via the DOM instead`);
      return { ...res, via: point.via + ' + dom', forcedActivation: true };
    }
    return { ...res, via: point.via };
  }

  async _selectOption(action) {
    if (!Number.isInteger(action.mark)) return { success: false, error: 'select_option needs the dropdown\'s mark number' };
    // A native <select> popup cannot be driven by input events; set it in the DOM.
    const res = await this.target.executeJS(
      `window.__grolSoM ? window.__grolSoM.selectOption(${action.mark}, ${arg(String(action.text ?? ''))}) : null`
    ).catch((err) => ({ success: false, error: err.message }));
    if (!res) return { success: false, error: 'Could not reach the dropdown' };
    if (!res.success && res.options) {
      return { success: false, error: res.error + '. Available: ' + res.options.join(' / ') };
    }
    return res;
  }

  async _type(action, view) {
    const text = String(action.text ?? '');
    const point = await this.resolveTarget(action, view);
    if (!point) return { success: false, error: 'Could not resolve the input field' };
    const field = point.meta || {};
    const hasMark = typeof action.mark === 'number';
    if (field.disabled) {
      return { success: false, error: `"${(field.name || 'that field').slice(0, 60)}" is disabled` };
    }
    if (field.role === 'select' || field.tag === 'SELECT') {
      return { success: false, error: `"${(field.name || 'that').slice(0, 60)}" is a dropdown - use select_option, not type` };
    }
    await this.pointAt(point.x, point.y);
    const clicked = await this.target.click(point.x, point.y);
    if (!clicked.success) return clicked;
    await this.sleep(140);

    // Rich editors (Gmail's body, some web components) need an explicit focus().
    if (hasMark) await this._som(`focusMark(${action.mark})`, false);

    const current = await this._som('activeValue()');
    if (typeof current === 'string' && current.trim()) await this.target.clearField();

    const typed = await this.target.typeText(text);
    if (!typed.success) return typed;

    // Keystrokes go wherever focus is: a mis-read mark number, or a React input
    // that re-renders from state, leaves nothing typed. Check, then set the
    // value directly on the field the agent meant.
    let landed = false;
    if (hasMark) {
      const got = await this._som(`fieldValue(${action.mark})`);
      landed = typeof got === 'string' && valueMatches(got, text);
    }
    if (!landed) {
      const forced = await this._som(`typeInto(${hasMark ? action.mark : -1}, ${arg(text)}, ${arg(text.slice(0, 40))})`);
      if (forced && forced.success) {
        this.logger?.info(
          `[Agent] keystrokes did not land - set "${(forced.field || '').slice(0, 40)}" ` +
          `directly${forced.retargeted ? ' (re-targeted from the named mark)' : ''}`
        );
      } else if (forced && forced.error) {
        return { success: false, error: forced.error };
      }
    }

    if (action.submit) {
      await this.sleep(220);
      await this.target.pressKey('Enter');
    }
    return { success: true, typed: text.length, via: point.via };
  }

  // Drag the handle like a person, then arrow keys for the exact value, then
  // set it through the DOM if the page ignores real input.
  async _setRange(action) {
    const mark = typeof action.mark === 'number' ? action.mark : -1;
    const planCall = `rangePlan(${mark}, ${arg(action.value)}, ${arg(action.bound || 'max')})`;
    const plan = await this._som(planCall);
    if (!plan) return { success: false, error: 'Could not reach the slider' };
    if (!plan.success) return plan;

    await this.sleep(250);         // rangePlan scrolled the slider into view
    await this.pointAt(plan.x0, plan.y);
    await this.target.drag(plan.x0, plan.y, plan.x1, plan.y);
    await this.sleep(300);

    let now = await this._som('rangeRead()');
    let via = 'drag';
    if (!now) {
      // Shops like Amazon apply the filter on release and reload, so the
      // dragged slider is gone; check the new page's slider instead.
      await this.target.waitForSettle({ timeout: POST_ACTION_SETTLE_MS });
      await this.target.executeJS(SOM_SCRIPT, { timeout: 6000 }).catch(() => null);
      const again = await this._som(planCall);
      if (again && again.success && again.from === again.to) {
        this.logger?.info(`[Agent] slider ${plan.bound} moved to ${again.targetText} - the page applied it and reloaded`);
        return { success: true, via: 'drag (page applied it)', shown: again.targetText };
      }
      return {
        success: false,
        error: again && again.success
          ? `The page reloaded but the slider shows a different value than ${plan.targetText}`
          : 'The page changed after the drag and the slider could not be found again'
      };
    }
    if (now.pos !== plan.to) {
      await this._som('rangeFocus()');
      const key = now.pos > plan.to ? 'ArrowLeft' : 'ArrowRight';
      const presses = Math.min(40, Math.ceil(Math.abs(now.pos - plan.to) / (plan.step || 1)));
      for (let i = 0; i < presses; i++) {
        await this.target.pressKey(key);
        await this.sleep(40);
      }
      now = await this._som('rangeRead()');
      via = 'drag + keys';
    }
    if (!now || now.pos !== plan.to) {
      now = await this._som(`rangeForce(${plan.to})`);
      via = 'dom';
    }
    if (!now) return { success: false, error: 'The slider disappeared while moving it' };
    const landed = now.pos === plan.to;
    this.logger?.info(`[Agent] slider ${plan.bound} moved to ${now.text} (${via})`);
    return {
      success: landed,
      via,
      shown: now.text,
      error: landed ? undefined : `The slider stopped at ${now.text}, not ${plan.targetText}`,
      note: `Slider now shows ${now.text}. If it has a "Go" or apply button, click it next.`
    };
  }

  // The new tab is attached directly: while it loads its URL is empty, and
  // re-picking "the active drivable tab" would wander back to the old one.
  async _openTab(url) {
    try {
      const tab = await chrome.tabs.create({ url, active: true });
      await this.target.useTab(tab.id);
      await this.target.waitForSettle({ timeout: POST_ACTION_SETTLE_MS });
      return { success: true, url: tab.url || tab.pendingUrl || url };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _switchTab(index) {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tab = Number.isInteger(index) ? tabs[index] : null;
      if (!tab) return { success: false, error: `There is no tab ${index}` };
      await chrome.tabs.update(tab.id, { active: true });
      await this.target.useTab(tab.id);
      await this.sleep(300);
      return { success: true, url: tab.url };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // window.scrollBy does nothing on apps that scroll an inner pane (Gmail,
  // Slack), so scroll the nearest scrollable ancestor of the viewport centre,
  // and fall back to a real wheel event for virtualised lists.
  async _scroll(direction, amount, view) {
    const by = Math.abs(Number(amount)) || 600;
    const dy = direction === 'up' ? -by : direction === 'down' ? by : 0;
    const dx = direction === 'left' ? -by : direction === 'right' ? by : 0;
    if (!dx && !dy) return { success: false, error: `Cannot scroll "${direction}" - use up, down, left or right` };

    const moved = await this.target.executeJS(`
      (function () {
        var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        var el = document.elementFromPoint(cx, cy);
        var dx = ${dx}, dy = ${dy};
        function scrollable(node) {
          while (node && node !== document.body && node !== document.documentElement) {
            var s = getComputedStyle(node);
            var oy = s.overflowY, ox = s.overflowX;
            if ((dy && (oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 4) ||
                (dx && (ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 4)) {
              return node;
            }
            node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
          }
          return null;
        }
        var pane = scrollable(el);
        if (pane) {
          var t0 = pane.scrollTop, l0 = pane.scrollLeft;
          pane.scrollBy(dx, dy);
          if (pane.scrollTop !== t0 || pane.scrollLeft !== l0) return { moved: true, target: 'pane' };
        }
        var y0 = window.scrollY, x0 = window.scrollX;
        window.scrollBy(dx, dy);
        return { moved: window.scrollY !== y0 || window.scrollX !== x0, target: 'window' };
      })()
    `).catch(() => null);

    if (moved && moved.moved) {
      await this.sleep(260);
      return { success: true, scrolled: direction, by, target: moved.target };
    }

    const cx = Math.round((view?.viewport?.w || 800) / 2);
    const cy = Math.round((view?.viewport?.h || 600) / 2);
    await this.target.wheel(cx, cy, dx, dy);
    await this.sleep(260);
    return { success: true, scrolled: direction, by, target: 'wheel' };
  }
}
