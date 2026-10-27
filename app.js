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
/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 2 of 7: YAML engine (uses js-yaml 4.1.0 from the CDN)
   BEGINS: the line "PART 2 of 7" below Part 1's END marker.
   ENDS:   the line "END OF PART 2".

   Registers DFI.Yaml:
     available()                  -> true when js-yaml loaded
     parse(text)                  -> {ok, data, docs, multi, empty, warnings, text, events} | {ok:false, error}
     beautify(parsed, unit)       -> {ok, text, notices} | {ok:false, error}
     minify(parsed)               -> {ok, text, notices}   (compact flow style, one line per document)
     dump(data, unit, compact, schemaName)   schemaName: 'same' (as read) | 'safe' (default, quotes ambiguous strings)
     analyze(parsed)              -> analysis (same shape as DFI.Json.analyze, plus optional notes[])
     toJsonValue(parsed)          -> {ok, value, notices} | {ok:false, error}

   Counting rules: nulls = YAML null (null, ~, or an empty value); the string "null" is not null.
   fields = mapping keys, objects = mappings, arrays = sequences. Aliases are counted where used.
   Duplicate mapping keys are a syntax error in YAML, so duplicateKeys is always 0 for valid input.
   Dates stay plain strings (timestamps are not converted), so values are never rewritten.
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI, Util = DFI.Util, Yaml = DFI.Yaml = {};
  var POSITION_MAX_CHARS = 300000;   // above this size, item positions are skipped
  var WALK_MAX_NODES = 2000000;      // guards against alias expansion blow-ups

  Yaml.available = function () {
    return !!(global.jsyaml && global.jsyaml.load && global.jsyaml.loadAll && global.jsyaml.dump);
  };

  var schemas = null;
  function getSchemas() {
    var y, t;
    if (schemas) { return schemas; }
    y = global.jsyaml; t = y.types;
    schemas = {
      same: y.CORE_SCHEMA.extend({ implicit: [t.merge], explicit: [t.binary, t.omap, t.pairs, t.set] }),
      safe: y.DEFAULT_SCHEMA
    };
    return schemas;
  }

  function isSeq(v) { return Array.isArray(v); }
  function isMap(v) { return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]'; }
  function isContainer(v) { return isSeq(v) || isMap(v); }

  function toError(e, text) {
    var m = e && e.mark, off = m ? m.position : -1, msg = (e && (e.reason || e.message)) || 'Invalid YAML', ls, le;
    if (m && off >= 0) {
      ls = text.lastIndexOf('\n', off - 1) + 1;
      le = text.indexOf('\n', off);
      if (le < 0) { le = text.length; }
      if (/^ *\t/.test(text.slice(ls, le))) { msg += ' (YAML does not allow tabs for indentation; use spaces)'; }
    }
    return { message: msg, line: m ? m.line + 1 : 0, column: m ? m.column + 1 : 0, offset: off };
  }

  /* ------------------------------------------------------------------
     parse
     ------------------------------------------------------------------ */
  Yaml.parse = function (text) {
    var docs = [], warnings = [], events = null, opens = [], opts, empty = false;
    if (!Yaml.available()) {
      return { ok: false, error: { message: 'The YAML library (js-yaml) did not load. Check your connection or CDN access, then reload the page.', line: 0, column: 0, offset: -1 } };
    }
    if (text.length <= POSITION_MAX_CHARS) { events = []; }
    opts = {
      schema: getSchemas().same,
      onWarning: function (w) {
        warnings.push({ text: w.reason || String(w), line: w.mark ? w.mark.line + 1 : 0, column: w.mark ? w.mark.column + 1 : 0 });
      },
      listener: events ? function (type, st) {
        var openPos, ev, last;
        if (type === 'open') { opens.push(st.position); return; }
        openPos = opens.pop();
        ev = { kind: st.kind, result: st.result, end: st.position, open: openPos };
        last = events[events.length - 1];
        // The loader reports some nodes twice (nested compose calls): keep one copy.
        if (last && last.kind === ev.kind && last.end === ev.end && Object.is(last.result, ev.result)) { return; }
        events.push(ev);
      } : null
    };
    try {
      global.jsyaml.loadAll(text, function (d) { docs.push(d); }, opts);
    } catch (e) {
      return { ok: false, error: toError(e, text) };
    }
    if (docs.length === 0 || (docs.length === 1 && docs[0] === undefined) ||
        (docs.length === 1 && docs[0] === null && !/^[ \t]*[^#\s]/m.test(text))) { docs = []; empty = true; }
    if (docs.length !== 1) { events = null; }
    return {
      ok: true, text: text, docs: docs, multi: docs.length > 1, empty: empty,
      data: empty ? null : (docs.length === 1 ? docs[0] : docs),
      warnings: warnings, events: events
    };
  };

  /* ------------------------------------------------------------------
     dump / beautify / minify
     ------------------------------------------------------------------ */
  Yaml.dump = function (data, unit, compact, schemaName) {
    var opts = {
      indent: unit && unit.length === 4 ? 4 : 2,
      lineWidth: -1,          // never fold long strings
      noRefs: false,          // keep shared nodes as anchors
      sortKeys: false,        // keep key order
      schema: getSchemas()[schemaName || 'safe']
    };
    if (compact) { opts.flowLevel = 0; }
    return global.jsyaml.dump(data === undefined ? null : data, opts);
  };

  function dumpAll(parsed, unit, compact) {
    if (parsed.empty) { return ''; }
    return parsed.docs.map(function (d) { return Yaml.dump(d, unit, compact, 'same'); }).join('---\n');
  }

  Yaml.notices = function (parsed, unit) {
    var n = [], t = parsed.text, i;
    if (/(^|[ \t])#/m.test(t)) {
      n.push({ level: 'warning', text: 'Comments, if any, are not preserved: the output is regenerated from the parsed data.' });
    }
    if (/^[ \t]*(?:-[ \t]+)?<<[ \t]*:/m.test(t)) {
      n.push({ level: 'warning', text: 'Merge keys (<<) are expanded into plain keys in the output.' });
    }
    if (/(^|[\s\-:\[,{])[&*][A-Za-z0-9_-]+/.test(t)) {
      n.push({ level: 'info', text: 'Anchor names are regenerated (ref_0, ref_1, ...). Aliases that are not shared are written out in full.' });
    }
    if (parsed.multi) {
      n.push({ level: 'info', text: 'The input has ' + parsed.docs.length + ' YAML documents. They stay separate documents in YAML output.' });
    }
    if (parsed.empty) {
      n.push({ level: 'info', text: 'The input has no YAML content (it is empty or only comments).' });
    }
    if (unit === '\t') {
      n.push({ level: 'info', text: 'YAML cannot be indented with tabs, so 2 spaces were used.' });
    }
    for (i = 0; i < parsed.warnings.length; i++) {
      n.push({ level: 'warning', text: 'YAML warning' + (parsed.warnings[i].line ? ' (line ' + parsed.warnings[i].line + ')' : '') + ': ' + parsed.warnings[i].text });
    }
    return n;
  };

  Yaml.beautify = function (parsed, unit) {
    try {
      return { ok: true, text: dumpAll(parsed, unit, false), notices: Yaml.notices(parsed, unit) };
    } catch (e) {
      return { ok: false, error: { message: (e && (e.reason || e.message)) || 'The data cannot be written as YAML.', line: 0, column: 0, offset: -1 } };
    }
  };

  Yaml.minify = function (parsed) {
    var notices;
    try {
      notices = Yaml.notices(parsed, '  ');
      notices.push({ level: 'info', text: 'Minified YAML uses flow style, for example {key: value, list: [1, 2]}.' });
      return { ok: true, text: dumpAll(parsed, '  ', true), notices: notices };
    } catch (e) {
      return { ok: false, error: { message: (e && (e.reason || e.message)) || 'The data cannot be written as YAML.', line: 0, column: 0, offset: -1 } };
    }
  };

  /* ------------------------------------------------------------------
     locate: map item paths to source offsets using the loader's event stream.
     The events are replayed against the parsed data and every event is checked
     (kind and object identity). On any mismatch, for example with merge keys,
     null is returned and items simply show "no position". Positions are never guessed.
     ------------------------------------------------------------------ */
  function isItem(v) {
    return v === null || v === '' || (isSeq(v) && !v.length) || (isMap(v) && !Object.keys(v).length);
  }

  function locate(parsed) {
    var ev = parsed.events, j = 0, out = Object.create(null), stack = [], f, e, len, idx, key, v, keyOff;

    function mark(path, keyOffset, e2) {
      var slot = out[path] || (out[path] = { k: -1, v: -1 });
      slot.v = e2.open;
      slot.k = keyOffset;
    }

    function enter(node, path, kOff) {
      var e2 = ev[j];
      if (!e2) { return false; }
      if (e2.kind === null) {                       // alias: the loader hands back the shared value
        if (!Object.is(e2.result, node)) { return false; }
        j++;
        if (isItem(node)) { mark(path, kOff, e2); }
        return true;
      }
      if (isContainer(node)) {
        stack.push({ n: node, keys: isMap(node) ? Object.keys(node) : null, i: 0, p: path, ko: kOff });
        return true;
      }
      if (e2.kind !== 'scalar' || !Object.is(e2.result, node)) { return false; }
      j++;
      if (isItem(node)) { mark(path, kOff, e2); }
      return true;
    }

    if (!ev || parsed.multi || parsed.empty) { return null; }
    if (!enter(parsed.data, '$', -1)) { return null; }
    while (stack.length) {
      f = stack[stack.length - 1];
      len = f.keys ? f.keys.length : f.n.length;
      if (f.i >= len) {
        e = ev[j];
        if (!e || e.kind !== (f.keys ? 'mapping' : 'sequence') || e.result !== f.n) { return null; }
        j++;
        if (isItem(f.n)) { mark(f.p, f.ko, e); }
        stack.pop();
        continue;
      }
      idx = f.i++;
      if (f.keys) {
        key = f.keys[idx];
        e = ev[j];
        if (!e || e.kind !== 'scalar' || String(e.result) !== key) { return null; }
        j++;
        keyOff = e.open;
        v = f.n[key];
        if (!enter(v, Util.pathKey(f.p, key), keyOff)) { return null; }
      } else {
        v = f.n[idx];
        if (!enter(v, f.p + '[' + idx + ']', -1)) { return null; }
      }
    }
    return j === ev.length ? out : null;
  }

  /* ------------------------------------------------------------------
     analyze
     ------------------------------------------------------------------ */
  Yaml.analyze = function (parsed) {
    var a = Util.newAnalysis(), c = a.counts, text = parsed.text, pos = null, li = null;
    var stack = [], onPath = new Set(), seen = new Set(), visits = 0, f, len, idx, key, v;
    var notedAlias = false, notedPrecision = false;
    a.notes = [];
    c.fields = c.objects = c.arrays = c.nulls = c.emptyStrings = 0;
    c.emptyArrays = c.emptyObjects = c.duplicateKeys = 0;
    if (parsed.empty) { return a; }
    pos = locate(parsed);
    if (!pos && !parsed.multi && parsed.events) {
      a.notes.push('Line and column positions are not available for this YAML (for example it uses merge keys, numeric keys, complex keys or empty list items).');
    } else if (!parsed.events) {
      a.notes.push('Line and column positions are skipped for multi-document or very large YAML.');
    }

    function where(path) {
      var p = pos && pos[path], off, ch;
      if (!p) { return null; }
      off = p.v;
      if (off >= 0) {
        while (off < text.length && (text.charAt(off) === ' ' || text.charAt(off) === '\t')) { off++; }
        ch = text.charAt(off);
        if (off >= text.length || ch === '\n' || ch === '\r' || ch === '#') { off = p.k; }   // value has no text: point at its key
      } else {
        off = p.k;
      }
      if (off < 0) { return null; }
      li = li || Util.lineIndex(text);
      return li.at(off);
    }

    function item(type, path, label, raw) {
      Util.pushItem(a, type, path, where(path), (label !== null ? label + ': ' : '') + raw);
    }

    function visit(val, path, label) {
      var keys = null;
      visits++;
      if (isContainer(val)) {
        if (onPath.has(val)) { a.notes.push('A recursive alias was skipped at ' + path + '.'); return; }
        if (seen.has(val) && !notedAlias) {
          notedAlias = true;
          a.notes.push('Aliases are counted every place they are used.');
        }
        seen.add(val);
        if (isMap(val)) {
          keys = Object.keys(val);
          c.objects++; c.fields += keys.length;
          if (!keys.length) { c.emptyObjects++; item('emptyObject', path, label, '{}'); return; }
        } else {
          c.arrays++;
          if (!val.length) { c.emptyArrays++; item('emptyArray', path, label, '[]'); return; }
        }
        onPath.add(val);
        stack.push({ n: val, keys: keys, i: 0, p: path });
      } else if (val === null || val === undefined) {
        c.nulls++; item('null', path, label, 'null');
      } else if (val === '') {
        c.emptyStrings++; item('emptyString', path, label, '""');
      } else if (typeof val === 'number' && !notedPrecision && Number.isInteger(val) && !Number.isSafeInteger(val)) {
        notedPrecision = true;
        a.notes.push('An integer larger than 2^53 was read as a JavaScript number and may lose precision when written back.');
      }
    }

    function drain() {
      while (stack.length) {
        f = stack[stack.length - 1];
        len = f.keys ? f.keys.length : f.n.length;
        if (f.i >= len) { onPath.delete(f.n); stack.pop(); continue; }
        if (visits > WALK_MAX_NODES) {
          a.notes.push('Analysis stopped after ' + WALK_MAX_NODES.toLocaleString('en-US') + ' nodes. Aliases may be expanding very deeply.');
          stack.length = 0; onPath.clear();
          return;
        }
        idx = f.i++;
        if (f.keys) { key = f.keys[idx]; v = f.n[key]; visit(v, Util.pathKey(f.p, key), key); }
        else { v = f.n[idx]; visit(v, f.p + '[' + idx + ']', null); }
      }
    }

    if (parsed.multi) {
      parsed.docs.forEach(function (d, i) { visit(d, '$[' + i + ']', null); drain(); });
      a.notes.push('Multi-document input: paths start with the document number, for example $[0].');
    } else {
      visit(parsed.data, '$', null);
      drain();
    }
    return a;
  };

  /* ------------------------------------------------------------------
     toJsonValue: plain JSON-safe copy of the parsed data (iterative).
     Fails instead of guessing when JSON cannot represent the data.
     ------------------------------------------------------------------ */
  function toBase64(bytes) {
    var s = '', i, chunk = 0x8000;
    for (i = 0; i < bytes.length; i += chunk) { s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); }
    return global.btoa(s);
  }

  Yaml.toJsonValue = function (parsed) {
    var notices = [], noted = {}, seen = new Set(), onPath = new Set(), visits = 0, stack = [], root, f, key, len;

    function note(k, level, text) {
      if (!noted[k]) { noted[k] = true; notices.push({ level: level, text: text }); }
    }

    function conv(v) {
      var sh;
      if (++visits > 3000000) { throw { msg: 'The data is too large to convert. Aliases may be expanding very deeply.' }; }
      if (isContainer(v)) {
        if (onPath.has(v)) { throw { msg: 'The YAML has a recursive alias, which JSON cannot represent.' }; }
        if (seen.has(v)) { note('alias', 'info', 'Aliases were expanded into full copies in the JSON output.'); }
        seen.add(v); onPath.add(v);
        sh = isSeq(v) ? [] : Object.create(null);
        stack.push({ src: v, dst: sh, keys: isMap(v) ? Object.keys(v) : null, i: 0 });
        return sh;
      }
      if (v === undefined || v === null) { return null; }
      if (typeof v === 'number') {
        if (!isFinite(v)) { throw { msg: 'The YAML contains .nan or .inf, which JSON cannot represent.' }; }
        if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
          note('bigint', 'warning', 'An integer larger than 2^53 may have lost precision when it was read.');
        }
        return v;
      }
      if (v instanceof Uint8Array) {
        note('binary', 'warning', 'Binary values (!!binary) were written as base64 strings.');
        return toBase64(v);
      }
      return v;
    }

    try {
      if (parsed.multi) { note('multi', 'warning', 'The YAML has several documents. They were written as a JSON array, one item per document.'); }
      root = conv(parsed.empty ? null : parsed.data);
      while (stack.length) {
        f = stack[stack.length - 1];
        len = f.keys ? f.keys.length : f.src.length;
        if (f.i >= len) { onPath.delete(f.src); stack.pop(); continue; }
        if (f.keys) { key = f.keys[f.i++]; f.dst[key] = conv(f.src[key]); }
        else { f.dst.push(conv(f.src[f.i++])); }
      }
      return { ok: true, value: root, notices: notices };
    } catch (e) {
      if (e && e.msg) { return { ok: false, error: { message: e.msg, line: 0, column: 0, offset: -1 } }; }
      throw e;
    }
  };

})(window);
/* ===================== END OF PART 2 ===================== */
/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 3 of 7: XML engine
   BEGINS: the comment block headed "PART 3 of 7" (paste right after "END OF PART 2").
   ENDS:   the line "END OF PART 3".

   Registers DFI.Xml:
     parse(text)                -> {ok, text, root, doc, ...} | {ok:false, error:{message,line,column,offset}}
     beautify(parsed, unit)     -> {ok, text, notices} | {ok:false, error}  (fails for absurdly deep nesting)
     minify(parsed)             -> {ok, text, notices}
     analyze(parsed)            -> analysis (same shape as DFI.Json.analyze, plus notes[])
     toJsonValue(parsed)        -> {ok, value, notices} | {ok:false, error}
     decodeText(raw)            -> text with &amp; &lt; &#65; etc. decoded (throws {msg} on custom entities)
     escapeText(s), escapeAttr(s), isName(s), firstInvalidChar(s)   (helpers for JSON -> XML in Part 5)

   How validation works: a character-level scanner (not regex based) checks well-formedness and
   records source offsets. When the browser provides DOMParser, the document is also parsed with it;
   if the browser finds an error the scanner missed (for example an unbound namespace prefix),
   that error is reported.

   XML counting rules:
   - fields          = elements                      objects = elements that contain child elements
   - attributes      = attributes, not counting xmlns declarations
   - textNodes       = text and CDATA nodes that are not whitespace-only
   - emptyElements   = elements with no child elements and no text, or only whitespace text:
                       <a></a>, <a/>, <a>   </a>. An element with attributes but no content is still listed.
   - whitespaceTexts = whitespace-only text nodes that are the only content of an element
                       (indentation between child elements is not counted)
   - nulls           = elements with xsi:nil="true" (the xsi prefix must map to the XMLSchema-instance
                       namespace). The text "null" is never a null. A nil element is not also listed as empty.
   - emptyStrings, emptyArrays, emptyObjects, duplicateKeys = N/A for XML.
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI, Util = DFI.Util, Xml = DFI.Xml = {};
  var XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
  var MAX_DOM_DEPTH = 3000;   // the browser parser is recursive, so skip it for extremely deep documents

  /* ------------------------------------------------------------------
     Character helpers
     ------------------------------------------------------------------ */
  function isWsc(c) { return c === 32 || c === 9 || c === 10 || c === 13; }
  function isNameStart(c) {
    return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 58 || (c >= 0xC0 && c !== 0xD7 && c !== 0xF7);
  }
  function isNameChar(c) { return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 0xB7; }
  function wsOnly(text, s, e) {
    var i;
    for (i = s; i < e; i++) { if (!isWsc(text.charCodeAt(i))) { return false; } }
    return true;
  }

  Xml.isName = function (s) {
    var i;
    if (!s || !isNameStart(s.charCodeAt(0))) { return false; }
    for (i = 1; i < s.length; i++) { if (!isNameChar(s.charCodeAt(i))) { return false; } }
    return true;
  };

  /** Index of the first character XML 1.0 does not allow, or -1. */
  Xml.firstInvalidChar = function (s) {
    var m = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.exec(s);
    return m ? m.index : -1;
  };

  Xml.escapeText = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  Xml.escapeAttr = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
  };

  Xml.decodeText = function (raw) {
    if (raw.indexOf('&') < 0) { return raw; }
    return raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z_:][\w:.\-]*);/g, function (m, ref) {
      var cp;
      if (ref.charAt(0) === '#') {
        cp = ref.charAt(1) === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        if (!(cp > 0 && cp <= 0x10FFFF) || (cp >= 0xD800 && cp <= 0xDFFF)) { throw { msg: 'Invalid character reference ' + m }; }
        return String.fromCodePoint(cp);
      }
      if (ref === 'amp') { return '&'; }
      if (ref === 'lt') { return '<'; }
      if (ref === 'gt') { return '>'; }
      if (ref === 'quot') { return '"'; }
      if (ref === 'apos') { return "'"; }
      throw { msg: 'The XML uses the custom entity &' + ref + '; which is not expanded here.' };
    });
  };

  /* ------------------------------------------------------------------
     Scanner: checks well-formedness and builds a position-aware tree.
     Node kinds: e element {n, s, e, attrs:[{n,v,q,s}], sc, kids, os, cs}
                 x text {s,e}   d CDATA   c comment   p processing instruction
                 dt DOCTYPE     decl XML declaration
     ------------------------------------------------------------------ */
  function scan(text) {
    var n = text.length, i = 0, stack = [], doc = { kids: [] }, root = null, afterRoot = false;
    var hasDoctype = false, customEntities = false, maxDepth = 0, parserErrorName = false;
    var bad, parent, c, next, j, k, e, e2, q, ve, lt, name, an, attrs, seen, sc, el, top, end, cd, body, depth, quote, internal;

    function fail(msg, off, rel) {
      throw { __xmlError: true, message: msg, offset: off, related: rel === undefined ? -1 : rel };
    }
    function nameEnd(p) {
      var ch = text.charCodeAt(p);
      if (!isNameStart(ch)) { return p; }
      p++;
      while (p < n && isNameChar(text.charCodeAt(p))) { p++; }
      return p;
    }
    function skipWs(p) {
      while (p < n && isWsc(text.charCodeAt(p))) { p++; }
      return p;
    }
    function checkRefs(from, to) {
      var seg = text.slice(from, to), p = seg.indexOf('&'), qq, nm;
      while (p !== -1) {
        qq = seg.indexOf(';', p + 1);
        if (qq === -1 || qq - p > 40) { fail("Unescaped '&'. Write &amp; for a literal ampersand", from + p); }
        nm = seg.slice(p + 1, qq);
        if (nm.charAt(0) === '#') {
          if (!/^#(?:[0-9]+|x[0-9A-Fa-f]+)$/.test(nm)) { fail('Invalid character reference &' + nm + ';', from + p); }
        } else if (!Xml.isName(nm)) {
          fail("Unescaped '&'. Write &amp; for a literal ampersand", from + p);
        } else if (nm !== 'amp' && nm !== 'lt' && nm !== 'gt' && nm !== 'quot' && nm !== 'apos' && !customEntities) {
          fail('Unknown entity &' + nm + '; (only &amp; &lt; &gt; &quot; &apos; are predefined)', from + p);
        }
        p = seg.indexOf('&', qq + 1);
      }
    }

    bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.exec(text);
    if (bad) { fail('Invalid character U+' + ('0000' + text.charCodeAt(bad.index).toString(16).toUpperCase()).slice(-4) + ' is not allowed in XML', bad.index); }
    if (text.charCodeAt(0) === 0xFEFF) { i = 1; }

    if (text.substr(i, 5) === '<?xml' && isWsc(text.charCodeAt(i + 5))) {
      end = text.indexOf('?>', i);
      if (end === -1) { fail('Unterminated XML declaration', i); }
      doc.kids.push({ t: 'decl', s: i, e: end + 2 });
      i = end + 2;
    }

    while (i < n) {
      parent = stack.length ? stack[stack.length - 1] : doc;
      c = text.charCodeAt(i);
      if (c !== 60) {
        j = text.indexOf('<', i);
        if (j === -1) { j = n; }
        if (parent === doc) {
          for (k = i; k < j; k++) { if (!isWsc(text.charCodeAt(k))) { fail('Text is not allowed outside the root element', k); } }
        } else {
          checkRefs(i, j);
          cd = text.slice(i, j).indexOf(']]>');
          if (cd !== -1) { fail("']]>' is not allowed in text (write ]]&gt;)", i + cd); }
          parent.kids.push({ t: 'x', s: i, e: j });
        }
        i = j;
        continue;
      }
      next = text.charCodeAt(i + 1);

      if (next === 33) {                                   /* <! */
        if (text.substr(i, 4) === '<!--') {
          end = text.indexOf('-->', i + 4);
          if (end === -1) { fail('Unterminated comment (missing -->)', i); }
          body = text.slice(i + 4, end);
          if (body.indexOf('--') >= 0 || body.charAt(body.length - 1) === '-') { fail("'--' is not allowed inside a comment", i); }
          parent.kids.push({ t: 'c', s: i, e: end + 3 });
          i = end + 3;
        } else if (text.substr(i, 9) === '<![CDATA[') {
          if (parent === doc) { fail('CDATA is not allowed outside the root element', i); }
          end = text.indexOf(']]>', i + 9);
          if (end === -1) { fail('Unterminated CDATA section (missing ]]>)', i); }
          parent.kids.push({ t: 'd', s: i, e: end + 3, cs: i + 9, ce: end });
          i = end + 3;
        } else if (text.substr(i, 9) === '<!DOCTYPE') {
          if (parent !== doc || root || hasDoctype) { fail('A DOCTYPE is only allowed once, before the root element', i); }
          j = i + 9; depth = 0; quote = 0; k = -1;
          while (j < n) {
            c = text.charCodeAt(j);
            if (quote) { if (c === quote) { quote = 0; } }
            else if (c === 34 || c === 39) { quote = c; }
            else if (c === 91) { depth++; if (k < 0) { k = j; } }
            else if (c === 93) { depth--; }
            else if (c === 62 && depth <= 0) { break; }
            j++;
          }
          if (j >= n) { fail('Unterminated DOCTYPE declaration', i); }
          internal = k >= 0 ? text.slice(k, j) : '';
          customEntities = internal.indexOf('<!ENTITY') >= 0;
          hasDoctype = true;
          doc.kids.push({ t: 'dt', s: i, e: j + 1 });
          i = j + 1;
        } else {
          fail("Unexpected '<!'. Comments start with <!-- and CDATA with <![CDATA[", i);
        }
        continue;
      }

      if (next === 63) {                                   /* <? */
        end = text.indexOf('?>', i + 2);
        if (end === -1) { fail('Unterminated processing instruction (missing ?>)', i); }
        k = nameEnd(i + 2);
        if (k === i + 2) { fail('A processing instruction needs a target name after <?', i); }
        if (text.slice(i + 2, k).toLowerCase() === 'xml') { fail('The XML declaration is only allowed at the very start of the document', i); }
        parent.kids.push({ t: 'p', s: i, e: end + 2 });
        i = end + 2;
        continue;
      }

      if (next === 47) {                                   /* </ */
        k = nameEnd(i + 2);
        if (k === i + 2) { fail('Malformed closing tag: a name is expected after </', i); }
        name = text.slice(i + 2, k);
        e2 = skipWs(k);
        if (text.charCodeAt(e2) !== 62) { fail("Expected '>' to end the closing tag </" + name + '>', e2); }
        top = stack.pop();
        if (!top) { fail('Closing tag </' + name + '> has no matching opening tag', i); }
        if (top.n !== name) { fail('Mismatched closing tag: expected </' + top.n + '> but found </' + name + '>', i, top.s); }
        top.cs = i; top.e = e2 + 1;
        i = e2 + 1;
        if (!stack.length) { afterRoot = true; }
        continue;
      }

      /* start tag */
      j = i + 1;
      k = nameEnd(j);
      if (k === j) { fail("'<' must be followed by a tag name. Write &lt; for a literal '<'", i); }
      name = text.slice(j, k);
      attrs = []; seen = Object.create(null); sc = false; j = k;
      while (true) {
        k = skipWs(j);
        if (k >= n) { fail('Unterminated start tag <' + name + '>', i); }
        c = text.charCodeAt(k);
        if (c === 62) { j = k + 1; break; }
        if (c === 47) {
          if (text.charCodeAt(k + 1) === 62) { sc = true; j = k + 2; break; }
          fail("Expected '>' after '/' in the tag", k);
        }
        if (k === j) { fail('Attributes must be separated by whitespace', k); }
        e = nameEnd(k);
        if (e === k) { fail("Invalid attribute name '" + text.charAt(k) + "'", k); }
        an = text.slice(k, e);
        e2 = skipWs(e);
        if (text.charCodeAt(e2) !== 61) { fail("Attribute '" + an + "' needs a value: expected '=' after the name", e2 < n ? e2 : k); }
        e2 = skipWs(e2 + 1);
        q = text.charCodeAt(e2);
        if (q !== 34 && q !== 39) { fail('Attribute values must be quoted with " or \'', e2 < n ? e2 : k); }
        ve = text.indexOf(text.charAt(e2), e2 + 1);
        if (ve === -1) { fail("Unterminated attribute value for '" + an + "'", e2); }
        lt = text.indexOf('<', e2 + 1);
        if (lt !== -1 && lt < ve) { fail("'<' is not allowed inside an attribute value (write &lt;)", lt); }
        checkRefs(e2 + 1, ve);
        if (seen[an]) { fail("Duplicate attribute '" + an + "'", k); }
        seen[an] = true;
        attrs.push({ n: an, v: text.slice(e2 + 1, ve), q: text.charAt(e2), s: k });
        j = ve + 1;
      }
      el = { t: 'e', n: name, s: i, e: 0, attrs: attrs, sc: sc, kids: [], os: j, cs: -1 };
      if (parent === doc) {
        if (afterRoot || root) { fail('Only one root element is allowed; a second element starts here', i); }
        root = el;
      }
      parent.kids.push(el);
      if (name === 'parsererror') { parserErrorName = true; }
      if (sc) {
        el.e = j;
        if (parent === doc) { afterRoot = true; }
      } else {
        stack.push(el);
        if (stack.length > maxDepth) { maxDepth = stack.length; }
      }
      i = j;
    }

    if (stack.length) {
      top = stack[stack.length - 1];
      fail('Unclosed element <' + top.n + '>: its closing tag is missing', n, top.s);
    }
    if (!root) { fail('No root element found', 0); }
    return { root: root, doc: doc, hasDoctype: hasDoctype, customEntities: customEntities, maxDepth: maxDepth, parserErrorName: parserErrorName };
  }

  /* ------------------------------------------------------------------
     Browser cross-check (DOMParser)
     ------------------------------------------------------------------ */
  function offsetOf(text, line, col) {
    var p = 0, l = 1, nl;
    while (l < line) {
      nl = text.indexOf('\n', p);
      if (nl === -1) { return text.length; }
      p = nl + 1; l++;
    }
    return Math.min(p + Math.max(col - 1, 0), text.length);
  }

  function domCheck(text, res) {
    var d, pe, msg, m, line = 0, col = 0, body;
    if (typeof global.DOMParser === 'undefined' || res.maxDepth > MAX_DOM_DEPTH || res.parserErrorName) { return null; }
    try {
      d = new global.DOMParser().parseFromString(text, 'application/xml');
    } catch (e) {
      return { message: (e && e.message) || 'The browser could not parse this XML.', line: 0, column: 0, offset: -1 };
    }
    pe = d.getElementsByTagName('parsererror')[0];
    if (!pe) { return null; }
    msg = pe.textContent || '';
    body = msg.split('\n')[0];
    if ((m = /error on line (\d+) at column (\d+):\s*([^\n]*)/i.exec(msg))) {
      line = +m[1]; col = +m[2]; body = m[3];
    } else if ((m = /Line Number (\d+), Column (\d+)/i.exec(msg))) {
      line = +m[1]; col = +m[2]; body = msg.split('\n')[0].replace(/^XML Parsing Error:\s*/i, '');
    }
    return { message: (body || 'The browser reported an XML error.').trim(), line: line, column: col, offset: line ? offsetOf(text, line, col) : -1 };
  }

  Xml.parse = function (text) {
    var res, li, p, r, msg, dom;
    try {
      res = scan(text);
    } catch (e) {
      if (e && e.__xmlError) {
        li = Util.lineIndex(text);
        p = li.at(Math.min(e.offset, text.length));
        msg = e.message;
        if (e.related >= 0) {
          r = li.at(e.related);
          msg += ' (the opening tag is at line ' + r.line + ', column ' + r.column + ')';
        }
        return { ok: false, error: { message: msg, line: p.line, column: p.column, offset: p.offset } };
      }
      throw e;
    }
    dom = domCheck(text, res);
    if (dom) { return { ok: false, error: dom }; }
    return { ok: true, text: text, root: res.root, doc: res.doc, hasDoctype: res.hasDoctype, customEntities: res.customEntities, depth: res.maxDepth };
  };

  /* ------------------------------------------------------------------
     beautify / minify. Text, attribute values, comments, CDATA and entities are copied
     exactly as written. Elements with mixed content (text next to child elements) or
     xml:space="preserve" are copied verbatim.
     ------------------------------------------------------------------ */
  function info(text, el) {
    var k = el.kids, i, kid, hasElem = false, hasText = false, pres = false;
    if (el.inf) { return el.inf; }
    for (i = 0; i < k.length; i++) {
      kid = k[i];
      if (kid.t === 'e') { hasElem = true; }
      else if (kid.t === 'd') { hasText = true; }
      else if (kid.t === 'x' && !wsOnly(text, kid.s, kid.e)) { hasText = true; }
    }
    for (i = 0; i < el.attrs.length; i++) {
      if (el.attrs[i].n === 'xml:space' && el.attrs[i].v === 'preserve') { pres = true; }
    }
    el.inf = { hasElem: hasElem, hasText: hasText, mixed: hasElem && hasText, preserve: pres };
    return el.inf;
  }

  function startTag(el) {
    var s = '<' + el.n, i, a;
    for (i = 0; i < el.attrs.length; i++) {
      a = el.attrs[i];
      s += ' ' + a.n + '=' + a.q + a.v + a.q;
    }
    return s + (el.sc ? '/>' : '>');
  }

  function serialize(parsed, unit, minify) {
    var text = parsed.text, nl = minify ? '' : '\n', pad = [], flags = { mixed: false, preserve: false };
    var top = [], i, kid;

    function ind(d) { return minify ? '' : (pad[d] || (pad[d] = new Array(d + 1).join(unit))); }

    function render(rootEl) {
      var out = [], stack = [], f, k;
      function emit(el, depth) {
        var nf = info(text, el);
        if (nf.preserve) { flags.preserve = true; out.push(text.slice(el.s, el.e)); return; }
        if (nf.mixed) { flags.mixed = true; out.push(text.slice(el.s, el.e)); return; }
        if (el.sc) { out.push(startTag(el)); return; }
        if (!nf.hasElem) { out.push(startTag(el), text.slice(el.os, el.cs), '</', el.n, '>'); return; }
        out.push(startTag(el));
        stack.push({ el: el, i: 0, depth: depth });
      }
      emit(rootEl, 0);
      while (stack.length) {
        f = stack[stack.length - 1];
        if (f.i >= f.el.kids.length) {
          stack.pop();
          out.push(nl, ind(f.depth), '</', f.el.n, '>');
          continue;
        }
        k = f.el.kids[f.i++];
        if (k.t === 'x') { continue; }
        out.push(nl, ind(f.depth + 1));
        if (k.t === 'e') { emit(k, f.depth + 1); } else { out.push(text.slice(k.s, k.e)); }
      }
      return out.join('');
    }

    for (i = 0; i < parsed.doc.kids.length; i++) {
      kid = parsed.doc.kids[i];
      if (kid.t === 'x') { continue; }
      top.push(kid.t === 'e' ? render(kid) : text.slice(kid.s, kid.e));
    }
    return { text: top.join(nl), flags: flags };
  }

  Xml.beautify = function (parsed, unit) {
    var u = unit || '  ', r, n = [], d = parsed.depth + 1;
    if (d * d * u.length > 40000000) {
      return { ok: false, error: { message: 'The XML is nested ' + parsed.depth + ' levels deep. Pretty-printing it would need hundreds of megabytes of indentation. Use Minify instead.', line: 0, column: 0, offset: -1 } };
    }
    r = serialize(parsed, u, false);
    if (r.flags.mixed) { n.push({ level: 'info', text: 'Elements with mixed content (text next to child elements) are kept exactly as written.' }); }
    if (r.flags.preserve) { n.push({ level: 'info', text: 'Elements marked xml:space="preserve" are kept exactly as written.' }); }
    return { ok: true, text: r.text, notices: n };
  };

  Xml.minify = function (parsed) {
    var r = serialize(parsed, '', true), n = [];
    n.push({ level: 'info', text: 'Whitespace between elements was removed. Text inside elements was not changed.' });
    if (r.flags.mixed) { n.push({ level: 'info', text: 'Elements with mixed content are kept exactly as written.' }); }
    if (r.flags.preserve) { n.push({ level: 'info', text: 'Elements marked xml:space="preserve" are kept exactly as written.' }); }
    return { ok: true, text: r.text, notices: n };
  };

  /* ------------------------------------------------------------------
     analyze
     ------------------------------------------------------------------ */
  function childNs(el, parentNs) {
    var ns = parentNs, i, a;
    for (i = 0; i < el.attrs.length; i++) {
      a = el.attrs[i];
      if (a.n === 'xmlns' || a.n.indexOf('xmlns:') === 0) {
        if (ns === parentNs) { ns = Object.create(parentNs); }
        ns[a.n === 'xmlns' ? '' : a.n.slice(6)] = a.v;
      }
    }
    return ns;
  }

  function isNil(el, ns) {
    var i, a, idx, v;
    for (i = 0; i < el.attrs.length; i++) {
      a = el.attrs[i];
      idx = a.n.indexOf(':');
      if (idx > 0 && a.n.slice(idx + 1) === 'nil' && ns[a.n.slice(0, idx)] === XSI_NS) {
        v = a.v.trim();
        if (v === 'true' || v === '1') { return true; }
      }
    }
    return false;
  }

  Xml.analyze = function (parsed) {
    var a = Util.newAnalysis(), c = a.counts, text = parsed.text, li = null, stack = [];
    var f, kid, k, p;
    c.fields = c.objects = c.attributes = c.textNodes = c.whitespaceTexts = c.emptyElements = c.nulls = 0;
    a.notes = [];
    if (parsed.hasDoctype) { a.notes.push('A DOCTYPE was found. External entities and DTDs are never loaded.'); }

    function pos(off) { li = li || Util.lineIndex(text); return li.at(off); }

    function visit(el, path, parentNs) {
      var ns = childNs(el, parentNs), kids = el.kids, i, at, hasElem = false, hasText = false, wsCount = 0, nonEmptyWs;
      c.fields++;
      for (i = 0; i < el.attrs.length; i++) {
        at = el.attrs[i].n;
        if (at !== 'xmlns' && at.indexOf('xmlns:') !== 0) { c.attributes++; }
      }
      for (i = 0; i < kids.length; i++) {
        kid = kids[i];
        if (kid.t === 'e') { hasElem = true; }
        else if (kid.t === 'x') {
          if (wsOnly(text, kid.s, kid.e)) { wsCount++; } else { hasText = true; c.textNodes++; }
        } else if (kid.t === 'd') {
          if (kid.ce > kid.cs) { hasText = true; c.textNodes++; }
        }
      }
      if (hasElem) { c.objects++; }
      if (isNil(el, ns)) {
        c.nulls++;
        Util.pushItem(a, 'null', path, pos(el.s), text.slice(el.s, el.os) + (el.sc ? '' : '\u2026'));
      } else if (!hasElem && !hasText) {
        c.emptyElements++;
        nonEmptyWs = wsCount > 0;
        if (nonEmptyWs) { c.whitespaceTexts += wsCount; }
        Util.pushItem(a, 'emptyElement', path, pos(el.s), (nonEmptyWs ? '(whitespace only) ' : '') + Util.truncate(startTag(el), 50));
      }
      return { ns: ns, hasElem: hasElem };
    }

    function pathFor(parentFrame, el) {
      var name = el.n, total = parentFrame.names[name];
      if (total > 1) {
        parentFrame.seen[name] = (parentFrame.seen[name] || 0) + 1;
        return parentFrame.path + '/' + name + '[' + parentFrame.seen[name] + ']';
      }
      return parentFrame.path + '/' + name;
    }

    function makeFrame(el, path, r) {
      var names = Object.create(null), i;
      for (i = 0; i < el.kids.length; i++) {
        if (el.kids[i].t === 'e') { names[el.kids[i].n] = (names[el.kids[i].n] || 0) + 1; }
      }
      return { el: el, i: 0, path: path, ns: r.ns, names: names, seen: Object.create(null) };
    }

    var rootNs = Object.create(null), r = visit(parsed.root, '/' + parsed.root.n, rootNs);
    if (r.hasElem) { stack.push(makeFrame(parsed.root, '/' + parsed.root.n, r)); }
    while (stack.length) {
      f = stack[stack.length - 1];
      if (f.i >= f.el.kids.length) { stack.pop(); continue; }
      k = f.el.kids[f.i++];
      if (k.t !== 'e') { continue; }
      p = pathFor(f, k);
      r = visit(k, p, f.ns);
      if (r.hasElem) { stack.push(makeFrame(k, p, r)); }
    }
    return a;
  };

  /* ------------------------------------------------------------------
     XML -> JSON value.
     Conventions: attributes become "@name" keys, text next to attributes or children becomes
     "#text", elements that repeat become arrays, xsi:nil elements become null.
     Comments and processing instructions are dropped. All values are strings.
     ------------------------------------------------------------------ */
  Xml.toJsonValue = function (parsed) {
    var notices = [], noted = Object.create(null), stack = [], rootNs = Object.create(null);
    var f, k, rootVal, wrap;

    function note(key, level, msg) {
      if (!noted[key]) { noted[key] = true; notices.push({ level: level, text: msg }); }
    }

    function textOf(el) {
      var s = '', i, kid;
      for (i = 0; i < el.kids.length; i++) {
        kid = el.kids[i];
        if (kid.t === 'x') { s += Xml.decodeText(parsed.text.slice(kid.s, kid.e)); }
        else if (kid.t === 'd') { s += parsed.text.slice(kid.cs, kid.ce); }
        else if (kid.t === 'c' || kid.t === 'p') { note('dropped', 'warning', 'Comments and processing instructions are not included in the JSON.'); }
      }
      return s;
    }

    function attrValue(raw) { return Xml.decodeText(raw.replace(/[\t\n\r]/g, ' ')); }

    function add(frame, name, value) {
      var existing = frame.obj[name], last = frame.order[frame.order.length - 1];
      if (existing === undefined) {
        frame.obj[name] = value;
      } else {
        note('repeat', 'info', 'Elements that repeat become JSON arrays. An element that appears once stays a single value, so the shape depends on the data.');
        if (!Array.isArray(existing)) { frame.obj[name] = [existing]; }
        frame.obj[name].push(value);
        if (last !== name) {
          note('interleaved', 'warning', 'Repeated elements are interleaved with other elements. Their relative order is not kept in the JSON.');
        }
      }
      frame.order.push(name);
    }

    // Converts one element. Returns the JSON value; pushes a frame when the element has child elements.
    function convert(el, parentNs) {
      var ns = childNs(el, parentNs), i, at, obj, hasAttrs = el.attrs.length > 0, hasElem = false, txt, inf;
      if (isNil(el, ns)) { return null; }
      inf = info(parsed.text, el);
      hasElem = inf.hasElem;
      if (el.n.indexOf(':') >= 0 || hasAttrs) { note('ns', 'info', 'Namespace prefixes and xmlns declarations are kept as written in the key names.'); }
      if (!hasAttrs && !hasElem) { return textOf(el); }
      obj = Object.create(null);
      for (i = 0; i < el.attrs.length; i++) {
        at = el.attrs[i];
        obj['@' + at.n] = attrValue(at.v);
      }
      if (!hasElem) {
        txt = textOf(el);
        if (txt !== '') { obj['#text'] = txt; }
        return obj;
      }
      if (inf.mixed) {
        note('mixed', 'warning', 'Mixed content (text next to child elements) was found. The text is joined under "#text" and its position among the elements is lost.');
        obj['#text'] = textOf(el);
      }
      stack.push({ el: el, i: 0, obj: obj, order: [], ns: ns });
      return obj;
    }

    try {
      if (parsed.customEntities) { throw { msg: 'The DOCTYPE defines custom entities, which are not expanded here, so the XML cannot be converted reliably.' }; }
      rootVal = convert(parsed.root, rootNs);
      while (stack.length) {
        f = stack[stack.length - 1];
        if (f.i >= f.el.kids.length) { stack.pop(); continue; }
        k = f.el.kids[f.i++];
        if (k.t !== 'e') { continue; }
        add(f, k.n, convert(k, f.ns));
      }
      wrap = Object.create(null);
      wrap[parsed.root.n] = rootVal;
      note('strings', 'info', 'XML has no data types, so every value is a string.');
      return { ok: true, value: wrap, notices: notices };
    } catch (e) {
      if (e && e.msg) { return { ok: false, error: { message: e.msg, line: 0, column: 0, offset: -1 } }; }
      throw e;
    }
  };

})(window);
/* ===================== END OF PART 3 ===================== */
/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 4 of 7: Java-style object engine
   BEGINS: the comment block headed "PART 4 of 7" (paste right after "END OF PART 3").
   ENDS:   the line "END OF PART 4".

   Registers DFI.JavaObj:
     parse(text)                -> {ok, text, root, warnings} | {ok:false, error:{message,line,column,offset}}
     beautify(parsed, unit)     -> {ok, text, notices}      (one field or item per line)
     minify(parsed)             -> {ok, text, notices}      (one line, fields separated by ", " as Java prints them)
     analyze(parsed)            -> analysis (same shape as DFI.Json.analyze, plus notes[])
     toJsonValue(parsed, opts)  -> {ok, value, notices}     opts.keepTypes adds "@type" keys
     fromJson(jsonParsed, unit, oneLine) -> {ok, text, notices}   (JSON -> Java-style)

   This is NOT a parser for every Java toString(). It reads the common patterns:
     User{id=1, name='John'}      IntelliJ / Lombok style with braces
     User(id=1, name=John)        Lombok / Kotlin data class style
     User[id=1, name=John]        Java record style
     {id=1, name=John}            Map.toString()
     [1, 2, User{...}]            List / Set / array-like
   Nothing is ever evaluated as code.

   Reading rules (the ambiguous parts, stated plainly):
   - 'text' and "text" are strings. An apostrophe inside quotes is accepted when it is not followed
     by a delimiter (IntelliJ does not escape them). Backslash escapes are understood.
   - Unquoted values are guessed: null -> null, true/false -> boolean, 12 or 3.5 -> number,
     anything else -> text. Unquoted text may contain spaces, '=' and balanced brackets.
     A comma or closing bracket at the top level of a value ends it.
   - An empty value after '=' (name=) is read as an empty string.
   - Name followed directly by { ( [ starts an object. Name[...] with name=value entries is a record;
     otherwise it is read as a typed list.
   - Map keys are kept as written. Complex keys such as User{id=1}=5 are kept as raw text.
   - Default Object.toString() output (com.x.User@1b2c3d) has no field data and is only a plain value.
   Counting: fields = name=value entries; objects = typed objects and maps; arrays = lists;
   nulls = the bare token null (never the quoted text 'null'); empty strings = '', "" or an empty value;
   empty arrays = [] ; empty objects = {} or Name{} or Name().
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI, Util = DFI.Util, Json = DFI.Json, J = DFI.JavaObj = {};
  var NUM = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  var JSON_NUM = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  var INLINE_WIDTH = 72;

  function isAlpha(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36; }
  function isAlnum(c) { return isAlpha(c) || (c >= 48 && c <= 57); }
  function isWsc(c) { return c === 32 || c === 9 || c === 10 || c === 13; }
  function closerOf(ch) { return ch === 123 ? 125 : (ch === 40 ? 41 : 93); }
  function isScalar(node) { return node.t !== 'obj' && node.t !== 'map' && node.t !== 'list'; }

  /* ------------------------------------------------------------------
     parse (iterative, no recursion)
     Nodes: scalar {t:'str'|'raw'|'num'|'bool'|'null'|'empty', s, e}
            obj  {t:'obj', type, open, close, fields:[{ks,ke,v}], s, e}   (Name{..} Name(..) Name[..])
            map  {t:'map', fields, ...}   untyped {..}
            list {t:'list', type, items, ...}
     ------------------------------------------------------------------ */
  // opts.from / opts.prefix work as in DFI.Json.parse: parse one value starting at an offset and report where it ends.
  J.parse = function (text, opts) {
    var n = text.length, i = (opts && opts.from) || 0, stack = [], root = null, warnings = [], warned = Object.create(null);
    var prefix = !!(opts && opts.prefix);
    var state = 'value', c, top, s, id, commaAt, node, cc;

    function warn(key, msg) {
      if (!warned[key]) { warned[key] = true; warnings.push(msg); }
    }
    function fail(msg, off) { throw { __javaError: true, message: msg, offset: off }; }
    function skipWs() { while (i < n && isWsc(text.charCodeAt(i))) { i++; } }
    function scanIdent(p) {
      if (!isAlpha(text.charCodeAt(p))) { return p; }
      p++;
      while (p < n && (isAlnum(text.charCodeAt(p)) || text.charCodeAt(p) === 46)) { p++; }
      return p;
    }
    function attach(v) {
      var t = stack[stack.length - 1];
      if (!t) { root = v; }
      else if (t.t === 'list') { t.items.push(v); }
      else { t.fields.push({ ks: t.ks, ke: t.ke, v: v }); }
    }
    function scalarNode(s0, e0, quoted, q) {
      var raw = text.slice(s0, e0), nd = { s: s0, e: e0 };
      if (quoted) { nd.t = 'str'; nd.q = q; }
      else if (raw === '') { nd.t = 'empty'; warn('empty', "An empty value after '=' (or between commas) was read as an empty string."); }
      else if (raw === 'null') { nd.t = 'null'; }
      else if (raw === 'true' || raw === 'false') { nd.t = 'bool'; }
      else if (NUM.test(raw)) { nd.t = 'num'; }
      else {
        nd.t = 'raw';
        if (/\s[A-Za-z_][\w.]*=/.test(raw)) {
          warn('maybecomma', "A value contains text like 'word=' after a space. If those are separate fields, a comma is missing.");
        }
      }
      return nd;
    }

    // Quoted string. A closing quote must be followed by a delimiter (or '=' for keys).
    function scanQuoted(isKey) {
      var q = text.charCodeAt(i), start = i, ch, j, nx;
      i++;
      while (true) {
        if (i >= n) { fail('Unterminated quoted string (missing closing ' + text.charAt(start) + ')', start); }
        ch = text.charCodeAt(i);
        if (ch === 92) { i += 2; continue; }
        if (ch === q) {
          j = i + 1;
          while (j < n && isWsc(text.charCodeAt(j))) { j++; }
          nx = text.charCodeAt(j);
          if (j >= n || nx === 44 || nx === 125 || nx === 41 || nx === 93 || (isKey && nx === 61)) { i++; return; }
        }
        i++;
      }
    }

    function scanRaw() {
      var stk = [], ch, startRaw = i;
      while (i < n) {
        ch = text.charCodeAt(i);
        if (ch === 44 && !stk.length) { break; }
        if (ch === 123 || ch === 40 || ch === 91) { stk.push(closerOf(ch)); }
        else if (ch === 125 || ch === 41 || ch === 93) {
          if (!stk.length) { break; }
          if (stk.pop() !== ch) { fail("Mismatched brackets inside a value: found '" + text.charAt(i) + "'", i); }
        }
        i++;
      }
      if (stk.length) { fail('Unbalanced brackets inside a value that starts here', startRaw); }
      var e0 = i;
      while (e0 > startRaw && isWsc(text.charCodeAt(e0 - 1))) { e0--; }
      return e0;
    }

    // Does an entry like  name=  start at position p?  (used to tell Name[a=1] records from lists)
    function looksLikeEntry(p) {
      var save = i, ch, ok;
      i = p;
      ch = text.charCodeAt(i);
      if (ch === 34 || ch === 39) {
        try { scanQuoted(true); } catch (e) { i = save; return false; }
      } else {
        while (i < n) {
          ch = text.charCodeAt(i);
          if (ch === 61 || ch === 44 || ch === 123 || ch === 125 || ch === 40 || ch === 41 || ch === 91 || ch === 93) { break; }
          i++;
        }
      }
      skipWs();
      ok = text.charCodeAt(i) === 61;
      i = save;
      return ok;
    }

    function open(kind, type, openIdx, afterOpen) {
      var ch = text.charCodeAt(openIdx);
      node = { t: kind, type: type, open: text.charAt(openIdx), close: String.fromCharCode(closerOf(ch)), s: type ? openIdx - type.length : openIdx, e: 0 };
      if (kind === 'list') { node.items = []; } else { node.fields = []; node.ks = 0; node.ke = 0; }
      attach(node);
      i = afterOpen;
      skipWs();
      if (text.charCodeAt(i) === closerOf(ch)) {
        node.e = i + 1; i++; state = 'after';
      } else {
        if (i >= n) { fail("Unexpected end of input: missing '" + node.close + "'", i); }
        stack.push(node);
        state = kind === 'list' ? 'value' : 'key';
      }
    }

    function readKey() {
      var ks, ke, ch, depth = 0, stk = [];
      skipWs();
      if (i >= n) { fail("Unexpected end of input: missing '" + top.close + "'", i); }
      ks = i;
      ch = text.charCodeAt(i);
      if (ch === 34 || ch === 39) {
        scanQuoted(true);
        ke = i;
        skipWs();
        if (text.charCodeAt(i) !== 61) { fail("Expected '=' after the field name", i < n ? i : ks); }
      } else {
        while (i < n) {
          ch = text.charCodeAt(i);
          if (ch === 61 && !stk.length) { break; }
          if (!stk.length && (ch === 44 || ch === 125 || ch === 41 || ch === 93)) {
            fail("Expected 'name=value' but found no '=' (a plain list needs [ ] around it, or a comma is misplaced)", ks);
          }
          if (ch === 123 || ch === 40 || ch === 91) { stk.push(closerOf(ch)); }
          else if (ch === 125 || ch === 41 || ch === 93) {
            if (stk.pop() !== ch) { fail('Mismatched brackets in a field name', i); }
          }
          i++;
        }
        if (i >= n) { fail("Expected '=' after the field name", ks); }
        ke = i;
        while (ke > ks && isWsc(text.charCodeAt(ke - 1))) { ke--; }
      }
      if (ke === ks) { fail('The field name before = is empty', ks); }
      top.ks = ks; top.ke = ke;
      i++;                       // consume '='
      state = 'value';
    }

    function run() {
      if (i === 0 && text.charCodeAt(0) === 0xFEFF) { i = 1; }
      skipWs();
      if (i >= n) { fail('Input is empty: expected an object, map or list', 0); }
      while (true) {
        top = stack[stack.length - 1];
        if (state === 'key') {
          readKey();
        } else if (state === 'value') {
          skipWs();
          if (i >= n) { fail('Unexpected end of input: a value is missing', i); }
          c = text.charCodeAt(i);
          if (c === 44 || c === 125 || c === 41 || c === 93) {
            if (!stack.length) { fail("Unexpected '" + text.charAt(i) + "' at the start", i); }
            attach(scalarNode(i, i, false)); state = 'after';
          } else if (c === 34 || c === 39) {
            s = i; scanQuoted(false); attach(scalarNode(s, i, true, text.charAt(s))); state = 'after';
          } else if (c === 91) {
            open('list', null, i, i + 1);
          } else if (c === 123) {
            open('map', null, i, i + 1);
          } else {
            id = scanIdent(i);
            cc = id > i ? text.charCodeAt(id) : 0;
            if (cc === 123 || cc === 40) {
              open('obj', text.slice(i, id), id, id + 1);
            } else if (cc === 91) {
              s = id + 1;
              while (s < n && isWsc(text.charCodeAt(s))) { s++; }
              if (text.charCodeAt(s) !== 93 && looksLikeEntry(s)) { open('obj', text.slice(i, id), id, id + 1); }
              else {
                open('list', text.slice(i, id), id, id + 1);
                warn('typedlist', 'A name followed by [ ] without name=value entries was read as a list (for example Optional[x] or ImmutableList[a, b]).');
              }
            } else {
              s = i;
              c = scanRaw();
              attach(scalarNode(s, c, false));
              state = 'after';
            }
          }
        } else {
          skipWs();
          if (!stack.length) {
            if (i < n && !prefix) { fail('Unexpected content after the end of the value', i); }
            return;
          }
          if (i >= n) { fail("Unexpected end of input: missing '" + top.close + "'", i); }
          c = text.charAt(i);
          if (c === ',') {
            commaAt = i; i++; skipWs();
            if (text.charAt(i) === top.close) { fail('Unexpected trailing comma: Java does not print one', commaAt); }
            state = top.t === 'list' ? 'value' : 'key';
          } else if (c === top.close) {
            i++; top.e = i; stack.pop();
          } else {
            fail("Expected ',' or '" + top.close + "' after the value (a comma may be missing, or the value contains an unbalanced bracket)", i);
          }
        }
      }
    }

    try {
      run();
    } catch (e) {
      if (e && e.__javaError) {
        if (prefix) { return { ok: false, error: { message: e.message, line: 0, column: 0, offset: e.offset } }; }
        var p = Util.lineIndex(text).at(Math.min(e.offset, n));
        return { ok: false, error: { message: e.message, line: p.line, column: p.column, offset: p.offset } };
      }
      throw e;
    }
    if (root.t === 'raw' && /@[0-9a-f]{4,}$/i.test(text.slice(root.s, root.e))) {
      warnings.push('This looks like default Object.toString() output (Class@hash). It contains no field data.');
    }
    return { ok: true, text: text, root: root, warnings: warnings, end: root.e };
  };

  /* ------------------------------------------------------------------
     serialize
     ------------------------------------------------------------------ */
  function sText(text, v) { return v.r !== undefined ? v.r : text.slice(v.s, v.e); }
  function kText(text, f) { return f.kr !== undefined ? f.kr : text.slice(f.ks, f.ke); }
  function head(node) { return (node.type || '') + node.open; }

  function serialize(text, root, unit, oneLine) {
    var out = [], stack = [], pad = [], f, len, item, v;
    function ind(d) { return pad[d] || (pad[d] = new Array(d + 1).join(unit)); }
    function shortScalarList(node) {
      var w = head(node).length + 1, k;
      for (k = 0; k < node.items.length; k++) {
        if (!isScalar(node.items[k])) { return false; }
        w += sText(text, node.items[k]).length + 2;
        if (w > INLINE_WIDTH) { return false; }
      }
      return true;
    }
    function openNode(node, depth) {
      var cnt = node.t === 'list' ? node.items.length : node.fields.length;
      if (!cnt) { out.push(head(node), node.close); return; }
      out.push(head(node));
      stack.push({ n: node, i: 0, depth: depth, inline: oneLine || (node.t === 'list' && shortScalarList(node)) });
    }
    function put(val, depth) {
      if (isScalar(val)) { out.push(sText(text, val)); } else { openNode(val, depth); }
    }
    put(root, 0);
    while (stack.length) {
      f = stack[stack.length - 1];
      len = f.n.t === 'list' ? f.n.items.length : f.n.fields.length;
      if (f.i >= len) {
        stack.pop();
        if (!f.inline) { out.push('\n', ind(f.depth)); }
        out.push(f.n.close);
        continue;
      }
      if (f.i > 0) { out.push(f.inline ? ', ' : ','); }
      if (!f.inline) { out.push('\n', ind(f.depth + 1)); }
      if (f.n.t === 'list') { item = f.n.items[f.i++]; v = item; }
      else { item = f.n.fields[f.i++]; out.push(kText(text, item), '='); v = item.v; }
      put(v, f.depth + 1);
    }
    return out.join('');
  }

  function notices(parsed, extra) {
    var n = [], i;
    for (i = 0; i < parsed.warnings.length; i++) { n.push({ level: 'warning', text: parsed.warnings[i] }); }
    if (extra) { n.push({ level: 'info', text: extra }); }
    return n;
  }

  J.beautify = function (parsed, unit) {
    return { ok: true, text: serialize(parsed.text, parsed.root, unit || '  ', false), notices: notices(parsed, null) };
  };

  J.minify = function (parsed) {
    return { ok: true, text: serialize(parsed.text, parsed.root, '', true), notices: notices(parsed, 'Java-style text has no standard minified form. This is the one-line form, with fields separated by ", " as Java prints them.') };
  };

  /* ------------------------------------------------------------------
     analyze
     ------------------------------------------------------------------ */
  function plainKey(text, f) {
    var raw = kText(text, f), q = raw.charAt(0);
    if ((q === '"' || q === "'") && raw.length >= 2 && raw.charAt(raw.length - 1) === q) { return raw.slice(1, -1); }
    return raw;
  }

  J.analyze = function (parsed) {
    var a = Util.newAnalysis(), c = a.counts, text = parsed.text, li = null, stack = [], f, idx, v, label, path, fld;
    c.fields = c.objects = c.arrays = c.nulls = c.emptyStrings = 0;
    c.emptyArrays = c.emptyObjects = c.duplicateKeys = 0;
    a.notes = [];

    function pos(off) { li = li || Util.lineIndex(text); return li.at(off); }
    function pre(lbl) { return lbl === null ? '' : lbl + '='; }

    function visit(node, p, lbl) {
      var seen, k, key, ps;
      if (node.t === 'null') { c.nulls++; Util.pushItem(a, 'null', p, pos(node.s), pre(lbl) + 'null'); return; }
      if (node.t === 'empty' || (node.t === 'str' && node.e - node.s === 2)) {
        c.emptyStrings++;
        Util.pushItem(a, 'emptyString', p, pos(node.s), pre(lbl) + (node.t === 'empty' ? '(empty value)' : node.q + node.q));
        return;
      }
      if (isScalar(node)) { return; }
      if (node.t === 'list') {
        c.arrays++;
        if (!node.items.length) { c.emptyArrays++; Util.pushItem(a, 'emptyArray', p, pos(node.s), pre(lbl) + (node.type || '') + '[]'); return; }
      } else {
        c.objects++; c.fields += node.fields.length;
        if (!node.fields.length) { c.emptyObjects++; Util.pushItem(a, 'emptyObject', p, pos(node.s), pre(lbl) + head(node) + node.close); return; }
        seen = Object.create(null);
        for (k = 0; k < node.fields.length; k++) {
          key = plainKey(text, node.fields[k]);
          if (seen[key]) {
            c.duplicateKeys++;
            if (a.duplicates.length < Util.LIMITS.maxItems) {
              ps = pos(node.fields[k].ks);
              a.duplicates.push({ path: Util.pathKey(p, key), key: key, line: ps.line, column: ps.column, offset: ps.offset });
            }
          } else { seen[key] = true; }
        }
      }
      stack.push({ n: node, i: 0, p: p });
    }

    visit(parsed.root, parsed.root.type && parsed.root.t === 'obj' ? parsed.root.type : '$', null);
    while (stack.length) {
      f = stack[stack.length - 1];
      if (f.n.t === 'list') {
        if (f.i >= f.n.items.length) { stack.pop(); continue; }
        idx = f.i++; v = f.n.items[idx];
        visit(v, f.p + '[' + idx + ']', null);
      } else {
        if (f.i >= f.n.fields.length) { stack.pop(); continue; }
        fld = f.n.fields[f.i++]; v = fld.v; label = kText(text, fld);
        path = Util.pathKey(f.p, plainKey(text, fld));
        visit(v, path, label);
      }
    }
    if (parsed.warnings.length) { a.notes = a.notes.concat(parsed.warnings); }
    return a;
  };

  /* ------------------------------------------------------------------
     Java-style -> JSON value
     ------------------------------------------------------------------ */
  function unescapeStr(raw) {
    var body = raw.slice(1, -1), out = '', i = 0, ch, h;
    if (body.indexOf('\\') < 0) { return body; }
    while (i < body.length) {
      ch = body.charAt(i);
      if (ch === '\\' && i + 1 < body.length) {
        i++; ch = body.charAt(i);
        if (ch === 'n') { out += '\n'; } else if (ch === 't') { out += '\t'; } else if (ch === 'r') { out += '\r'; }
        else if (ch === 'b') { out += '\b'; } else if (ch === 'f') { out += '\f'; }
        else if (ch === 'u' && /^[0-9a-fA-F]{4}$/.test(body.substr(i + 1, 4))) { h = body.substr(i + 1, 4); out += String.fromCharCode(parseInt(h, 16)); i += 4; }
        else if (ch === '\\' || ch === "'" || ch === '"' || ch === '/') { out += ch; }
        else { out += '\\' + ch; }
        i++;
      } else { out += ch; i++; }
    }
    return out;
  }

  J.toJsonValue = function (parsed, opts) {
    var text = parsed.text, nt = [], noted = Object.create(null), stack = [], keep = !!(opts && opts.keepTypes);
    var f, fld, root, key;

    function note(k, level, msg) { if (!noted[k]) { noted[k] = true; nt.push({ level: level, text: msg }); } }

    function scalar(node) {
      var raw = text.slice(node.s, node.e);
      switch (node.t) {
        case 'str': return unescapeStr(raw);
        case 'null': return null;
        case 'bool': return raw === 'true';
        case 'empty': return '';
        case 'num':
          if (!JSON_NUM.test(raw)) { note('numtext', 'warning', 'Numbers JSON cannot write as they are (for example 007) were kept as strings.'); return raw; }
          if (/^-?\d+$/.test(raw) && !Number.isSafeInteger(Number(raw))) {
            note('bigint', 'warning', 'Integers larger than 2^53 were kept as strings to avoid losing digits.');
            return raw;
          }
          return Number(raw);
        default: return raw;
      }
    }

    function make(node) {
      var o;
      if (isScalar(node)) { return scalar(node); }
      if (node.t === 'list') {
        if (node.type) { note('typedlist', 'warning', 'The type name before a list (' + node.type + '[...]) is not part of the JSON.'); }
        o = [];
      } else {
        o = Object.create(null);
        if (node.type) {
          if (keep) { o['@type'] = node.type; }
          else { note('types', 'warning', 'Class names such as ' + node.type + ' are not part of the JSON. Tick "keep types" to add them as "@type".'); }
        }
      }
      stack.push({ n: node, dst: o, i: 0 });
      return o;
    }

    root = make(parsed.root);
    while (stack.length) {
      f = stack[stack.length - 1];
      if (f.n.t === 'list') {
        if (f.i >= f.n.items.length) { stack.pop(); continue; }
        f.dst.push(make(f.n.items[f.i++]));
      } else {
        if (f.i >= f.n.fields.length) { stack.pop(); continue; }
        fld = f.n.fields[f.i++];
        key = plainKey(text, fld);
        f.dst[key] = make(fld.v);
      }
    }
    note('guess', 'info', 'Java-style text has no data types, so unquoted values were guessed: null, true/false and plain numbers became JSON null, booleans and numbers. Everything else is a string.');
    return { ok: true, value: root, notices: nt };
  };

  /* ------------------------------------------------------------------
     JSON -> Java-style text (strings single-quoted, as IntelliJ prints them)
     ------------------------------------------------------------------ */
  function quoteStr(s) {
    var out = "'", i, ch, code;
    for (i = 0; i < s.length; i++) {
      ch = s.charAt(i); code = s.charCodeAt(i);
      if (ch === '\\') { out += '\\\\'; }
      else if (ch === "'") { out += "\\'"; }
      else if (ch === '\n') { out += '\\n'; }
      else if (ch === '\r') { out += '\\r'; }
      else if (ch === '\t') { out += '\\t'; }
      else if (code < 32) { out += '\\u' + ('0000' + code.toString(16)).slice(-4); }
      else { out += ch; }
    }
    return out + "'";
  }

  function keyText(key) {
    if (key !== '' && !/[\s=,{}()\[\]'"\\]/.test(key)) { return key; }
    return '"' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }

  J.fromJson = function (jp, unit, oneLine) {
    var src = jp.text, stack = [], root, f, kid, v, nodeOut;

    function conv(jn) {
      var r, raw;
      if (jn.t === 'o' || jn.t === 'a') {
        r = jn.t === 'a' ? { t: 'list', type: null, open: '[', close: ']', items: [] } : { t: 'map', type: null, open: '{', close: '}', fields: [] };
        stack.push({ j: jn, dst: r, i: 0 });
        return r;
      }
      raw = src.slice(jn.s, jn.e);
      if (jn.t === 's') { return { t: 'str', r: quoteStr(JSON.parse(raw)) }; }
      return { t: jn.t === 'z' ? 'null' : (jn.t === 'b' ? 'bool' : 'num'), r: jn.t === 'z' ? 'null' : raw };
    }

    root = conv(jp.root);
    while (stack.length) {
      f = stack[stack.length - 1];
      if (f.i >= f.j.kids.length) { stack.pop(); continue; }
      kid = f.j.kids[f.i++];
      if (f.j.t === 'a') { f.dst.items.push(conv(kid)); }
      else { nodeOut = conv(kid.v); f.dst.fields.push({ kr: keyText(Json.decodeKey(src.slice(kid.ks, kid.ke))), v: nodeOut }); }
    }
    return {
      ok: true,
      text: serialize('', root, unit || '  ', !!oneLine),
      notices: [{ level: 'warning', text: 'Java has no standard text format for data. This output follows the common Map.toString() style, with strings in single quotes. Class names and the difference between 1 and 1.0 are not represented.' }]
    };
  };

})(window);
/* ===================== END OF PART 4 ===================== */
/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 5 of 7: Format detection, conversions and sample data
   BEGINS: the comment block headed "PART 5 of 7" (paste right after "END OF PART 4").
   ENDS:   the line "END OF PART 5".

   Registers DFI.Convert and DFI.Samples.
   DFI.Convert:
     FORMATS, label(id), supports(from,to), canSwap(from,to) -> {ok, hint}
     detect(text)                    -> {format, confidence:'high'|'low', reason}
     mismatchWarning(selected, text) -> string | null
     parse(format, text)             -> {ok, format, parsed} | {ok:false, format, error}
     analyze(format, parsed)         -> analysis (always has notes[])
     warningsFrom(analysis)          -> [{text}]   duplicate keys and engine notes, ready for the validation panel
     run({parsed, from, to, mode:'beautify'|'minify', indent:'2'|'4'|'tab'})
                                     -> {ok, text, notices[], lossy} | {ok:false, error, notices[]}

   Mixed text (logs): when the input is not one valid document, the JSON and Java-style parts inside it can still be
   formatted and analyzed, and all other text is left exactly as written.
     mixedScan(text)                        -> {segments:[{format:'json'|'java', start, end, parsed}], truncated}
     mixedRender(text, scan, {mode, indent}) -> {text, notices[]}
     mixedAnalysis(text, scan)              -> analysis for all parts together (paths start with #1, #2, ...; positions are
                                               offsets in the original text, so Jump works)
   Parts are found by trying the real parsers at every { [ and Name( Name{ Name[ . Parts that are too trivial
   (for example [INFO], (x), {id}, a list of plain numbers) are not treated as data. XML and YAML are not searched for.

   Supported conversions (everything else is refused with a clear message, never faked):
     JSON <-> YAML, JSON <-> XML, JSON <-> Java object, and each format to itself (beautify, minify).
   Every converted result is parsed again with the target format's engine before it is returned.

   JSON -> XML rules: a one-key object becomes the root element, otherwise <root> is added;
   keys starting with @ become attributes, "#text" becomes text content, arrays become repeated elements,
   null becomes <name xsi:nil="true"/>, "" becomes <name/>. Keys that are not valid XML names stop the
   conversion with a message. This is the inverse of the XML -> JSON rules in Part 3.
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI, Util = DFI.Util, Json = DFI.Json, Yaml = DFI.Yaml, Xml = DFI.Xml, JavaObj = DFI.JavaObj;
  var C = DFI.Convert = {};
  var XSI = 'http://www.w3.org/2001/XMLSchema-instance';

  C.FORMATS = [
    { id: 'json', label: 'JSON' },
    { id: 'xml', label: 'XML' },
    { id: 'yaml', label: 'YAML' },
    { id: 'java', label: 'Java object' }
  ];
  C.label = function (id) {
    var i;
    if (id === 'auto') { return 'Auto-detect'; }
    if (id === 'mixed') { return 'Mixed text'; }
    for (i = 0; i < C.FORMATS.length; i++) { if (C.FORMATS[i].id === id) { return C.FORMATS[i].label; } }
    return String(id);
  };

  var PATHS = {
    'json>json': 1, 'xml>xml': 1, 'yaml>yaml': 1, 'java>java': 1,
    'json>xml': 1, 'json>yaml': 1, 'yaml>json': 1, 'xml>json': 1, 'json>java': 1, 'java>json': 1
  };
  var LOSSY = {
    'xml>json': 'Lossy conversion: XML attributes, namespaces, comments, repeated elements and mixed content do not map cleanly to JSON.',
    'json>xml': 'Lossy conversion: JSON null, arrays and key names have no direct XML equivalent. Arrays become repeated elements and keys starting with @ become attributes.',
    'json>java': 'Lossy conversion: Java object text has no standard format and no distinction between 1 and 1.0.',
    'java>json': 'Lossy conversion: Java object text has no data types, so unquoted values are guessed and class names are dropped.'
  };

  C.supports = function (from, to) { return !!PATHS[from + '>' + to]; };

  C.unsupportedMessage = function (from, to) {
    return 'Converting ' + C.label(from) + ' to ' + C.label(to) + ' is not supported. Supported: JSON \u21C4 YAML, JSON \u21C4 XML and JSON \u21C4 Java object. To go between other formats, convert to JSON first.';
  };

  C.canSwap = function (from, to) {
    if (from === 'auto') { return { ok: false, hint: 'Choose a specific input format to enable swapping.' }; }
    if (!C.supports(to, from)) { return { ok: false, hint: 'Swapping is not available: ' + C.label(to) + ' to ' + C.label(from) + ' is not a supported conversion.' }; }
    return { ok: true, hint: '' };
  };

  /* ------------------------------------------------------------------
     Format detection (a quick look at the start of the text, not a full parse)
     ------------------------------------------------------------------ */
  C.detect = function (text) {
    var s = text.replace(/^\uFEFF/, '').trim(), head, c;
    if (!s) { return { format: 'unknown', confidence: 'low', reason: 'empty' }; }
    head = s.slice(0, 4000);
    c = s.charAt(0);
    if (c === '<') {
      return { format: 'xml', confidence: /^<[?!A-Za-z_]/.test(head) ? 'high' : 'low', reason: 'starts with <' };
    }
    if (c === '{') {
      if (/^\{\s*(?:"|\})/.test(head)) { return { format: 'json', confidence: 'high', reason: 'object with quoted keys' }; }
      if (/^\{\s*[^"\s:{}\[\],=][^:,{}\[\]]*=/.test(head)) { return { format: 'java', confidence: 'high', reason: 'braces with key=value' }; }
      if (/^\{\s*[A-Za-z_][\w-]*\s*:/.test(head)) { return { format: 'yaml', confidence: 'low', reason: 'flow mapping' }; }
      return { format: 'json', confidence: 'low', reason: 'starts with {' };
    }
    if (c === '[') {
      if (/^\[\s*[A-Za-z_][\w.]*\s*[{(]/.test(head) || /^\[\s*[A-Za-z_][\w.]*=/.test(head)) { return { format: 'java', confidence: 'high', reason: 'list of typed objects' }; }
      if (/^\[\s*(?:["{\[\-\d]|true\b|false\b|null\b|\])/.test(head)) { return { format: 'json', confidence: 'high', reason: 'array' }; }
      return { format: 'yaml', confidence: 'low', reason: 'flow sequence' };
    }
    if (/^[A-Za-z_][\w.]*[{(\[]/.test(head)) { return { format: 'java', confidence: 'high', reason: 'Name{...} object' }; }
    if (/^---/.test(head) || /^[ \t]*[\w"'.\-][^\n:]*:(?:[ \t]|$)/m.test(head) || /^[ \t]*-[ \t]+\S/m.test(head)) {
      return { format: 'yaml', confidence: 'high', reason: 'key: value or list lines' };
    }
    return { format: 'unknown', confidence: 'low', reason: 'plain text' };
  };

  C.mismatchWarning = function (selected, text) {
    var d;
    if (selected === 'auto') { return null; }
    d = C.detect(text);
    if (d.format === 'unknown' || d.format === selected || d.confidence !== 'high') { return null; }
    if (selected === 'yaml' && d.format === 'json') { return null; }          // JSON is valid YAML
    return 'The content looks like ' + C.label(d.format) + ', but the input format is set to ' + C.label(selected) + '.';
  };

  /* ------------------------------------------------------------------
     parse / analyze dispatch
     ------------------------------------------------------------------ */
  C.parse = function (format, text) {
    var r;
    if (format === 'json') { r = Json.parse(text); }
    else if (format === 'xml') { r = Xml.parse(text); }
    else if (format === 'yaml') { r = Yaml.parse(text); }
    else if (format === 'java') { r = JavaObj.parse(text); }
    else { return { ok: false, format: format, error: { message: 'Unknown format: ' + format, line: 0, column: 0, offset: -1 } }; }
    return r.ok ? { ok: true, format: format, parsed: r } : { ok: false, format: format, error: r.error };
  };

  C.analyze = function (format, parsed) {
    var a;
    if (format === 'json') { a = Json.analyze(parsed); }
    else if (format === 'xml') { a = Xml.analyze(parsed); }
    else if (format === 'yaml') { a = Yaml.analyze(parsed); }
    else { a = JavaObj.analyze(parsed); }
    a.notes = a.notes || [];
    return a;
  };

  C.warningsFrom = function (a) {
    var w = [], i, d, shown = Math.min(a.duplicates.length, 10);
    for (i = 0; i < shown; i++) {
      d = a.duplicates[i];
      w.push({ text: 'Duplicate key "' + d.key + '" at ' + d.path + ' (line ' + d.line + ', column ' + d.column + '). Parsers usually keep only the last value.' });
    }
    if (a.duplicates.length > shown) { w.push({ text: 'And ' + (a.duplicates.length - shown) + ' more duplicate keys.' }); }
    for (i = 0; i < a.notes.length; i++) { w.push({ text: a.notes[i] }); }
    if (a.truncated) { w.push({ text: 'Only the first ' + Util.LIMITS.maxItems.toLocaleString('en-US') + ' matches are listed. The counters above are exact.' }); }
    return w;
  };

  /* ------------------------------------------------------------------
     Helpers for conversions
     ------------------------------------------------------------------ */
  // YAML mappings come back as JavaScript objects, which list whole-number keys first.
  function yamlOrderNotice(parsed) {
    var stack = [], visited = 0, f, keys, i, v, found = false, root = parsed.empty ? null : parsed.data;
    var seen = new Set();
    function isMap(x) { return x !== null && typeof x === 'object' && Object.prototype.toString.call(x) === '[object Object]'; }
    if (root === null || typeof root !== 'object') { return []; }
    stack.push({ n: root, keys: isMap(root) ? Object.keys(root) : null, i: 0 });
    seen.add(root);
    while (stack.length && !found && visited < 200000) {
      f = stack[stack.length - 1];
      if (f.keys && f.i === 0 && f.keys.length > 1) {
        for (i = 0; i < f.keys.length; i++) { if (/^(?:0|[1-9]\d{0,8})$/.test(f.keys[i])) { found = true; break; } }
      }
      if (f.i >= (f.keys ? f.keys.length : f.n.length)) { stack.pop(); continue; }
      v = f.keys ? f.n[f.keys[f.i]] : f.n[f.i];
      f.i++; visited++;
      if (v !== null && typeof v === 'object' && !seen.has(v) && (Array.isArray(v) || isMap(v))) {
        seen.add(v);
        keys = Array.isArray(v) ? null : Object.keys(v);
        stack.push({ n: v, keys: keys, i: 0 });
      }
    }
    return found ? [{ level: 'warning', text: 'A mapping has whole-number keys (for example 10: ...). They are listed first, in number order, because JavaScript objects order them that way, so the order may differ from the input.' }] : [];
  }

  // JSON tree -> plain JavaScript value (for the YAML writer). Iterative.
  function jsonTreeToValue(jp) {
    var src = jp.text, notices = [], noted = Object.create(null), stack = [], root, f, kid, key, kidVal;
    function note(k, level, t) { if (!noted[k]) { noted[k] = true; notices.push({ level: level, text: t }); } }
    function conv(jn) {
      var raw, num, sh;
      if (jn.t === 'o' || jn.t === 'a') {
        sh = jn.t === 'a' ? [] : Object.create(null);
        stack.push({ j: jn, dst: sh, i: 0 });
        return sh;
      }
      raw = src.slice(jn.s, jn.e);
      if (jn.t === 's') { return JSON.parse(raw); }
      if (jn.t === 'z') { return null; }
      if (jn.t === 'b') { return raw === 'true'; }
      num = Number(raw);
      if (!isFinite(num)) { throw { msg: 'The number ' + Util.truncate(raw, 30) + ' is too large for YAML output.' }; }
      if (/^-?\d+$/.test(raw) && !Number.isSafeInteger(num)) {
        note('bigint', 'warning', 'An integer larger than 2^53 may lose precision in the output.');
      } else if (String(num) !== raw && !/^-?\d+$/.test(raw)) {
        note('numfmt', 'info', 'Decimal numbers are written in their shortest form (for example 1.50 becomes 1.5).');
      }
      return num;
    }
    root = conv(jp.root);
    while (stack.length) {
      f = stack[stack.length - 1];
      if (f.i >= f.j.kids.length) { stack.pop(); continue; }
      kid = f.j.kids[f.i++];
      if (f.j.t === 'a') { f.dst.push(conv(kid)); }
      else {
        key = Json.decodeKey(src.slice(kid.ks, kid.ke));
        if (key in f.dst) { note('dup', 'warning', 'The JSON has duplicate keys. Only the last value of each is kept in the output.'); }
        kidVal = conv(kid.v);
        f.dst[key] = kidVal;
      }
    }
    return { value: root, notices: notices };
  }

  /* ------------------------------------------------------------------
     JSON -> XML
     ------------------------------------------------------------------ */
  function jsonToXml(jp, unit, minify) {
    var src = jp.text, notices = [], noted = Object.create(null), stack = [], hasNil = false;
    var rootName, rootJn, wrapped = false, root, f, pair, k0;

    function note(k, level, t) { if (!noted[k]) { noted[k] = true; notices.push({ level: level, text: t }); } }
    function bad(msg) { throw { xmsg: msg }; }
    function chain(node) {
      var parts = [], p = node;
      while (p) { parts.unshift(p.n); p = p.parent; }
      return '/' + parts.join('/');
    }
    function scalarText(jn, where) {
      var s = jn.t === 's' ? JSON.parse(src.slice(jn.s, jn.e)) : src.slice(jn.s, jn.e), ix = Xml.firstInvalidChar(s);
      if (ix >= 0) { bad('The text at ' + where + ' contains the character U+' + ('0000' + s.charCodeAt(ix).toString(16)).slice(-4).toUpperCase() + ', which XML does not allow.'); }
      return s;
    }
    function checkPrefix(name, node, what) {
      var ix = name.indexOf(':'), prefix;
      if (ix < 0) { return; }
      prefix = name.slice(0, ix);
      if (name.indexOf(':', ix + 1) >= 0) { bad('The ' + what + ' name "' + name + '" has more than one colon.'); }
      if (prefix !== 'xml' && prefix !== 'xmlns' && !node.ns[prefix]) {
        bad('The ' + what + ' name "' + name + '" uses the prefix "' + prefix + '", but no "@xmlns:' + prefix + '" key declares it.');
      }
    }

    function enter(name, jn, parent) {
      var node = { n: name, attrs: [], text: null, kids: [], nil: false, parent: parent, ns: Object.create(parent ? parent.ns : null) };
      var queue = [], i, kid, key, an, v, pair2;
      if (parent) { parent.kids.push(node); }
      if (jn.t === 'z') { node.nil = true; hasNil = true; }
      else if (jn.t === 's' || jn.t === 'n' || jn.t === 'b') { node.text = scalarText(jn, chain(node)); }
      else if (jn.t === 'a') {
        note('nested', 'warning', 'Arrays inside arrays were written as <item> elements.');
        for (i = 0; i < jn.kids.length; i++) { queue.push(['item', jn.kids[i]]); }
      } else {
        for (i = 0; i < jn.kids.length; i++) {          // attributes first (they can declare namespaces)
          kid = jn.kids[i];
          key = Json.decodeKey(src.slice(kid.ks, kid.ke));
          if (key.charAt(0) !== '@') { continue; }
          an = key.slice(1); v = kid.v;
          if (v.t === 'o' || v.t === 'a') { bad('The attribute "' + key + '" at ' + chain(node) + ' must be a string, number or boolean, not an object or array.'); }
          if (v.t === 'z') { note('nullattr', 'warning', 'Attributes with a null value were left out.'); continue; }
          if (!Xml.isName(an)) { bad('The key "' + key + '" cannot be an XML attribute name. Attribute names follow the @ sign.'); }
          if (an === 'xmlns') { node.ns[''] = true; }
          else if (an.indexOf('xmlns:') === 0) { node.ns[an.slice(6)] = true; }
          node.attrs.push([an, scalarText(v, chain(node) + '/@' + an)]);
        }
        for (i = 0; i < node.attrs.length; i++) {
          if (node.attrs[i][0] !== 'xmlns' && node.attrs[i][0].indexOf('xmlns:') !== 0) { checkPrefix(node.attrs[i][0], node, 'attribute'); }
        }
        for (i = 0; i < jn.kids.length; i++) {
          kid = jn.kids[i];
          key = Json.decodeKey(src.slice(kid.ks, kid.ke));
          if (key.charAt(0) === '@') { continue; }
          v = kid.v;
          if (key === '#text') {
            if (v.t === 'o' || v.t === 'a') { bad('"#text" at ' + chain(node) + ' must be a string, number or boolean.'); }
            if (v.t !== 'z') { node.text = scalarText(v, chain(node) + '/#text'); }
          } else if (v.t === 'a') {
            if (!v.kids.length) { note('emptyarr', 'warning', 'Empty arrays disappear: XML has no way to show "no items".'); }
            for (pair2 = 0; pair2 < v.kids.length; pair2++) { queue.push([key, v.kids[pair2]]); }
          } else {
            queue.push([key, v]);
          }
        }
      }
      if (!Xml.isName(name)) {
        bad('The JSON key "' + name + '" cannot be an XML element name. Names start with a letter or _ and contain no spaces or special characters. Location: ' + chain(node));
      }
      checkPrefix(name, node, 'element');
      if (queue.length) { stack.push({ node: node, q: queue, i: 0 }); }
      return node;
    }

    function startTag(node) {
      var s = '<' + node.n, i;
      for (i = 0; i < node.attrs.length; i++) { s += ' ' + node.attrs[i][0] + '="' + Xml.escapeAttr(node.attrs[i][1]) + '"'; }
      if (node.nil) { s += ' xsi:nil="true"'; }
      return s;
    }

    function render(rootNode) {
      var out = [], st = [], fr, kid, nl = minify ? '' : '\n', pad = [];
      function ind(d) { return minify ? '' : (pad[d] || (pad[d] = new Array(d + 1).join(unit))); }
      function emit(node, depth) {
        var hasKids = node.kids.length > 0, hasText = node.text !== null && node.text !== '';
        if (!hasKids && !hasText) { out.push(startTag(node), '/>'); return; }
        if (!hasKids) { out.push(startTag(node), '>', Xml.escapeText(node.text), '</', node.n, '>'); return; }
        out.push(startTag(node), '>');
        if (hasText) { out.push(Xml.escapeText(node.text)); }
        st.push({ n: node, i: 0, depth: depth, inline: minify || hasText });
      }
      emit(rootNode, 0);
      while (st.length) {
        fr = st[st.length - 1];
        if (fr.i >= fr.n.kids.length) {
          st.pop();
          if (!fr.inline) { out.push(nl, ind(fr.depth)); }
          out.push('</', fr.n.n, '>');
          continue;
        }
        kid = fr.n.kids[fr.i++];
        if (!fr.inline) { out.push(nl, ind(fr.depth + 1)); }
        emit(kid, fr.depth + 1);
      }
      return out.join('');
    }

    try {
      rootJn = jp.root; rootName = 'root';
      if (jp.root.t === 'o' && jp.root.kids.length === 1) {
        k0 = Json.decodeKey(src.slice(jp.root.kids[0].ks, jp.root.kids[0].ke));
        if (k0.charAt(0) !== '@' && k0 !== '#text' && jp.root.kids[0].v.t !== 'a') { rootName = k0; rootJn = jp.root.kids[0].v; }
        else { wrapped = true; }
      } else { wrapped = true; }
      root = enter(rootName, rootJn, null);
      while (stack.length) {
        f = stack[stack.length - 1];
        if (f.i >= f.q.length) { stack.pop(); continue; }
        pair = f.q[f.i++];
        enter(pair[0], pair[1], f.node);
      }
      if (wrapped) { note('wrapped', 'info', 'A <root> element was added because XML needs exactly one root element.'); }
      if (hasNil) {
        if (!root.ns.xsi) { root.attrs.push(['xmlns:xsi', XSI]); }
        note('nil', 'info', 'JSON null values were written as xsi:nil="true", so they stay different from empty strings (<name/>).');
      }
      return {
        ok: true,
        text: '<?xml version="1.0" encoding="UTF-8"?>' + (minify ? '' : '\n') + render(root),
        notices: notices
      };
    } catch (e) {
      if (e && e.xmsg) { return { ok: false, error: { message: e.xmsg, line: 0, column: 0, offset: -1 } }; }
      throw e;
    }
  }


  /* ------------------------------------------------------------------
     Mixed text: format the data parts inside logs, keep everything else as written
     ------------------------------------------------------------------ */
  var MIXED = { maxSegments: 5000, timeMs: 2500 };

  function worthJson(root) {
    var k;
    if (root.t === 'o') { return root.kids.length > 0; }
    if (root.t === 'a') {
      for (k = 0; k < root.kids.length; k++) { if (root.kids[k].t === 'o' || root.kids[k].t === 'a') { return true; } }
    }
    return false;
  }
  function worthJava(root) {
    var k;
    if (root.t === 'obj' || root.t === 'map') { return root.fields.length > 0; }
    if (root.t === 'list') {
      for (k = 0; k < root.items.length; k++) { if (root.items[k].t === 'obj' || root.items[k].t === 'map') { return true; } }
    }
    return false;
  }

  C.mixedScan = function (text) {
    var re = /[{\[]|[A-Za-z_$][\w.$]*(?=[{(\[])/g, segs = [], m, idx, ch, r, seg, t0 = Date.now(), truncated = false;
    while ((m = re.exec(text)) !== null) {
      idx = m.index; ch = text.charAt(idx); seg = null;
      if (ch !== '{' && ch !== '[' && idx > 0 && /[\w.$]/.test(text.charAt(idx - 1))) { continue; }   // starts in the middle of a word
      if (ch === '{' || ch === '[') {
        r = Json.parse(text, { from: idx, prefix: true });
        if (r.ok && worthJson(r.root)) { seg = { format: 'json', start: idx, end: r.end, parsed: r }; }
      }
      if (!seg) {
        r = JavaObj.parse(text, { from: idx, prefix: true });
        if (r.ok && worthJava(r.root)) { seg = { format: 'java', start: idx, end: r.end, parsed: r }; }
      }
      if (seg) {
        segs.push(seg);
        re.lastIndex = seg.end;
        if (segs.length >= MIXED.maxSegments) { truncated = true; break; }
      }
      if (Date.now() - t0 > MIXED.timeMs) { truncated = true; break; }
    }
    return { segments: segs, truncated: truncated };
  };

  C.mixedRender = function (text, scan, o) {
    var minify = o.mode === 'minify', unit = Util.indentUnit(o.indent), pieces = [], pos = 0;
    var counts = { json: 0, java: 0 }, warn = Object.create(null), notices = [], parts = [], total = scan.segments.length;
    scan.segments.forEach(function (sg) {
      var f, ls, le;
      if (sg.format === 'json') {
        f = minify ? Json.minify(sg.parsed) : Json.beautify(sg.parsed, unit);
        counts.json++;
      } else {
        f = minify ? JavaObj.minify(sg.parsed).text : JavaObj.beautify(sg.parsed, unit).text;
        counts.java++;
        sg.parsed.warnings.forEach(function (w) { warn[w] = true; });
      }
      pieces.push(text.slice(pos, sg.start));
      if (!minify) {                                   // keep a formatted block on its own lines
        ls = text.lastIndexOf('\n', sg.start - 1) + 1;
        if (text.slice(ls, sg.start).trim() !== '') { pieces.push('\n'); }
      }
      pieces.push(f);
      if (!minify) {
        le = text.indexOf('\n', sg.end);
        if (le < 0) { le = text.length; }
        if (text.slice(sg.end, le).trim() !== '') { pieces.push('\n'); }
      }
      pos = sg.end;
    });
    pieces.push(text.slice(pos));
    if (counts.json) { parts.push(counts.json + ' JSON'); }
    if (counts.java) { parts.push(counts.java + ' Java-style'); }
    notices.push({ level: 'info', text: 'The input is not one single document, so it was treated as text with data inside it. Formatted ' + parts.join(' and ') + ' part' + (total === 1 ? '' : 's') + '. All other text was left exactly as written.' });
    if (scan.truncated) { notices.push({ level: 'warning', text: 'The search for parts stopped early (time or count limit), so some parts may not be formatted.' }); }
    Object.keys(warn).forEach(function (w) { notices.push({ level: 'warning', text: w }); });
    return { text: pieces.join(''), notices: notices };
  };

  C.mixedAnalysis = function (text, scan) {
    var a = Util.newAnalysis(), noted = Object.create(null), keys = Object.keys(a.counts);
    a.notes = [];
    scan.segments.forEach(function (sg, k) {
      var an = sg.format === 'json' ? Json.analyze(sg.parsed) : JavaObj.analyze(sg.parsed), prefix = '#' + (k + 1) + ' ';
      keys.forEach(function (key) {
        if (typeof an.counts[key] === 'number') { a.counts[key] = (typeof a.counts[key] === 'number' ? a.counts[key] : 0) + an.counts[key]; }
      });
      an.items.forEach(function (it) {
        if (a.items.length >= Util.LIMITS.maxItems) { a.truncated = true; return; }
        it.path = prefix + it.path;
        a.items.push(it);
      });
      an.duplicates.forEach(function (d) {
        if (a.duplicates.length < Util.LIMITS.maxItems) { d.path = prefix + d.path; a.duplicates.push(d); }
      });
      (an.notes || []).forEach(function (nt) { if (!noted[nt]) { noted[nt] = true; a.notes.push(nt); } });
      if (an.truncated) { a.truncated = true; }
    });
    return a;
  };

  /* ------------------------------------------------------------------
     run: format, minify or convert
     ------------------------------------------------------------------ */
  function fail(message, kind) {
    return { ok: false, error: { message: message, line: 0, column: 0, offset: -1, kind: kind || 'conversion' }, notices: [] };
  }

  function stringifyJson(value, unit, minify) {
    return minify ? JSON.stringify(value) : JSON.stringify(value, null, unit);
  }

  function verify(to, text) {
    var r = C.parse(to, text);
    return r.ok ? null : r.error.message;
  }

  C.run = function (o) {
    var from = o.from, to = o.to, minify = o.mode === 'minify', unit = Util.indentUnit(o.indent), p = o.parsed;
    var key = from + '>' + to, res, v, tv, nt = [], bad;
    if (!C.supports(from, to)) { return fail(C.unsupportedMessage(from, to), 'unsupported'); }
    try {
      if (from === to) {
        if (from === 'json') { res = { ok: true, text: minify ? Json.minify(p) : Json.beautify(p, unit), notices: [] }; }
        else if (from === 'xml') { res = minify ? Xml.minify(p) : Xml.beautify(p, unit); }
        else if (from === 'yaml') { res = minify ? Yaml.minify(p) : Yaml.beautify(p, unit); if (res.ok) { res.notices = res.notices.concat(yamlOrderNotice(p)); } }
        else { res = minify ? JavaObj.minify(p) : JavaObj.beautify(p, unit); }
      } else if (key === 'json>yaml') {
        v = jsonTreeToValue(p);
        res = { ok: true, text: Yaml.dump(v.value, unit, minify, 'safe'), notices: v.notices };
      } else if (key === 'yaml>json') {
        tv = Yaml.toJsonValue(p);
        if (!tv.ok) { return { ok: false, error: tv.error, notices: [] }; }
        nt = tv.notices.concat(yamlOrderNotice(p));
        if (/(^|[ \t])#/m.test(p.text)) { nt.push({ level: 'warning', text: 'YAML comments are not part of JSON and were dropped.' }); }
        res = { ok: true, text: stringifyJson(tv.value, unit, minify), notices: nt };
      } else if (key === 'json>xml') {
        res = jsonToXml(p, unit, minify);
      } else if (key === 'xml>json') {
        tv = Xml.toJsonValue(p);
        if (!tv.ok) { return { ok: false, error: tv.error, notices: [] }; }
        res = { ok: true, text: stringifyJson(tv.value, unit, minify), notices: tv.notices };
      } else if (key === 'json>java') {
        res = JavaObj.fromJson(p, unit, minify);
      } else {                                                   // java>json
        tv = JavaObj.toJsonValue(p, { keepTypes: !!o.keepTypes });
        res = { ok: true, text: stringifyJson(tv.value, unit, minify), notices: tv.notices };
      }
    } catch (e) {
      if (e && e.msg) { return fail(e.msg); }
      if (e instanceof RangeError) { return fail('The data is nested too deeply, or is too large, for this operation. Try Minify, or split the data.'); }
      return fail((e && e.message) || 'The operation failed.');
    }
    if (!res.ok) { return { ok: false, error: res.error, notices: res.notices || [] }; }
    if (from !== to) {
      bad = verify(to, res.text);
      if (bad) { return fail('The converted result is not valid ' + C.label(to) + ' (' + bad + '), so it was not produced.'); }
    }
    res.lossy = !!LOSSY[key];
    if (res.lossy) { res.notices = [{ level: 'warning', text: LOSSY[key] }].concat(res.notices || []); }
    return res;
  };

  /* ------------------------------------------------------------------
     Samples. Expected counts are noted for the test plan.
     ------------------------------------------------------------------ */
  DFI.Samples = [
    {
      id: 'json-user', format: 'json', label: 'JSON: user with null and empty values',
      // Expected: nulls 1, empty strings 1, empty arrays 1, empty objects 1
      text: '{"id":1,"name":"","email":null,"roles":[],"metadata":{}}'
    },
    {
      id: 'json-nested', format: 'json', label: 'JSON: nested data, Unicode and escapes',
      // Expected: nulls 2, empty strings 1, empty arrays 1, empty objects 1 ("null" in a string is not null)
      text: [
        '{',
        '  "company": "Khmer Digital Co.",',
        '  "city": "Phnom Penh",',
        '  "greeting": "\u179f\u17bd\u179f\u17d2\u178a\u17b8",',
        '  "quote": "He said \\"hello\\"\\nNew line, tab\\tand backslash \\\\",',
        '  "unicodeEscape": "\\u00e9\\u4e2d",',
        '  "emoji": "\uD83D\uDE00",',
        '  "users": [',
        '    {"id": 1, "name": "Sok", "email": null, "tags": [], "profile": {}, "bio": ""},',
        '    {"id": 2, "name": "Dara", "email": "dara@example.com", "tags": ["admin", "ops"], "profile": {"age": 30, "active": true}, "bio": null}',
        '  ],',
        '  "literalNull": "null",',
        '  "total": 12345678901234567890,',
        '  "ratio": 1.50',
        '}'
      ].join('\n')
    },
    {
      id: 'json-duplicate', format: 'json', label: 'JSON: duplicate keys',
      // Expected: duplicate keys 1
      text: '{\n  "id": 1,\n  "name": "A",\n  "id": 2\n}'
    },
    {
      id: 'json-bad', format: 'json', label: 'JSON: invalid (missing comma)',
      text: '{\n  "id": 1\n  "name": "John"\n}'
    },
    {
      id: 'xml-customers', format: 'xml', label: 'XML: namespaces, empty elements, CDATA',
      // Expected: empty elements 4 (phone, fax, nickname, address), null 1 (xsi:nil), whitespace-only 1
      text: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- Customer export -->',
        '<ns:customers xmlns:ns="urn:example:customers" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        '  <ns:customer id="1" status="active">',
        '    <ns:name>John &amp; Sons</ns:name>',
        '    <ns:email xsi:nil="true"/>',
        '    <ns:phone></ns:phone>',
        '    <ns:fax/>',
        '    <ns:nickname>   </ns:nickname>',
        '    <ns:note>null</ns:note>',
        '    <ns:address city="Phnom Penh" country="Cambodia"/>',
        '    <ns:bio><![CDATA[Uses <tags> & "quotes"]]></ns:bio>',
        '  </ns:customer>',
        '  <ns:customer id="2" status="inactive">',
        '    <ns:name>\u179f\u17bb\u1781</ns:name>',
        '    <ns:email>sok@example.com</ns:email>',
        '  </ns:customer>',
        '</ns:customers>'
      ].join('\n')
    },
    {
      id: 'xml-bad', format: 'xml', label: 'XML: invalid (mismatched closing tag)',
      text: '<order>\n  <item>Pen</item>\n  <price>2.50</prise>\n</order>'
    },
    {
      id: 'yaml-config', format: 'yaml', label: 'YAML: config with nulls, empties and anchors',
      // Expected: nulls 3, empty strings 2, empty arrays 1, empty objects 2
      text: [
        '# Service configuration',
        'id: 1',
        'name: ""',
        'email: null',
        'nickname: ~',
        'roles: []',
        'metadata: {}',
        'note: "null"',
        'defaults: &defaults',
        '  retries: 3',
        '  timeout: 30',
        'limits: *defaults',
        'description: |',
        '  First line',
        '  Second line',
        'unicode: "caf\\u00e9 \\u2603"',
        'list:',
        '  - alpha',
        '  - ~',
        '  - ""',
        '  - {}'
      ].join('\n')
    },
    {
      id: 'yaml-bad', format: 'yaml', label: 'YAML: invalid (inconsistent indentation)',
      text: 'service:\n  name: api\n  port: 8080\n debug: true'
    },
    {
      id: 'java-user', format: 'java', label: 'Java: User{...} with a null',
      // Expected: nulls 1
      text: "User{id=1, name='John', email=null, active=true}"
    },
    {
      id: 'java-nested', format: 'java', label: 'Java: nested list with null and empty values',
      // Expected: nulls 2, empty strings 2 (zip= and nickname=''), empty arrays 2, empty objects 1
      text: "[User{id=1, name='John', email=null, roles=[ADMIN, USER], address=Address{city=Phnom Penh, country=Cambodia, zip=}, nickname='', tags=[], meta={}}, User{id=2, name='O'Brien', email='null', roles=[], address=null}]"
    },
    {
      id: 'java-lombok', format: 'java', label: 'Java: Lombok style and plain map',
      text: "User(id=1, name=John, roles=[ADMIN, USER], address={city=Phnom Penh, country=Cambodia})"
    },
    {
      id: 'java-bad', format: 'java', label: 'Java: invalid (unbalanced list)',
      text: "User{id=1, roles=[ADMIN, USER, active=true}"
    }
  ];

})(window);
/* ===================== END OF PART 5 ===================== */
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
/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 7a of 7: Angular module, CodeMirror editors, directives, controller core
   BEGINS: the comment block headed "PART 7a of 7" (paste right after "END OF PART 6").
   ENDS:   the line "END OF PART 7a".   Part 7b follows and finishes the controller.

   What is here: the Java-style highlighting mode; directives dfiFileInput, dfiDropZone, dfiResizer;
   MainController (state, formats, processing pipeline with caching, validation, counters, inspector data,
   theme, settings, samples, toast). Search, file/clipboard actions, inspector jumping and keyboard
   shortcuts are added by Part 7b through DFI.attachments (functions called with (vm, ctx)).

   ctx (shared with Part 7b):
     ctx.$scope, ctx.$timeout, ctx.cm.input, ctx.cm.output
     ctx.apply(fn)                  run fn inside an Angular digest
     ctx.toast(message, type, ms)   type: info | success | warning | error
     ctx.setText(side, text, opts)  replace editor content without triggering auto-processing (opts.edited for loaded output)
     ctx.setOutputFormat(fmt)       set the output format selector, labels and highlighting
     ctx.refreshInspection()        rebuild counters and the inspector list for the current target
     ctx.getText(side)
     ctx.process(action, source)    action: beautify | minify | validate | auto
     ctx.schedule(action, source)   same, with the processing indicator for large input
     ctx.effective()                {input, output} format ids in use now (may be null)
     ctx.revealPanel(side), ctx.flash(side, fromPos, toPos)
     ctx.on(name, fn), ctx.emit(name, data)   events: outputChanged, layout, inspectTargetChanged,
                                              inspectFilterChanged, inspectItemsChanged
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI, Util = DFI.Util, Convert = DFI.Convert, Files = DFI.Files, Store = DFI.Store;
  var CM = global.CodeMirror, angular = global.angular;
  DFI.attachments = DFI.attachments || [];

  /* ------------------------------------------------------------------
     Highlighting mode for Java-style objects
     ------------------------------------------------------------------ */
  CM.defineMode('dfi-java', function () {
    return {
      startState: function () { return {}; },
      token: function (stream) {
        var ch, c, esc = false;
        if (stream.eatSpace()) { return null; }
        ch = stream.peek();
        if (ch === '"' || ch === "'") {
          stream.next();
          while ((c = stream.next()) != null) {
            if (c === ch && !esc && stream.match(/^\s*(?:[,})\]=]|$)/, false)) { break; }
            esc = !esc && c === '\\';
          }
          return 'string';
        }
        if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])/)) { return 'number'; }
        if (stream.match(/^(?:true|false|null)(?![\w.])/)) { return 'atom'; }
        if (stream.match(/^[A-Za-z_$][\w.$]*(?=\s*=)/)) { return 'property'; }
        if (stream.match(/^[A-Za-z_$][\w.$]*(?=[{(\[])/)) { return 'def'; }
        if (stream.match(/^[{}()\[\]]/)) { return 'bracket'; }
        if (stream.match(/^[,=]/)) { return 'operator'; }
        if (!stream.match(/^[^\s,=\[\]{}()'"]+/)) { stream.next(); }
        return 'variable';
      }
    };
  });

  function modeFor(format) {
    if (format === 'json') { return { name: 'javascript', json: true }; }
    if (format === 'xml') { return 'application/xml'; }
    if (format === 'yaml') { return 'yaml'; }
    if (format === 'java') { return 'dfi-java'; }
    return null;
  }

  var DEFAULT_SETTINGS = { indent: '2', wrap: false, lineNumbers: true, mode: 'auto' };
  var TYPE_WORDS = { 'null': 'null values', emptyString: 'empty strings', emptyArray: 'empty arrays', emptyObject: 'empty objects', emptyElement: 'empty elements' };

  /* ------------------------------------------------------------------
     Module and directives
     ------------------------------------------------------------------ */
  var app = angular.module('dfiApp', []);
  app.constant('DFI', DFI);

  app.directive('dfiFileInput', ['$parse', function ($parse) {
    return {
      restrict: 'A',
      link: function (scope, el, attrs) {
        var fn = $parse(attrs.dfiFileInput);
        el.on('change', function (ev) {
          var files = Array.prototype.slice.call(ev.target.files || []);
          ev.target.value = '';                       // lets the same file be chosen again
          scope.$applyAsync(function () { fn(scope, { files: files }); });
        });
      }
    };
  }]);

  app.directive('dfiDropZone', ['$parse', function ($parse) {
    return {
      restrict: 'A',
      link: function (scope, el, attrs) {
        var fn = $parse(attrs.dfiDropZone), node = el[0], depth = 0;
        function hasFiles(e) {
          var t = e.dataTransfer && e.dataTransfer.types;
          return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
        }
        // Capture phase, so the editor does not also insert the dropped file itself.
        node.addEventListener('dragenter', function (e) {
          if (!hasFiles(e)) { return; }
          depth++; node.classList.add('is-dragover'); e.preventDefault();
        }, true);
        node.addEventListener('dragover', function (e) {
          if (!hasFiles(e)) { return; }
          e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
        }, true);
        node.addEventListener('dragleave', function (e) {
          if (!hasFiles(e)) { return; }
          depth = Math.max(0, depth - 1);
          if (!depth) { node.classList.remove('is-dragover'); }
        }, true);
        node.addEventListener('drop', function (e) {
          var files;
          if (!hasFiles(e)) { return; }
          e.preventDefault(); e.stopPropagation();
          depth = 0; node.classList.remove('is-dragover');
          files = Files.fromDataTransfer(e.dataTransfer).files;
          scope.$applyAsync(function () { fn(scope, { files: files }); });
        }, true);
      }
    };
  }]);

  app.directive('dfiResizer', function () {
    return {
      restrict: 'A',
      link: function (scope, el) {
        var node = el[0], first = node.previousElementSibling, wrap = node.parentElement;
        var vertical = false, startPos = 0, startSize = 0, lastVertical = null, raf = 0;

        function isVertical() { return global.getComputedStyle(wrap).flexDirection === 'column'; }
        function fire() {
          if (raf) { return; }
          raf = global.requestAnimationFrame(function () { raf = 0; global.dispatchEvent(new global.Event('dfi-layout')); });
        }
        function clear() { first.style.flex = ''; first.style.height = ''; fire(); }
        function setSize(px) {
          var rect = wrap.getBoundingClientRect();
          if (vertical) {
            first.style.height = Math.max(160, Math.min(px, rect.height - 200)) + 'px';
          } else {
            first.style.flex = '0 0 ' + Math.max(200, Math.min(px, rect.width - 232)) + 'px';
          }
          fire();
        }
        node.addEventListener('pointerdown', function (e) {
          var r = first.getBoundingClientRect();
          vertical = isVertical();
          startPos = vertical ? e.clientY : e.clientX;
          startSize = vertical ? r.height : r.width;
          if (node.setPointerCapture) { node.setPointerCapture(e.pointerId); }
          node.classList.add('is-dragging'); global.document.body.classList.add('is-resizing');
          e.preventDefault();
        });
        node.addEventListener('pointermove', function (e) {
          if (!node.classList.contains('is-dragging')) { return; }
          setSize(startSize + (vertical ? e.clientY : e.clientX) - startPos);
        });
        function stop() { node.classList.remove('is-dragging'); global.document.body.classList.remove('is-resizing'); }
        node.addEventListener('pointerup', stop);
        node.addEventListener('pointercancel', stop);
        node.addEventListener('keydown', function (e) {
          var r = first.getBoundingClientRect(), step = 24, k = e.key;
          vertical = isVertical();
          if (k === 'Home' || k === 'Escape') { clear(); return; }
          if (k === 'ArrowLeft' || k === 'ArrowUp') { setSize((vertical ? r.height : r.width) - step); e.preventDefault(); }
          else if (k === 'ArrowRight' || k === 'ArrowDown') { setSize((vertical ? r.height : r.width) + step); e.preventDefault(); }
        });
        global.addEventListener('resize', function () {   // layout switched between side-by-side and stacked
          var v = isVertical();
          if (lastVertical !== null && v !== lastVertical) { clear(); }
          lastVertical = v;
        });
        lastVertical = isVertical();
      }
    };
  });

  /* ------------------------------------------------------------------
     MainController
     ------------------------------------------------------------------ */
  app.controller('MainController', ['$scope', '$timeout', function ($scope, $timeout) {
    var vm = this;
    var ctx = { $scope: $scope, $timeout: $timeout, cm: {}, hooks: {} };
    var cache = { input: null, output: null, mixed: null };
    var silent = { input: false, output: false };
    var state = { inFmt: null, outFmt: null, outGen: 0, errHandle: null, toastTimer: null, allItems: [], noAnalysis: '', mixedActive: false, modes: { input: undefined, output: undefined } };

    /* ---------- small helpers ---------- */
    ctx.apply = function (fn) { $scope.$evalAsync(fn); };
    ctx.on = function (name, fn) { (ctx.hooks[name] = ctx.hooks[name] || []).push(fn); };
    ctx.emit = function (name, data) { (ctx.hooks[name] || []).forEach(function (fn) { fn(data); }); };
    ctx.getText = function (side) { return ctx.cm[side].getValue(); };
    ctx.effective = function () { return { input: state.inFmt, output: state.outFmt }; };

    function friendly(e) {
      if (e instanceof RangeError) { return 'The data is nested too deeply, or is too large, to process here.'; }
      return (e && e.message) || 'Something went wrong.';
    }

    ctx.toast = function (message, type, ms) {
      ctx.apply(function () {
        vm.toast = { visible: true, type: type || 'info', message: message };
        if (state.toastTimer) { $timeout.cancel(state.toastTimer); }
        state.toastTimer = $timeout(function () { vm.toast.visible = false; }, ms || 3200);
      });
    };

    ctx.revealPanel = function (side) {
      var node = global.document.getElementById(side === 'input' ? 'inputPanel' : 'outputPanel'), r;
      if (!node) { return; }
      r = node.getBoundingClientRect();
      if (r.top < 0 || r.bottom > (global.innerHeight || 800)) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    };

    ctx.flash = function (side, from, to) {
      var mk = ctx.cm[side].markText(from, to, { className: 'cm-inspect-flash' });
      setTimeout(function () { mk.clear(); }, 1700);
    };

    /* ---------- state ---------- */
    vm.theme = Store.get('theme', (global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark');
    vm.settings = angular.extend({}, DEFAULT_SETTINGS, Store.get('settings', {}));
    if (['2', '4', 'tab'].indexOf(vm.settings.indent) < 0) { vm.settings.indent = '2'; }
    if (vm.settings.mode !== 'auto' && vm.settings.mode !== 'manual') { vm.settings.mode = 'auto'; }
    vm.showSettings = false;
    vm.sampleMenuOpen = false;
    vm.showDetails = false;

    vm.inputFormats = [{ id: 'auto', label: 'Auto-detect' }].concat(Convert.FORMATS);
    vm.outputFormats = [{ id: 'same', label: 'Same as input' }].concat(Convert.FORMATS);
    vm.inputFormat = 'auto';
    vm.outputFormat = 'same';
    vm.inputFormatLabel = 'Auto-detect';
    vm.outputFormatLabel = 'Same as input';
    vm.outputEdited = false;
    vm.canSwap = false;
    vm.swapHint = 'Choose a specific input format to enable swapping.';
    vm.samples = DFI.Samples;
    vm.lastAction = 'beautify';
    vm.processing = false;
    vm.dirty = false;

    vm.stats = { input: Util.textStats(''), output: Util.textStats('') };
    vm.validation = { status: 'idle', label: 'Not validated', message: 'Paste or type data, or load a sample, to validate it.', error: null, warnings: [] };
    vm.conversionNotices = [];
    vm.inspectTarget = 'input';
    vm.inspectFilter = 'all';
    vm.inspectFilters = [];
    vm.visibleItems = [];
    vm.itemLimit = 100;
    vm.inspectionMessage = 'Nothing to inspect yet.';
    vm.analysisMeta = '';
    vm.counters = [];
    vm.canUndo = false;
    vm.canRedo = false;
    vm.toast = { visible: false, type: 'info', message: '' };
    vm.search = {
      open: false, query: '', caseSensitive: false, wholeWord: false, regex: false,
      status: '', error: '', total: 0, current: 0, showReplace: false, replaceText: '', confirmAll: false
    };

    /* ---------- editors ---------- */
    function editorOptions(placeholder) {
      return {
        value: '', theme: 'dfi', mode: null, placeholder: placeholder,
        lineNumbers: !!vm.settings.lineNumbers, lineWrapping: !!vm.settings.wrap,
        indentUnit: vm.settings.indent === '4' ? 4 : 2, tabSize: vm.settings.indent === '4' ? 4 : 2,
        indentWithTabs: vm.settings.indent === 'tab', viewportMargin: 30,
        spellcheck: false, autocorrect: false, autocapitalize: false
      };
    }
    ctx.cm.input = CM(global.document.getElementById('inputEditor'), editorOptions('Paste or type JSON, XML, YAML or a Java-style object here, or drop a file'));
    ctx.cm.output = CM(global.document.getElementById('outputEditor'), editorOptions('The formatted output appears here'));

    function applyEditorOptions() {
      ['input', 'output'].forEach(function (side) {
        var cm = ctx.cm[side];
        cm.setOption('lineNumbers', !!vm.settings.lineNumbers);
        cm.setOption('lineWrapping', !!vm.settings.wrap);
        cm.setOption('indentUnit', vm.settings.indent === '4' ? 4 : 2);
        cm.setOption('tabSize', vm.settings.indent === '4' ? 4 : 2);
        cm.setOption('indentWithTabs', vm.settings.indent === 'tab');
      });
      refreshEditors();
    }
    function refreshEditors() { ctx.cm.input.refresh(); ctx.cm.output.refresh(); }
    ctx.on('layout', refreshEditors);
    global.addEventListener('dfi-layout', function () { ctx.emit('layout'); });
    global.addEventListener('resize', Util.debounce(refreshEditors, 150));
    $timeout(refreshEditors, 0);

    function applyModes(inFmt, outFmt) {
      if (state.modes.input !== inFmt) { state.modes.input = inFmt; ctx.cm.input.setOption('mode', modeFor(inFmt)); }
      if (state.modes.output !== outFmt) { state.modes.output = outFmt; ctx.cm.output.setOption('mode', modeFor(outFmt)); }
    }

    function refreshStats(side) { vm.stats[side] = Util.textStats(ctx.cm[side].getValue()); }

    // opts.edited marks output text that was supplied by the user (a loaded file) rather than generated.
    ctx.setText = function (side, text, opts) {
      var cm = ctx.cm[side];
      silent[side] = true;
      cm.operation(function () {
        cm.setValue(text);
        if (side === 'output') { cm.clearHistory(); state.outGen = (opts && opts.edited) ? -1 : cm.changeGeneration(true); }
      });
      silent[side] = false;
      refreshStats(side);
      if (side === 'output') { vm.outputEdited = !!(opts && opts.edited); vm.canUndo = false; vm.canRedo = false; }
    };

    ctx.setOutputFormat = function (fmt) {
      vm.outputFormat = fmt; state.outFmt = fmt;
      state.modes.output = fmt;
      ctx.cm.output.setOption('mode', modeFor(fmt));
      updateLabels();
    };

    var statsIn = Util.debounce(function () { ctx.apply(function () { refreshStats('input'); }); }, 120);
    var statsOut = Util.debounce(function () { ctx.apply(function () { refreshStats('output'); }); }, 120);
    var autoRun = Util.debounce(function () {
      ctx.apply(function () { if (vm.settings.mode === 'auto') { ctx.schedule('auto', 'typing'); } });
    }, 450);
    var outputInspect = Util.debounce(function () {
      ctx.apply(function () { if (vm.inspectTarget === 'output') { refreshInspection(); } });
    }, 300);

    ctx.cm.input.on('change', function () {
      statsIn();
      if (silent.input) { return; }
      ctx.apply(function () { vm.dirty = true; });
      if (vm.settings.mode === 'auto') { autoRun(); }
    });

    ctx.cm.output.on('change', function (cm, change) {
      statsOut();
      ctx.apply(function () {
        var h = cm.historySize();
        vm.outputEdited = !cm.isClean(state.outGen);
        vm.canUndo = h.undo > 0;
        vm.canRedo = h.redo > 0;
      });
      ctx.emit('outputChanged', change);
      outputInspect();
    });

    /* ---------- parsing with a one-entry cache per side ---------- */
    function parseCached(side, fmt, text) {
      var c = cache[side], res;
      if (c && c.fmt === fmt && c.text === text) { return c.res; }
      try { res = Convert.parse(fmt, text); }
      catch (e) { res = { ok: false, format: fmt, error: { message: friendly(e), line: 0, column: 0, offset: -1 } }; }
      cache[side] = { fmt: fmt, text: text, res: res };
      return res;
    }
    function analysisOf(res) {
      if (!res.analysis) {
        try { res.analysis = Convert.analyze(res.format, res.parsed); }
        catch (e) { res.analysisError = friendly(e); res.analysis = null; }
      }
      return res.analysis;
    }

    /* ---------- validation panel ---------- */
    function setIdle(message) {
      vm.validation = { status: 'idle', label: 'Not validated', message: message, error: null, warnings: [] };
    }
    function setInvalid(error, mismatch) {
      vm.validation = {
        status: 'invalid', label: 'Invalid', message: '',
        error: { message: error.message, line: error.line, column: error.column },
        warnings: mismatch ? [{ text: mismatch }] : []
      };
    }
    function setValid(fmt, res, analysis, text) {
      var w = [], m = vm.inputFormat === 'auto' ? null : Convert.mismatchWarning(vm.inputFormat, text), i, pw;
      if (m) { w.push({ text: m }); }
      if (analysis) { w = w.concat(Convert.warningsFrom(analysis)); }
      if (fmt === 'yaml' && res.parsed.warnings) {
        for (i = 0; i < res.parsed.warnings.length; i++) {
          pw = res.parsed.warnings[i];
          w.push({ text: 'YAML warning' + (pw.line ? ' (line ' + pw.line + ')' : '') + ': ' + pw.text });
        }
      }
      vm.validation = { status: 'valid', label: 'Valid', message: 'The input is valid ' + Convert.label(fmt) + '.', error: null, warnings: w };
    }
    function clearErrorMark() {
      if (state.errHandle) { ctx.cm.input.removeLineClass(state.errHandle, 'background', 'cm-error-line'); state.errHandle = null; }
    }
    function markError(error) {
      var cm = ctx.cm.input;
      if (error.line && error.line <= cm.lineCount()) { state.errHandle = cm.addLineClass(error.line - 1, 'background', 'cm-error-line'); }
    }

    vm.jumpToError = function () {
      var e = vm.validation.error, cm = ctx.cm.input, pos;
      if (!e || !e.line) { return; }
      pos = { line: Math.min(e.line - 1, cm.lineCount() - 1), ch: Math.max(e.column - 1, 0) };
      ctx.revealPanel('input');
      cm.focus(); cm.setCursor(pos); cm.scrollIntoView({ from: pos, to: pos }, 140);
      ctx.flash('input', pos, { line: pos.line, ch: pos.ch + 1 });
    };

    /* ---------- counters and inspector ---------- */
    function buildCounters(side, counts) {
      var st = vm.stats[side], c = counts || {}, na = Util.NA;
      function v(key) { return counts ? c[key] : na; }
      vm.counters = [
        { key: 'chars', label: 'Characters', value: st.chars, filter: null, cls: 'c-neutral', hint: 'Unicode characters' },
        { key: 'bytes', label: 'Bytes (UTF-8)', value: st.bytes, filter: null, cls: 'c-neutral', hint: 'Size in UTF-8 bytes' },
        { key: 'lines', label: 'Lines', value: st.lines, filter: null, cls: 'c-neutral', hint: 'Lines in the editor' },
        { key: 'words', label: 'Words', value: st.words, filter: null, cls: 'c-neutral', hint: 'Runs of non-space characters' },
        { key: 'fields', label: 'Fields', value: v('fields'), filter: null, cls: 'c-neutral', hint: 'Properties, keys or XML elements' },
        { key: 'objects', label: 'Objects', value: v('objects'), filter: null, cls: 'c-neutral', hint: 'Objects, mappings or elements with child elements' },
        { key: 'arrays', label: 'Arrays', value: v('arrays'), filter: null, cls: 'c-neutral', hint: 'Arrays, sequences and lists' },
        { key: 'attributes', label: 'Attributes', value: v('attributes'), filter: null, cls: 'c-neutral', hint: 'XML attributes (xmlns not counted)' },
        { key: 'textNodes', label: 'Text nodes', value: v('textNodes'), filter: null, cls: 'c-neutral', hint: 'XML text and CDATA that is not only whitespace' },
        { key: 'nulls', label: 'Null values', value: v('nulls'), filter: 'null', cls: 'c-null', hint: 'Real null values, not the text "null". Click to list.' },
        { key: 'emptyStrings', label: 'Empty strings', value: v('emptyStrings'), filter: 'emptyString', cls: 'c-emptystring', hint: 'Click to list' },
        { key: 'emptyArrays', label: 'Empty arrays', value: v('emptyArrays'), filter: 'emptyArray', cls: 'c-emptyarray', hint: 'Click to list' },
        { key: 'emptyObjects', label: 'Empty objects', value: v('emptyObjects'), filter: 'emptyObject', cls: 'c-emptyobject', hint: 'Click to list' },
        { key: 'emptyElements', label: 'Empty XML elements', value: v('emptyElements'), filter: 'emptyElement', cls: 'c-emptyelement', hint: 'No content, or only whitespace. Click to list.' },
        { key: 'whitespaceTexts', label: 'Whitespace-only text', value: v('whitespaceTexts'), filter: null, cls: 'c-neutral', hint: 'XML elements whose only content is whitespace' },
        { key: 'duplicateKeys', label: 'Duplicate keys', value: v('duplicateKeys'), filter: null, cls: 'c-neutral', hint: 'Repeated keys inside one object' }
      ];
      function n(key) { return typeof c[key] === 'number' ? c[key] : 0; }
      vm.inspectFilters = [
        { id: 'all', label: 'All', count: n('nulls') + n('emptyStrings') + n('emptyArrays') + n('emptyObjects') + n('emptyElements') },
        { id: 'null', label: 'Null', count: n('nulls') },
        { id: 'emptyString', label: 'Empty string', count: n('emptyStrings') },
        { id: 'emptyArray', label: 'Empty array', count: n('emptyArrays') },
        { id: 'emptyObject', label: 'Empty object', count: n('emptyObjects') },
        { id: 'emptyElement', label: 'Empty element', count: n('emptyElements') }
      ];
    }

    function applyFilter() {
      var f = vm.inspectFilter;
      vm.visibleItems = f === 'all' ? state.allItems : state.allItems.filter(function (it) { return it.type === f; });
      if (vm.visibleItems.length) { vm.inspectionMessage = ''; }
      else if (state.noAnalysis) { vm.inspectionMessage = state.noAnalysis; }
      else { vm.inspectionMessage = f === 'all' ? 'No null or empty values found.' : 'No ' + (TYPE_WORDS[f] || 'values') + ' found.'; }
      ctx.emit('inspectItemsChanged', vm.visibleItems);
    }

    function showAnalysis(side, fmt, analysis) {
      state.noAnalysis = '';
      buildCounters(side, analysis.counts);
      state.allItems = analysis.items;
      vm.analysisMeta = Convert.label(fmt) + ' ' + side + (analysis.truncated ? ' (first ' + Util.LIMITS.maxItems.toLocaleString('en-US') + ' matches listed)' : '');
      applyFilter();
    }
    function showNoAnalysis(side, reason) {
      state.noAnalysis = reason;
      state.allItems = [];
      buildCounters(side, null);
      vm.analysisMeta = 'Not available';
      applyFilter();
    }

    function refreshInspection() {
      var side = vm.inspectTarget, text = ctx.cm[side].getValue(), fmt, res, a, c;
      if (!text.trim()) { showNoAnalysis(side, side === 'input' ? 'Paste or type data, or load a sample.' : 'There is no output yet. Click Beautify.'); return; }
      if (side === 'input') {
        if (state.mixedActive && cache.mixed && cache.mixed.text === text && cache.mixed.analysis) {
          showAnalysis('input', 'mixed', cache.mixed.analysis);
          return;
        }
        c = cache.input;
        if (!c || c.text !== text) { showNoAnalysis(side, 'Click Validate or Beautify to analyze the input.'); return; }
        res = c.res; fmt = c.fmt;
        if (!res.ok) { showNoAnalysis(side, 'The input has a syntax error, so it cannot be inspected yet. See Validation.'); return; }
      } else {
        fmt = state.outFmt || state.inFmt || (vm.outputFormat === 'same' ? null : vm.outputFormat);
        if (!fmt) { showNoAnalysis(side, 'The output format is not known yet.'); return; }
        if (fmt === 'mixed') { showNoAnalysis(side, 'The output is mixed text, so it cannot be analyzed as one document. Switch to Input to inspect the parts.'); return; }
        res = parseCached('output', fmt, text);
        if (!res.ok) { showNoAnalysis(side, 'The output is not valid ' + Convert.label(fmt) + ' (' + res.error.message + ').'); return; }
      }
      a = analysisOf(res);
      if (!a) { showNoAnalysis(side, res.analysisError || 'This data could not be analyzed.'); return; }
      showAnalysis(side, fmt, a);
    }
    ctx.refreshInspection = refreshInspection;

    vm.setInspectTarget = function (t) {
      vm.inspectTarget = t;
      vm.itemLimit = 100;
      refreshInspection();
      ctx.emit('inspectTargetChanged', t);
    };
    vm.setInspectFilter = function (f) {
      if (!f) { return; }
      vm.inspectFilter = f;
      vm.itemLimit = 100;
      applyFilter();
      ctx.emit('inspectFilterChanged', f);
    };
    vm.showMoreItems = function () { vm.itemLimit += 200; };

    /* ---------- formats ---------- */
    function effectiveInput(text) {
      var d;
      if (vm.inputFormat !== 'auto') { return vm.inputFormat; }
      d = Convert.detect(text);
      return d.format === 'unknown' ? null : d.format;
    }

    function updateSwap(inFmt) {
      var r;
      if (vm.inputFormat === 'auto' || !inFmt) { vm.canSwap = false; vm.swapHint = 'Choose a specific input format to enable swapping.'; return; }
      if (vm.outputFormat === 'same') { vm.canSwap = false; vm.swapHint = 'Choose a specific output format to enable swapping.'; return; }
      r = Convert.canSwap(vm.inputFormat, vm.outputFormat);
      vm.canSwap = r.ok; vm.swapHint = r.hint;
    }
    function updateLabels() {
      if (state.mixedActive) { vm.inputFormatLabel = 'Mixed text'; vm.outputFormatLabel = 'Mixed text'; return; }
      vm.inputFormatLabel = vm.inputFormat === 'auto' ? (state.inFmt ? 'Auto: ' + Convert.label(state.inFmt) : 'Auto-detect') : Convert.label(vm.inputFormat);
      vm.outputFormatLabel = vm.outputFormat === 'same'
        ? (state.outFmt ? Convert.label(state.outFmt) + ' (same as input)' : 'Same as input')
        : Convert.label(vm.outputFormat);
    }

    /* ---------- processing pipeline ---------- */
    function clearOutputIfSafe(force) {
      if (ctx.cm.output.getValue() && (force || !vm.outputEdited)) { ctx.setText('output', ''); }
    }

    /* ---------- mixed text: format the data parts inside logs, leave the rest as written ---------- */
    function getMixed(text) {
      var c = cache.mixed, scan;
      if (c && c.text === text) { return c; }
      scan = Convert.mixedScan(text);
      c = { text: text, scan: scan, analysis: scan.segments.length ? Convert.mixedAnalysis(text, scan) : null };
      cache.mixed = c;
      return c;
    }

    function runMixed(text, action, error, inFmt) {
      var m, n, w = [], r, notices;
      if (action === 'auto' && text.length > 300000) { return false; }
      m = getMixed(text);
      n = m.scan.segments.length;
      if (!n) { return false; }
      state.mixedActive = true;
      if (error) {
        w.push({ text: 'As one ' + Convert.label(inFmt) + ' document this is not valid: ' + error.message + (error.line ? ' (line ' + error.line + ', column ' + error.column + ')' : '') + '. The valid parts were formatted instead.' });
      }
      vm.validation = {
        status: 'valid', label: 'Partly valid', error: null, warnings: w,
        message: 'Found ' + n + ' valid part' + (n === 1 ? '' : 's') + ' of structured data inside the text. Text that is not data was left as written.'
      };
      vm.dirty = false;
      state.inFmt = inFmt || null; state.outFmt = 'mixed';
      updateLabels(); updateSwap(null); applyModes(inFmt, 'mixed');
      if (action !== 'validate') {
        if (action === 'auto' && vm.outputEdited) {
          vm.conversionNotices = [{ level: 'info', text: 'The output was not refreshed because you edited it. Click Beautify or Minify to replace it.' }];
        } else {
          r = Convert.mixedRender(text, m.scan, { mode: action === 'auto' ? vm.lastAction : action, indent: vm.settings.indent });
          ctx.setText('output', r.text);
          notices = r.notices;
          if (vm.outputFormat !== 'same') {
            notices.push({ level: 'info', text: 'Conversion to ' + Convert.label(vm.outputFormat) + ' is not applied to mixed text. Each part keeps its own format.' });
          }
          vm.conversionNotices = notices;
        }
      }
      refreshInspection();
      return true;
    }

    ctx.process = function (action, source) {
      var text = ctx.cm.input.getValue(), inFmt, outFmt, res, analysis, mode, out, notices = [];
      if (action === 'beautify' || action === 'minify') { vm.lastAction = action; }
      state.mixedActive = false;
      clearErrorMark();

      if (action === 'auto' && text.length > Util.LIMITS.autoMaxChars) {
        setIdle('Auto mode is paused for large input (' + (text.length / 1048576).toFixed(1) + ' MB of text). Click Validate or Beautify, or switch to Manual mode.');
        vm.dirty = true; showNoAnalysis('input', 'Auto mode is paused for large input.');
        return;
      }
      if (!text.trim()) {
        setIdle('Paste or type data, or load a sample, to validate it.');
        vm.conversionNotices = []; vm.dirty = false;
        state.inFmt = null; state.outFmt = null; updateLabels(); updateSwap(null);
        clearOutputIfSafe(action !== 'auto');
        refreshInspection();
        return;
      }

      inFmt = effectiveInput(text);
      if (!inFmt) {
        if (vm.inputFormat === 'auto' && runMixed(text, action, null, null)) { return; }
        setInvalid({ message: 'The format could not be detected. Choose an input format from the list.', line: 0, column: 0 }, null);
        state.inFmt = null; state.outFmt = null; updateLabels(); updateSwap(null);
        showNoAnalysis('input', 'The format could not be detected.');
        vm.dirty = false;
        return;
      }
      outFmt = vm.outputFormat === 'same' ? inFmt : vm.outputFormat;
      state.inFmt = inFmt; state.outFmt = outFmt;
      updateLabels(); updateSwap(inFmt); applyModes(inFmt, outFmt);

      res = parseCached('input', inFmt, text);
      if (!res.ok) {
        if ((inFmt === 'json' || inFmt === 'java') && runMixed(text, action, res.error, inFmt)) { return; }
        setInvalid(res.error, vm.inputFormat === 'auto' ? null : Convert.mismatchWarning(vm.inputFormat, text));
        markError(res.error);
        vm.dirty = false;
        refreshInspection();
        return;
      }
      analysis = analysisOf(res);
      setValid(inFmt, res, analysis, text);
      vm.dirty = false;

      if (action !== 'validate') {
        if (action === 'auto' && vm.outputEdited) {
          vm.conversionNotices = [{ level: 'info', text: 'The output was not refreshed because you edited it. Click Beautify or Minify to replace it.' }];
        } else {
          mode = action === 'auto' ? vm.lastAction : action;
          out = Convert.run({ parsed: res.parsed, from: inFmt, to: outFmt, mode: mode, indent: vm.settings.indent });
          if (out.ok) {
            ctx.setText('output', out.text);
            notices = out.notices || [];
          } else {
            clearOutputIfSafe(true);
            notices = [{ level: 'error', text: out.error.message }];
          }
          vm.conversionNotices = notices;
        }
      }
      refreshInspection();
    };

    ctx.schedule = function (action, source) {
      function guarded() {
        try { ctx.process(action, source); }
        catch (e) {
          setIdle('');
          vm.validation = { status: 'invalid', label: 'Invalid', message: '', error: { message: 'Unexpected problem: ' + friendly(e), line: 0, column: 0 }, warnings: [] };
          ctx.toast(friendly(e), 'error');
          if (global.console) { global.console.error(e); }
        }
      }
      if (ctx.cm.input.getValue().length > 100000) {
        vm.processing = true;
        $timeout(function () { try { guarded(); } finally { vm.processing = false; } }, 30);
      } else {
        guarded();
      }
    };

    vm.beautify = function () { ctx.schedule('beautify', 'button'); };
    vm.minify = function () { ctx.schedule('minify', 'button'); };
    vm.validate = function () { ctx.schedule('validate', 'button'); };

    vm.onInputFormatChange = function () {
      state.modes.input = undefined;
      if (vm.settings.mode === 'auto') { ctx.schedule('auto', 'format'); }
      else { ctx.schedule('validate', 'format'); }
    };
    vm.onOutputFormatChange = function () {
      clearOutputIfSafe(true);
      state.modes.output = undefined;
      if (vm.settings.mode === 'auto') { ctx.schedule(vm.lastAction, 'format'); }
      else { updateLabels(); vm.dirty = true; }
    };

    vm.setMode = function (m) {
      vm.settings.mode = m;
      Store.set('settings', vm.settings);
      if (m === 'auto') { ctx.schedule('auto', 'mode'); }
    };

    vm.swapFormats = function () {
      var a, b, outText;
      if (!vm.canSwap) { return; }
      a = vm.inputFormat; b = vm.outputFormat;
      outText = ctx.cm.output.getValue();
      vm.inputFormat = b; vm.outputFormat = a;
      if (outText.trim()) {
        ctx.setText('input', outText);
        ctx.setText('output', '');
        ctx.toast('Swapped formats. The output is now the input.', 'success');
      } else {
        ctx.toast('Swapped formats. The input text was not changed, so it may not match the new input format.', 'warning', 4500);
      }
      state.modes.input = undefined; state.modes.output = undefined;
      ctx.schedule(vm.lastAction, 'swap');
    };

    vm.reset = function () {
      vm.inputFormat = 'auto'; vm.outputFormat = 'same';
      vm.settings = angular.extend({}, DEFAULT_SETTINGS);
      Store.set('settings', vm.settings);
      vm.inspectFilter = 'all'; vm.inspectTarget = 'input';
      applyEditorOptions();
      state.modes.input = undefined; state.modes.output = undefined;
      ctx.emit('reset');
      clearOutputIfSafe(true);
      ctx.schedule('beautify', 'reset');
      ctx.toast('Formats and options were reset. Your input was kept.', 'info');
    };

    vm.clearPanel = function (side) {
      if (side === 'input') {
        ctx.setText('input', '');
        ctx.process('validate', 'clear');
      } else {
        ctx.setText('output', '');
        refreshInspection();
      }
      ctx.cm[side].focus();
    };

    vm.clearAll = function () {
      ctx.setText('input', '');
      ctx.setText('output', '');
      vm.conversionNotices = [];
      cache.input = null; cache.output = null; cache.mixed = null;
      ctx.emit('reset');
      ctx.process('validate', 'clear');
      ctx.cm.input.focus();
      ctx.toast('Cleared. Ctrl+Z in the input editor brings the text back.', 'info');
    };

    vm.loadSample = function (s) {
      vm.sampleMenuOpen = false;
      vm.inputFormat = s.format;
      vm.outputFormat = 'same';
      state.modes.input = undefined; state.modes.output = undefined;
      ctx.setText('input', s.text);
      ctx.setText('output', '');
      ctx.schedule('beautify', 'sample');
      ctx.toast('Loaded sample: ' + s.label, 'info');
    };

    /* ---------- theme, settings, menus ---------- */
    vm.toggleTheme = function () {
      vm.theme = vm.theme === 'dark' ? 'light' : 'dark';
      Store.set('theme', vm.theme);
      $timeout(refreshEditors, 0);
    };
    vm.toggleSettings = function (ev) {
      if (ev) { ev.stopPropagation(); }
      vm.showSettings = !vm.showSettings;
      vm.sampleMenuOpen = false;
    };
    vm.toggleSampleMenu = function (ev) {
      if (ev) { ev.stopPropagation(); }
      vm.sampleMenuOpen = !vm.sampleMenuOpen;
      vm.showSettings = false;
    };
    global.document.addEventListener('click', function () {
      if (vm.showSettings || vm.sampleMenuOpen) { ctx.apply(function () { vm.showSettings = false; vm.sampleMenuOpen = false; }); }
    });
    vm.onSettingsChange = function () {
      Store.set('settings', vm.settings);
      applyEditorOptions();
      if (ctx.cm.output.getValue() && !vm.outputEdited && ctx.cm.input.getValue().trim()) {
        if (vm.settings.mode === 'auto') { ctx.schedule(vm.lastAction, 'settings'); } else { vm.dirty = true; }
      }
    };

    /* ---------- finish: let Part 7b add its features ---------- */
    DFI.attachments.forEach(function (attach) { attach(vm, ctx); });
    buildCounters('input', null);
    applyFilter();
    updateLabels();
    DFI.ctx = ctx;     // handy for debugging in the browser console
  }]);

})(window);
/* ===================== END OF PART 7a ===================== */
/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 7b of 7: Output search and replace, inspector jumping, files, clipboard, shortcuts
   BEGINS: the comment block headed "PART 7b of 7" (paste right after "END OF PART 7a").
   ENDS:   the line "END OF PART 7b" - this is the last line of app.js.

   Adds to the controller (through DFI.attachments, called by Part 7a with (vm, ctx)):
     Search:    toggleSearch, onSearchChange, onSearchKeydown, toggleSearchOption, nextMatch, prevMatch,
                clearSearch, toggleReplace, onReplaceKeydown, replaceCurrent, requestReplaceAll,
                confirmReplaceAll, cancelReplaceAll, undo, redo
     Inspector: jumpToItem and line highlighting for the selected null/empty type
     Files:     triggerUpload, handleFiles, pasteFromClipboard, selectAll, copy, download
     Keys:      Ctrl/Cmd+F focus search, Enter / Shift+Enter, Esc, Ctrl/Cmd+Enter = Beautify
   Search highlights only the matches near the visible part of the output, so typing in the search box
   never rebuilds the whole editor.
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI, Util = DFI.Util, Convert = DFI.Convert, Files = DFI.Files, S = DFI.SearchEngine;
  DFI.attachments = DFI.attachments || [];

  DFI.attachments.push(function (vm, ctx) {
    var out = ctx.cm.output, inp = ctx.cm.input;
    var sr = { built: null, res: null, current: -1, marks: [], paintQueued: false };

    /* ================================================================
       Search
       ================================================================ */
    function clearMarks() {
      sr.marks.forEach(function (m) { m.clear(); });
      sr.marks = [];
    }

    function syncStatus() {
      var s = vm.search;
      s.total = sr.res ? sr.res.count : 0;
      s.current = Math.max(sr.current, 0);
      s.status = S.statusText({
        query: s.query, error: s.error, total: s.total, current: s.current,
        truncated: !!(sr.res && sr.res.truncated), timedOut: !!(sr.res && sr.res.timedOut)
      });
    }

    function paintMarks() {
      var vp, fromOff, toOff, r, lo, hi, i;
      clearMarks();
      if (!sr.res || !sr.res.count) { return; }
      vp = out.getViewport();
      fromOff = out.indexFromPos({ line: vp.from, ch: 0 });
      toOff = out.indexFromPos({ line: vp.to, ch: 0 });
      r = S.visibleRange(sr.res.starts, sr.res.ends, fromOff, toOff);
      lo = r[0]; hi = Math.min(r[1], lo + 2000);
      out.operation(function () {
        for (i = lo; i < hi; i++) {
          sr.marks.push(out.markText(out.posFromIndex(sr.res.starts[i]), out.posFromIndex(sr.res.ends[i]),
            { className: i === sr.current ? 'cm-search-current' : 'cm-search-match' }));
        }
      });
    }

    function schedulePaint() {
      if (sr.paintQueued) { return; }
      sr.paintQueued = true;
      global.requestAnimationFrame(function () { sr.paintQueued = false; paintMarks(); });
    }
    out.on('viewportChange', function () { if (sr.res && sr.res.count) { schedulePaint(); } });

    function goTo(i) {
      var from, to;
      if (!sr.res || i < 0 || i >= sr.res.count) { return; }
      sr.current = i;
      from = out.posFromIndex(sr.res.starts[i]);
      to = out.posFromIndex(sr.res.ends[i]);
      out.setSelection(from, to);
      out.scrollIntoView({ from: from, to: to }, 120);
      syncStatus();
      paintMarks();
    }

    // opts.jump: select the current match; opts.after: choose the first match at or after this offset
    function recompute(opts) {
      var q = vm.search.query, res, base;
      opts = opts || {};
      vm.search.confirmAll = false;
      if (!q) {
        sr.built = null; sr.res = null; sr.current = -1;
        vm.search.error = ''; vm.search.total = 0; vm.search.current = 0; vm.search.status = '';
        clearMarks();
        return;
      }
      sr.built = S.build(q, { caseSensitive: vm.search.caseSensitive, wholeWord: vm.search.wholeWord, regex: vm.search.regex });
      res = S.find(out.getValue(), sr.built);
      if (!res.ok) {
        sr.res = null; sr.current = -1;
        vm.search.error = res.error; vm.search.total = 0; vm.search.current = 0; vm.search.status = 'Invalid pattern';
        clearMarks();
        return;
      }
      vm.search.error = '';
      sr.res = res;
      base = opts.after !== undefined && opts.after !== null ? opts.after : out.indexFromPos(out.getCursor('from'));
      sr.current = res.count ? S.indexAtOrAfter(res.starts, base) : -1;
      syncStatus();
      if (opts.jump && sr.current >= 0) { goTo(sr.current); } else { paintMarks(); }
    }

    var recomputeLater = Util.debounce(function () { ctx.apply(function () { recompute(); }); }, 200);
    ctx.on('outputChanged', function () { if (vm.search.query) { recomputeLater(); } });

    function focusSearch(selectText) {
      ctx.$timeout(function () {
        var el = global.document.getElementById('searchInput');
        if (el) { el.focus(); if (selectText) { el.select(); } }
      }, 0);
    }

    function openSearch(prefill) {
      var sel;
      vm.search.open = true;
      if (prefill && out.somethingSelected()) {
        sel = out.getSelection();
        if (sel.length <= 200 && sel.indexOf('\n') < 0) { vm.search.query = sel; recompute({ jump: false }); }
      }
      ctx.revealPanel('output');
      focusSearch(true);
    }
    function closeSearch() {
      vm.search.open = false; vm.search.showReplace = false; vm.search.confirmAll = false;
      vm.search.query = ''; recompute();
    }
    ctx.openSearch = openSearch;

    vm.toggleSearch = function () { if (vm.search.open) { closeSearch(); } else { openSearch(true); } };
    vm.onSearchChange = function () { recompute({ jump: true }); };
    vm.toggleSearchOption = function (name) { vm.search[name] = !vm.search[name]; recompute({ jump: true }); };
    vm.nextMatch = function () { if (sr.res && sr.res.count) { goTo(S.next(sr.current, sr.res.count)); } };
    vm.prevMatch = function () { if (sr.res && sr.res.count) { goTo(S.prev(sr.current, sr.res.count)); } };

    vm.clearSearch = function () {
      if (vm.search.query) { vm.search.query = ''; recompute(); focusSearch(false); }
      else { closeSearch(); }
    };

    vm.onSearchKeydown = function (ev) {
      var el = ev.target;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (el && el.value !== vm.search.query) { vm.search.query = el.value; recompute({ jump: true }); return; }
        if (ev.shiftKey) { vm.prevMatch(); } else { vm.nextMatch(); }
      } else if (ev.key === 'Escape') {
        ev.preventDefault(); ev.stopPropagation();
        vm.clearSearch();
      }
    };

    vm.toggleReplace = function () {
      vm.search.showReplace = !vm.search.showReplace;
      vm.search.confirmAll = false;
      if (vm.search.showReplace) {
        ctx.$timeout(function () { var el = global.document.getElementById('replaceInput'); if (el) { el.focus(); } }, 0);
      }
    };

    vm.onReplaceKeydown = function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (ev.ctrlKey || ev.metaKey || ev.altKey) { vm.requestReplaceAll(); } else { vm.replaceCurrent(); }
      } else if (ev.key === 'Escape') {
        ev.preventDefault(); ev.stopPropagation();
        vm.clearSearch();
      }
    };

    vm.replaceCurrent = function () {
      var i = sr.current, start, end, m, rep;
      if (!sr.res || i < 0) { return; }
      start = sr.res.starts[i]; end = sr.res.ends[i];
      m = S.execAt(out.getValue(), sr.built, start);
      if (!m || m[0].length !== end - start) { recompute({ jump: true }); return; }
      rep = S.expand(m, vm.search.replaceText, vm.search.regex);
      out.replaceRange(rep, out.posFromIndex(start), out.posFromIndex(end), '+dfi-replace');
      recompute({ jump: true, after: start + rep.length });
    };

    vm.requestReplaceAll = function () {
      if (sr.res && sr.res.count) { vm.search.confirmAll = true; }
    };
    vm.cancelReplaceAll = function () { vm.search.confirmAll = false; };
    vm.confirmReplaceAll = function () {
      var r, last;
      vm.search.confirmAll = false;
      if (!sr.built || !sr.res) { return; }
      r = S.replaceAll(out.getValue(), sr.built, vm.search.replaceText, vm.search.regex);
      if (!r.ok || !r.count) { ctx.toast('Nothing was replaced.', 'info'); return; }
      last = { line: out.lastLine(), ch: out.getLine(out.lastLine()).length };
      out.replaceRange(r.text, { line: 0, ch: 0 }, last, '+dfi-replace-all');
      recompute();
      ctx.toast('Replaced ' + r.count.toLocaleString('en-US') + ' matches. Use Undo to revert.', 'success');
    };

    vm.undo = function () { out.undo(); out.focus(); };
    vm.redo = function () { out.redo(); out.focus(); };

    ctx.on('reset', function () {
      vm.search.query = ''; vm.search.open = false; vm.search.showReplace = false; vm.search.confirmAll = false;
      recompute();
    });

    /* ================================================================
       Inspector: highlight matching lines and jump to a value
       ================================================================ */
    var hl = [];
    function clearHighlights() {
      hl.forEach(function (h) { h.cm.removeLineClass(h.handle, 'background', 'cm-search-match'); });
      hl = [];
    }
    function highlightItems(items) {
      var cm = ctx.cm[vm.inspectTarget];
      clearHighlights();
      if (vm.inspectFilter === 'all' || !items.length) { return; }
      cm.operation(function () {
        items.slice(0, 1500).forEach(function (it) {
          if (it.line > 0 && it.line <= cm.lineCount()) { hl.push({ cm: cm, handle: cm.addLineClass(it.line - 1, 'background', 'cm-search-match') }); }
        });
      });
    }
    ctx.on('inspectItemsChanged', highlightItems);
    ctx.on('inspectFilterChanged', function () { highlightItems(vm.visibleItems); });
    ctx.on('reset', clearHighlights);

    function valueEnd(cm, from) {
      var rest = (cm.getLine(from.line) || '').slice(from.ch), m;
      m = /^<[^>]*>/.exec(rest)                                                    // XML start tag
        || /^(?:[A-Za-z_$][\w.$]*)?[\[{(]\s*[\]})]/.exec(rest)                      // [] {} Name{} Name()
        || /^(?:""|'')/.exec(rest)                                                  // empty quoted string
        || /^(?:null|~)(?![\w])/.exec(rest);                                        // null
      return { line: from.line, ch: from.ch + (m ? m[0].length : Math.min(1, Math.max(rest.length, 1))) };
    }

    vm.jumpToItem = function (item) {
      var side = vm.inspectTarget, cm = ctx.cm[side], from, to;
      if (!item || !item.line || item.line > cm.lineCount()) { return; }
      from = { line: item.line - 1, ch: Math.max(item.column - 1, 0) };
      to = valueEnd(cm, from);
      ctx.revealPanel(side);
      cm.focus();
      cm.setCursor(from);
      cm.scrollIntoView({ from: from, to: to }, 160);
      ctx.flash(side, from, to);
    };

    /* ================================================================
       Files, clipboard, panel actions
       ================================================================ */
    vm.triggerUpload = function (side) {
      var el = global.document.getElementById(side === 'input' ? 'fileInputInput' : 'fileInputOutput');
      if (el) { el.click(); }
    };

    vm.handleFiles = function (files, side) {
      var pick = Files.pickFirst(files);
      if (!pick.file) { ctx.toast('No file was received.', 'warning'); return; }
      Files.read(pick.file).then(function (r) {
        ctx.apply(function () {
          var msg;
          if (!r.ok) { ctx.toast(r.message, 'error', 5500); return; }
          if (side === 'input') {
            vm.inputFormat = r.format || 'auto';
            ctx.setText('input', r.text);
            ctx.setText('output', '');
            ctx.schedule(vm.settings.mode === 'auto' ? 'beautify' : 'validate', 'file');
          } else {
            if (r.format) { ctx.setOutputFormat(r.format); }
            ctx.setText('output', r.text, { edited: true });
          }
          msg = 'Loaded ' + r.name + ' into the ' + side + '.';
          if (pick.extra) { msg += ' Only the first file was used (' + pick.extra + ' more ignored).'; }
          if (r.warnings.length) { msg += ' ' + r.warnings.join(' '); }
          ctx.toast(msg, r.warnings.length ? 'warning' : 'success', r.warnings.length || pick.extra ? 6000 : 3200);
        });
      });
    };

    vm.pasteFromClipboard = function () {
      Files.readClipboard().then(function (text) {
        ctx.apply(function () {
          if (!text) { ctx.toast('The clipboard is empty.', 'warning'); return; }
          inp.focus();
          inp.replaceSelection(text, 'end');
        });
      }, function (e) { ctx.toast(e.message, 'warning', 6000); });
    };

    vm.selectAll = function (side) {
      ctx.cm[side].focus();
      ctx.cm[side].execCommand('selectAll');
    };

    vm.copy = function (side) {
      var t = ctx.getText(side);
      if (!t) { ctx.toast('There is nothing to copy.', 'warning'); return; }
      Files.copyText(t).then(
        function () { ctx.toast('Copied the ' + side + ' (' + t.length.toLocaleString('en-US') + ' characters).', 'success'); },
        function (e) { ctx.toast(e.message, 'error', 6000); }
      );
    };

    vm.download = function (side) {
      var t = ctx.getText(side), eff = ctx.effective(), fmt, name;
      if (!t) { ctx.toast('There is nothing to download.', 'warning'); return; }
      fmt = side === 'input' ? (eff.input || (vm.inputFormat !== 'auto' ? vm.inputFormat : null)) : (eff.output || (vm.outputFormat !== 'same' ? vm.outputFormat : null));
      name = Files.fileName(side, fmt || 'text');
      Files.download(name, t, Files.mimeFor(fmt || 'text'));
      ctx.toast('Downloaded ' + name + '.', 'success');
    };

    /* ================================================================
       Keyboard shortcuts
       ================================================================ */
    global.document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey, panel, bar;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        ctx.apply(function () { openSearch(true); });
        return;
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        ctx.apply(function () { vm.beautify(); });
        return;
      }
      if (e.key === 'Escape') {
        if (vm.showSettings || vm.sampleMenuOpen) {
          ctx.apply(function () { vm.showSettings = false; vm.sampleMenuOpen = false; });
          return;
        }
        panel = global.document.getElementById('outputPanel');
        bar = global.document.activeElement;
        if (vm.search.open && panel && bar && panel.contains(bar)) { ctx.apply(function () { vm.clearSearch(); }); }
      }
    });

    out.on('change', function (cm, ch) { if (ch.origin !== 'setValue') { clearHighlights(); } });
    inp.on('change', function (cm, ch) { if (ch.origin !== 'setValue') { clearHighlights(); } });
  });

})(window);
/* ===================== END OF PART 7b ===================== */
