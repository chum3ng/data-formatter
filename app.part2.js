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
