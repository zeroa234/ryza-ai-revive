/* Desktop save file: inject-before-scripts + JSON embed. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const webStorage = require('../desktop/web-storage');

let failures = 0;
const ok = (cond, name) => {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name); }
};

console.log('# electron web-storage boot');
const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script src="js/config.js"></script></body></html>';
const injected = webStorage.inject(html, { 'ryza.game.v1': '{"money":9}' });
ok(injected.indexOf('ryza.game.v1') < injected.indexOf('js/config.js'),
   'boot script sits in <head> before page scripts');
ok(injected.indexOf('<script>(function(){') > 0, 'boot is an inline script');

const evil = webStorage.embedJson({ x: '</script><script>alert(1)' });
ok(evil.indexOf('</script>') === -1, 'embedded JSON cannot break out of <script>');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-store-'));
const file = webStorage.storePath(dir);
ok(path.basename(file) === 'ryza-web-storage.json', 'save file name is stable');
webStorage.save(file, { 'ryza.settings.v1': '{"lang":"zh"}' });
const round = webStorage.load(file);
ok(round['ryza.settings.v1'] === '{"lang":"zh"}', 'save file round-trips');
ok(Object.keys(webStorage.load(path.join(dir, 'missing.json'))).length === 0,
   'missing file is empty, not throw');

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
