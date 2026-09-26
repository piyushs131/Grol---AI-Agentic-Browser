#!/usr/bin/env python3
"""Rename the upstream product to Grol in the engine's UI strings and translations.

    brand-strings.py <engine src> <upstream name> <product name>

A script rather than a patch: the rule is one line, while the result touches ~560
messages in 82 files and would conflict on every engine bump. Copyright, licence,
credits and author attribution are left untouched. Idempotent.
"""
import glob, os, re, sys

if len(sys.argv) != 4:
    sys.exit(__doc__)
src, upstream, product = sys.argv[1:]
KEEP = re.compile(r'COPYRIGHT|OPEN_SOURCE|CREDITS|LICENSE|TERMS|ABOUT_VERSION_(COMPANY|LEGAL)', re.I)
NAME = re.compile(re.escape(upstream) + r'(?! Authors)(?! project)(?! open source)')
TRANSLATED_NAME = re.compile(re.escape(upstream) + r'(?! Authors)')
strings = f'{upstream.lower()}_strings'

grd = os.path.join(src, 'chrome/app', f'{strings}.grd')
text = open(grd, encoding='utf-8').read()
def fix(m):
    head, body, tail = m.groups()
    name = re.search(r'name="([^"]+)"', head)
    if name and KEEP.search(name.group(1)):
        return m.group(0)
    return head + NAME.sub(product, body) + tail
open(grd, 'w', encoding='utf-8').write(re.sub(r'(<message\b[^>]*>)(.*?)(</message>)', fix, text, flags=re.S))

for xtb in glob.glob(os.path.join(src, 'chrome/app/resources', f'{strings}_*.xtb')):
    t = open(xtb, encoding='utf-8').read()
    open(xtb, 'w', encoding='utf-8').write(TRANSLATED_NAME.sub(product, t))
print(f'  ✓ UI strings branded as {product}')
