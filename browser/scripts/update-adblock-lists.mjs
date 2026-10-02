#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertLists } from '../agent-extension/adblock/convert.js';
import { genericCss, excludeMatchesFor } from '../agent-extension/adblock/cosmetic-filters.js';
import { LISTS } from '../agent-extension/adblock/sources.js';

const EXT = fileURLToPath(new URL('../agent-extension/', import.meta.url));
const OUT = join(EXT, 'adblock/lists');
export const CONVERTER_FILES = ['filter-parser.js', 'dnr-rules.js', 'cosmetic-filters.js', 'convert.js'];
export const GENERIC_CSS = 'adblock/lists/generic.css';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function converterHash() {
  return sha256(CONVERTER_FILES.map((f) => readFileSync(join(EXT, 'adblock', f), 'utf8')).join('\0'));
}

export const rulesJson = (rules) => `[\n${rules.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;
export function cosmeticJson({ specific, elemhide, generichide }) {
  const hosts = Object.entries(specific).map(([h, e]) => `${JSON.stringify(h)}:${JSON.stringify(e)}`);
  return `{"elemhide":${JSON.stringify(elemhide)},\n"generichide":${JSON.stringify(generichide)},\n"specific":{\n${hosts.join(',\n')}\n}}\n`;
}

async function loadList({ id, url }, rawDir) {
  const cached = rawDir && join(rawDir, `${id}.txt`);
  if (cached && existsSync(cached)) return readFileSync(cached, 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const text = await res.text();
  if (cached) { mkdirSync(rawDir, { recursive: true }); writeFileSync(cached, text); }
  return text;
}

async function main() {
  const at = process.argv.indexOf('--raw-dir');
  const rawDir = at > 0 ? process.argv[at + 1] : null;
  const lists = [];
  for (const list of LISTS) lists.push({ ...list, text: await loadList(list, rawDir) });

  const { rules, generic, cosmetic, stats } = convertLists(lists);
  const fetchedAt = Date.now();
  const meta = {
    fetchedAt,
    version: `bundled-${new Date(fetchedAt).toISOString().slice(0, 10)}`,
    converter: converterHash(),
    sources: lists.map(({ id, title, url, text }) => ({
      id, title, url, version: (/^! Version: *(\S+)/m.exec(text) || [])[1] || null, sha256: sha256(text)
    })),
    stats
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'rules.json'), rulesJson(rules));
  writeFileSync(join(OUT, 'cosmetic.json'), cosmeticJson(cosmetic));
  writeFileSync(join(EXT, GENERIC_CSS), genericCss(generic));
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');

  const manifestPath = join(EXT, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = manifest.content_scripts.find((c) => (c.css || []).includes(GENERIC_CSS));
  if (!entry) throw new Error(`manifest.json has no content script for ${GENERIC_CSS}`);
  entry.exclude_matches = excludeMatchesFor([...new Set([...cosmetic.elemhide, ...cosmetic.generichide])].sort());
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const skipped = {};
  for (const s of Object.values(stats.lists)) for (const [k, n] of Object.entries(s.skipped)) skipped[k] = (skipped[k] || 0) + n;
  console.log(`✓ ${rules.length} network rules (${stats.regexRules} regex, dropped ${JSON.stringify(stats.droppedRules)})`);
  console.log(`✓ ${generic.length} generic selectors, ${stats.siteSelectorHosts} site entries, ${entry.exclude_matches.length} sites without generic hiding`);
  console.log(`  skipped: ${JSON.stringify(skipped)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
}
