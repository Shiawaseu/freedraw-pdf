# Drawing and Rendering Problems

This document tracks the reported handwriting and eraser failures, their causes, and the regression contract. The implementation changes below are complete; final iPad WKWebView confirmation is still required.

## Required Behavior

- Touch, pen, and mouse input take priority over background rendering.
- A new stroke can start while an older page rebuild is queued, running, or publishing.
- Recorded pointer samples are authoritative. Preview progress must never shorten or reshape recorded input.
- Pen and highlighter commits retain the pixels already drawn instead of rebuilding old strokes.
- Erasers do not create renderable eraser strokes.
- Object erase keeps the circular down/up indicator but removes contacted objects as complete objects.
- Existing handwriting is never split into manufactured fragments or recalculated merely because another object was erased.
- Reload, zoom, embed, and export use the same canonical ink geometry.

## Root Causes

### Touch blocked by completed render publication

Page rebuilds yielded between annotations, but completion used `getImageData` followed by `putImageData` for the full canvas. That uninterrupted CPU copy could block iPad pointer dispatch even though the preceding render steps were cooperative.

Resolution:

- Background rebuilds still use three reusable offscreen slots and a four millisecond cooperative budget.
- Completion now creates an asynchronous `ImageBitmap` snapshot, with an asynchronous PNG/image fallback.
- The final visible `drawImage` is guarded by a page version and input epoch.
- Pointer-down invalidates all older publications, so a render completed before touch can never land after touch begins.
- Rendering diagnostics return to `idle` after both render jobs and snapshot publications finish.

### Recorded touch samples coupled to preview progress

Pointer-up previously shortened `currentStroke.points` to `currentStrokeRenderedPointCount`. If touch samples arrived after the latest animation frame, valid input was deleted before commit.

Resolution:

- Recorded points are never sliced to the last rendered frame.
- The final transient promotion renders the complete recorded point list.
- Coalesced touch events and the pointer-up sample are retained for rapid lines and dots.

### Expensive work before first point admission

The capture fallback, canvas listener, and canvas handler could all invoke stale-interaction recovery. Pointer-down also rebuilt the toolbar and could rebuild/sort annotation buckets just to obtain the next z-index.

Resolution:

- Stale recovery has one owner in `handlePointerDownForCanvas`.
- Accepted ink calls `preventDefault` and cancels background work before stale recovery.
- Ink pointer-down does not synchronously rebuild the toolbar.
- Native PDF toolbar targets are excluded from fallback handwriting admission.
- Per-page z-index allocation is constant time after initial page setup.
- Annotation cache invalidation no longer scans every stored stroke after each commit.
- Queued interaction redraws are cancelled when ink starts.

### Fragmented or reshaped strokes after erase

Older segment erasing split strokes and replayed surviving fragments through the ink renderer. Object erase also exposed partial pixel removal before the full object disappeared.

Resolution:

- Legacy erase paths are consumed into stable object deletion during load and are not replayed.
- Segment and object erase batch contact detection and remove contacted stored objects atomically.
- Object mode shows only the eraser-area indicator and whole-object disappearance.
- Object preview composes offscreen and publishes one complete frame.
- No eraser annotation is rendered, exported, or embedded.

## Regression Contract

1. `handlePointerDownForCanvas` is the only new-stroke stale-recovery owner.
2. Accepted ink pointer-down calls `pauseCommittedRenderingForInkInput` before recording setup.
3. Input cancellation increments `renderInputEpoch` and clears queued jobs/publications.
4. A background publication requires matching page version, input epoch, surface, and dimensions.
5. Background publication never calls the synchronous full-frame `publishRenderedCanvas`.
6. Cooperative rendering processes at most one expensive old stroke per slice.
7. Current-stroke points are never truncated based on render progress.
8. Pen commit promotes only the current transient stroke and retains committed pixels.
9. Eraser pointer movement never rerenders surviving handwriting.
10. Object erase removes complete contacted objects and retains the eraser indicator animation.
11. Temporary rendering diagnostics remain disabled by default and are controlled by the plugin setting.

## Automated Verification

Run:

```powershell
cmd /c npm run build
cmd /c npm run check
```

The verifier suite covers mixed documents, ink geometry, touch admission and coalescing, eraser migration, render concurrency, templates, and toolbar behavior. The render verifier specifically rejects synchronous background frame publication, stale publication after input, preview-based point truncation, and full-stroke scans in the rapid-stroke path.

## iPad Reproduction

1. Enable `Allow touch drawing`.
2. Turn on `Show rendering diagnostics` only for this test.
3. Create a page rebuild by opening or zooming a page with many strokes.
4. While `RENDER RUNNING` or `RENDER PUBLISHING` is visible, quickly draw short parallel lines.
5. Repeat with ten or more isolated dots at short intervals.
6. Confirm every contact immediately changes `INPUT` to `RECORDING`.
7. Confirm every line/dot remains present and no stroke changes shape after render completion.
8. Confirm the render row returns to `IDLE`.
9. Turn rendering diagnostics off after testing.

## Status

Implemented and automated checks passing on 2026-07-28:

- asynchronous, input-invalidated background publication;
- complete recorded-point preservation;
- single-owner stale recovery;
- constant-time rapid-stroke z-index allocation;
- no full-stroke cache scan on commit;
- cooperative old-stroke rendering;
- touch admission and coalesced sample recovery;
- retained pen commits;
- non-renderable erasers and atomic whole-object erase;
- off-by-default rendering diagnostics with accurate idle state.

Desktop Obsidian stress validation on 2026-07-28:

- triggered a zoom page rebuild and immediately injected ten short consecutive strokes;
- all ten strokes were recorded and remained visually intact after render settle;
- all ten strokes remained intact after a second zoom redraw;
- no fragmented or reshaped committed stroke was observed.

Remaining release gate: repeat the iPad reproduction above in Obsidian's WKWebView and confirm the touch latency and visual result on-device.
