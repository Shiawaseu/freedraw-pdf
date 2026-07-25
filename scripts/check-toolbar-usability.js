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
const stylesCss = read("styles.css");
const packageJson = JSON.parse(read("package.json"));
const builtMainPath = path.join(projectRoot, "main.js");
const builtMain = fs.existsSync(builtMainPath) ? fs.readFileSync(builtMainPath, "utf8") : "";

assertContains("main.ts", mainTs, "if (!this.annotationMode) {", "toolbar must have an explicit read-mode branch");
assertContains("main.ts", mainTs, "pdf-native-annotator-read-mode-hint", "read mode must be visibly labeled");
assertContains("main.ts", mainTs, "readModeHint.textContent = \"Read mode\"", "read mode label must be clear");
assertContains("main.ts", mainTs, "this.toolbarEl.appendChild(leftGroup);\n\t\t\tthis.toolbarEl.appendChild(rightGroup);\n\t\t\tthis.repositionOpenPopovers();\n\t\t\treturn;", "read mode branch must return before rendering inactive drawing controls");
assertContains("main.ts", mainTs, "this.setActiveTool(\"pen\")", "annotation mode must still switch from select to pen when enabled");
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
assertContains("main.ts", mainTs, "new Notice(\"Nothing to undo\", 1200)", "undo must show a notice when no history is available");
assertContains("main.ts", mainTs, "new Notice(`Undo applied (${this.annotationDocument.strokes.length} strokes)`, 1600)", "undo must show a notice when it applies");
assertContains("main.ts", mainTs, "new Notice(\"Nothing to redo\", 1200)", "redo must show a notice when no history is available");
assertContains("main.ts", mainTs, "new Notice(`Redo applied (${this.annotationDocument.strokes.length} strokes)`, 1600)", "redo must show a notice when it applies");
assertContains("main.ts", mainTs, "new Notice(`New stroke on page ${pageNumber}`, 900)", "stroke start must show a temporary notice while debugging recording");
assertContains("main.ts", mainTs, "new Notice(`Stroke recorded (${pointCount} points, ${this.annotationDocument.strokes.length} total)`, 1400)", "normal stroke commit must show a data-recording notice");
assertContains("main.ts", mainTs, "new Notice(`Stroke recorded before layout refresh (${pointCount} points, ${strokeCount} total)`, 1600)", "layout-refresh stroke commit must show a data-recording notice");
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
assertContains("main.ts", mainTs, "private notePerf(label: string, elapsedMs = 0): void", "temporary efficiency build must include perf instrumentation");
assertContains("main.ts", mainTs, "freedraw-pdf perf:", "temporary efficiency build must log perf summaries");
assertContains("main.ts", mainTs, "this.notePerf(\"draw transient\"", "temporary efficiency build must time live drawing redraws");
assertContains("main.ts", mainTs, "this.notePerf(\"history clone\"", "temporary efficiency build must time full-document history clones");
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
