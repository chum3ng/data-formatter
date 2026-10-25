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
    var cache = { input: null, output: null };
    var silent = { input: false, output: false };
    var state = { inFmt: null, outFmt: null, outGen: 0, errHandle: null, toastTimer: null, allItems: [], noAnalysis: '', modes: { input: undefined, output: undefined } };

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
        c = cache.input;
        if (!c || c.text !== text) { showNoAnalysis(side, 'Click Validate or Beautify to analyze the input.'); return; }
        res = c.res; fmt = c.fmt;
        if (!res.ok) { showNoAnalysis(side, 'The input has a syntax error, so it cannot be inspected yet. See Validation.'); return; }
      } else {
        fmt = state.outFmt || state.inFmt || (vm.outputFormat === 'same' ? null : vm.outputFormat);
        if (!fmt) { showNoAnalysis(side, 'The output format is not known yet.'); return; }
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
      vm.inputFormatLabel = vm.inputFormat === 'auto' ? (state.inFmt ? 'Auto: ' + Convert.label(state.inFmt) : 'Auto-detect') : Convert.label(vm.inputFormat);
      vm.outputFormatLabel = vm.outputFormat === 'same'
        ? (state.outFmt ? Convert.label(state.outFmt) + ' (same as input)' : 'Same as input')
        : Convert.label(vm.outputFormat);
    }

    /* ---------- processing pipeline ---------- */
    function clearOutputIfSafe(force) {
      if (ctx.cm.output.getValue() && (force || !vm.outputEdited)) { ctx.setText('output', ''); }
    }

    ctx.process = function (action, source) {
      var text = ctx.cm.input.getValue(), inFmt, outFmt, res, analysis, mode, out, notices = [];
      if (action === 'beautify' || action === 'minify') { vm.lastAction = action; }
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
      cache.input = null; cache.output = null;
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
