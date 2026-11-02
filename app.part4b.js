/* ======================================================================
   Data Formatter & Inspector - app.js
   PART 4b of 7: SQL engine (uses sql-formatter 15.9.0 from the CDN)
   BEGINS: the comment block headed "PART 4b of 7" (paste right after "END OF PART 4").
   ENDS:   the line "END OF PART 4b".

   Registers DFI.Sql:
     DIALECTS, CASES, mimeFor(dialect), available()
     parse(text, {dialect})              -> {ok, text, tokens, dialect} | {ok:false, error:{message,line,column,offset}}
     beautify(parsed, {dialect, indent, keywordCase}) -> {ok, text, notices} | {ok:false, error}
     minify(parsed)                      -> {ok, text, notices}
     analyze(parsed)                     -> analysis (same shape as the other engines, plus notes[])

   What "valid" means for SQL: the tool checks the text itself (unterminated strings, quoted names and
   comments; unbalanced parentheses). It does NOT check the SQL grammar, table names or types, because that
   needs your database. The formatter also rejects text it cannot read, and then reports where.

   Safety net: after formatting, the result is read again and every token (words, strings, numbers,
   operators, comments) is compared with the input. If anything other than whitespace and keyword case
   differs, the result is discarded and an error is shown instead of a changed query.

   SQL counting rules:
   - statements = non-empty statements separated by ; (approximate for procedures with BEGIN ... END)
   - comments   = line comments (--), block comments, and for MySQL # comments
   - nulls      = the NULL keyword used as a value. IS NULL, IS NOT NULL and NOT NULL are tests or constraints
                  and are not counted.
   - emptyStrings = '' literals. Everything else (fields, objects, arrays ...) is N/A for SQL.
   Warnings: "= NULL" in WHERE/ON/HAVING/WHEN is never true; UPDATE or DELETE with no WHERE changes every row.
   ====================================================================== */
(function (global) {
  'use strict';

  var DFI = global.DFI, Util = DFI.Util, Sql = DFI.Sql = {};

  Sql.DIALECTS = [
    { id: 'sql', label: 'Standard SQL' }, { id: 'postgresql', label: 'PostgreSQL' }, { id: 'mysql', label: 'MySQL' },
    { id: 'mariadb', label: 'MariaDB' }, { id: 'sqlite', label: 'SQLite' }, { id: 'transactsql', label: 'SQL Server (T-SQL)' },
    { id: 'plsql', label: 'Oracle (PL/SQL)' }, { id: 'db2', label: 'IBM Db2' }, { id: 'bigquery', label: 'BigQuery' },
    { id: 'snowflake', label: 'Snowflake' }, { id: 'redshift', label: 'Amazon Redshift' }, { id: 'spark', label: 'Spark SQL' },
    { id: 'trino', label: 'Trino' }
  ];
  Sql.CASES = [{ id: 'upper', label: 'UPPERCASE' }, { id: 'lower', label: 'lowercase' }, { id: 'preserve', label: 'As written' }];

  Sql.mimeFor = function (dialect) {
    return { postgresql: 'text/x-pgsql', redshift: 'text/x-pgsql', mysql: 'text/x-mysql', mariadb: 'text/x-mariadb',
      sqlite: 'text/x-sqlite', transactsql: 'text/x-mssql', plsql: 'text/x-plsql', db2: 'text/x-sql' }[dialect] || 'text/x-sql';
  };

  Sql.available = function () { return !!(global.sqlFormatter && global.sqlFormatter.format); };

  /* ------------------------------------------------------------------
     Tokenizer (character level). Token types:
       c comment  s string  q quoted name  w word  n number  o operator  p punctuation ( ) , ; .
     ------------------------------------------------------------------ */
  function isSpace(c) { return c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0xFEFF; }
  function isDigit(c) { return c >= 48 && c <= 57; }
  function isWordStart(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80; }
  function isWordChar(c) { return isWordStart(c) || isDigit(c) || c === 36; }
  var OPCHARS = '+-*/%<>=!~^&|#@?:\\';
  var DOLLAR = /\$([A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$/y;
  var NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

  function tokenize(text, dialect) {
    var n = text.length, i = 0, toks = [], parens = [], c, j, q, esc, m, tag, start, depth, prev, end;
    var mysql = dialect === 'mysql' || dialect === 'mariadb';
    var bsDefault = mysql || dialect === 'bigquery' || dialect === 'snowflake' || dialect === 'spark' || dialect === 'hive';
    var nestedComments = dialect === 'postgresql' || dialect === 'redshift';

    function fail(msg, off) { throw { __sqlError: true, message: msg, offset: off }; }
    function push(t, s, e) { var tk = { t: t, s: s, e: e }; toks.push(tk); return tk; }

    function scanQuoted(open, closeCh, allowBackslash, what) {
      var k = open + 1, ch;
      while (true) {
        if (k >= n) { fail('Unterminated ' + what + ' (the closing ' + String.fromCharCode(closeCh) + ' is missing)', open); }
        ch = text.charCodeAt(k);
        if (allowBackslash && ch === 92) { k += 2; continue; }
        if (ch === closeCh) {
          if (text.charCodeAt(k + 1) === closeCh) { k += 2; continue; }    // doubled quote is an escaped quote
          return k + 1;
        }
        k++;
      }
    }

    while (i < n) {
      c = text.charCodeAt(i);
      if (isSpace(c)) { i++; continue; }

      if (c === 45 && text.charCodeAt(i + 1) === 45) {                                  // -- comment
        j = text.indexOf('\n', i); if (j < 0) { j = n; }
        push('c', i, j).k = 'line'; i = j; continue;
      }
      if (c === 35 && mysql) {                                                           // # comment (MySQL)
        j = text.indexOf('\n', i); if (j < 0) { j = n; }
        push('c', i, j).k = 'line'; i = j; continue;
      }
      if (c === 47 && text.charCodeAt(i + 1) === 42) {                                  // /* comment */
        depth = 1; j = i + 2;
        while (j < n && depth > 0) {
          if (nestedComments && text.charCodeAt(j) === 47 && text.charCodeAt(j + 1) === 42) { depth++; j += 2; }
          else if (text.charCodeAt(j) === 42 && text.charCodeAt(j + 1) === 47) { depth--; j += 2; }
          else { j++; }
        }
        if (depth > 0) { fail('Unterminated /* comment (the closing */ is missing)', i); }
        push('c', i, j).k = 'block'; i = j; continue;
      }
      if (c === 39) {                                                                    // 'string'
        prev = toks[toks.length - 1];
        esc = bsDefault || !!(prev && prev.t === 'w' && prev.e === i && (text.charCodeAt(prev.s) | 32) === 101 && prev.e - prev.s === 1);   // E'...'
        end = scanQuoted(i, 39, esc, 'string');
        push('s', i, end); i = end; continue;
      }
      if (c === 34) {                                                                    // "quoted name"
        end = scanQuoted(i, 34, mysql || dialect === 'bigquery', 'quoted name');
        push('q', i, end); i = end; continue;
      }
      if (c === 96) {                                                                    // `quoted name`
        end = scanQuoted(i, 96, false, 'quoted name');
        push('q', i, end); i = end; continue;
      }
      if (c === 91 && dialect === 'transactsql') {                                      // [quoted name]
        end = scanQuoted(i, 93, false, 'bracketed name');
        // scanQuoted starts after the opener and looks for the closer; the opener itself is not doubled
        push('q', i, end); i = end; continue;
      }
      if (c === 36) {                                                                    // $$dollar quoted$$ or $1
        DOLLAR.lastIndex = i;
        m = DOLLAR.exec(text);
        if (m && m.index === i) {
          tag = m[0];
          j = text.indexOf(tag, i + tag.length);
          if (j < 0) { fail('Unterminated dollar-quoted string (the closing ' + tag + ' is missing)', i); }
          push('s', i, j + tag.length).k = 'dollar'; i = j + tag.length; continue;
        }
        j = i + 1;
        while (j < n && isDigit(text.charCodeAt(j))) { j++; }
        if (j > i + 1) { push('w', i, j); i = j; continue; }
        push('o', i, i + 1); i++; continue;
      }
      if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {                // number
        NUMBER.lastIndex = i; m = NUMBER.exec(text); j = i + m[0].length;
        while (j < n && isWordChar(text.charCodeAt(j))) { j++; }                          // 0xFF, 10px ...
        push('n', i, j); i = j; continue;
      }
      if (isWordStart(c)) {
        j = i + 1;
        while (j < n && isWordChar(text.charCodeAt(j))) { j++; }
        push('w', i, j); i = j; continue;
      }
      if (c === 40) { start = push('p', i, i + 1); parens.push(start); i++; continue; }
      if (c === 41) {
        if (!parens.length) { fail('Unmatched closing parenthesis ")" (there is no "(" for it)', i); }
        parens.pop(); push('p', i, i + 1); i++; continue;
      }
      if (c === 44 || c === 59 || c === 46) { push('p', i, i + 1); i++; continue; }
      if (OPCHARS.indexOf(text.charAt(i)) >= 0) {
        j = i + 1;
        while (j < n && OPCHARS.indexOf(text.charAt(j)) >= 0 &&
               !(text.charCodeAt(j) === 45 && text.charCodeAt(j + 1) === 45) &&
               !(text.charCodeAt(j) === 47 && text.charCodeAt(j + 1) === 42)) { j++; }
        push('o', i, j); i = j; continue;
      }
      push('o', i, i + 1); i++;                                                          // any other character
    }
    if (parens.length) { fail('Unclosed parenthesis "(" (its ")" is missing)', parens[0].s); }
    return toks;
  }

  Sql.parse = function (text, opts) {
    var dialect = (opts && opts.dialect) || 'sql', toks, p;
    try {
      toks = tokenize(text, dialect);
    } catch (e) {
      if (e && e.__sqlError) {
        p = Util.lineIndex(text).at(Math.min(e.offset, text.length));
        return { ok: false, error: { message: e.message, line: p.line, column: p.column, offset: p.offset } };
      }
      throw e;
    }
    return { ok: true, text: text, tokens: toks, dialect: dialect };
  };

  /* ------------------------------------------------------------------
     Comparing token streams (the safety net)
     ------------------------------------------------------------------ */
  function norm(text, tk) {
    var v = text.slice(tk.s, tk.e);
    if (tk.t === 'w') { return v.toLowerCase(); }
    if (tk.t === 'c') { return tk.k === 'line' ? v.replace(/\s+$/, '') : v.replace(/\s+/g, ' '); }
    return v;
  }

  // Returns -1 when the streams match, else the index of the first token that differs.
  function firstDifference(textA, toksA, textB, toksB) {
    var i, len = Math.max(toksA.length, toksB.length);
    for (i = 0; i < len; i++) {
      if (!toksA[i] || !toksB[i] || toksA[i].t !== toksB[i].t || norm(textA, toksA[i]) !== norm(textB, toksB[i])) { return i; }
    }
    return -1;
  }

  /* ------------------------------------------------------------------
     beautify (sql-formatter) and minify
     ------------------------------------------------------------------ */
  function formatterError(e, text, dialect) {
    var raw = String((e && e.message) || 'The SQL could not be formatted.').split('\n')[0], m = /line (\d+) column (\d+)/.exec(raw);
    return {
      message: raw.replace(/^Parse error:\s*/, 'The formatter could not read this SQL: ') + ' Try another SQL dialect in Settings.',
      line: m ? +m[1] : 0, column: m ? +m[2] : 0, offset: -1, dialect: dialect
    };
  }

  Sql.beautify = function (parsed, o) {
    var dialect = (o && o.dialect) || parsed.dialect || 'sql', indent = (o && o.indent) || '2', out, re, d, tk;
    if (!Sql.available()) {
      return { ok: false, error: { message: 'The SQL library (sql-formatter) did not load. Check your connection or CDN access, then reload the page.', line: 0, column: 0, offset: -1 } };
    }
    if (!parsed.tokens.length) { return { ok: true, text: parsed.text, notices: [] }; }
    try {
      out = global.sqlFormatter.format(parsed.text, {
        language: dialect, tabWidth: indent === '4' ? 4 : 2, useTabs: indent === 'tab',
        keywordCase: (o && o.keywordCase) || 'upper', indentStyle: 'standard', logicalOperatorNewline: 'before',
        expressionWidth: 50, linesBetweenQueries: 1, denseOperators: false, newlineBeforeSemicolon: false
      });
    } catch (e) {
      return { ok: false, error: formatterError(e, parsed.text, dialect) };
    }
    re = Sql.parse(out, { dialect: dialect });
    if (!re.ok) {
      return { ok: false, error: { message: 'The formatter produced SQL that does not read back correctly (' + re.error.message + '), so the result was discarded. Try another SQL dialect in Settings.', line: 0, column: 0, offset: -1 } };
    }
    d = firstDifference(parsed.text, parsed.tokens, out, re.tokens);
    if (d >= 0) {
      tk = parsed.tokens[d];
      return { ok: false, error: {
        message: 'The formatter changed the content of the SQL' + (tk ? ' near "' + Util.truncate(parsed.text.slice(tk.s, tk.e), 30) + '"' : '') + ', so the result was discarded instead of showing a changed query. Try another SQL dialect in Settings.',
        line: 0, column: 0, offset: tk ? tk.s : -1
      } };
    }
    return { ok: true, text: out.replace(/\s+$/, '') + '\n', notices: [] };
  };

  Sql.minify = function (parsed) {
    var text = parsed.text, out = [], prev = null, removed = 0, keep, tk, v, i, space, re, d;
    for (i = 0; i < parsed.tokens.length; i++) {
      tk = parsed.tokens[i];
      v = text.slice(tk.s, tk.e);
      if (tk.t === 'c') {
        keep = tk.k === 'block' && (v.charAt(2) === '+' || v.charAt(2) === '!');     // optimizer hints and MySQL conditional comments
        if (!keep) { removed++; continue; }
      }
      // Tokens that touched each other in the input stay touching (E'..', U&'..', a::int, :name). Otherwise one space.
      space = prev !== null && prev.e !== tk.s && !(prev.v === '(' || prev.v === '.' || v === ')' || v === ',' || v === ';' || v === '.');
      if (space) { out.push(' '); }
      out.push(v);
      prev = { v: v, e: tk.e };
    }
    re = Sql.parse(out.join(''), { dialect: parsed.dialect });
    if (!re.ok) { return { ok: false, error: { message: 'The minified SQL did not read back correctly, so it was not produced.', line: 0, column: 0, offset: -1 } }; }
    d = firstDifference(text, parsed.tokens.filter(function (t) {
      return t.t !== 'c' || (t.k === 'block' && (text.charAt(t.s + 2) === '+' || text.charAt(t.s + 2) === '!'));
    }), re.text, re.tokens);
    if (d >= 0) { return { ok: false, error: { message: 'Minifying would change the SQL, so it was not produced.', line: 0, column: 0, offset: -1 } }; }
    return {
      ok: true, text: re.text,
      notices: removed ? [{ level: 'info', text: removed + ' comment' + (removed === 1 ? ' was' : 's were') + ' removed. Optimizer hints (/*+ ... */) and MySQL /*! ... */ comments were kept.' }] : []
    };
  };

  /* ------------------------------------------------------------------
     analyze
     ------------------------------------------------------------------ */
  var CLAUSES = { SELECT: 1, FROM: 1, WHERE: 1, JOIN: 1, ON: 1, GROUP: 1, ORDER: 1, HAVING: 1, SET: 1, VALUES: 1, INSERT: 1,
    UPDATE: 1, DELETE: 1, USING: 1, RETURNING: 1, LIMIT: 1, UNION: 1, WITH: 1, WHEN: 1, THEN: 1, ELSE: 1 };
  var COMPARE_CLAUSES = { WHERE: 1, ON: 1, HAVING: 1, WHEN: 1 };

  Sql.analyze = function (parsed) {
    var a = Util.newAnalysis(), c = a.counts, text = parsed.text, toks = parsed.tokens, li = null;
    var stmt = 0, inStmt = false, first = '', hasWhere = false, clause = '', depth = 0, prev = null, prevU = '';
    var nullCompare = 0, tk, u, v, i, nextTk, lineStart, lineEnd, s0, e0, ps, nulls = 0;
    var noteList = [], unsafe = [];
    c.statements = 0; c.comments = 0; c.nulls = 0; c.emptyStrings = 0;
    a.notes = [];

    function pos(off) { li = li || Util.lineIndex(text); return li.at(off); }
    function where() { return 'statement ' + stmt + (clause ? ' \u00B7 ' + clause : ''); }
    function preview(t) {
      lineStart = text.lastIndexOf('\n', t.s - 1) + 1;
      lineEnd = text.indexOf('\n', t.e); if (lineEnd < 0) { lineEnd = text.length; }
      s0 = Math.max(lineStart, t.s - 18); e0 = Math.min(lineEnd, t.e + 18);
      return text.slice(s0, e0).trim();
    }
    function endStmt() {
      if (inStmt && (first === 'UPDATE' || first === 'DELETE') && !hasWhere) { unsafe.push('Statement ' + stmt + ' (' + first + ') has no WHERE clause, so it changes every row.'); }
      inStmt = false; first = ''; hasWhere = false; clause = ''; depth = 0;
    }

    for (i = 0; i < toks.length; i++) {
      tk = toks[i];
      if (tk.t === 'c') { c.comments++; continue; }
      v = text.slice(tk.s, tk.e);
      if (tk.t === 'p' && v === ';' && depth === 0) { endStmt(); prev = tk; prevU = ''; continue; }
      if (!inStmt) {
        inStmt = true; stmt++;
        first = tk.t === 'w' ? v.toUpperCase() : '';
      }
      if (tk.t === 'p') { if (v === '(') { depth++; } else if (v === ')') { depth--; } }
      u = tk.t === 'w' ? v.toUpperCase() : '';
      if (u && CLAUSES[u]) { clause = u; if (u === 'WHERE' && depth === 0) { hasWhere = true; } }
      if (u === 'NULL') {
        if (prev && prev.t === 'o' && /^(?:=|<>|!=)$/.test(text.slice(prev.s, prev.e)) && COMPARE_CLAUSES[clause]) {
          nullCompare++;
          if (noteList.length < 10) { ps = pos(tk.s); noteList.push('Line ' + ps.line + ': "' + text.slice(prev.s, prev.e) + ' NULL" is never true in SQL. Use IS NULL or IS NOT NULL.'); }
        }
        if (!(prev && prev.t === 'w' && (prevU === 'IS' || prevU === 'NOT'))) {
          c.nulls++;
          Util.pushItem(a, 'null', where(), pos(tk.s), preview(tk));
        }
      } else if (tk.t === 's' && tk.e - tk.s === 2 && text.charAt(tk.s) === "'") {
        c.emptyStrings++;
        Util.pushItem(a, 'emptyString', where(), pos(tk.s), preview(tk));
      }
      prev = tk; prevU = u;
    }
    endStmt();
    c.statements = stmt;
    a.notes = noteList.concat(unsafe.slice(0, 10));
    if (nullCompare > noteList.length) { a.notes.push('And ' + (nullCompare - noteList.length) + ' more comparisons with NULL.'); }
    if (unsafe.length > 10) { a.notes.push('And ' + (unsafe.length - 10) + ' more statements without WHERE.'); }
    if (/\bcreate\s+(?:or\s+replace\s+)?(?:definer\s*=\s*\S+\s+)?(?:function|procedure|trigger)\b/i.test(text) || /^\s*(?:begin|declare)\b/im.test(text)) {
      a.notes.push('This looks like procedural SQL (BEGIN ... END, functions or triggers), so the statement count is approximate.');
    }
    return a;
  };

})(window);
/* ===================== END OF PART 4b ===================== */
