// Read-aloud (TTS) for EPUB and PDF books.
// Engine: window.AndroidCodexa.ttsSpeak (Android WebView has no speechSynthesis) or
// window.speechSynthesis (iOS WKWebView, mobile and desktop browsers).

const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dt,dd,figcaption,pre,td,th';
const ACTIVE_CLASS = 'cx-tts-active';
const MAX_CHUNK = 280;

/**
 * Split text into sentence chunks no longer than max characters.
 * >>> splitSentences('One. Two!  Three?')
 * ['One.', 'Two!', 'Three?']
 */
export function splitSentences(text, max = MAX_CHUNK) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?…。！？]+(?:[.!?…。！？]+["'”’)\]]*|$)/g) || [clean];
  const out = [];
  for (let s of parts) {
    s = s.trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max);
      const at = cut > max / 2 ? cut : max;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

/**
 * Leaf block elements of a document in reading order. A block that contains another
 * block is skipped, so nested text is read once.
 */
export function collectBlocks(doc) {
  if (!doc?.body) return [];
  return [...doc.body.querySelectorAll(BLOCK_SEL)].filter(el =>
    !el.querySelector(BLOCK_SEL) && el.textContent.trim());
}

/** First block at or after node in document order; -1 when none. */
export function blockIndexFrom(blocks, node) {
  if (!node) return blocks.length ? 0 : -1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b === node || b.contains(node) || node.contains(b)) return i;
    if (node.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) return i;
  }
  return -1;
}

/**
 * Index of the splitSentences() chunk that holds character offset in text.
 * >>> sentenceIndexAt('One. Two! Three?', 6)
 * 1
 */
export function sentenceIndexAt(text, offset) {
  const sentences = splitSentences(text);
  const prefix = String(text || '').slice(0, offset).replace(/\s+/g, ' ').replace(/^ /, '');
  let end = 0;
  for (let i = 0; i < sentences.length; i++) {
    end += sentences[i].length + 1;
    if (prefix.length < end) return i;
  }
  return Math.max(0, sentences.length - 1);
}

/** Character offset of DOM point (node, offset) inside el's textContent. */
export function textOffsetIn(el, node, offset) {
  try {
    const r = el.ownerDocument.createRange();
    r.setStart(el, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  } catch { return 0; }
}

/** DOM text point under viewport coordinates, or null. */
export function caretAt(doc, x, y) {
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  return null;
}

/** PDF page text from pdf.js getTextContent() items. */
export function pdfItemsToText(items) {
  return (items || []).map(i => (i.str || '') + (i.hasEOL ? '\n' : ' ')).join('');
}

// ── Engines ──────────────────────────────────────────────────────────────────
// speak(text, {rate, volume, lang}) resolves 'done' | 'stopped' | 'error'; stop() ends speech.

function androidEngine(win, bridge) {
  const pending = new Map();
  let seq = 0;
  win.__codexaTtsEvent = (id, ev) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(ev);
  };
  return {
    name: 'android',
    unlock() {},
    speak(text, { rate = 1, volume = 1, lang = '' } = {}) {
      const id = `u${++seq}`;
      return new Promise(resolve => {
        pending.set(id, resolve);
        try {
          if (typeof bridge.ttsSetVolume === 'function') bridge.ttsSetVolume(volume); // older APKs lack it
          bridge.ttsSpeak(id, text, rate, lang);
        }
        catch { pending.delete(id); resolve('error'); }
      });
    },
    // Headset keys arrive through a media session the app keeps in step with this state.
    session(active, playing) {
      if (typeof bridge.ttsSessionState === 'function') bridge.ttsSessionState(active, playing); // older APKs lack it
    },
    stop() {
      try { bridge.ttsStop(); } catch { /* bridge gone */ }
      for (const resolve of pending.values()) resolve('stopped');
      pending.clear();
    },
  };
}

function webEngine(synth) {
  let current = null;
  return {
    name: 'web',
    // iOS allows speech only after a speak() inside a user gesture.
    unlock() { try { synth.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ } },
    speak(text, { rate = 1, volume = 1, lang = '' } = {}) {
      return new Promise(resolve => {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate;
        u.volume = volume;
        if (lang) u.lang = lang;
        current = { u, resolve };
        u.onend = () => { if (current?.u === u) current = null; resolve('done'); };
        u.onerror = (e) => {
          if (current?.u === u) current = null;
          resolve(e.error === 'interrupted' || e.error === 'canceled' ? 'stopped' : 'error');
        };
        synth.speak(u);
      });
    },
    stop() {
      const c = current;
      current = null;
      // Safari can drop a speak() issued right after an idle cancel().
      if (synth.speaking || synth.pending) synth.cancel();
      c?.resolve('stopped');
    },
  };
}

export function pickEngine(win = window) {
  if (typeof win.AndroidCodexa?.ttsSpeak === 'function') return androidEngine(win, win.AndroidCodexa);
  if (win.speechSynthesis && typeof win.SpeechSynthesisUtterance === 'function') return webEngine(win.speechSynthesis);
  return null;
}

// ── Reader session ───────────────────────────────────────────────────────────

/**
 * Create a read-aloud controller over a CXReader.
 * opts: getRate(), getVolume() 0-1, getLang(), onState({ active, playing }), onError(), onNoText().
 * A session is active from the first play until stop() or the end of the book; pause keeps it.
 * The cursor is the sentence being read: EPUB { el, sentence }, PDF { page, sentence }.
 */
export function createTts(reader, opts = {}) {
  const engine = pickEngine();
  let run = 0;            // bumped on every start/pause/stop; a loop exits when its run is stale
  let active = false;
  let playing = false;
  let cursor = null;
  let selfTurn = false;   // true while this module turns the page
  let activeEl = null;
  const pdfCache = new Map();

  const emit = () => { engine?.session?.(active, playing); opts.onState?.({ active, playing }); };
  const say = (text) => engine.speak(text, {
    rate: opts.getRate?.() ?? 1, volume: opts.getVolume?.() ?? 1, lang: opts.getLang?.() || '',
  });
  const doc = () => reader.iframe?.contentDocument || null;
  const posKey = () => `${reader.spineIdx}:${reader.makePct?.()}`;
  const trace = (msg) => console.warn(`[tts] ${msg}`);

  function mark(el) {
    if (activeEl && activeEl !== el) activeEl.classList.remove(ACTIVE_CLASS);
    activeEl = el;
    if (!el) return;
    const d = el.ownerDocument;
    if (!d.getElementById('cx-tts-style')) {
      const st = d.createElement('style');
      st.id = 'cx-tts-style';
      st.textContent = `.${ACTIVE_CLASS}{background:rgba(255,200,0,.28);border-radius:2px}`;
      d.head?.appendChild(st);
    }
    el.classList.add(ACTIVE_CLASS);
  }

  async function turn(fn) {
    selfTurn = true;
    try { await fn(); } finally { selfTurn = false; }
  }

  function isVisible(el) {
    const f = reader.iframe;
    if (!f) return true;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < f.clientHeight && r.left < f.clientWidth;
  }

  function pageShown(page) {
    const i = reader.spineIdx;
    return page === i || (reader._twoColumn && !reader._continuous && page === i + 1);
  }

  function cursorVisible() {
    if (!cursor) return false;
    if (reader._isPdf) return pageShown(cursor.page);
    return cursor.el.isConnected && cursor.el.ownerDocument === doc() && isVisible(cursor.el);
  }

  async function pdfSentences(page) {
    if (!pdfCache.has(page)) {
      const item = reader.spine[page];
      const pg = await reader._book._pdfDoc.getPage(item.pageNum);
      pdfCache.set(page, splitSentences(pdfItemsToText((await pg.getTextContent()).items)));
    }
    return pdfCache.get(page);
  }

  // Turn pages until el is on screen. Stops when a turn does not move the reader.
  async function showBlock(el, myRun) {
    for (let i = 0; i < 50 && !isVisible(el) && myRun === run; i++) {
      if (el.ownerDocument !== doc()) return;
      const before = posKey();
      await turn(() => reader.next());
      if (posKey() === before) return;
    }
  }

  // Blocks after the last read block: appended chapters (continuous) or the next chapter.
  // Pages with no new block (trailing images) are turned past. null at the end of the book.
  // Continuous mode appends the next chapter asynchronously, so a turn that does not move
  // waits for that append once before it counts as the end of the book.
  async function nextBlocks(myRun, blocks) {
    const last = blocks[blocks.length - 1];
    let waited = false;
    for (let i = 0; i < 200 && myRun === run; i++) {
      const d = doc();
      const fresh = collectBlocks(d);
      const at = last && last.isConnected && last.ownerDocument === d ? fresh.indexOf(last) + 1 : 0;
      if (at < fresh.length) return { blocks: fresh, idx: at };
      const before = posKey();
      await turn(() => reader.next());
      if (posKey() !== before) { waited = false; continue; }
      if (!reader._continuous || waited) return null;
      waited = true;
      await reader._maybeAppendNextChapter?.();
      for (let t = 0; t < 30 && reader._continuousAppending; t++) await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  async function playEpub(myRun, from) {
    let blocks = collectBlocks(doc());
    let idx = from ? blocks.indexOf(from.el) : -1;
    let skip = idx >= 0 ? from.sentence : 0;
    if (idx < 0) idx = blockIndexFrom(blocks, reader._visibleAnchorEl?.());
    while (myRun === run) {
      if (idx < 0 || idx >= blocks.length) {
        const next = await nextBlocks(myRun, blocks);
        if (myRun !== run) return 'superseded';
        if (!next) return 'end of book';
        ({ blocks, idx } = next);
        skip = 0;
      }
      const el = blocks[idx];
      await showBlock(el, myRun);
      if (myRun !== run) return 'superseded';
      mark(el);
      const sentences = splitSentences(el.textContent);
      for (let s = skip; s < sentences.length; s++) {
        cursor = { el, sentence: s };
        const r = await say(sentences[s]);
        if (myRun !== run) return 'superseded';
        if (r !== 'done') return `engine ${r}`;
      }
      skip = 0;
      idx++;
    }
    return 'superseded';
  }

  async function playPdf(myRun, from) {
    let page = from ? from.page : reader.spineIdx;
    let skip = from ? from.sentence : 0;
    let emptyPages = 0;   // scanned PDFs have no text layer
    while (myRun === run && page < reader.spine.length) {
      if (!pageShown(page)) await turn(() => reader.goToSpineItem(page));
      const sentences = await pdfSentences(page);
      if (myRun !== run) return 'superseded';
      emptyPages = sentences.length ? 0 : emptyPages + 1;
      if (emptyPages >= 3) { opts.onNoText?.(); return 'no text'; }
      for (let s = skip; s < sentences.length; s++) {
        cursor = { page, sentence: s };
        const r = await say(sentences[s]);
        if (myRun !== run) return 'superseded';
        if (r !== 'done') return `engine ${r}`;
      }
      skip = 0;
      page++;
    }
    return myRun === run ? 'end of book' : 'superseded';
  }

  // Start reading at from (a cursor) or at the top of the visible page.
  async function start(from = null) {
    if (!engine || reader._isCbz) return;
    engine.stop();
    engine.unlock();
    const myRun = ++run;
    active = true; playing = true; emit();
    let reason;
    try {
      reason = reader._isPdf ? await playPdf(myRun, from) : await playEpub(myRun, from);
    } catch (err) {
      console.error('[tts] playback failed:', err);
      reason = 'exception';
    }
    if (myRun !== run) return;
    trace(`ended: ${reason}`);
    if (reason.startsWith('engine error') || reason === 'exception') opts.onError?.();
    playing = false;
    if (reason === 'end of book' || reason === 'no text') { active = false; cursor = null; mark(null); }
    emit();
  }

  function pause() {
    run++;
    engine?.stop();
    if (playing) { playing = false; emit(); }
  }

  function stop() {
    run++;
    engine?.stop();
    cursor = null;
    mark(null);
    if (active || playing) { active = false; playing = false; emit(); }
  }

  // Cursor delta sentences away, crossing into the neighbouring block or PDF page.
  async function stepCursor(delta) {
    if (!cursor) return null;
    if (reader._isPdf) {
      let { page, sentence } = cursor;
      sentence += delta;
      while (page >= 0 && page < reader.spine.length) {
        const n = (await pdfSentences(page)).length;
        if (sentence >= 0 && sentence < n) return { page, sentence };
        if (sentence < 0) { page--; if (page >= 0) sentence = (await pdfSentences(page)).length - 1; }
        else { page++; sentence = 0; }
      }
      return cursor;
    }
    const { el } = cursor;
    const n = splitSentences(el.textContent).length;
    const sentence = cursor.sentence + delta;
    if (sentence >= 0 && sentence < n) return { el, sentence };
    const blocks = collectBlocks(el.ownerDocument);
    const nb = blocks[blocks.indexOf(el) + (delta < 0 ? -1 : 1)];
    if (!nb) return delta < 0 ? { el, sentence: 0 } : null;
    return { el: nb, sentence: delta < 0 ? splitSentences(nb.textContent).length - 1 : 0 };
  }

  async function turnPage(dir) {
    pause();
    await turn(() => (dir < 0 ? reader.prev() : reader.next()));
    cursor = null;
    start();
  }

  const api = {
    get available() { return !!engine; },
    get active() { return active; },
    get playing() { return playing; },
    stop,
    toggle() { playing ? pause() : start(cursor); },
    prevSentence: async () => { const c = await stepCursor(-1); start(c || cursor); },
    // At the last sentence of a block, the next block may sit in the next chapter.
    nextSentence: async () => { const c = await stepCursor(1); if (c) start(c); else { cursor = null; start(); } },
    prevPage: () => turnPage(-1),
    nextPage: () => turnPage(1),
    // Settings changed mid-sentence: re-read the current sentence with them.
    refresh() { if (playing) start(cursor); },
    // Read from the sentence at a DOM point in the current EPUB document.
    playFrom(node, offset) {
      if (!engine || reader._isPdf || reader._isCbz || !node) return;
      const blocks = collectBlocks(doc());
      const el = blocks[blockIndexFrom(blocks, node)];
      if (!el) return;
      start({ el, sentence: sentenceIndexAt(el.textContent, textOffsetIn(el, node, offset)) });
    },
    // Read from the sentence under a tap; false when no text is there.
    playFromPoint(d, x, y) {
      const pt = caretAt(d, x, y);
      const el = pt?.node?.nodeType === 3 ? pt.node.parentElement : pt?.node;
      if (!el?.closest?.(BLOCK_SEL)) return false;
      this.playFrom(pt.node, pt.offset);
      return true;
    },
    // Relocation that moved the read sentence off screen came from the user (page turn, TOC
    // jump): reading continues from the new visible page. Reflow and scroll noise that leaves
    // the sentence on screen is ignored.
    onRelocated() {
      if (!active || selfTurn || cursorVisible()) return;
      trace('user relocation: restart from visible page');
      cursor = null;
      mark(null);
      if (playing) start();
    },
  };

  // Headset and Bluetooth keys, delivered by the Android media session.
  window.__codexaTtsMedia = (action) => {
    if (action === 'play' && !playing) start(cursor);
    else if (action === 'pause' && playing) pause();
    else if (action === 'stop') stop();
    else if (action === 'next') api.nextSentence();
    else if (action === 'prev') api.prevSentence();
  };
  return api;
}
