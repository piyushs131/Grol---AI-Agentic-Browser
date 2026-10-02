
import { SOM_SCRIPT } from './page-scripts.js';
import { drawMarks } from './mark-render.js';
import { pageFlags } from './vision-helpers.js';

const SLIDERS_JS = `
  Array.prototype.slice.call(document.querySelectorAll('input[type=range]'))
    .filter(function (r) { var b = r.getBoundingClientRect(); return b.width > 0 || (r.parentElement && r.parentElement.getBoundingClientRect().width > 0); })
    .slice(0, 6)
    .map(function (r) { return { label: r.getAttribute('aria-label') || r.name || r.id || 'slider',
                                 shows: r.getAttribute('aria-valuetext') || r.value }; })
`;

const PASSWORD_JS = `
  (function () {
    var f = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < f.length; i++) {
      var r = f[i].getBoundingClientRect();
      if (r.width > 20 && r.height > 8 && f[i].getClientRects().length) return true;
    }
    return false;
  })()
`;

const SIGN_IN_JS = `
  (function () {
    var title = document.title || '';
    var body = (document.body && document.body.innerText || '');
    var wants = /sign[-\\s]?in|log[-\\s]?in|choose an account|use another account/i;
    var f = document.querySelectorAll(
      'input[type="email"],input[name="identifier"],input[autocomplete="username"],' +
      'input[type="tel"],input[autocomplete="one-time-code"],' +
      'input[name*="otp" i],input[id*="otp" i],input[placeholder*="mobile" i],' +
      'input[placeholder*="phone" i]');
    for (var i = 0; i < f.length; i++) {
      var r = f[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 8 && f[i].getClientRects().length) return true;
    }
    if (wants.test(title) && body.replace(/\\s+/g, ' ').trim().length < 1500) return true;
    return false;
  })()
`;

const PAY_URL_PARTS = ['/checkout/payment', 'payment', 'razorpay', 'paytm', '/upi', 'billdesk', 'stripe.com/pay'];
const ACCOUNT_HOSTS = [
  'accounts.google.com', 'accounts.youtube.com',
  'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'
];

const hostOf = (url) => { try { return new URL(url).hostname; } catch (_) { return ''; } };

export class PageObserver {
  constructor({ target, logger }) {
    this.target = target;
    this.logger = logger;
  }

  async observe() {
    const target = this.target;
    try {
      await target.ensureDisplayed();
      await target.executeJS(SOM_SCRIPT, { timeout: 6000 });

      const analysis = await target
        .executeJS('window.__grolSoM.analyze()', { timeout: 9000 })
        .catch((err) => {
          this.logger?.warn('[Agent] page analysis failed: ' + err.message);
          return null;
        });

      const marked = await target.executeJS('window.__grolSoM.mark()', { timeout: 12000 });
      const sliders = await target.executeJS(SLIDERS_JS, { timeout: 3000 }).catch(() => []);

      const marks = (marked && Array.isArray(marked.marks)) ? marked.marks : [];
      const shot = await drawMarks(await target.capture(), marks);
      if (!shot) return null;

      const counts = (marked && marked.counts) || {};
      this.logger?.info(
        `[Agent] observed ${marks.length} elements ` +
        `(${counts.disabled || 0} disabled, ${counts.covered || 0} covered, ` +
        `${counts.below || 0} below the fold), ` +
        `shot ${shot.imageWidth}x${shot.imageHeight} (css ${shot.cssWidth}x${shot.cssHeight}), ` +
        `${Math.round((shot.bytes || 0) / 1024)}KB, ` +
        `text ${(analysis?.onScreenText || '').length} chars`
      );
      const flagged = pageFlags(analysis);
      if (flagged) this.logger?.info('[Agent] page state: ' + flagged);

      return {
        url: target.getURL(),
        docId: (marked && marked.docId) || null,
        shot,
        analysis,
        counts,
        blockers: (marked && marked.blockers) || [],
        menus: (marked && marked.menus) || [],
        sliders: Array.isArray(sliders) ? sliders : [],
        marks,
        scroll: (marked && marked.scroll) || analysis?.scroll || { y: 0, maxY: 0 },
        viewport: (marked && marked.viewport) || { w: shot.cssWidth, h: shot.cssHeight }
      };
    } catch (err) {
      this.logger?.error('[Agent] observe failed: ' + err.message);
      return null;
    }
  }

  async detectSensitiveScreen(url) {
    const u = String(url || '').toLowerCase();
    const isPay = PAY_URL_PARTS.some((p) => u.includes(p));

    const hasPassword = await this.target.executeJS(PASSWORD_JS).catch(() => false);
    if (hasPassword === true) {
      return {
        kind: 'signin',
        message: 'This page is asking for a password. Please sign in yourself — ' +
                 'the agent will never type credentials. Click "I\'m done" when finished.'
      };
    }

    const host = hostOf(url);
    const onAccountHost = ACCOUNT_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    const signInWall = onAccountHost || (await this.target.executeJS(SIGN_IN_JS).catch(() => false)) === true;
    if (signInWall) {
      return {
        kind: 'signin',
        message: 'This site wants you to sign in, and the agent never types ' +
                 'credentials. Please sign in yourself in this tab — for Google, ' +
                 'the ⋮ menu → import your Chrome session works best — then click ' +
                 '"I\'m done" and I will carry on from here.'
      };
    }
    if (isPay) {
      return {
        kind: 'payment',
        message: 'This is a payment screen. Please complete the payment yourself, ' +
                 'then click "I\'m done".'
      };
    }
    return null;
  }
}
