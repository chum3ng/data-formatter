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
