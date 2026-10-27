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
