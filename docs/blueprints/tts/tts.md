---
title: Read-aloud (TTS) for EPUB and PDF
---

Codexa can now read a book aloud, on Android and on iOS, using whichever speech engine that platform offers, and a Bluetooth or wired headset's play/pause/skip keys control it on Android. This Blueprint reconstructs the change from the code committed on `tts-read-aloud` at `976a7f8` (the read-aloud feature) and `b6b8933` (headset/Bluetooth media-key control); every `code` reference below resolves against the `5f0d08e..b6b8933` range (the parent of `976a7f8` through `b6b8933`).

Seven modules build the feature in order. [Pure text/parsing helpers](#1-pure-textparsing-helpers) turn raw content into speakable chunks and locate a tapped or selected point inside it. The [Android native TTS bridge](#2-android-native-tts-bridge) reaches Android's own `TextToSpeech` from inside the WebView, since Android WebView has no `speechSynthesis`. [Speech engine adapters](#3-speech-engine-adapters) give both platforms the same `speak()`/`stop()` shape. The [reader TTS controller](#4-reader-tts-controller) owns the play/pause/stop session state, walks an EPUB or a PDF one readable piece at a time, steps or turns by request, and can jump reading to a chosen point. [Reader UI integration](#5-reader-ui-integration) puts a header button, a bottom bar (volume, speed, and playback controls), a selection action, and a tap-to-jump gesture on the reading screen, and stops speech at every point a rendition already ends. [Offline delivery](#6-offline-delivery) makes sure an installed PWA actually gets the new file. [Android media-key control](#7-android-media-key-control) keeps a headset's play/pause/skip keys routed to Codexa while a session is active.

```items
---
items_schema: tts.kg/kg.schema
---
```

## The page-turn invariant

TTS never turns a page the reader did not ask for, except to keep the block it is speaking on screen. A relocation that moves the read sentence off screen restarts reading from the newly visible page; one that leaves it on screen (reflow, scroll noise) is ignored. Node **4.2** (`onRelocated`) is where this is enforced; its `code` reference points at the exact guard.

## The pause invariant

Pausing never clears the cursor. Toggling the button, the bar's play/pause control, or a headset's play/pause key all resume with the same sentence that was interrupted, not the block's first sentence or the visible anchor. Node **4.1** (`start`/`pause`/`stop`, the session's `cursor`) is where this is enforced.

## The start-here invariant

A user-chosen start point wins over the visible-page anchor. Selecting text and tapping "Read aloud from here", or tapping text while reading, jumps to that exact sentence instead of the first block the reader happens to be looking at. That same tap never overrides the left/right page-turn zones: the touch handler checks those zones first, and only reaches the read-aloud jump when the tap fell outside them. Node **4.10** (`playFrom`) and node **5.9** (the touch handler) are where this is enforced.

## The media-key invariant

Media keys reach Codexa while a read-aloud session is active. A headset's play/pause/skip keys act on the same controller the on-screen bar acts on, and the app keeps Android's own media-button routing pointed at itself between utterances instead of letting it drift to whatever app played audio last. Node **7.1** (`updateTtsMediaSession`) is where this is enforced.

## 1 Pure text/parsing helpers

`splitSentences`, `collectBlocks`, `blockIndexFrom`, and `pdfItemsToText` are plain functions with no engine or reader dependency, each with a small doctest-style example in its own docstring. `sentenceIndexAt`, `textOffsetIn`, and `caretAt` are the same kind of pure helper, added to locate the sentence under a selection or a tap.

## 2 Android native TTS bridge

Android WebView cannot call `window.speechSynthesis`. `MainActivity.kt` adds a `JsBridge.ttsSpeak`/`ttsStop`/`ttsSetVolume`/`ttsSessionState` set, a lazily created `TextToSpeech` with one pending utterance, and an `UtteranceProgressListener` that reports every outcome back into the page as a `window.__codexaTtsEvent` call. `AndroidManifest.xml` declares the `TTS_SERVICE` package-visibility query the platform needs on API 30+.

## 3 Speech engine adapters

`androidEngine` and `webEngine` both expose `speak(text, {rate, volume, lang}) -> Promise<'done'|'stopped'|'error'>` and `stop()`; `androidEngine` also exposes `session(active, playing)` for module 7. `pickEngine` chooses one, once, when the controller is created, so the controller itself never branches on which platform it is running on.

## 4 Reader TTS controller

`createTts(reader, opts)` owns a session (`active`/`playing`/`cursor`), exposed as `start(from)`/`pause()`/`stop()`/`toggle()`, plus `prevSentence`/`nextSentence`/`prevPage`/`nextPage`/`refresh`/`onRelocated`/`playFrom`/`playFromPoint`. `playEpub` walks the EPUB's blocks from the reader's visible position, or from a given cursor, turning pages only to keep the current block in view and waiting once for a continuous-mode chapter append before treating a stalled turn as the end of the book. `playPdf` walks the PDF's cached per-page sentences, stopping after three empty pages in a row (a scanned PDF has no text layer). `playFrom` jumps an EPUB rendition to the sentence at a DOM point; `playFromPoint` resolves a tap's viewport coordinates to that point first. `emit()` is the one seam that reports every state change to both the reader UI (5) and, on Android, the media session (7).

## 5 Reader UI integration

A header button (`btn-tts`), a settings toggle, a bottom bar (volume and speed sliders with step buttons, and stop/prev-page/prev-sentence/play-pause/next-sentence/next-page controls), an annotation-toolbar action ("Read aloud from here"), and a tap-to-jump gesture while reading give the reader a way to reach the controller. The bar opens while a session is active — playing or paused — not only while audio is sounding. It stops before a rendition closes, before a fired sleep timer dims the screen, and when the reader returns to the library.

## 6 Offline delivery

`public/js/tts.js` is added to the service worker's precached app shell, and `CACHE_VERSION` is bumped so an already-installed PWA actually fetches it.

## 7 Android media-key control

A Bluetooth or wired headset's media keys are delivered to whichever app's `MediaSession` the system currently considers active. `MainActivity.kt` keeps a `MediaSession` in step with the read-aloud session, requests and releases audio focus while playing (a focus loss pauses reading), and plays a short silent `AudioTrack` from this app's own process so media-button routing stays here between utterances, since `TextToSpeech` audio itself plays inside the engine's process. The session's callback routes each key back into the page through `window.__codexaTtsMedia`, which the controller (4) maps onto its own `start`/`pause`/`stop`/`nextSentence`/`prevSentence`.

## How to read this

- **Build order** (default view): every leaf's number is the order it must exist in; every arrow points from a lower number to a higher one.
- **Safeguards**: the same graph, read for the three invariants and what enforces each one.
- **`play_flow`**: an execution view. One tap on the button walks through engine selection, the EPUB block walk, the Android-vs-web `alt` branch, and the guarded page turn. Open its slides to step through it.
- **`start_here_flow`**: an execution view for the "start from here" path. An `alt` shows the two ways a reader picks a start point — selecting text, or tapping while reading — both converging on `playFrom`, then `start(cursor)` and the sentence skip; a `ref` row points back at `play_flow` for the engine call that follows.
- **`media_key_flow`**: an execution view for a headset key press. A press reaches the `MediaSession` callback, is relayed to the page, and routes to the same controller method the bar's own buttons call; the loop closes when the controller's new state is reported back to the `MediaSession`, which is where invariant (media-key) is actually enforced.

## What I found while reconstructing this

- **PDF read-aloud never gets a real language tag.** `pdf-parser.js` always sets `metadata.language: ''` (there is no PDF equivalent of an EPUB's `dc:language`), so `getLang()` for a PDF book falls back to the platform default voice every time, not the book's own language. This is a limitation, not a crash; flagging it because the reader may expect the same per-book language behavior PDFs already show for EPUB.
- **The continuous-mode resume path no longer falls back to the visible anchor.** An earlier version of `nextBlocks` fell back to `blockIndexFrom(blocks, reader._visibleAnchorEl())` when the previously-read block was no longer attached to the document. The committed code instead restarts numbering at the first block of the freshly collected list (`fresh[0]`) in that case — simpler, and in the ordinary case equivalent, since a fresh collection after a page turn is already the new page's own blocks, but it is no longer literally "the visible anchor." Whether continuous mode ever actually detaches the previously-read block, and whether resuming from `fresh[0]` lands on the sentence the reader expects, is still unverified against every continuous-mode re-render path; worth a manual check in continuous mode specifically.
- **The tap-to-jump gesture's annotation-toolbar bug is fixed.** `hasOpenPanel()` (`public/js/reader.js`) still does not check `#annot-toolbar`, but the touch handler now checks `#annot-toolbar` itself, alongside `hasOpenPanel()`, before treating a tap as a read-aloud jump — so a tap while the toolbar is open (left over from a text selection) no longer jumps reading to that tap's point.
- Everything else matched the acceptance example: opening an EPUB, tapping read-aloud, hearing the first visible paragraph, and seeing the page turn only when speech reaches the next page — traced through the code, not run on a device.

## Evidence for this pass

Node-runnable tests in the working session (not checked into the repository) covered: PDF cross-page reading, pause/resume keeping the cursor, sentence and page stepping, EPUB cross-page and cross-chapter reading, continuous-mode append waiting, and the media-action dispatch table (`window.__codexaTtsMedia`). The user separately confirmed on an Android device that the bar and Bluetooth headset play/pause both work. The bar covering the bottom of the reading page while open (5.10) is a known, accepted limit, not a bug.

## Open uncertainties (yours to test)

- **iOS silent switch.** Whether the hardware mute switch silences `speechSynthesis` inside a WKWebView is unconfirmed; test on an iPhone.
- **Background/locked-screen playback.** Android's WebView JavaScript keeps running after `onPause`, so speech may continue after the screen locks; this was not verified. iOS needs `UIBackgroundModes=audio` for the same, which this change does not add — background playback on iOS is expected to stop.
- **Missing voices.** A device may lack an installed voice for an EPUB's declared metadata language; the engine's own fallback behavior in that case was not tested here.
- **Start-from-here on-device behavior.** `playFrom`/`playFromPoint` (4.10, 4.11) are traced through the code and covered by Node tests, but not exercised on a device; confirm a long-press selection and a mid-read tap both jump to the intended sentence, and that `caretRangeFromPoint`/`caretPositionFromPoint` (1.7) resolve consistently across the browsers this reader targets.
- **Headset behavior beyond play/pause.** The user confirmed play/pause on device; `next`/`prev` (skip) from a headset, audio-focus loss to another app, and behavior across multiple connected Bluetooth devices are traced through the code (7) but not confirmed on a device.
