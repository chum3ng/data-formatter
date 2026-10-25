/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 6 of 7: Search engine, file and clipboard helpers, settings store
   BEGINS: the comment block headed "PART 6 of 7" (paste right after "END OF PART 5").
   ENDS:   the line "END OF PART 6".

   DFI.SearchEngine  (pure functions, no DOM; Part 7 connects it to CodeMirror)
     build(query, {caseSensitive, wholeWord, regex})  -> {ok, empty, re, risky} | {ok:false, error}
     find(text, built)          -> {ok, count, starts[], ends[], truncated, timedOut} | {ok:false, error}
     execAt(text, built, index) -> regex exec result for the match that starts at index, or null
     expand(execResult, replacement, useRegex) -> replacement text ($1, $&, $<name>, $$ in regex mode)
     replaceAll(text, built, replacement, useRegex) -> {ok, text, count}
     indexAtOrAfter(starts, offset), next(i, count), prev(i, count)
     visibleRange(starts, ends, fromOffset, toOffset) -> [lo, hi)   (only these need highlight marks)
     statusText({query, error, total, current, truncated, timedOut})
   Rules: empty matches are ignored. Whole word uses Unicode letters and digits. Regular expressions use
   JavaScript syntax with the "m" flag, so ^ and $ match at line starts and ends.

   DFI.Files   validate, formatFromName, extensionFor, mimeFor, fileName, read, download, copyText,
               readClipboard, pickFirst, fromDataTransfer
   DFI.Store   get(key, fallback), set(key, value), remove(key)  (localStorage, never throws)
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI;

  /* ------------------------------------------------------------------
     SearchEngine
     ------------------------------------------------------------------ */
  var S = DFI.SearchEngine = {};
  S.MAX_MATCHES = 50000;
  S.TIME_BUDGET_MS = 1500;
  S.RISKY_TEXT_LIMIT = 100000;

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function friendlyRegexError(msg) {
    return String(msg || 'Invalid regular expression').replace(/^Invalid regular expression:\s*/i, '').replace(/^\/.*?\/[a-z]*:\s*/, '');
  }

  // Nested repetition such as (a+)+ or (.*)* can freeze the page on long text.
  S.isRisky = function (src) {
    return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(src);
  };

  S.build = function (query, opts) {
    var src, flags, re = null;
    if (!query) { return { ok: true, empty: true }; }
    opts = opts || {};
    src = opts.regex ? query : escapeRe(query);
    flags = 'g' + (opts.caseSensitive ? '' : 'i') + 'm';
    try {
      if (opts.wholeWord) {
        try { re = new RegExp('(?<![\\p{L}\\p{N}_])(?:' + src + ')(?![\\p{L}\\p{N}_])', flags + 'u'); }
        catch (e1) { re = new RegExp('\\b(?:' + src + ')\\b', flags); }
      } else {
        re = new RegExp(src, flags);
      }
    } catch (e) {
      return { ok: false, error: friendlyRegexError(e && e.message) };
    }
    return { ok: true, empty: false, re: re, risky: !!opts.regex && S.isRisky(src) };
  };

  S.find = function (text, built) {
    var starts = [], ends = [], re, m, t0, truncated = false, timedOut = false;
    if (!built.ok) { return built; }
    if (built.empty) { return { ok: true, count: 0, starts: starts, ends: ends, truncated: false, timedOut: false }; }
    if (built.risky && text.length > S.RISKY_TEXT_LIMIT) {
      return { ok: false, error: 'This expression repeats a group that already repeats, which can take extremely long on large text. Simplify it, for example (a+)+ to a+.' };
    }
    re = built.re;
    re.lastIndex = 0;
    t0 = Date.now();
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      starts.push(m.index);
      ends.push(m.index + m[0].length);
      if (starts.length >= S.MAX_MATCHES) { truncated = true; break; }
      if ((starts.length & 1023) === 0 && Date.now() - t0 > S.TIME_BUDGET_MS) { timedOut = true; break; }
    }
    return { ok: true, count: starts.length, starts: starts, ends: ends, truncated: truncated, timedOut: timedOut };
  };

  S.execAt = function (text, built, index) {
    var m;
    if (!built.ok || built.empty) { return null; }
    built.re.lastIndex = index;
    m = built.re.exec(text);
    return m && m.index === index ? m : null;
  };

  S.expand = function (m, replacement, useRegex) {
    var groupCount;
    if (!useRegex) { return replacement; }
    groupCount = m.length - 1;
    return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, function (all, tok) {
      var n, v;
      if (tok === '$') { return '$'; }
      if (tok === '&') { return m[0]; }
      if (tok.charAt(0) === '<') {
        if (m.groups && Object.prototype.hasOwnProperty.call(m.groups, tok.slice(1, -1))) { return m.groups[tok.slice(1, -1)] || ''; }
        return all;
      }
      n = parseInt(tok, 10);
      if (tok.length === 2 && (n < 1 || n > groupCount)) {            // $12 with fewer groups: $1 followed by "2"
        n = parseInt(tok.charAt(0), 10);
        if (n >= 1 && n <= groupCount) { v = m[n]; return (v === undefined ? '' : v) + tok.charAt(1); }
        return all;
      }
      if (n < 1 || n > groupCount) { return all; }
      v = m[n];
      return v === undefined ? '' : v;
    });
  };

  S.replaceAll = function (text, built, replacement, useRegex) {
    var count = 0, out;
    if (!built.ok || built.empty) { return { ok: false, text: text, count: 0 }; }
    built.re.lastIndex = 0;
    out = text.replace(built.re, function () {
      var args = Array.prototype.slice.call(arguments), groups, m, len = args.length;
      if (typeof args[len - 1] === 'object' && args[len - 1] !== null) { groups = args.pop(); len--; }
      m = args.slice(0, len - 2);
      m.groups = groups;
      if (m[0].length === 0) { return m[0]; }
      count++;
      return S.expand(m, replacement, useRegex);
    });
    return { ok: true, text: out, count: count };
  };

  function lowerBound(arr, x) {
    var lo = 0, hi = arr.length, mid;
    while (lo < hi) { mid = (lo + hi) >> 1; if (arr[mid] < x) { lo = mid + 1; } else { hi = mid; } }
    return lo;
  }
  function upperBound(arr, x) {
    var lo = 0, hi = arr.length, mid;
    while (lo < hi) { mid = (lo + hi) >> 1; if (arr[mid] <= x) { lo = mid + 1; } else { hi = mid; } }
    return lo;
  }

  S.indexAtOrAfter = function (starts, offset) {
    var i = lowerBound(starts, offset);
    return i >= starts.length ? 0 : i;
  };
  S.next = function (i, count) { return count ? (i + 1) % count : -1; };
  S.prev = function (i, count) { return count ? (i - 1 + count) % count : -1; };

  S.visibleRange = function (starts, ends, fromOffset, toOffset) {
    return [upperBound(ends, fromOffset), lowerBound(starts, toOffset)];
  };

  S.statusText = function (st) {
    if (!st.query) { return ''; }
    if (st.error) { return 'Invalid pattern'; }
    if (!st.total) { return 'No results'; }
    return (st.current + 1) + ' of ' + st.total.toLocaleString('en-US') + (st.truncated || st.timedOut ? '+' : '');
  };

  /* ------------------------------------------------------------------
     Files
     ------------------------------------------------------------------ */
  var F = DFI.Files = {};
  F.ACCEPT = ['.json', '.xml', '.yaml', '.yml', '.txt', '.java'];
  F.MAX_BYTES = 20 * 1024 * 1024;

  function extOf(name) {
    var i = (name || '').lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
  }

  F.formatFromName = function (name) {
    var e = extOf(name);
    if (e === '.json') { return 'json'; }
    if (e === '.xml') { return 'xml'; }
    if (e === '.yaml' || e === '.yml') { return 'yaml'; }
    if (e === '.java') { return 'java'; }
    return null;                                   // .txt: detect from the content
  };

  // Java-style output is plain text, not Java source, so it is saved as .txt.
  F.extensionFor = function (format) {
    return { json: '.json', xml: '.xml', yaml: '.yaml', java: '.txt' }[format] || '.txt';
  };
  F.mimeFor = function (format) {
    return { json: 'application/json', xml: 'application/xml', yaml: 'application/x-yaml', java: 'text/plain' }[format] || 'text/plain';
  };
  F.fileName = function (side, format) { return side + F.extensionFor(format); };

  F.validate = function (file) {
    var e = extOf(file.name);
    if (F.ACCEPT.indexOf(e) < 0) {
      return { ok: false, message: 'Unsupported file type "' + (e || 'no extension') + '". Use .json, .xml, .yaml, .yml, .txt or .java.' };
    }
    if (!file.size) { return { ok: false, message: 'The file "' + file.name + '" is empty.' }; }
    if (file.size > F.MAX_BYTES) {
      return { ok: false, message: 'The file "' + file.name + '" is ' + (file.size / 1048576).toFixed(1) + ' MB. The limit is 20 MB because everything is processed in your browser.' };
    }
    return { ok: true, message: '' };
  };

  F.pickFirst = function (fileList) {
    var arr = Array.prototype.slice.call(fileList || []);
    return { file: arr[0] || null, extra: Math.max(arr.length - 1, 0) };
  };

  F.fromDataTransfer = function (dt) {
    var files = [], i, it;
    if (!dt) { return { files: files, text: '' }; }
    if (dt.items && dt.items.length) {
      for (i = 0; i < dt.items.length; i++) {
        it = dt.items[i];
        if (it.kind === 'file') { it = it.getAsFile(); if (it) { files.push(it); } }
      }
    } else if (dt.files) {
      files = Array.prototype.slice.call(dt.files);
    }
    return { files: files, text: files.length ? '' : (dt.getData ? dt.getData('text/plain') : '') };
  };

  // Resolves {ok, text, name, format, warnings[]}. Never rejects, so callers do not need a catch.
  F.read = function (file) {
    return new Promise(function (resolve) {
      var v = F.validate(file), reader;
      if (!v.ok) { resolve({ ok: false, message: v.message }); return; }
      reader = new global.FileReader();
      reader.onerror = function () { resolve({ ok: false, message: 'The browser could not read "' + file.name + '".' }); };
      reader.onload = function () {
        var text = String(reader.result), warnings = [];
        if (text.indexOf('\u0000') >= 0) {
          resolve({ ok: false, message: '"' + file.name + '" looks like a binary file (it contains NUL bytes), so it was not loaded.' });
          return;
        }
        if (text.indexOf('\uFFFD') >= 0) {
          warnings.push('Some bytes in "' + file.name + '" are not valid UTF-8 and were shown as \uFFFD.');
        }
        resolve({ ok: true, text: text, name: file.name, format: F.formatFromName(file.name), warnings: warnings });
      };
      reader.readAsText(file, 'UTF-8');
    });
  };

  F.download = function (filename, text, mime) {
    var blob = new global.Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = global.URL.createObjectURL(blob);
    var a = global.document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    global.document.body.appendChild(a);
    a.click();
    global.document.body.removeChild(a);
    setTimeout(function () { global.URL.revokeObjectURL(url); }, 4000);
  };

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = global.document.createElement('textarea'), ok = false;
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      global.document.body.appendChild(ta);
      ta.select();
      try { ta.setSelectionRange(0, text.length); ok = global.document.execCommand('copy'); } catch (e) { ok = false; }
      global.document.body.removeChild(ta);
      if (ok) { resolve(); } else { reject(new Error('The browser blocked copying. Select the text and press Ctrl+C instead.')); }
    });
  }

  F.copyText = function (text) {
    var nav = global.navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) {
      return nav.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  };

  F.readClipboard = function () {
    var nav = global.navigator, msg = 'The browser blocked reading the clipboard. Click inside the editor and press Ctrl+V (Cmd+V on Mac) instead.';
    if (nav && nav.clipboard && nav.clipboard.readText) {
      return nav.clipboard.readText().catch(function () { throw new Error(msg); });
    }
    return Promise.reject(new Error(msg));
  };

  /* ------------------------------------------------------------------
     Store: small localStorage wrapper (theme and settings only; never your data)
     ------------------------------------------------------------------ */
  DFI.Store = {
    get: function (key, fallback) {
      try {
        var raw = global.localStorage.getItem('dfi.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { global.localStorage.setItem('dfi.' + key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove: function (key) {
      try { global.localStorage.removeItem('dfi.' + key); } catch (e) { /* ignore */ }
    }
  };

})(window);
/* ===================== END OF PART 6 ===================== */
