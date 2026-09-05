/* Stamp config/version.json into the two shell manifests.

   The version used to live in three places (desktop/package.json,
   scripts/build_apk.ps1, android/app/build.gradle) and every release needed a
   manual three-way edit — the classic way to ship an exe and an APK that
   disagree. Now both build scripts call this, and the Gradle file stays
   correct for anyone building from Android Studio.

   usage: node scripts/stamp_version.js            # stamp from config/version.json
          node scripts/stamp_version.js <x.y.z> <n>  # explicit stamp
          node scripts/stamp_version.js --check      # verify only, never write
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* config/version.json is the single source — read it here so the source is
   actually protected by this script (the ps1 wrappers used to be the only
   readers, and a manual `node stamp_version.js` with no args just died). */
const SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/version.json'), 'utf8'));

const argv = process.argv.slice(2);

function manifestsAt(version, code) {
  const pj = fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8');
  const gr = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
  const bad = [];
  if (!new RegExp('"version":\\s*"' + version.replace(/\./g, '\\.') + '"').test(pj))
    bad.push('desktop/package.json is not at ' + version);
  if (!new RegExp('versionCode\\s+' + code + '\\b').test(gr) ||
      !new RegExp('versionName\\s+"' + version.replace(/\./g, '\\.') + '"').test(gr))
    bad.push('android/app/build.gradle is not at ' + version + ' (code ' + code + ')');
  return bad;
}

if (argv[0] === '--check') {
  const bad = manifestsAt(SRC.version, String(SRC.code));
  if (bad.length) { console.error('VERSION CHECK FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('version check OK: ' + SRC.version + ' (code ' + SRC.code + ') in both manifests');
  process.exit(0);
}

let [version, code] = argv;
if (version == null) { version = SRC.version; code = String(SRC.code); }

if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^\d+$/.test(code || '')) {
  console.error('usage: node scripts/stamp_version.js [<x.y.z> <versionCode> | --check]');
  process.exit(2);
}

function rewrite(file, label, fn) {
  const p = path.join(ROOT, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === null) {
    console.error('stamp_version: ' + label + ' not found in ' + file);
    process.exit(1);
  }
  if (after !== before) {
    fs.writeFileSync(p, after);
    console.log('  ' + file + ' → ' + label);
  } else {
    console.log('  ' + file + ' already at ' + label);
  }
}

rewrite('desktop/package.json', 'version ' + version, (s) => {
  if (!/"version":\s*"[^"]+"/.test(s)) return null;
  return s.replace(/"version":\s*"[^"]+"/, '"version": "' + version + '"');
});

rewrite('android/app/build.gradle', 'v' + version + ' / code ' + code, (s) => {
  if (!/versionCode\s+\d+/.test(s) || !/versionName\s+"[^"]+"/.test(s)) return null;
  return s
    .replace(/versionCode\s+\d+/, 'versionCode ' + code)
    .replace(/versionName\s+"[^"]+"/, 'versionName "' + version + '"');
});

console.log('version stamped: ' + version + ' (' + code + ')');
