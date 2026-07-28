const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

function read(relativePath) {
	return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function assertContains(fileName, content, needle, message) {
	if (!content.includes(needle)) {
		throw new Error(`${fileName}: ${message}\nMissing: ${needle}`);
	}
}

function assertNotContains(fileName, content, needle, message) {
	if (content.includes(needle)) {
		throw new Error(`${fileName}: ${message}\nUnexpected: ${needle}`);
	}
}

function assertOccurrenceAtLeast(fileName, content, needle, minCount, message) {
	const count = content.split(needle).length - 1;
	if (count < minCount) {
		throw new Error(`${fileName}: ${message}\nExpected at least ${minCount}, found ${count}: ${needle}`);
	}
}

const mainTs = read("main.ts");
const interactionTs = read("src/annotation/interaction.ts");
const annotationStoreTs = read("src/stores/annotationStore.ts");
const eraserTs = read("src/annotation/eraser.ts");
const embedRenderTs = read("src/markdown/embedRender.ts");
const cooperativeRenderTs = read("src/render/cooperativeRender.ts");
const renderTelemetryTs = read("src/debug/renderTelemetry.ts");
const configTs = read("src/config.ts");
const typesTs = read("src/types.ts");
const settingsControllerTs = read("src/settings/settingsController.ts");
const stylesCss = read("styles.css");
const packageJson = JSON.parse(read("package.json"));
const builtMainPath = path.join(projectRoot, "main.js");
const builtMain = fs.existsSync(builtMainPath) ? fs.readFileSync(builtMainPath, "utf8") : "";
const fontPopoverStart = mainTs.indexOf("private openTextStyleMenu");
const fontPopoverEnd = mainTs.indexOf("private getSelectedTextItems", fontPopoverStart);
const fontPopoverSource = mainTs.slice(fontPopoverStart, fontPopoverEnd);

assertContains("main.ts", mainTs, "if (!this.annotationMode) {", "toolbar must have an explicit read-mode branch");
assertContains("main.ts", mainTs, "pdf-native-annotator-read-mode-hint", "read mode must be visibly labeled");
assertContains("main.ts", mainTs, "readModeHint.textContent = \"Read mode\"", "read mode label must be clear");
assertContains("main.ts", mainTs, "this.toolbarEl.appendChild(leftGroup);\n\t\t\tthis.toolbarEl.appendChild(rightGroup);\n\t\t\tthis.repositionOpenPopovers();\n\t\t\treturn;", "read mode branch must return before rendering inactive drawing controls");
assertContains("main.ts", mainTs, "this.setActiveTool(\"pen\")", "annotation mode must still switch from select to pen when enabled");
assertContains("src/types.ts", typesTs, "textColor: string;", "text color must have independent persisted settings state");
assertContains("src/config.ts", configTs, "textColor: TEXT_COLOR_PRESETS[0].color", "text color must have a stable default");
assertContains("src/settings/settingsController.ts", settingsControllerTs, "getTextColor(): string", "sessions must be able to load the stored text color");
assertContains("src/settings/settingsController.ts", settingsControllerTs, "updateTextColor(color: string): void", "text color changes must persist independently");
assertContains("main.ts", mainTs, "this.currentTextColor = this.plugin.getTextColor();", "new sessions must restore the text color");
assertContains("main.ts", mainTs, "private usesTextColorControl(): boolean", "the shared toolbar color control must distinguish text from ink");
assertContains("main.ts", mainTs, "this.setTextColor(color, pushHistory, refreshToolbar);", "text color changes must not pass through ink preset state");
assertContains("main.ts", mainTs, "text: controlsTextColor ? \"Text color\" : \"Ink color\"", "the shared color popover must identify its active color domain");
assertContains("main.ts", mainTs, "pdf-native-annotator-tool-color-popover", "pen and text colors must use the same popup window");
assertContains("main.ts", mainTs, "for (const preset of TEXT_COLOR_PRESETS)", "pen and text color popups must use the same aligned palette");
assertNotContains("main.ts", mainTs, "const colorPresets = controlsTextColor", "tool color popup contents must not change dimensions between pen and text");
assertNotContains("main.ts font popover", fontPopoverSource, "text: \"Color\"", "the Font popover must not duplicate the toolbar color section");
assertNotContains("main.ts font popover", fontPopoverSource, "text: \"Custom color\"", "the Font popover must not duplicate the custom color control");
assertNotContains("styles.css", stylesCss, ".pdf-native-annotator-font-color-list", "removed Font color controls must not leave dead styles");
assertContains("styles.css", stylesCss, ".pdf-native-annotator-preset,\n.pdf-native-annotator-color-button,\n.pdf-native-annotator-swatch {", "pen presets and text color controls must share one interaction animation");
assertContains("styles.css", stylesCss, "transform 90ms ease-out", "shared color controls must use the same release timing");
assertContains("styles.css", stylesCss, ".pdf-native-annotator-preset:active,\n.pdf-native-annotator-color-button:active,\n.pdf-native-annotator-swatch:active {", "shared color controls must use the same pressed state");
assertContains("styles.css", stylesCss, ".pdf-native-annotator-tool-color-popover .pdf-native-annotator-color-popover-swatches {", "pen and text palettes must share a dedicated grid");
assertContains("styles.css", stylesCss, "width: min(240px, calc(100vw - 24px));", "pen and text color popups must retain the previous rectangular width");
assertContains("styles.css", stylesCss, "grid-template-columns: repeat(6, 28px);", "tool color popup swatches must align in one rectangular row");
assertContains("styles.css", stylesCss, "padding: var(--size-4-4) 0 var(--size-4-2);", "custom popups must retain a consistent bottom inset");
assertOccurrenceAtLeast("main.ts", mainTs, "this.addTemplatePageFromToolbar();", 2, "+ Page must be direct in both read and annotation modes");
assertNotContains("main.ts", mainTs, "this.openAddPageMenu(addPageButton)", "+ Page must not open a hidden menu");
assertContains("main.ts", mainTs, "Add template page before current PDF page...", "overflow menu must expose PDF-page before insertion");
assertContains("main.ts", mainTs, "Add template page after current PDF page...", "overflow menu must expose PDF-page after insertion");
assertNotContains("main.ts", mainTs, "setTitle(\"Add template page after current\")", "overflow menu must not keep the old duplicate add-after action");
assertNotContains("main.ts", mainTs, "setTitle(\"Add template page before current\")", "overflow menu must not keep the old duplicate add-before action");
assertContains("main.ts", mainTs, "this.isSessionShortcutActive(event)", "PDF key handler must route active annotation shortcuts before select-only shortcuts");
assertContains("main.ts", mainTs, "this.undo();", "PDF key handler must expose undo through standard shortcuts");
assertContains("main.ts", mainTs, "this.redo();", "PDF key handler must expose redo through standard shortcuts");
assertContains("main.ts", mainTs, "this.createHistoryIconButton(\"undo-2\", \"Undo\", () => this.undoFromToolbar())", "Undo toolbar button must use the dedicated history-button path");
assertContains("main.ts", mainTs, "this.createHistoryIconButton(\"redo-2\", \"Redo\", () => this.redoFromToolbar())", "Redo toolbar button must use the dedicated history-button path");
assertContains("main.ts", mainTs, "private createHistoryIconButton", "toolbar history buttons must have a dedicated pointer/click activation path");
assertContains("main.ts", mainTs, "this.forceFinishStalePdfInteraction(\"Finished active annotation before undo\")", "toolbar undo must finish active pointer state before reading history");
assertContains("main.ts", mainTs, "this.forceFinishStalePdfInteraction(\"Finished active annotation before redo\")", "toolbar redo must finish active pointer state before reading history");
assertContains("main.ts", mainTs, "type HistoryEntry =", "history must support lightweight entries");
assertContains("main.ts", mainTs, "| { kind: \"stroke-add\"; stroke: StrokeAnnotation };", "stroke additions must use lightweight history entries");
assertContains("main.ts", mainTs, "private pushStrokeAddHistory(stroke: StrokeAnnotation): void", "stroke commits must be able to push lightweight history");
assertContains("main.ts", mainTs, "this.pushStrokeAddHistory(this.currentStroke);", "stroke commits must use lightweight history instead of full document cloning");
assertContains("main.ts", mainTs, "if (previousEntry?.kind === \"document\")", "cancel interaction must only restore full-document history entries");
assertNotContains("main.ts", mainTs, "\t\tthis.pushHistory();\n\t\tconst strokeWidth", "stroke start must not clone the full annotation document");
assertContains("main.ts", mainTs, "this.showDrawingNotice(\"Nothing to undo\", 1200)", "undo notice must respect the drawing notice setting");
assertContains("main.ts", mainTs, "this.showDrawingNotice(`Undo applied (${this.annotationDocument.strokes.length} strokes)`, 1600)", "undo applied notice must respect the drawing notice setting");
assertContains("main.ts", mainTs, "this.showDrawingNotice(\"Nothing to redo\", 1200)", "redo notice must respect the drawing notice setting");
assertContains("main.ts", mainTs, "this.showDrawingNotice(`Redo applied (${this.annotationDocument.strokes.length} strokes)`, 1600)", "redo applied notice must respect the drawing notice setting");
assertContains("main.ts", mainTs, "this.showDrawingNotice(`New stroke on page ${pageNumber}`, 900)", "stroke start notice must respect the drawing notice setting");
assertContains("main.ts", mainTs, "this.showDrawingNotice(`Stroke recorded (${pointCount} points, ${this.annotationDocument.strokes.length} total)`, 1400)", "normal stroke commit notice must respect the drawing notice setting");
assertContains("main.ts", mainTs, "this.showDrawingNotice(`Stroke recorded before layout refresh (${pointCount} points, ${strokeCount} total)`, 1600)", "layout-refresh stroke commit notice must respect the drawing notice setting");
assertContains("main.ts", mainTs, "this.refreshStatus(`Stroke started: ${this.currentTool}, page ${pageNumber}, points 1`, 900)", "stroke start should use lightweight status text");
assertContains("main.ts", mainTs, "this.refreshStatus(`Stroke recorded (${pointCount} points, ${this.annotationDocument.strokes.length} strokes)`, 900)", "normal stroke commit should use lightweight status text");
assertContains("main.ts", mainTs, "if (this.currentTool === \"eraser\") {\n\t\t\tthis.updateToolPreview(event.clientX, event.clientY, this.erasingSession);\n\t\t}", "pen and highlighter pointer moves must not touch the eraser preview DOM path");
assertContains("main.ts", mainTs, "if (this.currentTool !== \"eraser\") {\n\t\t\tthis.hideToolPreview();\n\t\t\treturn;\n\t\t}", "tool preview refresh must exit early for non-eraser tools");
assertContains("main.ts", mainTs, "element.style.getPropertyValue(cssProperty) === value", "style updates must skip unchanged CSS properties");
assertContains("main.ts", mainTs, "element.style.getPropertyValue(property) === value", "CSS variable updates must skip unchanged values");
assertContains("main.ts", mainTs, "this.forceRedrawVisibleAnnotations();", "layout refresh should prefer visible-page redraws while resizing");
assertContains("main.ts", mainTs, "this.syncPages(false);", "layout refresh must update surfaces without forcing a full-page redraw cascade");
assertNotContains("main.ts", mainTs, "this.notePerf(\"layout full\"", "layout refresh must not schedule a settled all-page redraw during resize storms");
assertContains("main.ts", mainTs, "this.clearLayoutRefreshHandles();", "layout refresh scheduling must debounce duplicate resize/mutation events");
assertContains("main.ts", mainTs, "childList: true,\n\t\t\tsubtree: true\n\t\t});", "PDF DOM observer must not watch style/class attribute churn");
assertNotContains("main.ts", mainTs, "private markPageZooming(pageNumber: number): void {\n\t\tthis.zoomingPages.add(pageNumber);\n\t\tthis.scheduleLayoutRefresh();", "per-page resize observer must not start full layout refresh cascades");
assertContains("main.ts", mainTs, "surface.overlayEl.parentElement !== surface.hostEl", "zoom completion must reject stale PDF.js canvas hosts");
assertContains("main.ts", mainTs, "surface.hostEl.appendChild(backgroundEl);", "template backgrounds must not use a detached overlay as an insertBefore reference");
assertNotContains("main.ts", mainTs, "surface.hostEl.insertBefore(backgroundEl, surface.overlayEl);", "template background insertion must not abort redraw when PDF.js reparents the overlay");
assertContains("main.ts", mainTs, "const predictTail = this.plugin.getLivePreviewMode() === \"quality\";", "live stroke preview must support high-quality mode without changing renderer families");
assertContains("main.ts", mainTs, "this.drawStroke(context, surface, this.currentStroke, commitCurrentStroke ? false : predictTail, !commitCurrentStroke);", "live drawing must use prediction while committed promotion uses canonical geometry");
assertContains("main.ts", mainTs, "this.drawReliablePdfStroke(context, surface, stroke, baseWidth, true, predictTail, livePreview);", "pen rendering must stay on the release Perfect Freehand path");
assertNotContains("main.ts", mainTs, "drawBalancedLiveStroke", "alternate stroke renderers must not redraw handwriting into different geometry");
assertNotContains("main.ts", mainTs, "getFastPreviewStrokePoints", "live preview must not use a separate smoothing path from final rendering");
assertContains("main.ts", mainTs, "private retainCommittedPagePixels(pageNumber: number): void", "stroke commits must keep the retained committed canvas instead of queueing a page rebuild");
assertContains("main.ts", mainTs, "if (committedPreviewStroke) {\n\t\t\tthis.retainCommittedPagePixels(pageNumber);", "pen pointer-up must retain promoted pixels without scheduling a full-page render");
assertNotContains("main.ts", mainTs, "this.deferCommittedPageRedraw(pageNumber, holdCommittedStrokeRender);", "pen commits must not queue previous strokes for another render");
assertContains("main.ts", mainTs, "private promoteCurrentTransientPreview(pageNumber: number): void", "stroke commits must promote the finalized current stroke synchronously");
assertContains("main.ts", mainTs, "this.promoteCurrentTransientPreview(pageNumber);", "stroke commit paths must keep the just-drawn stroke visible without full rerendering");
assertContains("main.ts", mainTs, "private promoteTransientLayer(surface: PageSurface): void", "commits must copy transient pixels onto the committed overlay");
assertContains("main.ts", mainTs, "context.drawImage(surface.transientEl, 0, 0);", "transient promotion must preserve the finalized current-stroke pixels");
assertContains("main.ts", mainTs, "this.strokePathCache.delete(this.currentStroke.id);\n\t\t\tthis.drawTransientPageAnnotations(pageNumber, true);", "stroke pointer-up must replace only the predicted current stroke with canonical geometry");
assertContains("main.ts", mainTs, "private getCachedStrokeOutline(", "committed strokes must cache structured numeric geometry");
assertNotContains("main.ts", mainTs, "new Path2D(", "native ink rendering must not depend on Electron SVG path parsing");
assertContains("main.ts", mainTs, "A delayed preview must never", "stroke commit must preserve recorded samples that have not reached a preview frame");
assertContains("main.ts", mainTs, "canvases: [createEl(\"canvas\"), createEl(\"canvas\"), createEl(\"canvas\")]", "page rebuilds must rotate through three offscreen render slots");
assertContains("main.ts", mainTs, "runCooperativeRenderSlice(job.steps, job.nextStep", "background page rebuilds must use the cooperative input-aware scheduler");
assertContains("main.ts", mainTs, "scheduling?.isInputPending?.() ?? false", "background page rebuilds must yield before queued discrete pointer input");
assertContains("main.ts", mainTs, "const allowInputYield = sliceStart - job.lastProgressAt < 48;", "background page rebuilds must recover when the browser input signal remains pending");
assertContains("main.ts", mainTs, "const canSwap = !allowInputYield ||", "completed page rebuilds must eventually swap even when the browser input signal remains pending");
assertNotContains("main.ts", mainTs, "includeContinuous: true", "continuous touch and hover input must not starve page rebuilds");
assertContains("src/render/cooperativeRender.ts", cooperativeRenderTs, "if (step.expensive && processedExpensiveStep)", "a render task must calculate at most one old stroke before yielding");
assertContains("main.ts", mainTs, "this.renderTelemetry.recordRenderProgress(", "render progress must be broadcast from each cooperative slice");
assertContains("main.ts", mainTs, "this.renderTelemetry.recordPointerSamples(event, points.length, this.currentStroke.points.length);", "live stroke point progress must be broadcast");
assertContains("src/debug/renderTelemetry.ts", renderTelemetryTs, "freedraw-pdf:render-telemetry", "temporary diagnostics must publish a stable DOM event");
assertContains("src/debug/renderTelemetry.ts", renderTelemetryTs, "requestAnimationFrame(() =>", "telemetry UI updates must be frame-throttled");
assertContains("src/config.ts", read("src/config.ts"), "showRenderTelemetry: false", "temporary rendering diagnostics must be off by default");
assertContains("src/settings/settingTab.ts", read("src/settings/settingTab.ts"), "Show rendering diagnostics", "temporary rendering diagnostics must have a settings toggle");
assertContains("main.ts", mainTs, "this.syncRenderTelemetry();", "settings refresh must attach or remove rendering diagnostics");
assertContains("main.ts", mainTs, "this.cancelPageRenderJobs();", "active input must cancel background page rebuilds");
assertContains("main.ts", mainTs, "await this.createCanvasSnapshot(job.canvas)", "completed background rebuilds must snapshot without blocking touch input");
assertContains("main.ts", mainTs, "const frame = sourceContext.getImageData(0, 0, source.width, source.height);", "offscreen rendering must flush a complete CPU pixel frame before publication");
assertContains("main.ts", mainTs, "targetContext.putImageData(frame, 0, 0);", "native overlays must publish exact pixels without Electron GPU canvas-copy artifacts");
assertContains("main.ts", mainTs, "getContext(\"2d\", { willReadFrequently: true })", "offscreen render slots must use CPU-backed contexts");
assertNotContains("main.ts", mainTs, "private invalidateAnnotationPageCache(): void {\n\t\tthis.annotationPageCache = null;\n\t\tthis.strokePathCache.clear();", "adding or erasing annotations must not discard cached geometry for surviving strokes");
assertNotContains("main.ts", mainTs, "drawFastCommittedPreview", "stroke commits must not use a second committed-preview geometry path");
assertNotContains("main.ts", mainTs, "shouldHoldCommittedInkRedraw", "deferred rendering must not switch committed pages to a different fast renderer");
assertNotContains("main.ts", mainTs, "isCommittedInkRedrawHeld", "held committed rendering must not redraw with alternate stroke geometry");
assertNotContains("main.ts", mainTs, "wasHoldingCommittedInkRedraw", "tool switches must not flush final rendering during annotation mode");
assertNotContains("main.ts", mainTs, "const useFastStrokeRender = this.isCommittedInkRedrawHeld(pageNumber);", "committed redraws must not choose an alternate stroke renderer");
assertContains("main.ts", mainTs, "private eraserSessionPoints: AnnotationPoint[] = [];", "eraser strokes must collect a path for one batch mutation");
assertContains("main.ts", mainTs, "this.eraserSessionPoints = [point];", "eraser pointer-down must begin a collected path without scanning annotations");
assertContains("main.ts", mainTs, "if (this.currentTool === \"eraser\" && this.erasingSession && canvas)", "eraser pointer-up must process the final touch point");
assertContains("main.ts", mainTs, "this.appendEraserSessionPoint(pageNumber, sample);", "eraser pointer-move must record path samples without mutating annotations");
assertContains("main.ts", mainTs, "const changed = this.applyEraserSession(pageNumber);", "eraser pointer-up must apply annotation mutations once");
assertContains("main.ts", mainTs, "private applyEraserSession(pageNumber: number): boolean", "eraser mutation must be batched outside pointermove");
assertContains("main.ts", mainTs, "private applySegmentEraserSession(pageNumber: number, points: AnnotationPoint[], threshold: number): boolean", "segment erasing must batch one geometry mutation after input ends");
assertContains("main.ts", mainTs, "return migrateLegacyEraserPaths(this.annotationDocument);", "segment erasing must consume its temporary path into stable geometry");
assertContains("src/annotation/eraser.ts", eraserTs, "function pathTouchesStroke(", "touch erasing must resolve contact against stored stroke geometry");
assertContains("src/annotation/eraser.ts", eraserTs, "document.strokes = document.strokes.filter(", "contacted strokes must disappear atomically");
assertNotContains("src/annotation/eraser.ts", eraserTs, "splitStrokeByEraser", "eraser operations must never manufacture fragmented survivor strokes");
assertContains("src/annotation/eraser.ts", eraserTs, "document.eraserPaths = [];", "consumed eraser paths must not remain renderable");
assertContains("src/stores/annotationStore.ts", annotationStoreTs, "const migratedLegacyErasers = migrateLegacyEraserPaths(document);", "legacy erase operations must migrate during load");
assertContains("main.ts", mainTs, "await this.store.save(nextFile, this.annotationDocument);", "legacy eraser migration must persist before PDF view reattachment can cancel autosave");
assertNotContains("src/markdown/embedRender.ts", embedRenderTs, "renderEmbedEraserPath", "exports and embeds must never replay eraser paths");
assertNotContains("main.ts", mainTs, "drawEraserPath", "native redraws must never replay eraser paths");
assertNotContains("main.ts", mainTs, "if (this.lastEraserPoint && this.eraseAlongPath(pageNumber, this.lastEraserPoint, sample, false))", "eraser pointer-move must not split annotations in the input hot path");
assertNotContains("main.ts", mainTs, "let changed = this.eraseAtPoint(pageNumber, point, false);", "eraser pointer-up prelude must not run per-point mutation before the batch apply");
assertContains("main.ts", mainTs, "if (this.currentStroke || this.currentShape || this.erasingSession) {\n\t\t\tthis.cancelPendingInteractionRedraw();", "eraser pointer-up must not synchronously redraw before the eraser session closes");
assertContains("main.ts", mainTs, "private eraseCommittedLayerAtPoint(surface: PageSurface, point: AnnotationPoint): void", "eraser pointer-down must erase committed pixels without redrawing surviving strokes");
assertContains("main.ts", mainTs, "private eraseCommittedLayerAlongPath(surface: PageSurface, start: AnnotationPoint, end: AnnotationPoint): void", "eraser pointer-move must erase committed pixels along the drag path");
assertContains("main.ts", mainTs, "context.globalCompositeOperation = \"destination-out\";", "eraser preview must use pixel erasing instead of survivor rerendering");
assertContains("main.ts", mainTs, "this.eraseCommittedLayerAtPoint(surface, point);", "eraser pointer-down/up must visibly erase affected committed pixels");
assertContains("main.ts", mainTs, "this.eraseCommittedLayerAlongPath(surface, this.lastEraserPoint, sample);", "eraser pointer-move must visibly erase affected committed pixels");
assertContains("main.ts", mainTs, "this.retainCommittedPagePixels(pageNumber);", "touch eraser pointer-up must keep its pixel result without redrawing surviving strokes");
assertContains("main.ts", mainTs, "private redrawObjectErasePreview(pageNumber: number, changedTargets: SelectedTarget[]): void", "object erasing must rebuild offscreen without queueing a page render");
assertContains("main.ts", mainTs, "const excludedKeys = new Set(this.objectErasePreviewTargets.keys());", "object erasing must exclude only selected targets while rebuilding overlaps");
assertContains("main.ts", mainTs, "const renderCanvas = this.getNextPageRenderSlot(surface);", "object erasing must compose the post-erase page in an offscreen slot");
assertContains("main.ts", mainTs, "this.publishRenderedCanvas(renderCanvas, surface.overlayEl);", "object erasing must publish the completed result in one atomic pixel-frame swap");
assertNotContains("main.ts", mainTs, "context.clip();", "object erasing must not expose clipped reconstruction seams");
assertNotContains("main.ts", mainTs, "private eraseObjectTargetsFromCommittedLayer", "object erasing must not punch target geometry through the flattened canvas");
assertContains("main.ts", mainTs, "addTargets(Array.from(this.objectErasePreviewTargets.values()));", "object erase commits must use exactly the targets already removed by the live preview");
assertContains("main.ts", mainTs, "this.ensureOverlayLayerOrder(surface);\n\t\tthis.resizeOverlay(surface);", "object erase composition must synchronize canvas dimensions before swapping pixels");
assertNotContains("main.ts", mainTs, "if (this.currentTool === \"eraser\" && this.eraserMode === \"object\") {\n\t\t\tthis.hideToolPreview();", "object erasing must retain the eraser-area indicator");
assertContains("styles.css", stylesCss, "transform 90ms ease-out", "eraser indicator must animate its pointer-down and pointer-up scale state");
assertContains("main.ts", mainTs, "private previewObjectErase(pageNumber: number, start: AnnotationPoint, end: AnnotationPoint): void", "object erasing must preview whole-object disappearance");
assertContains("main.ts", mainTs, "if (this.eraserMode === \"object\") {\n\t\t\t\t\tthis.previewObjectErase(pageNumber, this.lastEraserPoint ?? sample, sample);", "object eraser movement must remove whole targets instead of drawing a segment trail");
assertContains("main.ts", mainTs, "private findObjectEraseTargetsAlongPath(", "object erasing must collect every object under its contact area");
assertContains("main.ts", mainTs, "return candidates.map((candidate) => ({", "stacked contacted strokes must disappear together instead of revealing old fragments");
assertNotContains("main.ts", mainTs, "if (this.eraserMode === \"object\") {\n\t\t\t\t\tthis.schedulePageRedraw(pageNumber);", "eraser pointer-up must never enter the page render queue");
assertNotContains("main.ts", mainTs, "this.clearCommittedLayer(surface);", "eraser preview must not clear and rerender the whole committed layer");
assertContains("main.ts", mainTs, "private flushDeferredScrollRedraws(): void", "scroll redraw flushing must be guarded");
assertContains("main.ts", mainTs, "if (this.hasActiveTransientRender()) {\n\t\t\t\tthis.scheduleCommittedRedrawAfterIdle(waitMs);\n\t\t\t\treturn;\n\t\t\t}", "committed page redraws must pause while a live stroke is active");
assertContains("main.ts", mainTs, "const remainingIdleMs = Math.max(0, waitMs - (performance.now() - this.lastInkInputTimestamp));", "committed page redraws must wait for actual input idle time");
assertContains("main.ts", mainTs, "if (!isInkDrawingTool(tool) && this.pendingCommittedRedrawPages.size > 0) {\n\t\t\tthis.flushPendingCommittedPageRedraws();\n\t\t}", "switching away from ink tools must flush queued final renders");
assertContains("main.ts", mainTs, "private showDrawingNotice(message: string, durationMs: number): void", "drawing/history notices must be routed through a setting-aware helper");
assertContains("main.ts", mainTs, "this.plugin.shouldShowDrawingNotices()", "drawing/history notice helper must honor the settings toggle");
assertContains("src/settings/settingTab.ts", read("src/settings/settingTab.ts"), "Show drawing notices", "settings must expose a drawing notice toggle");
assertContains("main.ts", mainTs, "this.pauseCommittedRenderingForInkInput();", "accepted ink pointer-down must pause stale committed redraw work");
assertNotContains("main.ts", mainTs, "if (this.pendingCommittedRedrawPages.has(pageNumber)) {\n\t\t\t\tthis.drawPageAnnotations(pageNumber);\n\t\t\t}", "starting a new ink stroke must not synchronously run pending committed rendering");
assertContains("main.ts", mainTs, "if (this.hasActiveTransientRender()) {\n\t\t\treturn;\n\t\t}", "scroll redraw flushing must not run during active transient input");
assertContains("main.ts", mainTs, "image.onload = () => this.schedulePageRedraw(imageItem.page);", "image load callbacks must use the guarded redraw scheduler");
assertNotContains("main.ts", mainTs, "freedraw-pdf perf:", "production build must not include temporary performance console logging");
assertNotContains("main.ts", mainTs, "private notePerf(", "production build must not include temporary performance instrumentation");
assertNotContains("main.ts", mainTs, "this.notePerf(", "production build must not call temporary performance instrumentation");
assertContains("main.ts", mainTs, "button.type = \"button\";", "toolbar controls must be real buttons");
assertContains("main.ts", mainTs, "button.className = \"pdf-native-annotator-button\";", "text toolbar buttons must keep the stable working button class");
assertContains("main.ts", mainTs, "button.addEventListener(\"pointerdown\", (event) => event.stopPropagation());", "toolbar buttons must stop toolbar drag on pointer down");
assertContains("main.ts", mainTs, "button.addEventListener(\"pointerup\"", "toolbar buttons must keep the known-good mouse pointerup activation path");
assertNotContains("main.ts", mainTs, "button.addEventListener(\"mousedown\"", "toolbar buttons must not use the failed mousedown experiment");
assertNotContains("main.ts", mainTs, "button.addEventListener(\"mouseup\"", "toolbar buttons must not use custom mouse-release activation");
assertContains("main.ts", mainTs, "event.pointerType !== \"mouse\"", "toolbar pointerup activation must stay scoped to mouse events");
assertContains("main.ts", mainTs, "if (handledMousePointerUp) {", "toolbar click fallback must avoid duplicate mouse activation");
assertContains("main.ts", mainTs, "onActivate(event);", "toolbar button activation must call the handler");
assertNotContains("main.ts", mainTs, "registerNotebookCommands", "standalone notebook mode commands must not be registered");
assertNotContains("main.ts", mainTs, "AnnotatorNotebookView", "standalone notebook view must not be registered");
assertNotContains("main.ts", mainTs, "NOTEBOOK_VIEW_TYPE", "standalone notebook view type must not be registered");

assertContains("styles.css", stylesCss, ".pdf-native-annotator-read-mode-hint", "read-mode hint must be styled");
assertContains("package.json", JSON.stringify(packageJson.scripts), "check:toolbar", "package scripts must expose this verifier");

if (builtMain) {
	assertContains("main.js", builtMain, "Read mode", "built bundle must include compact read-mode toolbar label");
	assertContains("main.js", builtMain, "pdf-native-annotator-read-mode-hint", "built bundle must include read-mode hint class");
	assertContains("main.js", builtMain, "addTemplatePageFromToolbar", "built bundle must wire direct + Page behavior");
	assertContains("main.js", builtMain, "isSessionShortcutActive", "built bundle must include active annotation shortcut handling");
}

console.log("Toolbar usability verifier passed.");
