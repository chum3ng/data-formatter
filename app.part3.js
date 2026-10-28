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

   Fragments: several top-level elements with no single root, for example <A>1</A><B>2</B>, are accepted as an
   "XML fragment" (parsed.fragment === true). They are formatted, minified and analyzed element by element, and
   convert to JSON as the keys of one object. Text outside elements is still an error.
   Prefix mode: parse(text, {from, prefix:true}) reads one element starting at an offset and reports {end}
   (used to find XML inside logs).

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
  function scan(text, opts) {
    var fragment = !!(opts && opts.fragment), prefix = !!(opts && opts.prefix);
    var n = text.length, i = (opts && opts.from) || 0, stack = [], doc = { kids: [] }, root = null, afterRoot = false;
    var hasDoctype = false, customEntities = false, maxDepth = 0, parserErrorName = false;
    var bad, parent, c, next, j, k, e, e2, q, ve, lt, name, an, attrs, seen, sc, el, top, end, cd, body, depth, quote, internal;

    function fail(msg, off, rel, code) {
      throw { __xmlError: true, message: msg, offset: off, related: rel === undefined ? -1 : rel, code: code || '' };
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

    if (!prefix) {
      bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.exec(text);
      if (bad) { fail('Invalid character U+' + ('0000' + text.charCodeAt(bad.index).toString(16).toUpperCase()).slice(-4) + ' is not allowed in XML', bad.index); }
    }
    if (i === 0 && text.charCodeAt(0) === 0xFEFF) { i = 1; }

    if (!prefix && text.substr(i, 5) === '<?xml' && isWsc(text.charCodeAt(i + 5))) {
      end = text.indexOf('?>', i);
      if (end === -1) { fail('Unterminated XML declaration', i); }
      doc.kids.push({ t: 'decl', s: i, e: end + 2 });
      i = end + 2;
    }

    while (i < n) {
      if (prefix && afterRoot) { break; }
      parent = stack.length ? stack[stack.length - 1] : doc;
      c = text.charCodeAt(i);
      if (c !== 60) {
        j = text.indexOf('<', i);
        if (j === -1) { j = n; }
        if (parent === doc) {
          for (k = i; k < j; k++) { if (!isWsc(text.charCodeAt(k))) { fail('Text is not allowed outside the root element', k, undefined, 'outside'); } }
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
        if ((afterRoot || root) && !fragment) { fail('Only one root element is allowed; a second element starts here', i, undefined, 'multiroot'); }
        if (!root) { root = el; }
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
    if (fragment) {
      var tops = doc.kids.filter(function (kd) { return kd.t === 'e'; });
      if (tops.length > 1) {      // an implicit wrapper lets analysis and conversion treat the fragment as one tree
        root = { t: 'e', n: '', implicit: true, s: tops[0].s, e: tops[tops.length - 1].e, attrs: [], sc: false, kids: tops, os: tops[0].s, cs: tops[tops.length - 1].e };
      }
    }
    return { root: root, doc: doc, hasDoctype: hasDoctype, customEntities: customEntities, maxDepth: maxDepth, parserErrorName: parserErrorName, fragment: !!root.implicit };
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

  Xml.parse = function (text, opts) {
    var res, li, p, r, msg, dom, prefix = !!(opts && opts.prefix);
    try {
      res = scan(text, opts);
    } catch (e) {
      if (e && e.__xmlError) {
        if (prefix) { return { ok: false, error: { message: e.message, line: 0, column: 0, offset: e.offset, code: e.code } }; }
        li = Util.lineIndex(text);
        p = li.at(Math.min(e.offset, text.length));
        msg = e.message;
        if (e.related >= 0) {
          r = li.at(e.related);
          msg += ' (the opening tag is at line ' + r.line + ', column ' + r.column + ')';
        }
        return { ok: false, error: { message: msg, line: p.line, column: p.column, offset: p.offset, code: e.code } };
      }
      throw e;
    }
    dom = (prefix || res.fragment) ? null : domCheck(text, res);
    if (dom) { return { ok: false, error: dom }; }
    return {
      ok: true, text: text, root: res.root, doc: res.doc, hasDoctype: res.hasDoctype, customEntities: res.customEntities,
      depth: res.maxDepth, fragment: res.fragment, end: res.root.e
    };
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

    var rootNs = Object.create(null), r;
    if (parsed.root.implicit) {
      stack.push(makeFrame(parsed.root, '', { ns: rootNs }));
      a.notes.push('This XML has no single root element, so it is treated as a fragment of several top-level elements. A complete XML document needs exactly one root element.');
    } else {
      r = visit(parsed.root, '/' + parsed.root.n, rootNs);
      if (r.hasElem) { stack.push(makeFrame(parsed.root, '/' + parsed.root.n, r)); }
    }
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
      if (parsed.root.implicit) {
        wrap = rootVal;
        note('fragment', 'info', 'The XML has several top-level elements and no root, so they became the keys of one JSON object.');
      } else {
        wrap = Object.create(null);
        wrap[parsed.root.n] = rootVal;
      }
      note('strings', 'info', 'XML has no data types, so every value is a string.');
      return { ok: true, value: wrap, notices: notices };
    } catch (e) {
      if (e && e.msg) { return { ok: false, error: { message: e.msg, line: 0, column: 0, offset: -1 } }; }
      throw e;
    }
  };

})(window);
/* ===================== END OF PART 3 ===================== */
