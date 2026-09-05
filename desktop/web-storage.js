/* Desktop save file. The window origin is ryza://app/ (stable, no port).
   Chromium localStorage is a cache: this JSON under userData is the copy
   that survives upgrades. Browser debug via serve.py does not use this. */
'use strict';

const fs = require('fs');
const path = require('path');

const NAME = 'ryza-web-storage.json';

function storePath(userData) {
  return path.join(userData, NAME);
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    Object.keys(raw).forEach((k) => {
      if (typeof raw[k] === 'string') out[k] = raw[k];
      else if (raw[k] != null) out[k] = JSON.stringify(raw[k]);
    });
    return out;
  } catch (e) {
    return {};
  }
}

function save(file, obj) {
  if (!file || !obj || typeof obj !== 'object') return;
  if (pendingFile === file) {
    if (timer) { clearTimeout(timer); timer = null; }
    pendingObj = null;
  }
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

let timer = null;
let pendingFile = null;
let pendingObj = null;

function queueSave(file, obj) {
  pendingFile = file;
  pendingObj = obj;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, 80);
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (pendingFile && pendingObj) {
    try { save(pendingFile, pendingObj); } catch (e) {}
    pendingObj = null;
  }
}

function embedJson(obj) {
  return JSON.stringify(obj || {})
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function bootScript(store) {
  return '<script>(function(){' +
    'var disk=' + embedJson(store) + ';' +
    'var rawSet=Storage.prototype.setItem;' +
    'var rawDel=Storage.prototype.removeItem;' +
    'var rawClr=Storage.prototype.clear;' +
    'function dump(){var o={},i,k;for(i=0;i<localStorage.length;i++){' +
      'k=localStorage.key(i);if(k)o[k]=localStorage.getItem(k);}return o;}' +
    'function flush(sync){var s=window.ryzaShell;if(!s)return;' +
      'if(sync&&s.saveWebStorageSync)s.saveWebStorageSync(dump());' +
      'else if(s.saveWebStorage)s.saveWebStorage(dump());}' +
    'try{if(Object.keys(disk).length){rawClr.call(localStorage);' +
      'Object.keys(disk).forEach(function(k){rawSet.call(localStorage,k,String(disk[k]));});}' +
    '}catch(e){}' +
    'Storage.prototype.setItem=function(k,v){rawSet.call(this,k,v);flush(false);};' +
    'Storage.prototype.removeItem=function(k){rawDel.call(this,k);flush(false);};' +
    'Storage.prototype.clear=function(){rawClr.call(this);flush(false);};' +
    'document.addEventListener("visibilitychange",function(){if(document.hidden)flush(true);});' +
    'window.addEventListener("pagehide",function(){flush(true);});' +
    '})();</script>';
}

function inject(html, store) {
  const boot = bootScript(store);
  const i = String(html || '').toLowerCase().indexOf('<head>');
  if (i < 0) return boot + html;
  const open = html.indexOf('>', i);
  if (open < 0) return boot + html;
  return html.slice(0, open + 1) + boot + html.slice(open + 1);
}

module.exports = {
  NAME, storePath, load, save, queueSave, flush, embedJson, bootScript, inject
};
