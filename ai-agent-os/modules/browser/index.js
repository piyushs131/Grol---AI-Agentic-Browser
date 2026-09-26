const { CapabilityModule } = require('../../shared/schemas/capability-schema');
const { PathPolicy } = require('../filesystem');

let playwright = null;
try {
  playwright = require('playwright');
} catch {}

const BROWSER_TYPES = ['chromium', 'firefox', 'webkit'];   // Playwright's engine names
const DEFAULT_BROWSER = BROWSER_TYPES[0];
// file: and friends would let a page read local files and bypass the
// filesystem module's protections.
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

function toUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('URL is required');
  if (url.trim() === 'about:blank') return 'about:blank';
  let parsed;
  try { parsed = new URL(url.trim()); } catch (_) { throw new Error(`Invalid URL: ${url}`); }
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) throw new Error(`Only http(s) URLs can be opened, not ${parsed.protocol}`);
  return parsed.href;
}

function toBrowserType(browserType = DEFAULT_BROWSER) {
  const t = String(browserType).toLowerCase();
  if (!BROWSER_TYPES.includes(t)) throw new Error(`browserType must be one of ${BROWSER_TYPES.join(', ')}`);
  return t;
}

function toMs(value, fallback, max = 120000) {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n) || n < 0) return fallback;
  return Math.min(max, Math.round(n));
}

function requireSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('Selector is required');
  return selector;
}

class BrowserModule extends CapabilityModule {
  constructor() {
    super('browser', 'Browser automation via Playwright');
    this.browser = null;
    this.contexts = new Map();
    this.pages = new Map();
    this.pageCounter = 0;
  }

  async initialize(context = {}) {
    await super.initialize(context);
    this.paths = new PathPolicy({ platform: context.platform || process.platform, home: context.homeDir });

    this.registerAction('launch', this.launch, {
      description: 'Launch a browser instance',
      parameters: ['browserType', 'headless'],
      riskLevel: 'medium'
    });

    this.registerAction('openURL', this.openURL, {
      description: 'Open a URL in a new or existing page',
      parameters: ['url', 'pageId'],
      riskLevel: 'medium'
    });

    this.registerAction('click', this.click, {
      description: 'Click an element by CSS selector',
      parameters: ['selector', 'pageId'],
      riskLevel: 'medium'
    });

    this.registerAction('type', this.type, {
      description: 'Type text into an input element',
      parameters: ['selector', 'text', 'pageId'],
      riskLevel: 'medium'
    });

    this.registerAction('extractText', this.extractText, {
      description: 'Extract text content from an element',
      parameters: ['selector', 'pageId'],
      riskLevel: 'low'
    });

    this.registerAction('extractHTML', this.extractHTML, {
      description: 'Extract HTML content from a page or element',
      parameters: ['selector', 'pageId'],
      riskLevel: 'low'
    });

    this.registerAction('screenshot', this.screenshot, {
      description: 'Take a screenshot of the current page',
      parameters: ['pageId', 'path', 'fullPage'],
      riskLevel: 'low'
    });

    this.registerAction('waitForSelector', this.waitForSelector, {
      description: 'Wait for an element to appear',
      parameters: ['selector', 'pageId', 'timeout'],
      riskLevel: 'low'
    });

    this.registerAction('evaluate', this.evaluate, {
      description: 'Execute JavaScript in the page context',
      parameters: ['script', 'pageId'],
      riskLevel: 'high'
    });

    this.registerAction('uploadFile', this.uploadFile, {
      description: 'Upload a file to a file input element',
      parameters: ['selector', 'filePath', 'pageId'],
      riskLevel: 'high'
    });

    this.registerAction('getPages', this.getPages, {
      description: 'List all open browser pages',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('closePage', this.closePage, {
      description: 'Close a browser page',
      parameters: ['pageId'],
      riskLevel: 'low'
    });

    this.registerAction('close', this.closeBrowser, {
      description: 'Close the browser instance',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('scroll', this.scroll, {
      description: 'Scroll the page',
      parameters: ['direction', 'amount', 'pageId'],
      riskLevel: 'low'
    });

    this.registerAction('select', this.select, {
      description: 'Select an option from a dropdown',
      parameters: ['selector', 'value', 'pageId'],
      riskLevel: 'medium'
    });

    this.registerAction('hover', this.hover, {
      description: 'Hover over an element',
      parameters: ['selector', 'pageId'],
      riskLevel: 'low'
    });
  }

  async shutdown() {
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
    }
    this.contexts.clear();
    this.pages.clear();
    await super.shutdown();
  }

  async _ensureBrowser(browserType = DEFAULT_BROWSER, headless = false) {
    if (!playwright) throw new Error('Playwright is not installed. Run: npm install playwright');
    if (!this.browser || !this.browser.isConnected()) {
      this.pages.clear();
      this.contexts.clear();
      this.browser = await playwright[browserType].launch({ headless });
    }
    return this.browser;
  }

  async _newPage() {
    const browser = await this._ensureBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageId = `page_${++this.pageCounter}`;
    this.pages.set(pageId, page);
    this.contexts.set(pageId, context);
    return { page, pageId };
  }

  _page(pageId) {
    if (!playwright) throw new Error('Playwright is not installed. Run: npm install playwright');
    const page = this.pages.get(pageId);
    if (!page) throw new Error(`Page '${pageId}' not found`);
    return page;
  }

  async launch({ browserType = DEFAULT_BROWSER, headless = false } = {}) {
    const type = toBrowserType(browserType);
    const wantHeadless = headless === true || headless === 'true';
    await this._ensureBrowser(type, wantHeadless);
    return { launched: true, browserType: type, headless: wantHeadless };
  }

  async openURL({ url, pageId } = {}) {
    const target = toUrl(url);
    const tab = pageId && this.pages.has(pageId)
      ? { page: this.pages.get(pageId), pageId }
      : await this._newPage();

    await tab.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { url: target, title: await tab.page.title(), pageId: tab.pageId };
  }

  async click({ selector, pageId } = {}) {
    requireSelector(selector);
    const page = this._page(pageId);
    await page.click(selector, { timeout: 10000 });
    return { clicked: selector, pageId };
  }

  async type({ selector, text, pageId } = {}) {
    requireSelector(selector);
    if (text === undefined || text === null) throw new Error('Selector and text are required');
    const value = String(text);
    const page = this._page(pageId);
    await page.fill(selector, value);
    return { typed: true, selector, textLength: value.length, pageId };
  }

  async extractText({ selector, pageId } = {}) {
    const page = this._page(pageId);
    const text = selector
      ? await page.textContent(selector)
      : await page.evaluate(() => document.body.innerText);
    return { text: text?.substring(0, 10000), selector, pageId };
  }

  async extractHTML({ selector, pageId } = {}) {
    const page = this._page(pageId);
    const html = selector ? await page.innerHTML(selector) : await page.content();
    return { html: html?.substring(0, 50000), selector, pageId };
  }

  async screenshot({ pageId, path: savePath, fullPage = true } = {}) {
    const page = this._page(pageId);
    const safePath = savePath ? this.paths.resolve(savePath) : null;
    const buffer = await page.screenshot(safePath ? { fullPage: !!fullPage, path: safePath } : { fullPage: !!fullPage });
    return {
      pageId,
      saved: !!safePath,
      path: safePath,
      size: buffer.length,
      base64: safePath ? undefined : buffer.toString('base64')
    };
  }

  async waitForSelector({ selector, pageId, timeout } = {}) {
    requireSelector(selector);
    const page = this._page(pageId);
    await page.waitForSelector(selector, { timeout: toMs(timeout, 10000) });
    return { found: true, selector, pageId };
  }

  async evaluate({ script, pageId } = {}) {
    if (typeof script !== 'string' || !script.trim()) throw new Error('Script is required');
    const page = this._page(pageId);
    const result = await page.evaluate(script);
    return { result, pageId };
  }

  // Uploading hands a local file to a web page, so the same path rules apply
  // as for reading it through the filesystem module.
  async uploadFile({ selector, filePath, pageId } = {}) {
    if (!selector || !filePath) throw new Error('Selector and filePath are required');
    const safePath = this.paths.resolve(filePath);
    const page = this._page(pageId);
    await page.setInputFiles(selector, safePath);
    return { uploaded: true, selector, filePath: safePath, pageId };
  }

  async getPages() {
    const pages = [];
    for (const [id, page] of this.pages) {
      try {
        pages.push({
          pageId: id,
          url: page.url(),
          title: await page.title()
        });
      } catch {
        this.pages.delete(id);
      }
    }
    return { pages, count: pages.length };
  }

  async closePage({ pageId } = {}) {
    const page = this._page(pageId);
    const context = this.contexts.get(pageId);
    this.pages.delete(pageId);
    this.contexts.delete(pageId);
    try { await page.close(); } catch {}
    if (context) { try { await context.close(); } catch {} }
    return { closed: true, pageId };
  }

  async closeBrowser() {
    const browser = this.browser;
    this.browser = null;
    this.pages.clear();
    this.contexts.clear();
    if (browser) await browser.close();
    return { closed: true };
  }

  async scroll({ direction = 'down', amount = 500, pageId } = {}) {
    const dir = String(direction).toLowerCase();
    if (!['up', 'down'].includes(dir)) throw new Error("direction must be 'up' or 'down'");
    const px = Number(amount);
    if (!Number.isFinite(px) || px < 0) throw new Error('amount must be a non-negative number of pixels');
    const page = this._page(pageId);
    await page.evaluate((y) => window.scrollBy(0, y), dir === 'up' ? -px : px);
    return { scrolled: true, direction: dir, amount: px, pageId };
  }

  async select({ selector, value, pageId } = {}) {
    requireSelector(selector);
    if (value === undefined || value === null) throw new Error('Selector and value are required');
    const page = this._page(pageId);
    await page.selectOption(selector, value);
    return { selected: true, selector, value, pageId };
  }

  async hover({ selector, pageId } = {}) {
    requireSelector(selector);
    const page = this._page(pageId);
    await page.hover(selector);
    return { hovered: true, selector, pageId };
  }
}

module.exports = BrowserModule;
module.exports.__test = { toUrl, toBrowserType, toMs, hasPlaywright: () => !!playwright };
