
const TYPE_OPTIONS = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
  xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest', subdocument: 'sub_frame', frame: 'sub_frame',
  media: 'media', font: 'font', object: 'object', 'object-subrequest': 'object', ping: 'ping', beacon: 'ping',
  websocket: 'websocket', other: 'other', document: 'main_frame', doc: 'main_frame'
};
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];
const PARTY_OPTIONS = {
  'third-party': 'thirdParty', '3p': 'thirdParty', '~first-party': 'thirdParty', '~1p': 'thirdParty',
  '~third-party': 'firstParty', '~3p': 'firstParty', 'first-party': 'firstParty', '1p': 'firstParty'
};
const COSMETIC_OPTIONS = { elemhide: 'elemhide', ehide: 'elemhide', generichide: 'generichide', ghide: 'generichide' };
const UNSUPPORTED_OPTIONS = new Set(['csp', 'redirect', 'redirect-rule', 'rewrite', 'removeparam', 'queryprune',
  'header', 'replace', 'permissions', 'urltransform', 'uritransform', 'urlskip', 'method', 'to', 'denyallow',
  'sitekey', 'webrtc', 'empty', 'mp4', 'badfilter', 'cname', 'inline-script', 'inline-font', 'genericblock',
  'strict1p', 'strict3p', 'strict-first-party', 'strict-third-party', 'specifichide', 'shide', 'ipaddress', 'reason']);

const PROCEDURAL = /:(?:-abp-[\w-]+|has-text|contains|xpath|matches-css(?:-before|-after)?|matches-attr|matches-path|matches-prop|matches-media|min-text-length|nth-ancestor|upward|remove|remove-attr|remove-class|style|watch-attr|others|if|if-not|spath|shadow)\(/;
const PSEUDOS = new Set(['not', 'is', 'where', 'has', 'nth-child', 'nth-of-type', 'nth-last-child', 'nth-last-of-type',
  'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'empty', 'root',
  'link', 'visited', 'hover', 'active', 'focus', 'focus-within', 'checked', 'disabled', 'enabled', 'lang', 'target',
  'before', 'after', 'first-line', 'first-letter', 'placeholder-shown', 'required', 'optional', 'read-only', 'scope']);

const OPTIONS_RE = /^~?[a-z0-9_-]+(?:=[^,]*)?(?:,~?[a-z0-9_-]+(?:=[^,]*)?)*$/i;
const COSMETIC_RE = /^([^/|@"!]*?)#(@)?([?$%])?#(.*)$/;
const PLAIN_HOST_RE = /^[a-z0-9.-]+$/;
const ENTITY_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.\*$/i;

export function parseFilter(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('!') || line.startsWith('[')) return { kind: 'comment' };
  const cosmetic = COSMETIC_RE.exec(line);
  if (cosmetic) return parseCosmetic(cosmetic);
  if (/^[^/|@]*\$@?\$/.test(line)) return skip('html-filter');
  return parseNetwork(line);
}

function skip(reason) { return { kind: 'skip', reason }; }

export function normalizeDomain(domain) {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!d || /[*/:[\]]/.test(d)) return null;
  if (PLAIN_HOST_RE.test(d)) return /^[.-]|[.-]$|\.\./.test(d) ? null : d;
  try { return new URL(`http://${d}/`).hostname; } catch (_) { return null; }
}

const hasPositive = (text, separator) => text.split(separator).some((d) => d.trim() && !d.startsWith('~'));

function parseDomainList(text, separator, allowEntity = false) {
  const include = [];
  const exclude = [];
  for (const part of text.split(separator)) {
    const negated = part.startsWith('~');
    const name = negated ? part.slice(1) : part;
    const domain = allowEntity && ENTITY_RE.test(name) ? name.toLowerCase() : normalizeDomain(name);
    if (domain) (negated ? exclude : include).push(domain);
  }
  return { include, exclude };
}

function parseCosmetic([, domainText, exception, extended, body]) {
  if (extended === '$') return skip('css-injection');
  if (extended === '%') return skip('scriptlet');
  if (extended === '?') return skip('procedural');
  if (body.startsWith('+js(')) return skip('scriptlet');
  if (body.startsWith('^')) return skip('html-filter');
  const selector = body.trim();
  if (/\{[^}]*\}\s*$/.test(selector)) return skip('css-injection');
  const problem = selectorProblem(selector);
  if (problem) return skip(problem);
  const { include, exclude } = parseDomainList(domainText, ',', true);
  if (!include.length && hasPositive(domainText, ',')) return skip('entity-domain');
  return { kind: 'cosmetic', exception: !!exception, selector, include, exclude };
}

export function selectorProblem(selector) {
  if (!selector) return 'empty-selector';
  if (PROCEDURAL.test(selector)) return 'procedural';
  if (/[{}]|\/\*|\\$/.test(selector)) return 'unsafe-selector';
  let depth = 0;
  let bracket = false;
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'") { if (!bracket) return 'unsafe-selector'; quote = c; continue; }
    if (bracket) { if (c === ']') bracket = false; continue; }
    if (c === '[') bracket = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return 'unsafe-selector';
    else if (c === ':') {
      const name = /^:?:?([a-z-]+)/i.exec(selector.slice(i))[1].toLowerCase();
      if (!PSEUDOS.has(name) && !name.startsWith('-webkit-')) return 'unsupported-pseudo';
      i += selector[i + 1] === ':' ? 1 : 0;
    }
  }
  return depth || bracket || quote ? 'unsafe-selector' : null;
}

function splitOptions(line) {
  const at = line.lastIndexOf('$');
  const options = at < 0 ? '' : line.slice(at + 1);
  if (!options || !OPTIONS_RE.test(options)) return { pattern: line, options: '' };
  return { pattern: line.slice(0, at), options };
}

function parseNetwork(line) {
  const exception = line.startsWith('@@');
  const { pattern: rawPattern, options } = splitOptions(exception ? line.slice(2) : line);
  const filter = {
    kind: 'network', exception, pattern: rawPattern, regex: null, domain: null,
    types: [], excludedTypes: [], party: null, include: [], exclude: [], matchCase: false, important: false,
    cosmetic: null
  };
  let popup = false;
  for (const option of options ? options.split(',') : []) {
    const eq = option.indexOf('=');
    const name = (eq < 0 ? option : option.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? '' : option.slice(eq + 1);
    const negated = name.startsWith('~');
    const bare = negated ? name.slice(1) : name;
    if (TYPE_OPTIONS[bare]) (negated ? filter.excludedTypes : filter.types).push(TYPE_OPTIONS[bare]);
    else if (PARTY_OPTIONS[name]) filter.party = PARTY_OPTIONS[name];
    else if (bare === 'popup' || bare === 'popunder') popup = !negated;
    else if (bare === 'all') filter.types.push(...ALL_TYPES);
    else if (name === 'domain' || name === 'from') {
      const { include, exclude } = parseDomainList(value, '|');
      if (!include.length && hasPositive(value, '|')) return skip('entity-domain');
      filter.include = include;
      filter.exclude = exclude;
    } else if (name === 'match-case') filter.matchCase = true;
    else if (name === 'important') filter.important = true;
    else if (COSMETIC_OPTIONS[name]) filter.cosmetic = COSMETIC_OPTIONS[name];
    else if (UNSUPPORTED_OPTIONS.has(bare)) return skip(bare);
    else return skip('unknown-option');
  }
  if (popup && !filter.types.length) return skip('popup');
  if (filter.cosmetic) return exception ? filter : skip('cosmetic-option');
  return normalizePattern(filter);
}

function normalizePattern(filter) {
  let p = filter.pattern;
  if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
    const source = p.slice(1, -1);
    if (/\(\?[=!<]|\\[1-9]/.test(source)) return skip('regex-unsupported');
    if (/[^\x20-\x7e]/.test(source)) return skip('non-ascii');
    filter.regex = source;
    filter.pattern = '';
    return filter;
  }
  if (!filter.matchCase) p = p.toLowerCase();
  p = p.replace(/^\*+|\*+$/g, '');
  if (p.startsWith('||*')) p = p.slice(3).replace(/^\*+/, '');
  if (p.replace(/^\|\|?/, '').replace(/\|$/, '').includes('|')) return skip('invalid-pattern');
  if (/[^\x20-\x7e]/.test(p)) return skip('non-ascii');
  if (['', '|', '||', '^', '|http', '|https', '|http://', '|https://', 'http', 'https', '://', 'http://', 'https://'].includes(p)) {
    if (!filter.include.length) return skip('too-broad');
    p = '';
  }
  const host = /^\|\|([a-z0-9.-]+)(?:\^\|?|\/)?$/.exec(p);
  filter.domain = host ? normalizeDomain(host[1]) : null;
  filter.pattern = p;
  return filter;
}
