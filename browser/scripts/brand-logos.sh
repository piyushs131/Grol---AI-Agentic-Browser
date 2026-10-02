#!/usr/bin/env bash
set -euo pipefail
SRC="${1:?usage: brand-logos.sh <engine src>}"
BROWSER="$(cd "$(dirname "$0")/.." && pwd)"
LOGO="$BROWSER/resources/logo"

fit() {
  local w h
  w=$(sips -g pixelWidth "$2" | awk '/pixelWidth/{print $2}')
  h=$(sips -g pixelHeight "$2" | awk '/pixelHeight/{print $2}')
  if [ "$w" = "$h" ]; then sips -z "$h" "$w" "$1" --out "$2" >/dev/null
  else sips --resampleHeight "$h" "$1" --out "$2" >/dev/null; fi
}

count=0
while IFS= read -r target; do
  case "$target" in
    *_mono.png)                 fit "$LOGO/logo-mono.png" "$SRC/$target" ;;
    *product_logo_white.png)    fit "$LOGO/logo-white.png" "$SRC/$target" ;;
    *product_logo_name_*white*) fit "$LOGO/wordmark-white.png" "$SRC/$target" ;;
    *product_logo_name_*)       fit "$LOGO/wordmark.png" "$SRC/$target" ;;
    *.png)                      fit "$LOGO/logo.png" "$SRC/$target" ;;
    *.svg)                      cp "$BROWSER/agent-extension/logo.svg" "$SRC/$target" ;;
  esac
  count=$((count + 1))
done < <(cd "$SRC" && ls chrome/app/theme/*/product_logo*.* chrome/app/theme/default_*_percent/*/product_logo*.png \
  components/resources/default_*_percent/*/product_logo*.png 2>/dev/null | grep -v '/google_chrome/' | grep -E '\.(png|svg)$')

while IFS= read -r icon; do
  printf 'CANVAS_DIMENSIONS, 24,\nSTROKE, 2.75,\nCIRCLE, 12, 12, 8.6\n' > "$SRC/$icon"
  count=$((count + 1))
done < <(cd "$SRC" && ls components/vector_icons/*/product.icon components/vector_icons/*/product_refresh.icon \
  chrome/app/vector_icons/chrome_product.icon components/omnibox/browser/vector_icons/chrome_product.icon \
  components/omnibox/browser/vector_icons/product_old.icon components/omnibox/browser/vector_icons/product_chrome_refresh_old.icon \
  ui/message_center/vector_icons/chrome_product.icon ui/message_center/vector_icons/product_old.icon 2>/dev/null | grep -v '/google_chrome/')

ring() {
  /usr/bin/python3 -c "import sys; g=float(sys.argv[1]); c=g/2; o=g*0.41; i=g*0.275
f=lambda v: ('%.2f' % v).rstrip('0').rstrip('.')
print('<path fill-rule=\"evenodd\" d=\"M%s %sa%s %s 0 1 0 0 %s %s %s 0 0 0 0-%sZm0 %sa%s %s 0 1 1 0 %s %s %s 0 0 1 0-%sZ\"></path>' % (
  f(c), f(c-o), f(o), f(o), f(2*o), f(o), f(o), f(2*o), f(o-i), f(i), f(i), f(2*i), f(i), f(i), f(2*i)))" "$1"
}
while IFS= read -r file; do
  case "$file" in ui/webui/resources/*) grid=24 ;; *) grid=20 ;; esac
  RING="$(ring $grid)" /usr/bin/perl -0pi -e 's#(<g id="chrome-product">).*?(</g>)#$1$ENV{RING}$2#gs' "$SRC/$file"
  count=$((count + 1))
done < <(cd "$SRC" && grep -rl --include='*.html' --include='*.html.ts' 'id="chrome-product"' chrome/browser/resources ui/webui/resources 2>/dev/null)

echo "  ✓ product logo replaced in $count files"
