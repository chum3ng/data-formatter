/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 1 of 7: Core utilities + JSON engine
   BEGINS: first line of app.js.   ENDS: the line "END OF PART 1".
   Parts 2-7 are appended below, in order, with nothing in between.
   Each part is its own IIFE and registers itself on the global DFI object.

   Counting rules used by the JSON engine:
   - fields        = object properties (array items are not fields)
   - objects       = every object node, including the root
   - arrays        = every array node, including the root
   - nulls         = real JSON null only (never the string "null")
   - emptyStrings  = ""    emptyArrays = []    emptyObjects = {}
   - duplicateKeys = extra occurrences of a key inside one object
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI = global.DFI || {};
  var Util = DFI.Util = {};
  var Json = DFI.Json = {};

  /* ------------------------------------------------------------------
     Util
     ------------------------------------------------------------------ */
  Util.NA = 'N/A';
  Util.LIMITS = { autoMaxChars: 1500000, maxItems: 5000, previewLength: 60 };
  Util.TYPE_LABELS = {
    'null': 'Null',
    emptyString: 'Empty string',
    emptyArray: 'Empty array',
    emptyObject: 'Empty object',
    emptyElement: 'Empty element',
    whitespace: 'Whitespace text'
  };

  /** Fresh analysis result. Every format engine returns this shape. */
  Util.newAnalysis = function () {
    var na = Util.NA;
    return {
      counts: {
        fields: na, objects: na, arrays: na, nulls: na, emptyStrings: na,
        emptyArrays: na, emptyObjects: na, emptyElements: na, duplicateKeys: na,
        attributes: na, textNodes: na, whitespaceTexts: na
      },
      items: [],        // {type, typeLabel, path, line, column, offset, preview}
      duplicates: [],   // {path, key, line, column, offset}
      truncated: false  // true when items were capped at LIMITS.maxItems
    };
  };

  Util.pushItem = function (a, type, path, pos, preview) {
    if (a.items.length >= Util.LIMITS.maxItems) { a.truncated = true; return; }
    a.items.push({
      type: type,
      typeLabel: Util.TYPE_LABELS[type],
      path: path,
      line: pos ? pos.line : 0,
      column: pos ? pos.column : 0,
      offset: pos ? pos.offset : -1,
      preview: Util.truncate(preview, Util.LIMITS.previewLength)
    });
  };

  Util.truncate = function (str, max) {
    str = String(str).replace(/[\r\n\t]+/g, ' ');
    return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
  };

  /** Path segment helpers: $.name, $['odd key'], $.list[2] */
  Util.pathKey = function (parent, key) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) { return parent + '.' + key; }
    return parent + "['" + key.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
  };

  Util.indentUnit = function (setting) {
    return setting === 'tab' ? '\t' : (String(setting) === '4' ? '    ' : '  ');
  };

  Util.debounce = function (fn, ms) {
    var t = null;
    function d() {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(ctx, args); }, ms);
    }
    d.cancel = function () { clearTimeout(t); t = null; };
    return d;
  };

  /** Offset -> {line, column, offset}. Lines and columns are 1-based. */
  var liText = null, liValue = null;     // the last index is reused when the same text is asked for again
  Util.lineIndex = function (text) {
    var starts, p = -1, result;
    if (text === liText && liValue) { return liValue; }
    starts = [0];
    while ((p = text.indexOf('\n', p + 1)) !== -1) { starts.push(p + 1); }
    result = {
      at: function (off) {
        var lo = 0, hi = starts.length - 1, mid;
        while (lo < hi) {
          mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= off) { lo = mid; } else { hi = mid - 1; }
        }
        return { line: lo + 1, column: off - starts[lo] + 1, offset: off };
      }
    };
    liText = text; liValue = result;
    return result;
  };

  function isWs(c) {
    return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0xFEFF || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F ||
      c === 0x205F || c === 0x3000;
  }

  /**
   * Text statistics in one pass.
   * chars = Unicode code points, bytes = UTF-8 size, lines = editor lines
   * (a trailing newline starts one more, empty line), words = runs of non-whitespace,
   * emptyLines = lines with no non-whitespace character, longestLine in code points.
   */
  Util.textStats = function (text) {
    var s = { chars: 0, bytes: 0, lines: 0, words: 0, leadingWs: 0, trailingWs: 0, emptyLines: 0, longestLine: 0 };
    var n = text.length;
    if (!n) { return s; }
    var inWord = false, lineLen = 0, hasText = false, lines = 1, i, c, d, j, k;
    for (i = 0; i < n; i++) {
      c = text.charCodeAt(i);
      if (c === 10) {
        if (!hasText) { s.emptyLines++; }
        if (lineLen > s.longestLine) { s.longestLine = lineLen; }
        lineLen = 0; hasText = false; inWord = false; lines++; s.chars++; s.bytes++;
        continue;
      }
      s.chars++;
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n && (d = text.charCodeAt(i + 1)) >= 0xDC00 && d <= 0xDFFF) {
        s.bytes += 4; lineLen++; i++;
        if (!inWord) { s.words++; inWord = true; }
        hasText = true;
        continue;
      }
      s.bytes += c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);
      if (c === 13) { inWord = false; continue; }
      lineLen++;
      if (isWs(c)) { inWord = false; }
      else { if (!inWord) { s.words++; inWord = true; } hasText = true; }
    }
    if (lineLen > s.longestLine) { s.longestLine = lineLen; }
    if (!hasText && lineLen > 0) { s.emptyLines++; }
    s.lines = lines;
    j = 0;
    while (j < n && isWs(text.charCodeAt(j))) { j++; }
    k = n;
    while (k > j && isWs(text.charCodeAt(k - 1))) { k--; }
    s.leadingWs = j;
    s.trailingWs = n - k;
    return s;
  };

  /* ------------------------------------------------------------------
     Json: strict RFC 8259 parser (iterative, no recursion), position-aware.
     The tree keeps source offsets, so formatting never rewrites a value:
     numbers and string escapes are copied exactly as typed.
     Node: {t:'o'|'a'|'s'|'n'|'b'|'z', s:start, e:end, kids:[]}
       object kids: {ks, ke, v}   array kids: nodes
     ------------------------------------------------------------------ */
  function fail(message, offset) {
    throw { __jsonError: true, message: message, offset: offset };
  }

  // opts.from: start parsing at this offset. opts.prefix: stop after the first complete value and
  // report where it ended ({end}) instead of failing on text that follows (used to find JSON inside logs).
  Json.parse = function (text, opts) {
    var n = text.length, i = (opts && opts.from) || 0, stack = [], root = null, prefix = !!(opts && opts.prefix);

    function skipWs() {
      var c;
      while (i < n) {
        c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) { i++; } else { break; }
      }
    }
    function isDigit(c) { return c >= 48 && c <= 57; }
    function isHex(c) { return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }

    function attach(node) {
      var top = stack[stack.length - 1];
      if (!top) { root = node; }
      else if (top.t === 'o') { top.kids.push({ ks: top.pk.s, ke: top.pk.e, v: node }); }
      else { top.kids.push(node); }
    }

    function unexpected(off) {
      var ch = text.charAt(off), hint = '';
      if (ch === "'") { hint = ' (JSON strings must use double quotes)'; }
      else if (ch === ',') { hint = ': a value is missing before the comma'; }
      else if (ch === '}' || ch === ']') { hint = ': a value is expected here'; }
      else if (ch === '/') { hint = ' (comments are not allowed in JSON)'; }
      else if (/[A-Za-z_]/.test(ch)) { hint = ' (strings need double quotes; the only bare words are true, false and null)'; }
      fail("Unexpected '" + ch + "'" + hint, off);
    }

    function scanString() {
      var start = i, c, e, k;
      i++;
      while (true) {
        if (i >= n) { fail('Unterminated string (missing closing double quote)', start); }
        c = text.charCodeAt(i);
        if (c === 34) { i++; return; }
        if (c === 92) {
          i++;
          e = text.charCodeAt(i);
          if (e === 117) {
            for (k = 1; k <= 4; k++) {
              if (!isHex(text.charCodeAt(i + k))) { fail('Invalid \\u escape: four hex digits are required', i - 1); }
            }
            i += 5;
          } else if (e === 34 || e === 92 || e === 47 || e === 98 || e === 102 || e === 110 || e === 114 || e === 116) {
            i++;
          } else {
            fail('Invalid escape sequence in string', i - 1);
          }
        } else if (c < 32) {
          fail(c === 10 || c === 13 ? 'Line break inside a string (use \\n instead)' : 'Unescaped control character in string', i);
        } else {
          i++;
        }
      }
    }

    function scanNumber() {
      var c;
      if (text.charCodeAt(i) === 45) { i++; }
      c = text.charCodeAt(i);
      if (c === 48) {
        i++;
        if (isDigit(text.charCodeAt(i))) { fail('Invalid number: leading zeros are not allowed', i); }
      } else if (c >= 49 && c <= 57) {
        while (isDigit(text.charCodeAt(i))) { i++; }
      } else {
        fail('Invalid number: a digit is expected', i);
      }
      if (text.charCodeAt(i) === 46) {
        i++;
        if (!isDigit(text.charCodeAt(i))) { fail('Invalid number: digits are expected after the decimal point', i); }
        while (isDigit(text.charCodeAt(i))) { i++; }
      }
      c = text.charCodeAt(i);
      if (c === 101 || c === 69) {
        i++;
        c = text.charCodeAt(i);
        if (c === 43 || c === 45) { i++; }
        if (!isDigit(text.charCodeAt(i))) { fail('Invalid number: digits are expected in the exponent', i); }
        while (isDigit(text.charCodeAt(i))) { i++; }
      }
    }

    function literal(word) {
      var nx;
      if (text.substr(i, word.length) !== word) { return false; }
      nx = text.charCodeAt(i + word.length);
      return !(isDigit(nx) || (nx >= 65 && nx <= 90) || (nx >= 97 && nx <= 122) || nx === 95);
    }

    function readKey(obj) {
      var ks;
      skipWs();
      if (text.charCodeAt(i) !== 34) {
        if (i >= n) { fail("Unexpected end of input: missing '}'", i); }
        fail('Expected a property name in double quotes' + (text.charAt(i) === "'" ? ' (single quotes are not valid JSON)' : ''), i);
      }
      ks = i;
      scanString();
      obj.pk = { s: ks, e: i };
      skipWs();
      if (text.charCodeAt(i) !== 58) { fail("Expected ':' after the property name", i); }
      i++;
    }

    function run() {
      var state = 'value', c, node, s, top, commaAt;
      if (i === 0 && text.charCodeAt(0) === 0xFEFF) { i = 1; }
      skipWs();
      if (i >= n) { fail('Input is empty: expected a JSON value', 0); }
      while (true) {
        if (state === 'value') {
          skipWs();
          if (i >= n) { fail('Unexpected end of input: a value is missing', i); }
          c = text.charCodeAt(i);
          if (c === 123) {
            node = { t: 'o', s: i, e: 0, kids: [], pk: null };
            attach(node); i++; stack.push(node); skipWs();
            if (text.charCodeAt(i) === 125) { i++; node.e = i; stack.pop(); state = 'after'; }
            else { readKey(node); }
          } else if (c === 91) {
            node = { t: 'a', s: i, e: 0, kids: [] };
            attach(node); i++; stack.push(node); skipWs();
            if (text.charCodeAt(i) === 93) { i++; node.e = i; stack.pop(); state = 'after'; }
          } else if (c === 34) {
            s = i; scanString(); attach({ t: 's', s: s, e: i }); state = 'after';
          } else if (c === 45 || isDigit(c)) {
            s = i; scanNumber(); attach({ t: 'n', s: s, e: i }); state = 'after';
          } else if (c === 116 && literal('true')) {
            attach({ t: 'b', s: i, e: i + 4 }); i += 4; state = 'after';
          } else if (c === 102 && literal('false')) {
            attach({ t: 'b', s: i, e: i + 5 }); i += 5; state = 'after';
          } else if (c === 110 && literal('null')) {
            attach({ t: 'z', s: i, e: i + 4 }); i += 4; state = 'after';
          } else {
            unexpected(i);
          }
        } else {
          skipWs();
          if (!stack.length) {
            if (i < n && !prefix) { fail('Unexpected content after the end of the JSON value', i); }
            return;
          }
          top = stack[stack.length - 1];
          if (i >= n) { fail(top.t === 'o' ? "Unexpected end of input: missing '}'" : "Unexpected end of input: missing ']'", i); }
          c = text.charCodeAt(i);
          if (c === 44) {
            commaAt = i; i++; skipWs();
            if (top.t === 'o') {
              if (text.charCodeAt(i) === 125) { fail('Trailing comma is not allowed in JSON', commaAt); }
              readKey(top);
            } else if (text.charCodeAt(i) === 93) {
              fail('Trailing comma is not allowed in JSON', commaAt);
            }
            state = 'value';
          } else if (c === 125 && top.t === 'o') {
            i++; top.e = i; stack.pop();
          } else if (c === 93 && top.t === 'a') {
            i++; top.e = i; stack.pop();
          } else {
            fail(top.t === 'o'
              ? "Expected ',' or '}' after the property value (a comma may be missing)"
              : "Expected ',' or ']' after the array item (a comma may be missing)", i);
          }
        }
      }
    }

    try {
      run();
      return { ok: true, root: root, text: text, end: root.e };
    } catch (e) {
      if (e && e.__jsonError) {
        if (prefix) { return { ok: false, error: { message: e.message, line: 0, column: 0, offset: e.offset } }; }
        var p = Util.lineIndex(text).at(Math.min(e.offset, n));
        return { ok: false, error: { message: e.message, line: p.line, column: p.column, offset: p.offset } };
      }
      throw e;
    }
  };

  /** Decode a raw quoted key ("a\u0062") to its real string value. */
  Json.decodeKey = function (raw) {
    if (raw.indexOf('\\') < 0) { return raw.slice(1, -1); }
    try { return JSON.parse(raw); } catch (e) { return raw.slice(1, -1); }
  };

  /**
   * Serialize a parsed tree. indent === '' minifies; otherwise pretty-prints.
   * Scalars are copied from the source text, so no value is ever altered.
   */
  Json.serialize = function (parsed, indent) {
    var text = parsed.text, root = parsed.root, out = [], stack = [];
    var pretty = indent !== '', pad = [];
    function rep(d) { return pad[d] || (pad[d] = new Array(d + 1).join(indent)); }
    function open(node) {
      if (!node.kids.length) { out.push(node.t === 'o' ? '{}' : '[]'); return; }
      out.push(node.t === 'o' ? '{' : '[');
      stack.push({ n: node, i: 0 });
    }
    var f, node, kid, v;
    if (root.t !== 'o' && root.t !== 'a') { return text.slice(root.s, root.e); }
    open(root);
    while (stack.length) {
      f = stack[stack.length - 1];
      node = f.n;
      if (f.i >= node.kids.length) {
        stack.pop();
        if (pretty) { out.push('\n' + rep(stack.length)); }
        out.push(node.t === 'o' ? '}' : ']');
        continue;
      }
      kid = node.kids[f.i];
      if (f.i > 0) { out.push(','); }
      if (pretty) { out.push('\n' + rep(stack.length)); }
      f.i++;
      if (node.t === 'o') {
        out.push(text.slice(kid.ks, kid.ke), pretty ? ': ' : ':');
        v = kid.v;
      } else {
        v = kid;
      }
      if (v.t === 'o' || v.t === 'a') { open(v); } else { out.push(text.slice(v.s, v.e)); }
    }
    return out.join('');
  };

  Json.beautify = function (parsed, unit) { return Json.serialize(parsed, unit || '  '); };
  Json.minify = function (parsed) { return Json.serialize(parsed, ''); };

  /** Counts, null/empty inspection list and duplicate keys for a parsed tree. */
  Json.analyze = function (parsed) {
    var a = Util.newAnalysis(), c = a.counts, text = parsed.text, root = parsed.root;
    var li = null, stack = [], f, idx, kid, v, kt, p, needPath;
    c.fields = c.objects = c.arrays = c.nulls = c.emptyStrings = 0;
    c.emptyArrays = c.emptyObjects = c.duplicateKeys = 0;

    function pos(off) { li = li || Util.lineIndex(text); return li.at(off); }

    function findDuplicates(obj, path) {
      var seen = Object.create(null), k = obj.kids, j, key, ps;
      for (j = 0; j < k.length; j++) {
        key = Json.decodeKey(text.slice(k[j].ks, k[j].ke));
        if (seen[key]) {
          c.duplicateKeys++;
          if (a.duplicates.length < Util.LIMITS.maxItems) {
            ps = pos(k[j].ks);
            a.duplicates.push({ path: Util.pathKey(path, key), key: key, line: ps.line, column: ps.column, offset: ps.offset });
          }
        } else {
          seen[key] = true;
        }
      }
    }

    function enter(node, path, keyText) {
      var pre = keyText ? keyText + ': ' : '', len = node.kids.length;
      if (node.t === 'o') {
        c.objects++; c.fields += len;
        if (!len) { c.emptyObjects++; Util.pushItem(a, 'emptyObject', path, pos(node.s), pre + '{}'); return; }
        if (len > 1) { findDuplicates(node, path); }
      } else {
        c.arrays++;
        if (!len) { c.emptyArrays++; Util.pushItem(a, 'emptyArray', path, pos(node.s), pre + '[]'); return; }
      }
      stack.push({ n: node, i: 0, p: path });
    }

    function leaf(node, path, keyText) {
      var pre = keyText ? keyText + ': ' : '';
      if (node.t === 'z') { c.nulls++; Util.pushItem(a, 'null', path, pos(node.s), pre + 'null'); }
      else if (node.t === 's' && node.e - node.s === 2) { c.emptyStrings++; Util.pushItem(a, 'emptyString', path, pos(node.s), pre + '""'); }
    }

    if (root.t === 'o' || root.t === 'a') { enter(root, '$', null); } else { leaf(root, '$', null); }
    while (stack.length) {
      f = stack[stack.length - 1];
      if (f.i >= f.n.kids.length) { stack.pop(); continue; }
      idx = f.i++;
      kid = f.n.kids[idx];
      kt = null;
      if (f.n.t === 'o') { v = kid.v; kt = text.slice(kid.ks, kid.ke); } else { v = kid; }
      needPath = v.t === 'o' || v.t === 'a' || v.t === 'z' || (v.t === 's' && v.e - v.s === 2);
      if (!needPath) { continue; }
      p = f.n.t === 'o' ? Util.pathKey(f.p, Json.decodeKey(kt)) : f.p + '[' + idx + ']';
      if (v.t === 'o' || v.t === 'a') { enter(v, p, kt); } else { leaf(v, p, kt); }
    }
    return a;
  };

})(window);
/* ===================== END OF PART 1 ===================== */
