---
title: Read-aloud (TTS) for EPUB and PDF
---

Codexa can now read a book aloud, on Android and on iOS, using whichever speech engine that platform offers. This Blueprint reconstructs the uncommitted working-tree change that adds it (`git -C codexa diff`, plus the untracked `public/js/tts.js`); every `code` reference below resolves against that working tree, not a commit.

Six modules build the feature in order. [Pure text/parsing helpers](#1-pure-textparsing-helpers) turn raw content into speakable chunks and locate a tapped or selected point inside it. The [Android native TTS bridge](#2-android-native-tts-bridge) reaches Android's own `TextToSpeech` from inside the WebView, since Android WebView has no `speechSynthesis`. [Speech engine adapters](#3-speech-engine-adapters) give both platforms the same `speak()`/`stop()` shape. The [reader TTS controller](#4-reader-tts-controller) owns play/stop state, walks an EPUB or a PDF one readable piece at a time, and can jump reading to a chosen point. [Reader UI integration](#5-reader-ui-integration) puts a button, a speed slider, a selection action, and a tap-to-jump gesture on the reading screen, and stops speech at every point a rendition already ends. [Offline delivery](#6-offline-delivery) makes sure an installed PWA actually gets the new file.

```items
---
items_schema: tts.kg/kg.schema
---
```

## The one invariant

TTS never turns a page the reader did not ask for, except to keep the block it is speaking on screen. A page turn the reader makes themselves restarts reading from the newly visible page. Node **4.2** (`onRelocated`) is where this is enforced; its `code` reference points at the exact guard.

## The start-here invariant

A user-chosen start point wins over the visible-page anchor. Selecting text and tapping "Read aloud from here", or tapping text while reading, jumps to that exact sentence instead of the first block the reader happens to be looking at. That same tap never overrides the left/right page-turn zones: the touch handler checks those zones first, and only reaches the read-aloud jump when the tap fell outside them. Node **4.5** (`playFrom`) and node **5.9** (the touch handler) are where this is enforced.

## 1 Pure text/parsing helpers

`splitSentences`, `collectBlocks`, `blockIndexFrom`, and `pdfItemsToText` are plain functions with no engine or reader dependency, each with a small doctest-style example in its own docstring. `sentenceIndexAt`, `textOffsetIn`, and `caretAt` are the same kind of pure helper, added to locate the sentence under a selection or a tap.

## 2 Android native TTS bridge

Android WebView cannot call `window.speechSynthesis`. `MainActivity.kt` adds a `JsBridge.ttsSpeak`/`ttsStop` pair, a lazily created `TextToSpeech` with one pending utterance, and an `UtteranceProgressListener` that reports every outcome back into the page as a `window.__codexaTtsEvent` call. `AndroidManifest.xml` declares the `TTS_SERVICE` package-visibility query the platform needs on API 30+.

## 3 Speech engine adapters

`androidEngine` and `webEngine` both expose `speak(text, {rate, lang}) -> Promise<'done'|'stopped'|'error'>` and `stop()`. `pickEngine` chooses one, once, when the controller is created, so the controller itself never branches on which platform it is running on.

## 4 Reader TTS controller

`createTts(reader, opts)` owns `play`/`stop`/`toggle`/`onRelocated`/`playFrom`/`playFromPoint`. `playEpub` walks the EPUB's blocks from the reader's visible position, or from a given start point, turning pages only to keep the current block in view. `playPdf` walks the PDF's pages, stopping after three empty pages in a row (a scanned PDF has no text layer). `playFrom` jumps an EPUB rendition to the sentence at a DOM point; `playFromPoint` resolves a tap's viewport coordinates to that point first.

## 5 Reader UI integration

A header button (`btn-tts`), a settings toggle, a read-aloud speed slider, an annotation-toolbar action ("Read aloud from here"), and a tap-to-jump gesture while reading give the reader a way to reach the controller. It stops before a rendition closes, before a fired sleep timer dims the screen, and when the reader returns to the library.

## 6 Offline delivery

`public/js/tts.js` is added to the service worker's precached app shell, and `CACHE_VERSION` is bumped so an already-installed PWA actually fetches it.

## How to read this

- **Build order** (default view): every leaf's number is the order it must exist in; every arrow points from a lower number to a higher one.
- **Safeguards**: the same graph, read for the one invariant and what backs it.
- **`play_flow`**: an execution view. One tap on the button walks through engine selection, the EPUB block walk, the Android-vs-web `alt` branch, and the guarded page turn. Open its slides to step through it.
- **`start_here_flow`**: an execution view for the "start from here" path. An `alt` shows the two ways a reader picks a start point — selecting text, or tapping while reading — both converging on `playFrom`, then `stop()`/`play(start)` and the sentence skip; a `ref` row points back at `play_flow` for the engine call that follows.

## What I found while reconstructing this

- **The tap-to-jump gesture does not check whether the annotation toolbar is open.** `hasOpenPanel()` (`public/js/reader.js`) checks the TOC, search, settings, and bookmarks sidebars and the annotations sidebar, but not `#annot-toolbar`. So a tap while `_tts.playing` and the annotation toolbar is open (left over from a text selection) can still jump reading to that tap's point, instead of leaving the toolbar's own "Read aloud from here" action as the only way to start reading from a selection. Not necessarily wrong — flagging it because it looked like an intentional exclusion list that quietly omits one panel.
- **PDF read-aloud never gets a real language tag.** `pdf-parser.js` always sets `metadata.language: ''` (there is no PDF equivalent of an EPUB's `dc:language`), so `getLang()` for a PDF book falls back to the platform default voice every time, not the book's own language. This is a limitation, not a crash; flagging it because the reader may expect the same per-book language behavior PDFs already show for EPUB.
- **The continuous-mode resume path is now guarded, but still unverified.** `playEpub` used to do `blocks.indexOf(last) + 1` unconditionally when it ran out of blocks; if continuous mode ever detached the previously-read block, `indexOf` returned `-1` and reading silently restarted at block `0`. The code now checks `last.isConnected` first and falls back to `blockIndexFrom(blocks, reader._visibleAnchorEl())` when the block is gone, so a detached block resumes near the visible page instead of jumping to the top of the document. Whether continuous mode ever actually detaches that block, and whether the fallback lands on the sentence the reader expects, is still unconfirmed; worth a manual check in continuous mode specifically.
- Everything else matched the acceptance example: opening an EPUB, tapping read-aloud, hearing the first visible paragraph, and seeing the page turn only when speech reaches the next page — traced through the code, not run on a device.

## Open uncertainties (yours to test)

- **iOS silent switch.** Whether the hardware mute switch silences `speechSynthesis` inside a WKWebView is unconfirmed; test on an iPhone.
- **Background/locked-screen playback.** Android's WebView JavaScript keeps running after `onPause`, so speech may continue after the screen locks; this was not verified. iOS needs `UIBackgroundModes=audio` for the same, which this change does not add — background playback on iOS is expected to stop.
- **The Kotlin change is unbuilt.** `MainActivity.kt` has not been compiled in this pass; confirm it builds and that a device actually speaks before relying on it.
- **Missing voices.** A device may lack an installed voice for an EPUB's declared metadata language; the engine's own fallback behavior in that case was not tested here.
- **Start-from-here on-device behavior.** `playFrom`/`playFromPoint` (4.5, 4.6) are traced through the code, not run on a device; confirm a long-press selection and a mid-read tap both jump to the intended sentence, and that `caretRangeFromPoint`/`caretPositionFromPoint` (1.7) resolve consistently across the browsers this reader targets.
