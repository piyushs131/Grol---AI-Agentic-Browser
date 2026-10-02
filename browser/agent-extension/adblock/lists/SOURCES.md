# Filter list sources and licences

The files in this directory (`rules.json`, `cosmetic.json`, `generic.css`, `meta.json`) are
generated from the filter lists below by `browser/scripts/update-adblock-lists.mjs`, and the
browser refreshes them from the same URLs once a day. `meta.json` records the exact version and
SHA-256 of each list used for the bundled copy.

These files are data derived from third-party lists. They keep the licences of their sources,
not the MIT licence of the rest of Grol. The share-alike terms below apply to this list data
(and anything derived from it) only, not to Grol's code.

| List | Source | Authors | Licence |
|------|--------|---------|---------|
| EasyList | https://easylist.to/easylist/easylist.txt | The EasyList authors (https://easylist.to/) | Dual-licensed: GNU GPL v3 or later, or Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0) — https://easylist.to/pages/licence.html |
| EasyPrivacy | https://easylist.to/easylist/easyprivacy.txt | The EasyList authors (https://easylist.to/) | Dual-licensed: GNU GPL v3 or later, or CC BY-SA 3.0 — https://easylist.to/pages/licence.html |
| EasyList India (IndianList) | https://easylist-downloads.adblockplus.org/indianlist.txt | The IndianList / EasyList authors | Dual-licensed: GNU GPL v3 or later, or CC BY-SA 3.0 — https://easylist.to/pages/licence.html |
| Peter Lowe's Ad and tracking server list | https://pgl.yoyo.org/adservers/ | Peter Lowe | No formal licence is published; the site invites combining the list with others and republishing it ("Feel free to combine this list with yours or lists from other sites and put it up on the web"). Credited here; ask the author before any commercial redistribution. |

Grol uses the three EasyList-family lists under their CC BY-SA 3.0 option: the generated files are an adaptation
(converted to Chromium declarativeNetRequest rules and CSS) and are shared under the same licence.

Not included: uBlock Origin's own filter lists and uBlock Origin Lite code.
`../domains.txt` and `../exceptions.txt` are Grol's own curated lists (MIT).
