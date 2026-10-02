import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { parseFilter, selectorProblem } from '../../browser/agent-extension/adblock/filter-parser.js';
import { buildRules, PRIORITY } from '../../browser/agent-extension/adblock/dnr-rules.js';
import {
  buildCosmetic, createCosmeticLookup, genericCss, parseGenericCss, hidingCss, excludeMatchesFor, withRuntimeGeneric
} from '../../browser/agent-extension/adblock/cosmetic-filters.js';
import { convertLists, domainsToFilters } from '../../browser/agent-extension/adblock/convert.js';
import { createCosmeticInjector, COSMETIC_MESSAGE } from '../../browser/agent-extension/adblock/cosmetic-inject.js';
import { createListStore, refreshLists, isStale, REFRESH_MS } from '../../browser/agent-extension/adblock/updater.js';
import {
  composeRules, replaceDynamicRules, neverBlockRules, createAdblocker
} from '../../browser/agent-extension/adblock/network.js';
import { LISTS, NEVER_BLOCK } from '../../browser/agent-extension/adblock/sources.js';
import { converterHash, GENERIC_CSS } from '../../browser/scripts/update-adblock-lists.mjs';

const EXT = new URL('../../browser/agent-extension/', import.meta.url);
const read = (p) => readFileSync(new URL(p, EXT), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const YT_MAIN = read('adblock/youtube-main.js');
const GOOGLE_JS = read('adblock/google.js');

function createMatcher(rules) {
  const site = (h) => h.split('.').slice(-2).join('.');
  const under = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));
  const toRegExp = (filter, caseSensitive) => {
    let s = filter;
    let src = '';
    if (s.startsWith('||')) { src = '^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?'; s = s.slice(2); } else if (s.startsWith('|')) { src = '^'; s = s.slice(1); }
    const end = s.endsWith('|');
    if (end) s = s.slice(0, -1);
    src += [...s].map((c) => (c === '*' ? '.*' : c === '^' ? '(?:[^a-zA-Z0-9_.%-]|$)' : c.replace(/[.+?${}()[\]\\/|]/g, '\\$&'))).join('');
    return new RegExp(src + (end ? '$' : ''), caseSensitive ? '' : 'i');
  };
  const compiled = rules.map((r) => {
    const c = r.condition;
    const re = c.regexFilter ? new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i') : c.urlFilter ? toRegExp(c.urlFilter, c.isUrlFilterCaseSensitive) : null;
    return { r, re };
  });
  const matches = ({ r, re }, url, type, initiator) => {
    const c = r.condition;
    const host = new URL(url).hostname;
    const from = initiator ? new URL(initiator).hostname : null;
    if (c.requestDomains && !under(host, c.requestDomains)) return false;
    if (c.initiatorDomains && !(from && under(from, c.initiatorDomains))) return false;
    if (c.excludedInitiatorDomains && from && under(from, c.excludedInitiatorDomains)) return false;
    if (c.resourceTypes ? !c.resourceTypes.includes(type) : (c.excludedResourceTypes || ['main_frame']).includes(type)) return false;
    if (c.domainType && (c.domainType === 'thirdParty') !== (!!from && site(from) !== site(host))) return false;
    return re ? re.test(url) : true;
  };
  const RANK = { allow: 3, allowAllRequests: 2, block: 1 };
  return (url, type = 'script', initiator = null) => {
    const hits = compiled.filter((x) => x.r.action.type !== 'allowAllRequests' && matches(x, url, type, initiator));
    if (initiator && type !== 'main_frame') {
      hits.push(...compiled.filter((x) => x.r.action.type === 'allowAllRequests' && matches(x, initiator, 'main_frame', null)));
    }
    hits.sort((a, b) => (b.r.priority - a.r.priority) || (RANK[b.r.action.type] - RANK[a.r.action.type]));
    return hits[0] ? hits[0].r.action.type : null;
  };
}
const blocks = (rules, ...req) => createMatcher(rules)(...req) === 'block';

describe('filter parser', () => {
  const net = (line) => { const f = parseFilter(line); assert.equal(f.kind, 'network', line); return f; };
  const skipped = (line) => { const f = parseFilter(line); assert.equal(f.kind, 'skip', line); return f.reason; };

  test('comments, headers and blank lines are ignored', () => {
    for (const line of ['', '   ', '! Title: EasyList', '[Adblock Plus 2.0]']) assert.equal(parseFilter(line).kind, 'comment');
  });

  test('domain anchors become groupable domain filters', () => {
    assert.equal(net('||doubleclick.net^').domain, 'doubleclick.net');
    assert.equal(net('||ads.example.com^$third-party').party, 'thirdParty');
    assert.equal(net('||Tracker.Example.COM^').domain, 'tracker.example.com');
    assert.equal(net('||example.com/').domain, 'example.com');
    assert.equal(net('||example.com/ads/').domain, null, 'a path is not a domain block');
    assert.equal(net('||example.com/ads/').pattern, '||example.com/ads/');
  });

  test('paths, wildcards, separators and anchors keep DNR urlFilter syntax', () => {
    assert.equal(net('/banner/ads/*').pattern, '/banner/ads/');
    assert.equal(net('*/adsbygoogle.js').pattern, '/adsbygoogle.js');
    assert.equal(net('-ad-300x250.').pattern, '-ad-300x250.');
    assert.equal(net('|https://ads.').pattern, '|https://ads.');
    assert.equal(net('.com/ads.js|').pattern, '.com/ads.js|');
    assert.equal(net('||cdn.example.com^*/ad-*.js').pattern, '||cdn.example.com^*/ad-*.js');
    assert.equal(net('/Ad/Banner.$match-case').pattern, '/Ad/Banner.');
    assert.equal(net('/Ad/Banner.').pattern, '/ad/banner.', 'case-insensitive filters are lower-cased');
  });

  test('options: types, negated types, party, domains, important, match-case', () => {
    const f = net('||example.com/ad.js$script,image,subdocument,third-party,domain=a.com|~b.a.com,important');
    assert.deepEqual(f.types, ['script', 'image', 'sub_frame']);
    assert.equal(f.party, 'thirdParty');
    assert.deepEqual([f.include, f.exclude], [['a.com'], ['b.a.com']]);
    assert.equal(f.important, true);
    assert.deepEqual(net('/ads.$~script,~xmlhttprequest').excludedTypes, ['script', 'xmlhttprequest']);
    assert.equal(net('/track.$~third-party').party, 'firstParty');
    assert.equal(net('/track.$1p').party, 'firstParty');
    assert.deepEqual(net('/x.$css,xhr,frame,doc').types, ['stylesheet', 'xmlhttprequest', 'sub_frame', 'main_frame']);
    assert.equal(net('/Ad.$match-case').matchCase, true);
    assert.deepEqual(net('||xn--80ak6aa92e.com^').domain, 'xn--80ak6aa92e.com');
  });

  test('exceptions, including page-level and cosmetic-only ones', () => {
    const allow = net('@@||example.com/ads.js$script');
    assert.equal(allow.exception, true);
    assert.deepEqual(net('@@||example.com^$document').types, ['main_frame']);
    assert.equal(net('@@||example.com^$generichide').cosmetic, 'generichide');
    assert.equal(net('@@||example.com^$elemhide').cosmetic, 'elemhide');
    assert.equal(skipped('||example.com^$elemhide'), 'cosmetic-option');
  });

  test('regular expressions: supported ones kept, RE2-incompatible ones skipped', () => {
    assert.equal(net('/^https?:\\/\\/[a-z]{8}\\.com\\/ads/$script').regex, '^https?:\\/\\/[a-z]{8}\\.com\\/ads');
    assert.equal(skipped('/ads(?=banner)/'), 'regex-unsupported');
    assert.equal(skipped('/(ad)\\1/'), 'regex-unsupported');
  });

  test('unsupported syntax is skipped with a reason, never half-converted', () => {
    const cases = {
      '||example.com^$popup': 'popup',
      '||example.com^$csp=script-src none': 'csp',
      '||example.com/ads.js$script,redirect=noopjs': 'redirect',
      '||example.com^$removeparam=utm_source': 'removeparam',
      '||example.com/a.js$rewrite=abp-resource:blank-js': 'rewrite',
      '||example.com^$denyallow=x.com': 'denyallow',
      '||example.com^$badfilter': 'badfilter',
      '||example.com^$someday-option': 'unknown-option',
      '||example.com^$domain=example.*': 'entity-domain',
      '*$ping,third-party': 'too-broad',
      '/addyn|*|adtech;': 'invalid-pattern',
      'example.com##+js(set, ads, false)': 'scriptlet',
      'example.com#%#window.x=1': 'scriptlet',
      'example.com#$#body { overflow: auto }': 'css-injection',
      'example.com##.header {top:0 !important}': 'css-injection',
      'example.com#?#.ad:-abp-has(.x)': 'procedural',
      'example.com##.post:has-text(Sponsored)': 'procedural',
      'example.com##:xpath(//div)': 'procedural',
      'example.com##.ad:upward(2)': 'procedural',
      'example.com##.ad:style(display:none)': 'procedural',
      'example.com##.ad:remove()': 'procedural',
      'example.com##^script:has-text(ad)': 'html-filter',
      'example.com$$script[data-ad]': 'html-filter',
      'example.com##.ad:matches-whatever(1)': 'unsupported-pseudo'
    };
    for (const [line, reason] of Object.entries(cases)) assert.equal(skipped(line), reason, line);
  });

  test('cosmetic filters: generic, site-specific, exceptions, :has(), any-TLD domains', () => {
    assert.deepEqual(parseFilter('##.ad-banner'), { kind: 'cosmetic', exception: false, selector: '.ad-banner', include: [], exclude: [] });
    const specific = parseFilter('example.com,~shop.example.com###sidebar-ad');
    assert.deepEqual([specific.selector, specific.include, specific.exclude], ['#sidebar-ad', ['example.com'], ['shop.example.com']]);
    assert.equal(parseFilter('example.com#@#.ad-banner').exception, true);
    assert.equal(parseFilter('example.com##div:has(> .sponsored)').selector, 'div:has(> .sponsored)');
    assert.deepEqual(parseFilter('amazon.*##.kw-ads').include, ['amazon.*']);
    assert.equal(parseFilter('##a[href^="https://ad.example/"]').kind, 'cosmetic');
  });

  test('selector checks reject anything that could escape a CSS rule', () => {
    for (const bad of ['.a{}', '.a } body { display:none', '.a /* x', '.a[b="c"', 'div:not(.x', '.a)', 'a"b']) {
      assert.ok(selectorProblem(bad), bad);
    }
    for (const good of ['.ad', '#top-ad', 'div[id^="div-gpt-ad"]', 'a[href*="x)y"]', 'div:not(.x) > span:nth-child(2n+1)',
      '.bg-white\\/50', 'div:has(> a[href*="ads"])', 'div::before']) {
      assert.equal(selectorProblem(good), null, good);
    }
  });
});

describe('DNR rule building', () => {
  const filters = (lines, rank = 0) => lines.map((l) => ({ ...parseFilter(l), rank }));

  test('domain blocks with the same options share one rule; subdomains of listed domains are dropped', () => {
    const { rules } = buildRules(filters(['||ads.com^', '||tracker.net^', '||x.ads.com^', '||third.com^$third-party', '||other.com^$third-party']));
    assert.equal(rules.length, 2);
    const plain = rules.find((r) => !r.condition.domainType);
    assert.deepEqual(plain.condition.requestDomains, ['ads.com', 'tracker.net']);
    assert.equal(rules.find((r) => r.condition.domainType).condition.requestDomains.length, 2);
  });

  test('actions and priorities: exceptions beat blocks, important beats exceptions, never-block beats all', () => {
    const { rules } = buildRules(filters(['||a.com/ad.js', '@@||a.com/ad.js$script', '@@||site.com^$document', '||b.com/x.js$important']));
    const by = (u, type = 'block') => rules.find((r) => r.action.type === type && (r.condition.urlFilter === u || (r.condition.requestDomains || []).includes(u)));
    assert.equal(by('||a.com/ad.js').priority, PRIORITY.block);
    assert.equal(by('||a.com/ad.js', 'allow').priority, PRIORITY.allow);
    const page = by('site.com', 'allowAllRequests');
    assert.deepEqual([page.action.type, page.condition.resourceTypes], ['allowAllRequests', ['main_frame', 'sub_frame']]);
    assert.equal(by('||b.com/x.js').priority, PRIORITY.important);
    assert.ok(PRIORITY.neverBlock > PRIORITY.important && PRIORITY.important > PRIORITY.allow && PRIORITY.allow > PRIORITY.block);
  });

  test('conditions map ABP options onto DNR fields', () => {
    const [rule] = buildRules(filters(['/ads/*$script,third-party,domain=a.com|~b.a.com,match-case'])).rules;
    assert.deepEqual(rule.condition, {
      urlFilter: '/ads/', domainType: 'thirdParty', initiatorDomains: ['a.com'], excludedInitiatorDomains: ['b.a.com'],
      resourceTypes: ['script'], isUrlFilterCaseSensitive: true
    });
    const [neg] = buildRules(filters(['/banner.$~image'])).rules;
    assert.deepEqual(neg.condition.excludedResourceTypes, ['image', 'main_frame'], 'negated types never add top-level pages');
  });

  test('ids are unique and sequential; duplicates collapse', () => {
    const { rules } = buildRules(filters(['/ad.js', '/ad.js', '/ad2.js']));
    assert.deepEqual(rules.map((r) => r.id), [1, 2]);
  });

  test('over budget: exceptions and domain groups stay, the least valuable path rules go', () => {
    const lines = ['@@/ok.js', '||d1.com^', ...Array.from({ length: 20 }, (_, i) => `/ad${'x'.repeat(i)}.js`)];
    const trusted = filters(['/short.js$domain=site.com', '/a.js'], 0);
    const { rules, dropped } = buildRules([...trusted, ...filters(lines, 1)], { maxRules: 6 });
    assert.equal(rules.length, 6);
    assert.equal(dropped.budget, 18);
    assert.equal(rules[0].action.type, 'allow');
    assert.ok(rules.some((r) => r.condition.requestDomains));
    assert.deepEqual(rules.slice(2).map((r) => r.condition.urlFilter), ['/a.js', '/short.js', '/ad.js', '/adx.js'],
      'more trusted list first, then generic before site-only, then shorter');
  });

  test('regex rules are capped separately', () => {
    const { rules, dropped, regexCount } = buildRules(filters(['/a[0-9]/', '/b[0-9]/', '/c[0-9]/']), { maxRegexRules: 2 });
    assert.equal(regexCount, 2);
    assert.equal(dropped.regex, 1);
    assert.equal(rules.length, 2);
  });
});

describe('element hiding', () => {
  const cosmetic = (lines, hosts) => buildCosmetic(lines.map(parseFilter), hosts);

  test('generic, site-specific and exception filters end up where they apply', () => {
    const out = cosmetic([
      '##.ad', '##.promo', '##.banner', '###gone', '#@##gone',
      'news.com##.sticky-ad', 'news.com,~live.news.com##.top-ad', 'blog.com#@#.promo', '~shop.com##.side',
      'amazon.*##.kw-ads', '##div:has(> .ad)'
    ], { generichide: ['nogeneric.com'], elemhide: ['clean.com'] });
    assert.deepEqual(out.generic, ['.ad', '.banner'], 'static sheet: generic selectors nobody opts out of');
    assert.deepEqual(out.cosmetic.specific['*'].hide, ['.promo', '.side'], 'generic selectors with exceptions are applied per page');
    assert.deepEqual(out.skipped, { 'generic-has': 1 });
    const lookup = createCosmeticLookup(out.cosmetic);
    assert.deepEqual(lookup('www.news.com').sort(), ['.promo', '.side', '.sticky-ad', '.top-ad']);
    assert.deepEqual(lookup('live.news.com').sort(), ['.promo', '.side', '.sticky-ad']);
    assert.deepEqual(lookup('blog.com'), ['.side']);
    assert.deepEqual(lookup('m.shop.com'), ['.promo']);
    assert.deepEqual(lookup('www.amazon.co.uk').sort(), ['.kw-ads', '.promo', '.side']);
    assert.deepEqual(lookup('amazon.de').sort(), ['.kw-ads', '.promo', '.side']);
    assert.deepEqual(lookup('a.nogeneric.com'), []);
    assert.deepEqual(lookup('clean.com'), []);
  });

  test('generic stylesheet is chunked and round-trips; per-page CSS is one rule per selector', () => {
    const selectors = Array.from({ length: 250 }, (_, i) => `.ad-${i}`);
    const css = genericCss(selectors);
    assert.equal(css.split('{display:none!important}').length - 1, 3);
    assert.deepEqual(parseGenericCss(css), selectors);
    assert.equal(hidingCss(['.a', '#b']), '.a{display:none!important}\n#b{display:none!important}');
    assert.deepEqual(excludeMatchesFor(['x.com']), ['*://*.x.com/*']);
  });

  test('generic selectors new since the bundled sheet are added per page', () => {
    const merged = withRuntimeGeneric({ specific: { '*': { hide: ['.x'] } } }, ['.a', '.new'], ['.a']);
    assert.deepEqual(merged.specific['*'].hide, ['.new', '.x']);
  });
});

describe('list conversion', () => {
  test('merges lists, collects stats and cosmetic opt-outs', () => {
    const out = convertLists([
      { id: 'one', text: '! c\n||ads.com^\n/banner/*\n##.ad\n@@||site.com^$generichide\n||x.com^$popup' },
      { id: 'two', text: '||track.com^$third-party\n@@||page.com^$document\nnews.com##.promo' }
    ]);
    assert.deepEqual(out.stats.lists.one, { network: 2, cosmetic: 2, skipped: { popup: 1 } });
    assert.equal(out.stats.lists.two.network, 2);
    assert.deepEqual(out.cosmetic.generichide, ['site.com']);
    assert.deepEqual(out.cosmetic.elemhide, ['page.com'], '$document exceptions also turn off element hiding');
    assert.deepEqual(out.generic, ['.ad']);
    assert.equal(out.rules.length, 4);
  });

  test('curated bare domains become third-party blocks', () => {
    assert.equal(domainsToFilters('# c\nads.com\n\n tracker.net '), '||ads.com^$third-party\n||tracker.net^$third-party');
  });
});

describe('bundled lists', () => {
  const rules = JSON.parse(read('adblock/lists/rules.json'));
  const cosmeticData = JSON.parse(read('adblock/lists/cosmetic.json'));
  const meta = JSON.parse(read('adblock/lists/meta.json'));
  const curated = convertLists([{ id: 'grol', text: `${read('adblock/exceptions.txt')}\n${domainsToFilters(read('adblock/domains.txt'))}` }]).rules;
  const installed = composeRules({ lists: rules, curated, extensionId: 'abcdefghijklmnopabcdefghijklmnop' });

  test('were generated by the current converter (run browser/scripts/update-adblock-lists.mjs after changing it)', () => {
    assert.equal(meta.converter, converterHash());
    assert.deepEqual(meta.sources.map((s) => s.id), LISTS.map((l) => l.id));
    for (const s of meta.sources) assert.match(s.sha256, /^[0-9a-f]{64}$/);
    assert.equal(meta.stats.rules, rules.length);
    assert.equal(parseGenericCss(read(GENERIC_CSS)).length, meta.stats.genericSelectors);
  });

  test('are large, valid and within the browser limits', () => {
    assert.ok(rules.length > 5000 && installed.length <= 30000, `${installed.length} rules`);
    assert.deepEqual(installed.map((r) => r.id), installed.map((_, i) => i + 1));
    assert.ok(installed.filter((r) => r.condition.regexFilter).length <= 1000);
    for (const r of installed) {
      assert.ok(['block', 'allow', 'allowAllRequests'].includes(r.action.type));
      const c = r.condition;
      assert.ok(!(c.urlFilter && c.regexFilter));
      if (c.urlFilter) assert.ok(/^[\x20-\x7e]+$/.test(c.urlFilter) && !c.urlFilter.startsWith('||*'), c.urlFilter);
      for (const list of [c.requestDomains, c.initiatorDomains, c.excludedInitiatorDomains]) {
        if (list) assert.ok(list.length && list.every((d) => /^[a-z0-9.-]+$/.test(d)), JSON.stringify(list).slice(0, 80));
      }
      if (r.action.type === 'allowAllRequests') assert.deepEqual(c.resourceTypes, ['main_frame', 'sub_frame']);
    }
    const domains = rules.flatMap((r) => r.condition.requestDomains || []).length;
    assert.ok(domains > 50000, `${domains} blocked domains`);
  });

  test('never block the agent, sign-in, video playback or common sites', () => {
    const match = createMatcher(installed);
    const ok = [
      ['https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', 'xmlhttprequest', 'https://www.example.com/'],
      ['http://127.0.0.1:8765/status', 'xmlhttprequest', 'https://www.example.com/'],
      ['https://easylist.to/easylist/easylist.txt', 'xmlhttprequest', null],
      ['https://www.google.com/search?q=shoes', 'main_frame', null],
      ['https://accounts.google.com/ServiceLogin', 'main_frame', null],
      ['https://www.youtube.com/s/player/abc/player_ias.vflset/en_US/base.js', 'script', 'https://www.youtube.com/'],
      ['https://www.youtube.com/youtubei/v1/player?prettyPrint=false', 'xmlhttprequest', 'https://www.youtube.com/'],
      ['https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1', 'xmlhttprequest', 'https://www.youtube.com/'],
      ['https://i.ytimg.com/vi/abc/hqdefault.jpg', 'image', 'https://www.youtube.com/'],
      ['https://static.doubleclick.net/instream/ad_status.js', 'script', 'https://www.youtube.com/'],
      ['https://m.media-amazon.com/images/I/61abc.jpg', 'image', 'https://www.amazon.in/'],
      ['https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', 'script', 'https://www.example.com/'],
      ['https://code.jquery.com/jquery-3.7.1.min.js', 'script', 'https://www.example.com/'],
      ['https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js', 'script', 'https://www.example.com/']
    ];
    for (const req of ok) assert.notEqual(match(...req), 'block', req[0]);
    const ads = [
      ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script', 'https://www.cnn.com/'],
      ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script', 'https://www.ndtv.com/'],
      ['https://cdn.taboola.com/libtrc/x/loader.js', 'script', 'https://www.ndtv.com/'],
      ['https://www.google-analytics.com/analytics.js', 'script', 'https://www.ndtv.com/'],
      ['https://www.youtube.com/api/stats/ads?x=1', 'xmlhttprequest', 'https://www.youtube.com/'],
      ['https://www.youtube.com/pagead/viewthroughconversion/1', 'image', 'https://www.youtube.com/']
    ];
    for (const req of ads) assert.equal(match(...req), 'block', req[0]);
  });

  test('manifest skips the generic stylesheet exactly on the sites that opt out of it', () => {
    const entry = manifest.content_scripts.find((c) => (c.css || []).includes(GENERIC_CSS));
    assert.deepEqual(entry.exclude_matches, excludeMatchesFor([...new Set([...cosmeticData.elemhide, ...cosmeticData.generichide])].sort()));
  });
});

describe('installing rules', () => {
  const rule = (id, extra = {}) => ({ id, priority: 1, action: { type: 'block' }, condition: { urlFilter: `/r${id}`, ...extra } });

  function fakeDnr({ reject = () => null, regexOk = () => true } = {}) {
    const dnr = {
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000, MAX_NUMBER_OF_REGEX_RULES: 1000, rules: [], updates: 0,
      getDynamicRules: async (filter) => (filter && filter.ruleIds ? dnr.rules.filter((r) => filter.ruleIds.includes(r.id)) : dnr.rules),
      updateDynamicRules: async ({ removeRuleIds, addRules }) => {
        const bad = reject(addRules);
        if (bad) throw new Error(`Rule with id ${bad} specifies an incorrect value for the "regexFilter" key.`);
        dnr.rules = dnr.rules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
        dnr.updates++;
      },
      isRegexSupported: async ({ regex }) => ({ isSupported: regexOk(regex) })
    };
    return dnr;
  }

  test('never-block rules come first and keep the top priority', () => {
    const rules = composeRules({ lists: [rule(1)], curated: [rule(1)], extensionId: 'ext' });
    assert.deepEqual(rules.slice(0, 2).map((r) => r.action.type), ['allow', 'allow']);
    assert.ok(rules[0].condition.requestDomains.includes('generativelanguage.googleapis.com'));
    assert.ok(NEVER_BLOCK.includes('127.0.0.1') && NEVER_BLOCK.includes('easylist.to'));
    assert.deepEqual(rules[1].condition, { initiatorDomains: ['ext'] });
    assert.ok(rules.slice(0, 2).every((r) => r.priority === PRIORITY.neverBlock));
    assert.deepEqual(rules.map((r) => r.id), [1, 2, 3, 4]);
  });

  test('a smaller browser limit cuts the least valuable tail, never the protected head', () => {
    const lists = [rule(1, { urlFilter: undefined, regexFilter: 'a+' }), rule(2, { urlFilter: undefined, regexFilter: 'b+' }), rule(3), rule(4)];
    const rules = composeRules({ lists, extensionId: 'ext', maxRules: 4, maxRegexRules: 1 });
    assert.equal(rules.length, 4);
    assert.equal(rules.filter((r) => r.condition.regexFilter).length, 1);
    assert.deepEqual(rules.slice(2).map((r) => r.condition.regexFilter || r.condition.urlFilter), ['a+', '/r3']);
  });

  test('swap is atomic; a rule the browser rejects is dropped and the swap retried', async () => {
    const dnr = fakeDnr({ reject: (rules) => (rules.some((r) => r.id === 3) ? 3 : null), regexOk: (re) => re !== 'bad(' });
    dnr.rules = [rule(90), rule(91)];
    const rules = [rule(1), rule(2), rule(3), rule(4, { urlFilter: undefined, regexFilter: 'bad(' })];
    assert.equal(await replaceDynamicRules(dnr, rules, 2), 2);
    assert.deepEqual(dnr.rules.map((r) => r.id), [1, 2]);
  });

  test('if a protected rule is rejected the previous rules stay', async () => {
    const dnr = fakeDnr({ reject: () => 1 });
    dnr.rules = [rule(90)];
    await assert.rejects(replaceDynamicRules(dnr, [rule(1), rule(2)], 2));
    assert.deepEqual(dnr.rules.map((r) => r.id), [90]);
  });

  function fakeStorage(initial = {}) {
    const data = { ...initial };
    return {
      data,
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (obj) => { Object.assign(data, obj); }
    };
  }
  const listText = (n) => `[Adblock Plus 2.0]\n${Array.from({ length: n }, (_, i) => `/ad-path-${i}/*`).join('\n')}\n##.fresh-ad\n##.ad`;
  const bundle = (fetchedAt) => ({
    meta: async () => ({ fetchedAt, version: 'bundled-1' }),
    rules: async () => [rule(1), rule(2)],
    cosmetic: async () => ({ specific: { 'news.com': { hide: ['.bundled'] } }, elemhide: [], generichide: [] }),
    generic: async () => ['.ad'],
    curated: async () => '||curated.com^$third-party'
  });
  function setup({ storage = fakeStorage(), fetchedAt = Date.now(), fetchImpl, dnr = fakeDnr(), inserted = [] } = {}) {
    const listeners = [];
    const blocker = createAdblocker({
      dnr, storage, bundle: bundle(fetchedAt), extensionId: 'ext', fetchImpl: fetchImpl || (async () => { throw new Error('offline'); }),
      alarms: { onAlarm: { addListener() {} }, get: async () => null, create: async () => {} },
      onMessage: { addListener: (l) => listeners.push(l) },
      insertCSS: async (d) => { inserted.push(d); },
      logger: { log() {}, warn() {} }
    });
    return { blocker, dnr, storage, listeners, inserted };
  }
  const okFetch = (n = 1200) => async () => ({ ok: true, status: 200, text: async () => listText(n) });

  test('first start installs never-block + curated + bundled rules, later starts skip the reinstall', async () => {
    const { blocker, dnr, storage } = setup();
    const stubs = neuterRules().length;
    assert.equal(await blocker.start(), 5 + stubs);
    assert.equal(dnr.rules[2 + stubs].condition.requestDomains[0], 'curated.com');
    const again = setup({ storage, dnr });
    assert.equal(await again.blocker.start(), 5 + stubs);
    assert.equal(dnr.updates, 1, 'rules already installed for this list version');
  });

  test('stale lists are refreshed, installed and saved; the injector sees the new selectors', async () => {
    const inserted = [];
    const { blocker, dnr, storage, listeners } = setup({ fetchedAt: Date.now() - REFRESH_MS - 1, fetchImpl: okFetch(), inserted });
    await blocker.start();
    await blocker.refresh();
    assert.ok(dnr.rules.length > 1000);
    assert.ok(storage.data['adblock.meta'].fetchedAt > Date.now() - 5000);
    assert.equal(storage.data['adblock.rules'].length, dnr.rules.length - 3 - neuterRules().length);
    listeners[0]({ type: COSMETIC_MESSAGE }, { id: 'ext', tab: { id: 7 }, frameId: 0, url: 'https://any.site/page' });
    await new Promise((r) => setTimeout(r, 20));
    assert.match(inserted[0].css, /\.fresh-ad\{display:none!important\}/, 'generic selector not in the bundled sheet');
    assert.doesNotMatch(inserted[0].css, /(^|\n)\.ad\{/, 'already in the static sheet');
    assert.equal(inserted[0].origin, 'USER');
  });

  test('a failed download or install keeps the last good lists', async () => {
    for (const fetchImpl of [async () => ({ ok: false, status: 503 }), okFetch(10), async () => ({ ok: true, text: async () => '<html>captive portal</html>' })]) {
      const { blocker, dnr, storage } = setup({ fetchedAt: 0, fetchImpl });
      await blocker.start();
      const before = dnr.rules;
      await blocker.refresh();
      assert.equal(dnr.rules, before);
      assert.equal(storage.data['adblock.meta'], undefined);
    }
    const dnr = fakeDnr({ reject: (rules) => (rules.length > 100 ? 1 : null) });
    const { blocker, storage } = setup({ fetchedAt: 0, fetchImpl: okFetch(), dnr });
    await blocker.start();
    await blocker.refresh();
    assert.equal(dnr.rules.length, 5 + neuterRules().length, 'bundled rules still installed');
    assert.equal(storage.data['adblock.meta'], undefined, 'nothing saved');
  });

  test('saved lists newer than the bundled ones win at startup', async () => {
    const storage = fakeStorage({
      'adblock.meta': { fetchedAt: Date.now(), version: 'fetched-1' },
      'adblock.rules': [rule(1), rule(2), rule(3)],
      'adblock.cosmetic': { specific: {}, elemhide: [], generichide: [] }
    });
    const { blocker } = setup({ storage, fetchedAt: 1 });
    assert.equal(await blocker.start(), 6 + neuterRules().length);
    const store = createListStore({ storage, bundle: bundle(Date.now() + 1000) });
    assert.equal((await store.current()).meta.version, 'bundled-1', 'a newer browser build brings newer lists');
  });

  test('staleness and refresh validation', async () => {
    assert.equal(isStale(null), true);
    assert.equal(isStale({ fetchedAt: Date.now() }), false);
    assert.equal(isStale({ fetchedAt: Date.now() - REFRESH_MS - 1 }), true);
    const store = createListStore({ storage: fakeStorage(), bundle: bundle(0) });
    const fewRules = async () => ({ ok: true, text: async () => `${'! comment\n'.repeat(200)}||ads.com^` });
    await assert.rejects(refreshLists({ store, apply: async () => {}, fetchImpl: fewRules }), /rules converted/);
  });

  test('cosmetic injection: only our own content script, only http(s), only matching hosts', async () => {
    const inserted = [];
    const injector = createCosmeticInjector({
      loadCosmetic: async () => ({ specific: { 'news.com': { hide: ['.x'] } }, elemhide: [], generichide: [] }),
      insertCSS: async (d) => { inserted.push(d); }, extensionId: 'ext'
    });
    const sender = { id: 'ext', tab: { id: 3 }, frameId: 2, documentId: 'doc1', url: 'https://www.news.com/a' };
    assert.equal(injector.listener({ type: 'other' }, sender), false);
    injector.listener({ type: COSMETIC_MESSAGE }, { ...sender, id: 'evil' });
    await injector.inject({ ...sender, url: 'https://blog.com/' });
    await injector.inject(sender);
    assert.deepEqual(inserted, [{ target: { tabId: 3, documentIds: ['doc1'] }, css: '.x{display:none!important}', origin: 'USER' }]);
  });

  test('never-block rule list is exported for the worker', () => {
    assert.equal(neverBlockRules().length, 1);
  });

  test('the service worker installs ad blocking at startup', () => {
    assert.match(read('background.js'), /import \{ installAdblockRules \} from '\.\/adblock\/network\.js'/);
    assert.match(read('background.js'), /installAdblockRules\(\)/);
  });
});

describe('manifest wiring', () => {
  test('permissions and every referenced file exist', () => {
    for (const p of ['declarativeNetRequest', 'storage', 'alarms', 'unlimitedStorage', 'scripting']) assert.ok(manifest.permissions.includes(p), p);
    assert.ok(manifest.key, 'fixed extension id kept');
    const files = ['adblock/domains.txt', 'adblock/exceptions.txt', 'adblock/lists/rules.json', 'adblock/lists/cosmetic.json',
      'adblock/lists/meta.json', 'adblock/lists/SOURCES.md', ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])])];
    for (const f of files) assert.ok(existsSync(new URL(f, EXT)), f);
  });

  test('YouTube ad removal runs in the page context before the player loads', () => {
    const main = manifest.content_scripts.find((c) => (c.js || []).includes('adblock/youtube-main.js'));
    assert.equal(main.world, 'MAIN');
    assert.equal(main.run_at, 'document_start');
    assert.ok(main.matches.includes('*://*.youtube.com/*'));
  });

  test('element hiding runs at document_start in every http(s) frame', () => {
    for (const file of ['adblock/cosmetic-request.js', GENERIC_CSS]) {
      const entry = manifest.content_scripts.find((c) => [...(c.js || []), ...(c.css || [])].includes(file));
      assert.deepEqual([entry.run_at, entry.all_frames, entry.matches], ['document_start', true, ['http://*/*', 'https://*/*']], file);
    }
    const google = manifest.content_scripts.find((c) => (c.js || []).includes('adblock/google.js'));
    assert.ok(google.matches.includes('*://www.google.com/search*') && google.matches.includes('*://www.google.co.in/search*'));
  });

  test('the content script asks the worker with the message type it listens for', () => {
    assert.ok(read('adblock/cosmetic-request.js').includes(`'${COSMETIC_MESSAGE}'`));
  });
});

const adPayload = () => ({
  responseContext: { a: 1 },
  videoDetails: { videoId: 'abc', title: 'lofi' },
  streamingData: { formats: [1, 2] },
  adPlacements: [{ ad: 1 }],
  playerAds: [{ ad: 2 }],
  adSlots: [{ ad: 3 }],
  adBreakHeartbeatParams: 'x',
  playerResponse: { adPlacements: [1], videoDetails: { videoId: 'nested' } }
});
const assertClean = (o) => {
  for (const k of ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams']) assert.equal(k in o, false, `${k} removed`);
  assert.equal('adPlacements' in o.playerResponse, false, 'nested ad slots removed');
  assert.deepEqual(o.videoDetails, { videoId: 'abc', title: 'lofi' }, 'video data untouched');
  assert.deepEqual(o.streamingData, { formats: [1, 2] });
};

describe('YouTube ad slots (VM)', () => {
  function load() {
    class Response { constructor(v) { this.v = v; } json() { return Promise.resolve(this.v); } }
    const window = {};
    const ctx = vm.createContext({ window, Response, JSON: { parse: JSON.parse, stringify: JSON.stringify } });
    vm.runInContext(YT_MAIN, ctx);
    return { ctx, window, Response };
  }

  test('JSON.parse output is pruned, video data kept', () => {
    const { ctx } = load();
    assertClean(ctx.JSON.parse(JSON.stringify(adPayload())));
  });

  test('fetch().json() output is pruned', async () => {
    const { Response } = load();
    assertClean(await new Response(adPayload()).json());
  });

  test('inline ytInitialPlayerResponse assignment is pruned', () => {
    const { window } = load();
    window.ytInitialPlayerResponse = adPayload();
    assertClean(window.ytInitialPlayerResponse);
  });

  test('Shorts ad reels are removed from the reel sequence', () => {
    const { ctx } = load();
    const seq = ctx.JSON.parse(JSON.stringify({ entries: [
      { command: { reelWatchEndpoint: { videoId: 'a' } } },
      { command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } },
      { command: { reelWatchEndpoint: { videoId: 'b' } } }
    ] }));
    assert.deepEqual(seq.entries.map((e) => e.command.reelWatchEndpoint.videoId), ['a', 'b']);
  });

  test('ordinary JSON and parse errors behave exactly as before', () => {
    const { ctx } = load();
    assert.deepEqual(ctx.JSON.parse('{"a":[1,2],"b":null}'), { a: [1, 2], b: null });
    assert.equal(ctx.JSON.parse('7'), 7);
    assert.throws(() => ctx.JSON.parse('{bad'), SyntaxError);
  });

  test('leaves no global marker a page could detect', () => {
    const { window } = load();
    assert.deepEqual(Object.keys(window).filter((k) => /grol|adblock/i.test(k)), []);
  });
});

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);

describe('in real Chrome', { skip: CHROME ? false : 'Google Chrome not found' }, () => {
  let proc, profile, send;
  after(async () => {
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      try { process.kill(-proc.pid); } catch (_) {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function cdp() {
    if (send) return send;
    profile = mkdtempSync(join(tmpdir(), 'grol-adblock-'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' });
    let targets;
    for (let i = 0; i < 50 && !targets; i++) {
      await new Promise((r) => setTimeout(r, 200));
      targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
    }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable');
    return send;
  }
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;
  const open = async (html) => {
    await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) });
    await new Promise((r) => setTimeout(r, 800));
  };

  test('YouTube: inline player data, JSON.parse and fetch responses all lose their ad slots', async () => {
    await cdp();
    const { identifier } = (await send('Page.addScriptToEvaluateOnNewDocument', { source: YT_MAIN })).result;
    const payload = JSON.stringify(adPayload());
    await open(`<script>var ytInitialPlayerResponse = ${payload};</script>
      <script>window.parsed = JSON.parse(${JSON.stringify(payload)});</script>`);
    const { inline, parsed, fetched } = await evaluate(`(async () => ({
      inline: ytInitialPlayerResponse, parsed: window.parsed, fetched: await new Response(${JSON.stringify(payload)}).json()
    }))()`);
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    assertClean(inline);
    assertClean(parsed);
    assertClean(fetched);
  });

  test('every chunk of the bundled generic stylesheet parses', async () => {
    await cdp();
    const css = read(GENERIC_CSS);
    const chunks = css.split('{display:none!important}').length - 1;
    await open('<p>x</p>');
    const parsed = await evaluate(`(() => { const s = new CSSStyleSheet(); s.replaceSync(${JSON.stringify(css)}); return s.cssRules.length; })()`);
    assert.equal(parsed, chunks);
  });

  test('Google Search: sponsored blocks are hidden, organic results stay', async () => {
    await cdp();
    await open(`<div id="main"><div id="rcnt"><div id="center_col"><div id="taw"><div id="tvcap"><div class="blk"><span>Sponsored</span><a>ad</a></div></div></div>
      <div id="rso"><div class="r" id="org"><a>organic result about sponsored content</a></div>
      <div class="r" id="shop"><div><div><span>Sponsored products</span></div></div><a>shoe</a></div></div></div></div></div>
      <script>${GOOGLE_JS}</script>`);
    await new Promise((r) => setTimeout(r, 200));
    const shown = await evaluate(`[...document.querySelectorAll('.blk, #org, #shop, #rso, #center_col')].map((e) => e.id || e.className).filter((_, i, a) => getComputedStyle(document.querySelectorAll('.blk, #org, #shop, #rso, #center_col')[i]).display !== 'none')`);
    assert.deepEqual(shown.sort(), ['center_col', 'org', 'rso']);
  });
});

const { neuterRules, STUB_PATHS, NEUTER_PRIORITY } = await import('../../browser/agent-extension/adblock/neuter.js');

describe('stand-ins for scripts sites depend on', () => {

  test('Tag Manager and Analytics scripts are redirected to local stand-ins, above every block rule', () => {
    const rules = neuterRules();
    assert.ok(rules.some((r) => r.condition.urlFilter === '||googletagmanager.com/gtm.js'));
    for (const r of rules) {
      assert.equal(r.action.type, 'redirect');
      assert.ok(r.priority > PRIORITY.important && r.priority < PRIORITY.neverBlock);
      assert.deepEqual(r.condition.resourceTypes, ['script']);
      assert.ok(existsSync(new URL('.' + r.action.redirect.extensionPath, EXT)), r.action.redirect.extensionPath);
    }
    const composed = composeRules({ neuter: neuterRules(), lists: [{ priority: 1, action: { type: 'block' }, condition: { requestDomains: ['googletagmanager.com'] } }] });
    const gtm = composed.filter((r) => JSON.stringify(r.condition).includes('googletagmanager.com'));
    assert.equal(Math.max(...gtm.map((r) => r.priority)), NEUTER_PRIORITY, "the stand-in outranks the block");
  });

  test('the stand-ins are web accessible (required for redirects)', () => {
    const war = manifest.web_accessible_resources.flatMap((w) => w.resources);
    for (const p of STUB_PATHS) assert.ok(war.some((r) => r === p || (r.endsWith('/*') && p.startsWith(r.slice(0, -1)))), p);
  });

  test('Tag Manager stand-in: queued and later eventCallbacks run, container lookups work', async () => {
    const fired = [];
    const window = { dataLayer: [{ event: 'early', eventCallback: () => fired.push('early') }] };
    vm.runInContext(read('adblock/stubs/google-tag.js'), vm.createContext({ window, setTimeout, Proxy, Array }));
    window.dataLayer.push({ event: 'checkout', eventCallback: () => fired.push('checkout') });
    window.gtag('event', 'purchase', { event_callback: () => fired.push('gtag') });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fired.sort(), ['checkout', 'early', 'gtag']);
    assert.equal(typeof window.google_tag_manager['GTM-ABC'].dataLayer.get, 'function');
  });

  test('Analytics stand-in: ga() queue, ready callbacks and hitCallbacks run', async () => {
    const fired = [];
    const q = [['create', 'UA-1'], [() => fired.push('ready')]];
    const window = { ga: { q } };
    vm.runInContext(read('adblock/stubs/google-analytics.js'), vm.createContext({ window, setTimeout, Array, Object }));
    window.ga('send', 'event', { hitCallback: () => fired.push('hit') });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fired.sort(), ['hit', 'ready']);
    assert.equal(typeof window.ga.getAll()[0].get, 'function');
  });
});
