export const NEUTER_PRIORITY = 50;

const STUBS = [
  { urlFilter: '||googletagmanager.com/gtm.js', path: '/adblock/stubs/google-tag.js' },
  { urlFilter: '||googletagmanager.com/gtag/js', path: '/adblock/stubs/google-tag.js' },
  { urlFilter: '||google-analytics.com/analytics.js', path: '/adblock/stubs/google-analytics.js' },
  { urlFilter: '||google-analytics.com/ga.js', path: '/adblock/stubs/google-analytics.js' },
  { urlFilter: '||ssl.google-analytics.com/ga.js', path: '/adblock/stubs/google-analytics.js' }
];

export function neuterRules() {
  return STUBS.map(({ urlFilter, path }) => ({
    priority: NEUTER_PRIORITY,
    action: { type: 'redirect', redirect: { extensionPath: path } },
    condition: { urlFilter, resourceTypes: ['script'] }
  }));
}

export const STUB_PATHS = [...new Set(STUBS.map((s) => s.path.slice(1)))];
