export const LISTS = [
  { id: 'easylist', title: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'pgl', title: "Peter Lowe's Ad and tracking server list", url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext' },
  { id: 'indian', title: 'EasyList India', url: 'https://easylist-downloads.adblockplus.org/indianlist.txt' },
  { id: 'easyprivacy', title: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' }
];

export const NEVER_BLOCK = ['generativelanguage.googleapis.com', '127.0.0.1', 'localhost',
  ...new Set(LISTS.map((l) => new URL(l.url).hostname))];
