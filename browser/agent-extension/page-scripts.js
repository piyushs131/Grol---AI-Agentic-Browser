// Scripts evaluated inside the driven page.
// SOM_SCRIPT installs window.__grolSoM: numbered "set of marks" for everything
// clickable/typable, page-text analysis, and the DOM helpers the agent calls at
// action time. CURSOR_SCRIPT installs the visible agent cursor.

const SOM_VERSION = 18;
const CURSOR_VERSION = 2;

const SOM_SCRIPT = `
(function () {
  if (window.__grolSoM && window.__grolSoM.version === ${SOM_VERSION}) { return 'already'; }

  var MAX_MARKS = 110;
  // Bounds the cursor:pointer sweep, the one pass that computes styles for
  // arbitrary elements; huge DOMs must not blow the mark() timeout.
  var MAX_POINTER_PROBES = 6000;
  // New per document, so the agent can tell a re-rendered page (same id,
  // cached coordinates still meaningful) from a new one (id changed).
  var DOC_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var PALETTE = [
    '#E11D48', '#2563EB', '#059669', '#D97706', '#7C3AED',
    '#0891B2', '#DB2777', '#65A30D', '#EA580C', '#4F46E5'
  ];

  var SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label[for]',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="option"]', '[role="switch"]',
    '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]',
    '[role="spinbutton"]', '[role="slider"]', '[role="treeitem"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '[onclick]', '[jsaction]', '[data-action]', '[aria-haspopup]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  // Sites build buttons from these with no role/href/handler attribute;
  // they are found by a cursor:pointer / framework-handler check instead.
  var POINTER_TAGS = { DIV: 1, SPAN: 1, LI: 1, TD: 1, TH: 1, P: 1, IMG: 1, SECTION: 1, ARTICLE: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, LABEL: 1 };

  var UNAVAILABLE_RE = /(currently unavailable|out of stock|sold out|temporarily out of stock|no longer available|cannot be shipped|can't be shipped|cannot be delivered|does not ship to|doesn't ship to|not available for (delivery|shipping|purchase)|unavailable in your (area|location|region)|item is not available|we don't ship|choose a different delivery location)/i;
  var CAPTCHA_RE = /(captcha|verify (that )?you are (a )?human|are you a robot|unusual traffic|security check|i'm not a robot)/i;
  var LOGIN_RE = /(sign in to continue|please sign in|log in to continue|you must be signed in|session (has )?expired)/i;

  // Ace, CodeMirror and Monaco render divs over an invisible proxy textarea,
  // so the visible container is marked and written through the editor API.
  var CODE_EDITOR_SEL = '.ace_editor, .CodeMirror, .cm-editor, .monaco-editor';

  function isCodeEditor(el) {
    try { return !!(el && el.matches && el.matches(CODE_EDITOR_SEL)); } catch (e) { return false; }
  }

  function setEditorValue(el, text) {
    try {
      if (el.classList.contains('ace_editor') && window.ace && window.ace.edit) {
        window.ace.edit(el).setValue(text, -1);          // -1 = cursor to start
        return true;
      }
      if (el.CodeMirror) { el.CodeMirror.setValue(text); return true; }
      var inner = el.querySelector && el.querySelector('.CodeMirror');
      if (inner && inner.CodeMirror) { inner.CodeMirror.setValue(text); return true; }
      if (el.classList.contains('cm-editor')) {
        var view = (el.cmView && el.cmView.view) || el.CodeMirrorView;
        if (view && view.state) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
          return true;
        }
      }
      if (el.classList.contains('monaco-editor') && window.monaco && window.monaco.editor) {
        var models = window.monaco.editor.getModels();
        if (models && models.length) { models[0].setValue(text); return true; }
      }
    } catch (e) {}
    return false;
  }

  function editorValue(el) {
    try {
      if (el.classList.contains('ace_editor') && window.ace && window.ace.edit) {
        return window.ace.edit(el).getValue();
      }
      if (el.CodeMirror) return el.CodeMirror.getValue();
      var inner = el.querySelector && el.querySelector('.CodeMirror');
      if (inner && inner.CodeMirror) return inner.CodeMirror.getValue();
      if (el.classList.contains('cm-editor')) {
        var view = (el.cmView && el.cmView.view) || el.CodeMirrorView;
        if (view && view.state) return view.state.doc.toString();
      }
      if (el.classList.contains('monaco-editor') && window.monaco && window.monaco.editor) {
        var models = window.monaco.editor.getModels();
        if (models && models.length) return models[0].getValue();
      }
    } catch (e) {}
    return null;
  }

  function styleOf(el) {
    try { return window.getComputedStyle(el); } catch (e) { return null; }
  }

  function inOverlay(el) {
    try { return !!(el && el.closest && el.closest('[data-grol-overlay]')); } catch (e) { return false; }
  }

  function isRendered(el) {
    var s = styleOf(el);
    if (!s) return false;
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (parseFloat(s.opacity) < 0.05) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    // An ancestor's opacity:0 or content-visibility hides el without showing
    // in el's own computed style.
    try {
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    } catch (e) {}
    try { if (el.closest && el.closest('[inert]')) return false; } catch (e) {}
    return true;
  }

  // Parent across shadow boundaries: a shadow root's parent is its host.
  function parentOf(node) {
    if (!node) return null;
    if (node.parentNode && node.parentNode.nodeType === 11) return node.parentNode.host || null;
    return node.parentElement || (node.parentNode && node.parentNode.host) || null;
  }

  // Node.contains stops at shadow roots; this follows hosts upward.
  function containsDeep(outer, inner) {
    for (var n = inner; n; n = parentOf(n)) if (n === outer) return true;
    return false;
  }

  // document.elementFromPoint retargets to the outermost shadow host.
  function deepHit(x, y) {
    var hit = document.elementFromPoint(x, y);
    for (var guard = 0; hit && hit.shadowRoot && guard < 12; guard++) {
      var inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  function deepActive() {
    var a = document.activeElement;
    for (var guard = 0; a && a.shadowRoot && a.shadowRoot.activeElement && guard < 12; guard++) {
      a = a.shadowRoot.activeElement;
    }
    return a;
  }

  // Every element of the document and of its open shadow roots.
  function allElements() {
    var out = [];
    (function walk(root) {
      var found;
      try { found = root.querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < found.length; i++) {
        out.push(found[i]);
        if (found[i].shadowRoot) walk(found[i].shadowRoot);
      }
    })(document);
    return out;
  }

  function squash(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^\\p{L}\\p{N}]/gu, '');
  }

  // Formatting inputs (phone numbers, card numbers) re-space what was typed.
  function valueHas(got, want) {
    got = String(got == null ? '' : got);
    want = String(want == null ? '' : want);
    if (got.indexOf(want) !== -1) return true;
    var w = squash(want);
    return !!w && squash(got).indexOf(w) !== -1;
  }

  // Disabled elements are kept and flagged: "greyed out" and "absent" need
  // different next actions.
  function isDisabled(el) {
    try {
      if (el.disabled === true) return true;
      // Covers controls inside <fieldset disabled>, which el.disabled misses.
      if (el.matches && el.matches(':disabled')) return true;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
      // pointer-events:none is a hit-testing property, not a disabled state:
      // Material Design puts it on decorative spans inside live menu items.
      // Only honour it on real form controls.
      var s = styleOf(el);
      if (s && s.pointerEvents === 'none' &&
          /^(BUTTON|INPUT|SELECT|TEXTAREA|A|OPTION)$/.test(el.tagName)) return true;
      var cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '';
      if (typeof cls === 'string' && /(^|[\\s_-])disabled([\\s_-]|$)/i.test(cls)) return true;
    } catch (e) {}
    return false;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Where a real click on el would land, whether it reaches el, and what
  // element would swallow it if not.
  function probe(el, rect) {
    var vw = window.innerWidth, vh = window.innerHeight;
    // Sample the on-screen part only: a tall element whose middle is below
    // the fold is still clickable where it shows.
    var left = Math.max(rect.left, 0), right = Math.min(rect.right, vw);
    var top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, vh);
    var cx = clamp(rect.left + rect.width / 2, 1, vw - 1);
    var cy = clamp(rect.top + rect.height / 2, 1, vh - 1);
    if (right - left < 1 || bottom - top < 1) {
      return { x: cx, y: cy, covered: false, hitsTarget: true, blocker: null, offscreen: true };
    }
    var w = right - left, h = bottom - top;
    var pts = [
      [left + w / 2, top + h / 2],
      [left + w * 0.25, top + h * 0.5],
      [left + w * 0.75, top + h * 0.5],
      [left + w * 0.5, top + h * 0.25],
      [left + w * 0.5, top + h * 0.75]
    ];
    var blocker = null, wrapper = null;
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0], y = pts[i][1];
      var hit = null;
      try { hit = deepHit(x, y); } catch (e) { continue; }
      if (!hit) continue;
      if (hit === el || containsDeep(el, hit)) {
        return { x: x, y: y, covered: false, hitsTarget: true, blocker: null };
      }
      // An ancestor on top is not an overlay, but clicking it never reaches
      // the target's handler: events bubble up, not down.
      if (containsDeep(hit, el)) { if (!wrapper) wrapper = [x, y]; continue; }
      if (!blocker) blocker = hit;
    }
    if (wrapper) {
      return {
        x: wrapper[0], y: wrapper[1],
        covered: false,        // nothing is blocking it - the aim is just wrong
        hitsTarget: false,     // ... so dispatch through the DOM instead
        blocker: null
      };
    }
    return {
      x: clamp(left + w / 2, 1, vw - 1),
      y: clamp(top + h / 2, 1, vh - 1),
      covered: true,
      hitsTarget: false,
      blocker: blocker
    };
  }

  function accessibleName(el) {
    var parts = [];
    var push = function (v) {
      if (!v) return;
      v = String(v).replace(/\\s+/g, ' ').trim();
      if (v && parts.indexOf(v) === -1) parts.push(v);
    };
    push(el.getAttribute && el.getAttribute('aria-label'));
    var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\\s+/).forEach(function (id) {
        var n = document.getElementById(id);
        if (n) push(n.innerText || n.textContent);
      });
    }
    push(el.placeholder);
    push(el.getAttribute && el.getAttribute('title'));
    push(el.getAttribute && el.getAttribute('alt'));
    if (el.tagName === 'INPUT' && el.type !== 'password') {
      push(el.value);
      if (el.labels && el.labels.length) push(el.labels[0].innerText || el.labels[0].textContent);
    }
    if (isCodeEditor(el)) {
      // Its innerText is the rendered source, which would swamp the name.
      var cur = editorValue(el);
      var head = cur ? cur.replace(/\\s+/g, ' ').trim().slice(0, 40) : '';
      return 'code editor' + (head ? ' (' + head + ' ...)' : ' (empty)');
    }
    var text = (el.innerText || el.textContent || '');
    push(text.slice(0, 140));
    push(el.getAttribute && el.getAttribute('name'));
    return parts.join(' | ').slice(0, 130);
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') return 'input:' + (el.type || 'text');
    if (el.isContentEditable) return 'textbox';
    return tag;
  }

  function isTypable(el) {
    var tag = el.tagName.toLowerCase();
    if (isCodeEditor(el)) return true;
    if (tag === 'textarea') return true;
    if (el.isContentEditable) return true;
    var role = (el.getAttribute && el.getAttribute('role')) || '';
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      return ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].indexOf(t) === -1;
    }
    return false;
  }

  // Which open menu / listbox / dialog an element belongs to, so the model
  // knows a choice is pending. ARIA-only on purpose: a z-index heuristic
  // flagged sticky site headers as open menus.
  function expandedOwnerOf(node) {
    var id = node.id;
    if (!id) return false;
    try {
      var esc = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/["\\\\]/g, '\\\\$&');
      return !!document.querySelector(
        '[aria-expanded="true"][aria-controls="' + esc + '"],' +
        '[aria-expanded="true"][aria-owns="' + esc + '"]'
      );
    } catch (e) { return false; }
  }

  function floatingOwner(el) {
    var node = el, hops = 0;
    while (node && hops++ < 10 && node !== document.body && node !== document.documentElement) {
      var role = node.getAttribute && node.getAttribute('role');
      if (role === 'listbox') return { el: node, kind: 'suggestions' };
      if (role === 'menu' || role === 'tree') return { el: node, kind: 'menu' };
      if (role === 'dialog' || role === 'alertdialog') return { el: node, kind: 'dialog' };
      if (node.tagName === 'DIALOG' && node.open) return { el: node, kind: 'dialog' };
      if (node.getAttribute && node.getAttribute('aria-modal') === 'true') {
        return { el: node, kind: 'dialog' };
      }
      if (node !== el && expandedOwnerOf(node)) return { el: node, kind: 'menu' };
      node = node.parentElement;
    }
    return null;
  }

  function optionsOf(el) {
    if (!el || el.tagName !== 'SELECT') return null;
    var out = [];
    for (var i = 0; i < el.options.length && i < 25; i++) {
      var t = (el.options[i].text || '').replace(/\\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out.length ? out : null;
  }

  // React keeps props on the node under a per-build key; a framework onClick
  // there is a clickable control even with no role, attribute or cursor.
  function hasHandler(node) {
    try {
      if (typeof node.onclick === 'function') return true;
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.charCodeAt(0) !== 95) continue;              // fast reject: not "_"
        if (k.indexOf('__reactProps$') === 0 || k.indexOf('__reactEventHandlers$') === 0) {
          var p = node[k];
          if (p && (typeof p.onClick === 'function' ||
                    typeof p.onMouseDown === 'function' ||
                    typeof p.onPointerDown === 'function')) return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function gather() {
    var nodes = [];
    var seen = new Set();
    var probes = 0;

    function scan(root) {
      var found;
      try { found = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      for (var i = 0; i < found.length; i++) {
        var el = found[i];
        if (seen.has(el)) continue;
        seen.add(el);
        nodes.push(el);
      }
      // Open shadow roots (web components).
      var all;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (var j = 0; j < all.length; j++) {
        var node = all[j];
        if (node.shadowRoot) scan(node.shadowRoot);
        // Cheap geometry checks first so getComputedStyle runs rarely.
        if (seen.has(node)) continue;
        if (!POINTER_TAGS[node.tagName]) continue;
        var r;
        try { r = node.getBoundingClientRect(); } catch (e) { continue; }
        if (r.width < 12 || r.height < 12) continue;
        if (r.bottom < 2 || r.right < 2) continue;
        if (r.top > window.innerHeight - 2 || r.left > window.innerWidth - 2) continue;
        if (r.width > window.innerWidth * 0.9 && r.height > window.innerHeight * 0.5) continue;
        if (++probes > MAX_POINTER_PROBES) continue;
        if (!isActivatable(node)) continue;
        var txt = (node.innerText || '').trim();
        if (txt.length > 120) continue;
        seen.add(node);
        nodes.push(node);
      }
    }
    scan(document);
    // Code editor containers match none of the signals above.
    try {
      var eds = document.querySelectorAll(CODE_EDITOR_SEL);
      for (var e = 0; e < eds.length; e++) {
        if (!seen.has(eds[e])) { seen.add(eds[e]); nodes.push(eds[e]); }
      }
    } catch (e) {}
    return nodes;
  }

  // "title — price" of the card a control sits in, used to tell apart
  // repeated labels like thirty identical "Add to cart" buttons.
  var PRICE_RE = /(?:₹|Rs\\.?|INR|\\$|€|£)\\s?\\d[\\d,]*(?:\\.\\d+)?/;

  function titleWithin(node) {
    var sels = ['h1', 'h2', 'h3', 'h4', '[class*="title" i]', 'a[href]'];
    for (var i = 0; i < sels.length; i++) {
      var found;
      try { found = node.querySelectorAll(sels[i]); } catch (e) { continue; }
      for (var j = 0; j < found.length; j++) {
        var t = '';
        try { t = (found[j].innerText || '').replace(/\\s+/g, ' ').trim(); } catch (e) {}
        // A title is prose, not a price tag or a one-word affordance.
        if (t.length > 12 && !PRICE_RE.test(t.slice(0, 12))) return t;
      }
    }
    return '';
  }

  function cardContextOf(el) {
    // Controls can sit ~17 levels deep, under wrappers with a price but no
    // title, so climb until one ancestor has both.
    var n = el.parentElement, hops = 0;
    while (n && hops++ < 22) {
      var txt = '';
      try { txt = (n.innerText || '').replace(/\\s+/g, ' ').trim(); } catch (e) {}
      if (txt.length > 25 && txt.length < 1200) {
        var price = txt.match(PRICE_RE);
        if (price) {
          var title = titleWithin(n);
          if (title) return title.slice(0, 70) + ' — ' + price[0];
        }
      }
      n = n.parentElement;
    }
    return '';
  }

  function collect() {
    var nodes = gather();
    var vw = window.innerWidth, vh = window.innerHeight;
    var candidates = [];
    var offscreen = { above: 0, below: 0 };

    for (var k = 0; k < nodes.length; k++) {
      var el = nodes[k];
      if (inOverlay(el)) continue;
      if (!isRendered(el)) continue;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!rect || rect.width < 8 || rect.height < 8) continue;
      // Count what is out of reach so the model knows scrolling is worthwhile.
      if (rect.bottom < 2) { offscreen.above++; continue; }
      if (rect.top > vh - 2) { offscreen.below++; continue; }
      if (rect.right < 2 || rect.left > vw - 2) continue;
      // Skip full-page wrappers that merely carry a tabindex.
      if (rect.width > vw * 0.98 && rect.height > vh * 0.9) continue;

      var p = probe(el, rect);
      candidates.push({
        el: el, rect: rect, point: p, area: rect.width * rect.height,
        covered: p.covered, disabled: isDisabled(el), owner: floatingOwner(el),
        role: roleOf(el), typable: isTypable(el), name: accessibleName(el)
      });
    }

    // Drop ancestors that are all-but-identical to a descendant we already have,
    // so a link wrapping a div wrapping a span yields ONE mark, not three.
    // Walks each candidate's ancestors instead of comparing all pairs, which
    // is quadratic on pages with thousands of controls.
    var byEl = new Map();
    candidates.forEach(function (c) { byEl.set(c.el, c); });
    var redundant = new Set();
    candidates.forEach(function (o) {
      for (var up = o.el.parentElement, hops = 0; up && hops < 40; up = up.parentElement, hops++) {
        var c = byEl.get(up);
        if (c && o.area > c.area * 0.82) redundant.add(c);
      }
    });
    var keep = candidates.filter(function (c) { return !redundant.has(c); });

    // Over the limit, drop the least useful candidates rather than
    // truncating in reading order (which loses the lower half of the page).
    if (keep.length > MAX_MARKS) {
      keep.forEach(function (c) {
        var r = c.rect, s = 0;
        if (c.owner) s += 500;
        if (r.top >= 0 && r.bottom <= vh) s += 30;
        if (!c.covered) s += 45;
        if (!c.disabled) s += 15;
        if (c.typable) s += 30;
        if (/button|submit|link|tab|option|menuitem/i.test(c.role)) s += 22;
        if (c.name) s += Math.min(18, c.name.length / 3);
        if (c.area < 200) s -= 12;
        if (c.area > vw * vh * 0.45) s -= 28;
        s -= Math.max(0, r.top) / 220;
        c._score = s;
      });
      keep.sort(function (p, q) { return q._score - p._score; });
      keep = keep.slice(0, MAX_MARKS);
    }

    // Give repeated names the identity of their own item.
    var nameCount = {};
    keep.forEach(function (c) {
      var k = (c.name || '').trim();
      if (k) nameCount[k] = (nameCount[k] || 0) + 1;
    });
    keep.forEach(function (c) {
      var k = (c.name || '').trim();
      if (!k || nameCount[k] < 2 || k.length > 60) return;
      var ctx = cardContextOf(c.el);
      if (ctx) c.name = k + ' | ' + ctx;
    });

    // Reading order: top-to-bottom, then left-to-right.
    keep.sort(function (p, q) {
      var dy = p.rect.top - q.rect.top;
      if (Math.abs(dy) > 12) return dy;
      return p.rect.left - q.rect.left;
    });

    keep.offscreen = offscreen;
    return keep;
  }

  // Computes the marks only; the agent draws them onto a copy of the
  // screenshot (mark-render.js) so nothing flashes over the site.
  function mark() {
    var items = collect();

    var out = [];
    var covered = 0, disabled = 0;
    // What is swallowing clicks, measured with the same elementFromPoint a
    // real click goes through.
    var blockers = [];
    var blockerIndex = new Map();
    var menus = [];
    var menuIndex = new Map();

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var r = it.rect;
      var color = PALETTE[i % PALETTE.length];
      var n = i + 1;
      var muted = it.covered || it.disabled;
      if (it.disabled) disabled++;
      if (it.covered) {
        covered++;
        var bl = it.point.blocker;
        if (bl) {
          // Attribute the block to the floating popover, not an inner span.
          var owner = bl;
          for (var up = 0; up < 6 && owner.parentElement; up++) {
            var os = styleOf(owner);
            if (os && (os.position === 'fixed' || os.position === 'absolute') &&
                parseInt(os.zIndex, 10) >= 1) break;
            owner = owner.parentElement;
          }
          var key = textOf(owner, 90) || owner.tagName;
          if (!blockerIndex.has(key)) {
            blockerIndex.set(key, { text: key, count: 0 });
            blockers.push(blockerIndex.get(key));
          }
          blockerIndex.get(key).count++;
        }
      }

      var menuId = null;
      if (it.owner) {
        if (!menuIndex.has(it.owner.el)) {
          menuIndex.set(it.owner.el, {
            id: menus.length + 1,
            kind: it.owner.kind,
            label: textOf(it.owner.el, 120),
            marks: []
          });
          menus.push(menuIndex.get(it.owner.el));
        }
        var m = menuIndex.get(it.owner.el);
        m.marks.push(n);
        menuId = m.id;
      }

      out.push({
        mark: n,
        color: color,
        muted: !!muted,
        role: it.role,
        name: it.name,
        typable: it.typable,
        disabled: it.disabled,
        covered: it.covered,
        menu: menuId,
        options: optionsOf(it.el),
        x: Math.round(it.point.x),
        y: Math.round(it.point.y),
        rect: {
          x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height)
        }
      });
    }

    window.__grolSoM._els = items.map(function (i) { return i.el; });

    blockers.sort(function (p, q) { return q.count - p.count; });

    return {
      docId: DOC_ID,
      marks: out,
      menus: menus.filter(function (m) { return m.marks.length > 0; }).slice(0, 4),
      blockers: blockers.slice(0, 3),
      counts: {
        total: out.length, covered: covered, disabled: disabled,
        above: items.offscreen ? items.offscreen.above : 0,
        below: items.offscreen ? items.offscreen.below : 0
      },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroll: {
        y: Math.round(window.scrollY || 0),
        maxY: Math.max(0, Math.round(
          (document.documentElement.scrollHeight || 0) - window.innerHeight
        ))
      }
    };
  }


  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1 };

  // The page's words, split by whether they are on screen (what the
  // screenshot shows) or not (a short digest of what scrolling reveals).
  function readText() {
    var visible = [];
    var hidden = [];
    var vBudget = 4000, hBudget = 1200;
    var vh = window.innerHeight, vw = window.innerWidth;
    var walked = 0;

    var walker;
    try {
      walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
    } catch (e) { return { onScreen: '', offScreen: '' }; }

    // Measure each text run with a Range: a tall parent's rect would claim
    // all of its text is on screen.
    var range = null;
    try { range = document.createRange(); } catch (e) { range = null; }

    var node;
    while ((node = walker.nextNode())) {
      if (++walked > 6000) break;
      if (vBudget <= 0 && hBudget <= 0) break;
      var raw = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
      if (!raw || raw.length < 2) continue;
      var el = node.parentElement;
      if (!el || SKIP_TAGS[el.tagName]) continue;
      if (inOverlay(el)) continue;
      if (!isRendered(el)) continue;
      var r = null;
      if (range) {
        try { range.selectNodeContents(node); r = range.getBoundingClientRect(); } catch (e) { r = null; }
      }
      if (!r || (r.width < 1 && r.height < 1)) {
        try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      }
      if (r.width < 1 || r.height < 1) continue;
      var onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (onScreen) {
        if (vBudget <= 0) continue;
        visible.push(raw);
        vBudget -= raw.length + 1;
      } else {
        if (hBudget <= 0) continue;
        hidden.push(raw);
        hBudget -= raw.length + 1;
      }
    }
    return {
      onScreen: visible.join(' \\u00b7 ').slice(0, 4200),
      offScreen: hidden.join(' \\u00b7 ').slice(0, 1300)
    };
  }

  function textOf(el, cap) {
    var t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, cap || 200);
  }

  function readAlerts() {
    var out = [];
    var sel = '[role="alert"],[role="status"],[aria-live="assertive"],.a-alert-content,' +
              '[class*="error" i],[class*="warning" i],[class*="unavailable" i],' +
              '[class*="out-of-stock" i],[class*="outofstock" i],[class*="notice" i]';
    var nodes;
    try { nodes = document.querySelectorAll(sel); } catch (e) { return out; }
    for (var i = 0; i < nodes.length && out.length < 8; i++) {
      var el = nodes[i];
      if (inOverlay(el) || !isRendered(el)) continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 20 || r.height < 8) continue;
      var t = textOf(el, 240);
      if (t.length < 4) continue;
      // A container that merely wraps a nested alert would repeat its text.
      var dup = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j].indexOf(t) !== -1 || t.indexOf(out[j]) !== -1) { dup = true; break; }
      }
      if (!dup) out.push(t);
    }
    return out;
  }

  function readDialogs() {
    var out = [];
    var seen = new Set();
    var vw = window.innerWidth, vh = window.innerHeight;
    var area = vw * vh;

    function add(el, kind) {
      if (!el || seen.has(el) || inOverlay(el) || !isRendered(el)) return;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { return; }
      if (r.width < 60 || r.height < 40) return;
      if (r.bottom < 0 || r.top > vh) return;
      seen.add(el);
      var t = textOf(el, 300);
      if (!t) return;
      out.push({ kind: kind, text: t, coversPct: Math.round((r.width * r.height) / area * 100) });
    }

    var explicit;
    try {
      explicit = document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]');
    } catch (e) { explicit = []; }
    for (var i = 0; i < explicit.length && out.length < 4; i++) add(explicit[i], 'dialog');

    // Unlabelled popovers (cookie walls, location bubbles) have no role. Rect
    // is checked before computed style to keep this cheap on big pages.
    var all;
    try { all = document.body ? document.body.querySelectorAll('*') : []; } catch (e) { all = []; }
    for (var j = 0; j < all.length && out.length < 4; j++) {
      var el = all[j];
      if (seen.has(el) || inOverlay(el)) continue;
      var r2;
      try { r2 = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r2.width * r2.height < area * 0.012) continue;
      if (r2.bottom < 0 || r2.top > vh) continue;
      // A full-width strip pinned to an edge is a sticky header, not a popover.
      if (r2.width > vw * 0.9 && r2.height < vh * 0.35 && (r2.top <= 2 || r2.bottom >= vh - 2)) continue;
      var s = styleOf(el);
      if (!s) continue;
      if (s.position !== 'fixed' && s.position !== 'absolute') continue;
      var z = parseInt(s.zIndex, 10);
      if (!isFinite(z) || z < 50) continue;
      if (!isRendered(el)) continue;
      add(el, 'popover');
    }
    return out;
  }

  function sentenceAround(hay, needle) {
    var i = hay.toLowerCase().indexOf(needle.toLowerCase());
    if (i === -1) return needle;
    var start = Math.max(0, hay.lastIndexOf('.', i) + 1);
    var stop = hay.indexOf('.', i + needle.length);
    if (stop === -1) stop = Math.min(hay.length, i + needle.length + 90);
    return hay.slice(start, stop + 1).replace(/^[\\s\\u00b7]+/, '').trim().slice(0, 220);
  }

  function analyze() {
    var text = readText();
    var haystack = (text.onScreen + ' ' + text.offScreen);
    var alerts = readAlerts();
    var dialogs = readDialogs();

    var headings = [];
    try {
      var hs = document.querySelectorAll('h1,h2,[role="heading"]');
      for (var i = 0; i < hs.length && headings.length < 8; i++) {
        if (!isRendered(hs[i]) || inOverlay(hs[i])) continue;
        var t = textOf(hs[i], 120);
        if (t && headings.indexOf(t) === -1) headings.push(t);
      }
    } catch (e) {}

    var blockedText = alerts.join(' ') + ' ' + haystack;
    var unavailable = UNAVAILABLE_RE.exec(blockedText);
    var captcha = CAPTCHA_RE.exec(haystack);
    var login = LOGIN_RE.exec(haystack);

    var hasPassword = false;
    try {
      var pw = document.querySelectorAll('input[type="password"]');
      for (var p = 0; p < pw.length; p++) {
        var pr = pw[p].getBoundingClientRect();
        if (pr.width > 20 && pr.height > 8 && pw[p].offsetParent !== null) { hasPassword = true; break; }
      }
    } catch (e) {}

    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      headings: headings,
      onScreenText: text.onScreen,
      offScreenText: text.offScreen,
      alerts: alerts,
      dialogs: dialogs,
      signals: {
        unavailable: unavailable ? sentenceAround(blockedText, unavailable[0]) : null,
        captcha: captcha ? sentenceAround(haystack, captcha[0]) : null,
        loginWall: hasPassword ? 'a password field is visible on this page'
                 : (login ? sentenceAround(haystack, login[0]) : null)
      },
      scroll: {
        y: Math.round(window.scrollY || 0),
        maxY: Math.max(0, Math.round((document.documentElement.scrollHeight || 0) - window.innerHeight))
      },
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
  }


  function markEl(n) {
    return (window.__grolSoM._els || [])[n - 1];
  }

  // Share of the viewport an element covers. A real modal or scrim covers a
  // big slab; a hit-test artifact (a menu's scroll container) is small.
  function screenShare(el) {
    try {
      var br = el.getBoundingClientRect();
      return Math.round(100 * br.width * br.height /
                        Math.max(1, window.innerWidth * window.innerHeight));
    } catch (e) { return 100; }
  }

  // Re-read a mark's live position at action time; the page may have moved.
  function resolveMark(n) {
    var el = markEl(n);
    if (!el || !el.isConnected) return null;
    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return null; }
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    // Scrolling a visible target would invalidate the model's screenshot.
    var offscreen = rect.top < 0 || rect.bottom > window.innerHeight ||
                    rect.left < 0 || rect.right > window.innerWidth;
    if (offscreen) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
      try { rect = el.getBoundingClientRect(); } catch (e) {}
    }
    var p = probe(el, rect);
    return {
      x: Math.round(p.x),
      y: Math.round(p.y),
      covered: p.covered,
      hitsTarget: p.hitsTarget !== false,
      blockedBy: p.covered && p.blocker ? textOf(p.blocker, 80) || p.blocker.tagName : null,
      blockerPct: p.covered && p.blocker ? screenShare(p.blocker) : 0,
      disabled: isDisabled(el),
      typable: isTypable(el),
      role: roleOf(el),
      name: accessibleName(el),
      tag: el.tagName
    };
  }

  // Native clicks do not always focus complex editors.
  function focusMark(n) {
    var el = markEl(n);
    if (!el || !el.isConnected) return false;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { return false; } }
    var a = deepActive();
    return a === el || containsDeep(el, a);
  }

  // A native <select> popup cannot be driven by input events.
  function selectOption(n, wanted) {
    var el = markEl(n);
    if (!el || !el.isConnected) return { success: false, error: 'mark ' + n + ' is gone' };
    if (el.tagName !== 'SELECT') return { success: false, error: 'mark ' + n + ' is a ' + el.tagName + ', not a dropdown' };
    var want = String(wanted == null ? '' : wanted).replace(/\\s+/g, ' ').trim().toLowerCase();
    var wantSquashed = squash(want);
    var pick = null;
    for (var pass = 0; pass < 3 && !pick; pass++) {
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        if (o.disabled) continue;
        var label = (o.text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        var val = String(o.value == null ? '' : o.value).trim().toLowerCase();
        if (pass === 0 && (val === want || label === want)) pick = o;
        else if (pass === 1 && want && label.indexOf(want) !== -1) pick = o;
        else if (pass === 2 && wantSquashed && squash(label).indexOf(wantSquashed) !== -1) pick = o;
        if (pick) break;
      }
    }
    if (!pick) {
      var avail = [];
      for (var j = 0; j < el.options.length && j < 20; j++) avail.push((el.options[j].text || '').trim());
      return { success: false, error: 'no option matching "' + wanted + '"', options: avail };
    }
    try { el.focus({ preventScroll: true }); } catch (e) {}
    // Through the prototype so an instance-level override cannot intercept it.
    var setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set;
    setSelect.call(el, pick.index);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, selected: (pick.text || '').trim() };
  }

  // A slider's value is rarely what it shows (Amazon: 0-187, aria-valuetext
  // "₹4,800"), so rangePlan binary-searches the position whose shown value
  // is closest to the target without crossing it, then restores the slider
  // and returns the drag start/end points.
  function rangeShown(el) {
    var txt = el.getAttribute('aria-valuetext') || '';
    var digits = txt.replace(/[^0-9.]/g, '');
    return { text: txt || String(el.value), num: digits !== '' ? Number(digits) : Number(el.value) };
  }

  function rangePlan(n, target, which) {
    var picked = markEl(n);
    var all = Array.prototype.slice.call(document.querySelectorAll('input[type=range]'));
    if (picked && !(picked.tagName === 'INPUT' && picked.type === 'range')) {
      var inside = picked.querySelectorAll ? picked.querySelectorAll('input[type=range]') : [];
      picked = inside.length ? inside[0] : null;
    }
    if (!all.length && !picked) return { success: false, error: 'there is no slider on this page' };
    var want = String(which || 'max').toLowerCase() === 'min' ? 'min' : 'max';
    var tag = function (r) {
      return ((r.getAttribute('aria-label') || '') + ' ' + (r.id || '') + ' ' + (r.name || '')).toLowerCase();
    };
    // A slider with two handles is two inputs: take the bound that was asked for.
    var group = picked ? all.filter(function (r) {
      return r.parentElement === picked.parentElement || (picked.form && r.form === picked.form);
    }) : all;
    if (!group.length) group = [picked];
    var el = null;
    for (var i = 0; i < group.length && !el; i++) {
      var t = tag(group[i]);
      if (want === 'max' ? /max|upper|high/.test(t) : /min|lower|low/.test(t)) el = group[i];
    }
    if (!el) el = want === 'max' ? group[group.length - 1] : group[0];

    var digits = String(target).replace(/[^0-9.]/g, '');
    if (digits === '') return { success: false, error: 'set_range needs a numeric value' };
    var goal = Number(digits);

    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    var lo = Number(el.min || 0), hi = Number(el.max || 100), step = Number(el.step) || 1;
    var original = el.value;
    var probe = function (v) {
      setter.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return rangeShown(el).num;
    };
    var a = 0, b = Math.round((hi - lo) / step), best = null;
    while (a <= b) {            // shown values rise with position
      var mid = Math.floor((a + b) / 2), pos = lo + mid * step, val = probe(pos);
      if (want === 'max') { if (val <= goal) { best = pos; a = mid + 1; } else b = mid - 1; }
      else { if (val >= goal) { best = pos; b = mid - 1; } else a = mid + 1; }
    }
    if (best === null) best = want === 'max' ? lo : hi;
    probe(best);
    var bestShown = rangeShown(el);
    probe(original);            // leave the slider as the user saw it

    window.__grolSoM._range = el;
    var r = el.getBoundingClientRect();
    var thumb = Math.min(Math.max(r.height, 12), 24);
    var xAt = function (v) { return r.left + thumb / 2 + ((v - lo) / ((hi - lo) || 1)) * (r.width - thumb); };
    return {
      success: true, bound: want,
      x0: Math.round(xAt(Number(original))), x1: Math.round(xAt(best)),
      y: Math.round(r.top + r.height / 2),
      from: Number(original), to: best, step: step, targetText: bestShown.text
    };
  }

  function rangeRead() {
    var el = window.__grolSoM._range;
    if (!el || !el.isConnected) return null;
    var s = rangeShown(el);
    return { pos: Number(el.value), text: s.text, num: s.num };
  }

  function rangeFocus() {
    var el = window.__grolSoM._range;
    if (!el || !el.isConnected) return false;
    try { el.focus({ preventScroll: true }); } catch (e) { return false; }
    return document.activeElement === el;
  }

  // For sliders that ignore real input.
  function rangeForce(pos) {
    var el = window.__grolSoM._range;
    if (!el || !el.isConnected) return null;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(pos));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return rangeRead();
  }

  function findText(needle) {
    var target = String(needle || '').toLowerCase().trim();
    if (!target || !document.body) return { found: false };
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var t = (node.nodeValue || '').toLowerCase();
      if (t.indexOf(target) === -1) continue;
      var el = node.parentElement;
      if (!el || inOverlay(el) || !isRendered(el)) continue;
      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
      var r = el.getBoundingClientRect();
      return {
        found: true,
        text: textOf(el, 160),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2)
      };
    }
    return { found: false };
  }

  // The single definition of "clickable", shared by the marker and the
  // off-screen sweep so they can never disagree.
  function isActivatable(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      if (node.matches && node.matches(SELECTOR)) return true;
      if (typeof node.onclick === 'function') return true;
      var s = styleOf(node);
      if (s && s.cursor === 'pointer') return true;
    } catch (e) { /* fall through to the handler test */ }
    return hasHandler(node);
  }

  function fireActivation(target) {
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    try { target.focus({ preventScroll: true }); } catch (e) {}

    var rect = target.getBoundingClientRect();
    var opts = {
      bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };

    // Frameworks listen on pointer/mouse events; a bare click() misses them.
    try {
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', opts));
      }
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      // A dispatched click runs activation behaviour itself (links navigate,
      // checkboxes toggle), so a follow-up el.click() would do it twice.
      target.dispatchEvent(new MouseEvent('click', opts));
    } catch (e) {
      try { target.click(); } catch (e2) {
        return { success: false, error: 'could not dispatch: ' + e2.message };
      }
    }

    return { success: true, tag: target.tagName, label: textOf(target, 60) };
  }

  // textContent needs no layout, so it rules out most of a big page before
  // anything computes style or innerText. It is a superset of innerText.
  function mayCarry(el, want) {
    var raw = el.textContent || '';
    if (raw.length && raw.toLowerCase().indexOf(want) !== -1) return true;
    var label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value'));
    return !!label && label.toLowerCase().indexOf(want) !== -1;
  }

  function labelText(el) {
    var t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!t && el.getAttribute) t = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '';
    return String(t).replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  // Find and activate a control by label anywhere in the document: the
  // recovery when a re-render detached the marked node.
  function activateText(wanted) {
    var want = String(wanted == null ? '' : wanted).replace(/\\s+/g, ' ').trim().toLowerCase();
    if (!want) return { success: false, error: 'no label to look for' };

    var all = allElements();
    var best = null, bestScore = -1;
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (!mayCarry(c, want) || !isActivatable(c)) continue;
      var t = labelText(c);
      if (!t || t.indexOf(want) === -1) continue;
      var r = c.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // Prefer the tightest label match that is actually on screen.
      var score = 100 - Math.min(60, t.length - want.length);
      if (r.top >= 0 && r.bottom <= window.innerHeight) score += 25;
      if (best && containsDeep(best, c)) score += 10;    // deeper is tighter
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return { success: false, error: 'nothing labelled "' + wanted + '" is on the page now' };
    var out = fireActivation(best);
    out.via = 'text';
    return out;
  }

  // Framework-controlled inputs revert a plain .value assignment; go through
  // the native setter and announce it with an input event.
  function setFieldValue(el, text) {
    if (isCodeEditor(el)) return setEditorValue(el, text);
    if (el.isContentEditable) {
      // Rich editors (ProseMirror, Draft, Lexical) keep their own model and
      // follow beforeinput; replacing innerText would desync or break them.
      try {
        el.focus();
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        if (document.execCommand('insertText', false, text) && valueHas(el.innerText, text)) return true;
      } catch (e) {}
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      return true;
    }
    var proto = (el.tagName === 'TEXTAREA')
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    try {
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
    } catch (e) { try { el.value = text; } catch (e2) { return false; } }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function isRealField(el) {
    if (!el || !el.isConnected) return false;
    var tag = el.tagName;
    if (isCodeEditor(el)) return true;
    if (el.isContentEditable) return true;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    if (el.disabled || el.readOnly) return false;
    var t = (el.type || 'text').toLowerCase();
    if (/^(hidden|submit|button|reset|checkbox|radio|image|file|range|color)$/.test(t)) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    try {
      var s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
    } catch (e) {}
    return true;
  }

  // The field the agent meant when the named mark is not typable: prefer one
  // inside the topmost dialog, then a label match.
  function bestField(hint) {
    var want = String(hint == null ? '' : hint).replace(/\\s+/g, ' ').trim().toLowerCase();
    var all = document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"]');
    var top = null;
    try {
      var dlgs = document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]');
      for (var d = 0; d < dlgs.length; d++) {
        var dr = dlgs[d].getBoundingClientRect();
        if (dr.width > 60 && dr.height > 60) top = dlgs[d];
      }
    } catch (e) {}

    var best = null, bestScore = -1;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!isRealField(el)) continue;
      var score = 0;
      var r = el.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight) score += 30;
      if (top && top.contains(el)) score += 60;
      var label = ((el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' +
                   (el.name || '') + ' ' + (el.id || '')).toLowerCase();
      if (want && label.indexOf(want) !== -1) score += 40;
      if (want && want.length > 3 && label.indexOf(want.slice(0, 4)) !== -1) score += 10;
      score += Math.min(20, r.width / 40);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function typeInto(n, text, hint) {
    var el = markEl(n);
    var retargeted = false;
    if (!isRealField(el)) {
      var alt = bestField(hint);
      if (!alt) {
        return { success: false, error: 'there is no text field on this page to type into' };
      }
      retargeted = el !== alt;
      el = alt;
    }
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    try { el.focus({ preventScroll: true }); } catch (e) {}
    if (!setFieldValue(el, text)) return { success: false, error: 'could not set the field value' };

    // Some autocompletes only query on a key event, not on input alone.
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    } catch (e) {}

    // Editors keep text in JS, so el.value is empty even on success.
    var got = isCodeEditor(el) ? (editorValue(el) || '')
            : el.isContentEditable ? (el.innerText || '') : (el.value || '');
    var ok = valueHas(got, text);
    var kind = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : '';
    var out = {
      success: ok,
      retargeted: retargeted,
      value: String(got).slice(0, 80),
      field: isCodeEditor(el) ? 'code editor'
           : (el.placeholder || el.getAttribute('aria-label') || el.name || el.tagName)
    };
    // The browser drops values these inputs cannot parse, leaving them empty.
    if (!ok && FORMAT_HINTS[kind]) out.error = 'this is a ' + kind + ' field; it only accepts ' + FORMAT_HINTS[kind];
    return out;
  }

  var FORMAT_HINTS = {
    date: 'YYYY-MM-DD', time: 'HH:MM (24-hour)', 'datetime-local': 'YYYY-MM-DDTHH:MM',
    month: 'YYYY-MM', week: 'YYYY-Www', number: 'plain digits', email: 'an email address'
  };

  // What the focused field (inside shadow roots too) currently holds.
  function activeValue() {
    var a = deepActive();
    if (!a || a === document.body || a === document.documentElement) return null;
    if (isCodeEditor(a)) return editorValue(a);
    if (a.isContentEditable) return a.innerText || '';
    return a.value == null ? null : String(a.value);
  }

  function fieldValue(n) {
    var el = markEl(n);
    if (!el || !el.isConnected) return null;
    if (isCodeEditor(el)) return editorValue(el);
    return el.isContentEditable ? (el.innerText || '') : (el.value == null ? null : String(el.value));
  }

  // mark() only covers the viewport; find a labelled control anywhere in the
  // document and scroll it into view so a pointer click can follow.
  function findActionable(wanted) {
    var want = String(wanted == null ? '' : wanted).replace(/\\s+/g, ' ').trim().toLowerCase();
    if (!want) return { found: false };

    var all = allElements();
    var best = null, bestScore = -1;
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (!mayCarry(c, want)) continue;
      if (inOverlay(c) || !isRendered(c) || isDisabled(c)) continue;
      if (!isActivatable(c)) continue;
      var t = labelText(c);
      if (!t || t.indexOf(want) === -1) continue;
      var r = c.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      var score = 200 - Math.min(120, t.length - want.length);
      if (r.top >= 0 && r.bottom <= window.innerHeight) score += 15;
      if (best && containsDeep(best, c)) score += 8;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return { found: false };

    var before = window.scrollY;
    try { best.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    var r2 = best.getBoundingClientRect();
    var p = probe(best, r2);
    return {
      found: true,
      x: Math.round(p.x),
      y: Math.round(p.y),
      hitsTarget: p.hitsTarget !== false,
      disabled: isDisabled(best),
      tag: best.tagName,
      scrolledBy: Math.round(window.scrollY - before)
    };
  }

  // Records where the next real click lands. A click can reach its control
  // and change nothing visible (a counter, a request, a delayed update); only
  // a click that never arrived may be repeated through the DOM, or "Add to
  // cart" would be pressed twice.
  function armClick() {
    window.__grolSoM._clickPath = null;
    if (!window.__grolClickTap) {
      window.__grolClickTap = function (e) {
        if (e.isTrusted && window.__grolSoM) window.__grolSoM._clickPath = e.composedPath();
      };
      window.addEventListener('click', window.__grolClickTap, true);
    }
    return true;
  }

  function clickReached(n, wanted) {
    var path = window.__grolSoM._clickPath;
    if (!path) return false;
    var el = n > 0 ? markEl(n) : null;
    if (el && path.indexOf(el) !== -1) return true;
    var want = String(wanted == null ? '' : wanted).replace(/\\s+/g, ' ').trim().toLowerCase();
    if (!want) return false;
    for (var i = 0; i < path.length && i < 8; i++) {
      var node = path[i];
      if (!node || node.nodeType !== 1) continue;
      var t = labelText(node);
      if (t && t.indexOf(want) !== -1 && t.length <= want.length + 40) return true;
    }
    return false;
  }

  // Would a click at (x, y) right now reach a control with this label?
  // Lazy-loading pages reflow between resolving a point and clicking it.
  function pointHits(x, y, wanted) {
    var want = String(wanted == null ? '' : wanted).replace(/\\s+/g, ' ').trim().toLowerCase();
    var hit = null;
    try { hit = deepHit(x, y); } catch (e) { return false; }
    if (!hit) return false;
    if (!want) return true;
    // The hit is often an inner span of the control, so walk up a little.
    var n = hit, hops = 0;
    while (n && hops++ < 5) {
      var t = labelText(n);
      if (t && t.indexOf(want) !== -1 && t.length <= want.length + 40) return true;
      n = parentOf(n);
    }
    return false;
  }

  function activateMark(n, wanted) {
    var el = markEl(n);
    var want = String(wanted == null ? '' : wanted).replace(/\\s+/g, ' ').trim().toLowerCase();

    if (!el || !el.isConnected) {
      return want ? activateText(wanted) : { success: false, error: 'mark ' + n + ' is gone' };
    }

    // 1. The innermost descendant that both carries the wanted label and is
    //    actually activatable - the real button inside the bar.
    var target = null;
    if (want) {
      var cands = el.querySelectorAll('*');
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (!mayCarry(c, want)) continue;
        var t = labelText(c);
        if (!t || t.indexOf(want) === -1) continue;
        if (!isActivatable(c)) continue;
        var r = c.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // Deepest match wins: it is the tightest control carrying the label.
        if (!target || target.contains(c)) target = c;
      }
    }
    // 2. Otherwise the element itself if it is activatable, else its nearest
    //    activatable ancestor (the <a> that wraps a padded nav <span>).
    if (!target) {
      if (isActivatable(el)) target = el;
      else {
        var p = el.parentElement, hops = 0;
        while (p && hops++ < 6) { if (isActivatable(p)) { target = p; break; } p = p.parentElement; }
      }
    }
    if (!target) target = el;

    var out = fireActivation(target);
    out.via = target === el ? 'self' : 'inner';
    return out;
  }

  window.__grolSoM = {
    version: ${SOM_VERSION},
    docId: DOC_ID,
    mark: mark,
    analyze: analyze,
    resolveMark: resolveMark,
    focusMark: focusMark,
    activateMark: activateMark,
    activateText: activateText,
    findActionable: findActionable,
    armClick: armClick,
    clickReached: clickReached,
    pointHits: pointHits,
    typeInto: typeInto,
    fieldValue: fieldValue,
    activeValue: activeValue,
    valueHas: valueHas,
    selectOption: selectOption,
    rangePlan: rangePlan,
    rangeRead: rangeRead,
    rangeFocus: rangeFocus,
    rangeForce: rangeForce,
    findText: findText,
    _els: []
  };
  return 'installed';
})()
`;

const CURSOR_SCRIPT = `
(function () {
  if (window.__grolCursor && window.__grolCursor.version === ${CURSOR_VERSION}) { return 'already'; }
  if (window.__grolCursor) { try { window.__grolCursor.hide(); } catch (e) {} }
  var ID = '__grol_cursor__';

  function node() {
    var el = document.getElementById(ID);
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.id = ID;
    el.setAttribute('data-grol-overlay', '1');
    el.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:26px', 'height:26px',
      'margin-left:-13px', 'margin-top:-13px', 'border-radius:50%',
      'border:3px solid #2563EB', 'background:rgba(37,99,235,.22)',
      'box-shadow:0 0 18px rgba(37,99,235,.75)', 'pointer-events:none',
      'z-index:2147483647', 'will-change:transform',
      'transition:transform 380ms cubic-bezier(.33,.9,.36,1)',
      'transform:translate3d(-100px,-100px,0)'
    ].join(';');
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  var state = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  function place(x, y) {
    var el = node();
    el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    state.x = x; state.y = y;
  }

  // A CSS transition, returned immediately: rAF can be throttled to ~1fps
  // and the cosmetic cursor must never delay an action.
  function moveTo(x, y, duration) {
    var el = node();
    var dur = Math.max(120, Math.min(duration || 380, 900));
    el.style.transition = 'transform ' + dur + 'ms cubic-bezier(.33,.9,.36,1)';
    place(x, y);
    return { x: x, y: y, duration: dur };
  }

  function pulse() {
    var el = node();
    el.style.background = 'rgba(239,68,68,.45)';
    el.style.borderColor = '#EF4444';
    setTimeout(function () {
      el.style.background = 'rgba(37,99,235,.22)';
      el.style.borderColor = '#2563EB';
    }, 220);
    return true;
  }

  function hide() {
    var el = document.getElementById(ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    return true;
  }

  window.__grolCursor = { version: ${CURSOR_VERSION}, moveTo: moveTo, pulse: pulse, hide: hide };
  place(state.x, state.y);
  return 'installed';
})()
`;

export { SOM_SCRIPT, CURSOR_SCRIPT, SOM_VERSION, CURSOR_VERSION };
