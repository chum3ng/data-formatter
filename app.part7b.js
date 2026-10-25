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
