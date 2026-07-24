import { App, FileView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { getInputMethod, isTabletWebKitTouchDevice } from "../utils/deviceUtils";
import { appendStrokePoints, drawSmoothInkStroke } from "../ink/inkEngine";
import { boundsOverlap, distanceBetween, distanceToSegment, getPolygonBounds, pathIntersectsPolygon, pointInPolygon } from "../annotation/geometry";
import { getAnnotationRenderables, getRenderableOrder, reorderRenderables } from "../annotation/renderOrder";
import type { AnnotationReorderDirection } from "../annotation/renderOrder";
import { getShapeBounds, getStrokeBounds, getTextBounds } from "../annotation/bounds";
import { cloneAnnotationsForPage, distanceToShape, distanceToStroke, getClipboardPasteOffset, getSelectionBoxPoints, pointInBounds, polygonIntersectsBounds, segmentIntersectsExpandedBounds, splitStrokeByEraser, splitStrokeByEraserPath } from "../annotation/interaction";
import { LRUCache } from "../utils/lruCache";
import { MAX_HISTORY, NOTEBOOK_VIEW_TYPE, PAPER_COLOR_PRESETS, TEXT_COLOR_PRESETS, TEXT_FONT_FAMILIES } from "../config";
import { NotebookStore, cloneNotebookDocument, normalizeNotebookZIndexes } from "../stores/notebookStore";
import { dataUrlToArrayBuffer, clamp, generateId, getBaseName } from "../utils/general";
import { writeClipboardText } from "../utils/clipboard";
import { createPdfBackedNotebookPage, createTemplateNotebookPage, getNotebookPageKindLabel, getNotebookPageSizeDimensions, getNotebookPageSizeLabel, getNotebookPageSourceSummary, getNotebookTemplateLabel } from "./pageModel";
import { drawTemplatePageBackground } from "./templateCanvas";
import { getNativePdfJs } from "../pdf/nativePdfJs";
import { getCoalescedPointerEvents, resolvePointerPressure, shouldIgnoreInkPointerEvent } from "../pointer/pointerInput";
import { getInlineTextEditorLayout, getWrappedCanvasTextLines, resizeInlineTextEditor } from "../text/textLayout";
import { PreviewStateController, ToolStateController, isShapeTool } from "../tools/toolState";
import type { AnnotationClipboardPayload, AnnotationPoint, AnnotationTool, EraserMode, HitCandidate, LassoSelection, NotebookDocument, NotebookHistoryState, NotebookPage, NotebookPageSize, NotebookTemplate, RegionReference, ResizeHandle, SelectedTarget, SelectionMode, ShapeAnnotation, StrokeAnnotation, TextAnnotation, ToolPreset, ToolPresetKind, ToolStateSnapshot } from "../types";

interface NotebookPdfSessionBridge {
	focusRegion(page: number, rect: RegionReference["rect"]): void;
}

function isDomNode(value: unknown): value is Node {
	const candidate = value as { instanceOf?: <T>(type: { new (): T }) => boolean } | null;
	return typeof candidate?.instanceOf === "function" && candidate.instanceOf(Node);
}

function isHtmlElement(value: unknown): value is HTMLElement {
	return isDomNode(value) && value.instanceOf(HTMLElement);
}

function isHtmlDivElement(value: unknown): value is HTMLDivElement {
	return isDomNode(value) && value.instanceOf(HTMLDivElement);
}

function isHtmlCanvasElement(value: unknown): value is HTMLCanvasElement {
	return isDomNode(value) && value.instanceOf(HTMLCanvasElement);
}

export interface AnnotatorNotebookPluginBridge {
	app: App;
	getStoredPresets(): ToolPreset[];
	getToolDefaults(): ToolStateSnapshot;
	updateToolPreferences(snapshot: ToolStateSnapshot, presets: ToolPreset[]): void;
	getAutosaveDelayMs(): number;
	hasClipboard(): boolean;
	getClipboard(): AnnotationClipboardPayload | null;
	setClipboard(payload: AnnotationClipboardPayload): void;
	getPreferredPdfInsertionSource(): { file: TFile; page: number } | null;
	syncSessionsForNotebook(): Promise<void>;
	getSessionForLeafForNotebook(leaf: WorkspaceLeaf | null): NotebookPdfSessionBridge | null;
}
export class AnnotatorNotebookView extends FileView {
	private document: NotebookDocument | null = null;
	private activePageId: string | null = null;
	private readonly toolState: ToolStateController;
	private readonly notebookPdfRenderCache = new LRUCache<string, HTMLCanvasElement>(24); // LRU cache with max 24 items
	private readonly notebookPdfRenderPromises = new Map<string, Promise<HTMLCanvasElement | null>>();
	private readonly notebookPdfAspectCache = new Map<string, { width: number; height: number }>();
	private backgroundEl: HTMLCanvasElement | null = null;
	private notebookCommittedEl: HTMLCanvasElement | null = null;
	private overlayEl: HTMLCanvasElement | null = null;
	private notebookToolPreviewEl: HTMLDivElement | null = null;
	private pageSurfaceEl: HTMLDivElement | null = null;
	private pageViewportEl: HTMLDivElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private viewportResizeObserver: ResizeObserver | null = null;
	private autosaveHandle: number | null = null;
	private currentStroke: StrokeAnnotation | null = null;
	private currentShape: ShapeAnnotation | null = null;
	private currentPointerId: number | null = null;
	private selectedTarget: SelectedTarget | null = null;
	private selectedTargets: SelectedTarget[] = [];
	private currentLasso: LassoSelection | null = null;
	private currentSelectionAdditive = false;
	private dragAnchor: AnnotationPoint | null = null;
	private activeResizeHandle: ResizeHandle | null = null;
	private dragMoved = false;
	private isDirty = false;
	private pageSwitchDelta = 0;
	private pageSwitchCooldownHandle: number | null = null;
	private notebookZoom = 1;
	private notebookZoomMode: "custom" | "fit-width" | "fit-page" = "fit-width";
	private notebookFlowMode: "single" | "paged" | "continuous" = "single";
	private notebookPanMode = false;
	private notebookSpacePanActive = false;
	private notebookPanAnchor: { clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null = null;
	private notebookScrollSyncHandle: number | null = null;
	private notebookScrollSettleHandle: number | null = null;
	private notebookInkRedrawHandle: number | null = null;
	private notebookBridgedPointerId: number | null = null;
	private notebookUndoStack: NotebookHistoryState[] = [];
	private notebookRedoStack: NotebookHistoryState[] = [];
	private lastNotebookPoint: { clientX: number; clientY: number } | null = null;
	private lastNotebookPointTime: number = 0;
	private lastNotebookViewportPointer: { clientX: number; clientY: number } | null = null;
	private readonly notebookPreviewState = new PreviewStateController();
	private notebookInlineTextEditorEl: HTMLTextAreaElement | null = null;
	private notebookInlineTextTargetId: string | null = null;
	private notebookInlineTextPoint: AnnotationPoint | null = null;
	private currentTextFontFamily = TEXT_FONT_FAMILIES[0];
	private currentTextFontSize = 18;
	private currentTextColor = TEXT_COLOR_PRESETS[0].color;
	private notebookColorPopoverEl: HTMLDivElement | null = null;
	private notebookStrokePopoverEl: HTMLDivElement | null = null;
	private notebookColorPopoverAnchorEl: HTMLElement | null = null;
	private notebookStrokePopoverAnchorEl: HTMLElement | null = null;
	private notebookPopoverRepositionHandle: number | null = null;
	private notebookConfirmPopoverEl: HTMLDivElement | null = null;
	private notebookRenamePopoverEl: HTMLDivElement | null = null;
	private notebookPaperColorPopoverEl: HTMLDivElement | null = null;
	private notebookPopoverBackdropEl: HTMLDivElement | null = null;
	private notebookKeyboardNudgeHistoryOpen = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly notebookStore: NotebookStore,
		private readonly plugin: AnnotatorNotebookPluginBridge
	) {
		super(leaf);
		this.toolState = new ToolStateController(this.plugin.getStoredPresets(), this.plugin.getToolDefaults());
		this.registerDomEvent(window, "keydown", this.handleNotebookKeyDown);
		this.registerDomEvent(window, "keyup", this.handleNotebookKeyUp);
		this.registerDomEvent(window, "pointermove", this.handleNotebookWindowPointerMove);
		this.registerDomEvent(window, "pointerup", this.handleNotebookWindowPointerUp);
		this.registerDomEvent(window, "pointercancel", this.handleNotebookWindowPointerCancel);
		this.registerDomEvent(window, "resize", this.scheduleNotebookPopoverReposition);
		this.registerDomEvent(window, "blur", this.handleNotebookWindowBlur);
	}

	getViewType(): string {
		return NOTEBOOK_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Annotator Notebook";
	}

	getIcon(): string {
		return "book-open";
	}

	canNavigate(offset: -1 | 1): boolean {
		if (!this.document) {
			return false;
		}
		const nextIndex = this.activePageIndex + offset;
		return nextIndex >= 0 && nextIndex < this.document.pages.length;
	}

	goToPreviousPage(): void {
		this.navigateNotebookPage(-1);
	}

	goToNextPage(): void {
		this.navigateNotebookPage(1);
	}

	hasNotebookSelection(): boolean {
		return this.selectedTargets.length > 0;
	}

	copyCurrentSelection(): void {
		this.copyNotebookSelection();
	}

	cutCurrentSelection(): void {
		this.cutNotebookSelection();
	}

	pasteCurrentClipboard(pasteInPlace = false): void {
		this.pasteNotebookClipboard(pasteInPlace);
	}

	duplicateCurrentSelection(): void {
		this.duplicateNotebookSelection();
	}

	deleteCurrentSelection(): void {
		this.deleteNotebookSelection();
	}

	bringCurrentSelectionForward(): void {
		this.reorderNotebookSelection("forward");
	}

	sendCurrentSelectionBackward(): void {
		this.reorderNotebookSelection("backward");
	}

	bringCurrentSelectionToFront(): void {
		this.reorderNotebookSelection("front");
	}

	sendCurrentSelectionToBack(): void {
		this.reorderNotebookSelection("back");
	}

	selectAllCurrentPageAnnotations(): void {
		this.selectAllNotebookPageAnnotations();
	}

	exportPageSnapshot(): Promise<TFile | null> {
		return this.exportNotebookPageSnapshot();
	}

	exportCurrentSelectionSnapshot(): Promise<TFile | null> {
		return this.exportNotebookSelectionSnapshot();
	}

	addPageAfterCurrent(): void {
		void this.insertTemplatePage("after");
	}

	addPageBeforeCurrent(): void {
		void this.insertTemplatePage("before");
	}

	addPageToEnd(): void {
		void this.insertTemplatePage("end");
	}

	addPageBefore(pageId: string): void {
		void this.insertTemplatePage("before", pageId);
	}

	addPageAfter(pageId: string): void {
		void this.insertTemplatePage("after", pageId);
	}

	addPageMenuBefore(button: HTMLButtonElement, pageId: string): void {
		this.openNotebookInlineAddMenu(button, pageId, "before");
	}

	addPageMenuAfter(button: HTMLButtonElement, pageId: string): void {
		this.openNotebookInlineAddMenu(button, pageId, "after");
	}

	insertCurrentPdfPageAfterCurrent(): void {
		void this.insertPdfBackedPage("after");
	}

	insertCurrentPdfPageBeforeCurrent(): void {
		void this.insertPdfBackedPage("before");
	}

	insertCurrentPdfPageToEnd(): void {
		void this.insertPdfBackedPage("end");
	}

	insertCurrentPdfPageBefore(pageId: string): void {
		void this.insertPdfBackedPage("before", pageId);
	}

	insertCurrentPdfPageAfter(pageId: string): void {
		void this.insertPdfBackedPage("after", pageId);
	}

	openPdfSourceForPage(pageId: string): void {
		void this.openNotebookPdfSourcePage(pageId);
	}

	focusSinglePage(pageId: string): void {
		this.focusNotebookSinglePage(pageId);
	}

	focusCurrentPageSingle(): void {
		if (!this.activePageId) {
			return;
		}
		this.focusNotebookSinglePage(this.activePageId);
	}

	hasActivePdfBackedPage(): boolean {
		return !!this.activePage?.pdfSource;
	}

	openCurrentPdfSourcePage(): void {
		if (!this.activePageId) {
			return;
		}
		void this.openNotebookPdfSourcePage(this.activePageId);
	}

	copyCurrentPdfSourceLink(): void {
		if (!this.activePageId) {
			return;
		}
		void this.copyNotebookPdfSourceLink(this.activePageId);
	}

	moveCurrentPageToTop(): void {
		if (!this.activePageId) {
			return;
		}
		void this.movePageToBoundary(this.activePageId, "start");
	}

	moveCurrentPageToBottom(): void {
		if (!this.activePageId) {
			return;
		}
		void this.movePageToBoundary(this.activePageId, "end");
	}

	renameCurrentPage(): void {
		if (!this.activePageId) {
			return;
		}
		void this.renamePage(this.activePageId);
	}

	toggleNotebookFlowMode(): void {
		this.notebookFlowMode =
			this.notebookFlowMode === "single"
				? "paged"
				: this.notebookFlowMode === "paged"
					? "continuous"
					: "single";
		this.render();
	}

	setNotebookFlowMode(mode: "single" | "paged" | "continuous"): void {
		if (this.notebookFlowMode === mode) {
			return;
		}
		this.notebookFlowMode = mode;
		this.render();
	}

	toggleNotebookPanMode(): void {
		this.notebookPanMode = !this.notebookPanMode;
		this.notebookPanAnchor = null;
		this.refreshNotebookCursor();
		this.renderNotebookToolbar();
	}

	fitCurrentPageWidth(): void {
		this.fitNotebookToWidth();
	}

	fitCurrentPageView(): void {
		this.fitNotebookToPage();
	}

	duplicateCurrentPage(): void {
		void this.duplicateActivePage();
	}

	duplicateCurrentPageStructure(): void {
		void this.duplicateActivePage(false);
	}

	clearCurrentPageContents(): void {
		void this.clearActivePageContents();
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.document = await this.notebookStore.load(file);
		if (normalizeNotebookZIndexes(this.document)) {
			this.markNotebookDirty();
		}
		this.activePageId = this.document.pages[0]?.id ?? null;
		this.notebookUndoStack = [];
		this.notebookRedoStack = [];
		this.render();
	}

	async onClose(): Promise<void> {
		this.finishNotebookInlineTextEditor(false);
		await this.flushSave();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.viewportResizeObserver?.disconnect();
		this.viewportResizeObserver = null;
		if (this.notebookScrollSyncHandle !== null) {
			window.cancelAnimationFrame(this.notebookScrollSyncHandle);
			this.notebookScrollSyncHandle = null;
		}
		if (this.notebookScrollSettleHandle !== null) {
			window.clearTimeout(this.notebookScrollSettleHandle);
			this.notebookScrollSettleHandle = null;
		}
		if (this.notebookInkRedrawHandle !== null) {
			window.cancelAnimationFrame(this.notebookInkRedrawHandle);
			this.notebookInkRedrawHandle = null;
		}
		if (this.notebookPopoverRepositionHandle !== null) {
			window.cancelAnimationFrame(this.notebookPopoverRepositionHandle);
			this.notebookPopoverRepositionHandle = null;
		}
		if (this.pageSwitchCooldownHandle !== null) {
			window.clearTimeout(this.pageSwitchCooldownHandle);
			this.pageSwitchCooldownHandle = null;
		}
		this.closeNotebookColorPopover();
		this.closeNotebookStrokePopover();
		this.closeNotebookConfirmPopover();
		this.closeNotebookRenamePopover();
		this.closeNotebookPaperColorPopover();
		this.forceRemoveNotebookPopoverBackdrop();
		this.notebookKeyboardNudgeHistoryOpen = false;
		this.contentEl.empty();
	}

	private async saveNotebook(): Promise<void> {
		if (!this.file || !this.document) {
			return;
		}
		this.isDirty = false;
		await this.notebookStore.save(this.file, this.document);
	}

	private get activePage(): NotebookPage | null {
		if (!this.document || !this.activePageId) {
			return null;
		}
		return this.document.pages.find((page) => page.id === this.activePageId) ?? this.document.pages[0] ?? null;
	}

	private get activePageIndex(): number {
		if (!this.document || !this.activePageId) {
			return 0;
		}
		const index = this.document.pages.findIndex((page) => page.id === this.activePageId);
		return index >= 0 ? index : 0;
	}

	private get currentTool(): AnnotationTool {
		return this.toolState.activeTool;
	}

	private get currentColor(): string {
		return this.toolState.activeColor;
	}

	private get currentOpacity(): number {
		return this.toolState.activeOpacity;
	}

	private getActiveWidth(): number {
		return this.toolState.getWidth();
	}

	private setActiveTool(tool: AnnotationTool): void {
		if (this.notebookInlineTextEditorEl && tool !== "text") {
			this.finishNotebookInlineTextEditor(true);
		}
		if (tool !== "select" && this.selectedTargets.length > 0) {
			this.clearNotebookSelection();
		}
		this.toolState.setActiveTool(tool);
		this.persistToolDefaults();
		this.renderNotebookToolbar();
		this.refreshNotebookCursor();
		if (tool === "eraser") {
			this.refreshNotebookToolPreviewFromLastPointer(false);
		} else {
			this.hideNotebookToolPreview();
		}
	}

	private setCurrentColor(color: string): void {
		this.toolState.setColor(color);
		this.persistToolDefaults();
		if (this.notebookInlineTextEditorEl) {
			this.notebookInlineTextEditorEl.dataset.textColor = color;
			this.notebookInlineTextEditorEl.setCssStyles({ color });
		}
		this.renderNotebookToolbar();
	}

	private getNotebookActivePresetKind(): ToolPresetKind | null {
		if (this.currentTool === "pen" || this.currentTool === "highlighter" || this.currentTool === "eraser") {
			return this.currentTool;
		}
		return null;
	}

	private shouldApplyStyleToNotebookSelection(): boolean {
		return this.currentTool === "select" && this.selectedTargets.length > 0;
	}

	private setSelectionMode(mode: SelectionMode): void {
		this.toolState.setSelectionMode(mode);
		this.persistToolDefaults();
		if (mode !== "lasso") {
			this.currentLasso = null;
		}
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private persistToolDefaults(): void {
		this.plugin.updateToolPreferences(this.toolState.snapshot, this.toolState.presetsSnapshot);
	}

	private clearNotebookInteractionState(): void {
		this.selectedTarget = null;
		this.selectedTargets = [];
		this.currentLasso = null;
		this.currentSelectionAdditive = false;
		this.dragAnchor = null;
		this.activeResizeHandle = null;
		this.dragMoved = false;
	}

	private getNextNotebookPageTitle(): string {
		return `Page ${this.document ? this.document.pages.length + 1 : 1}`;
	}

	private buildTemplatePageFromActive(title?: string): NotebookPage {
		return createTemplateNotebookPage(
			title ?? this.getNextNotebookPageTitle(),
			this.activePage?.template ?? "ruled",
			this.activePage?.pageSize ?? "a4",
			this.activePage?.paperColor ?? "#fffdf7"
		);
	}

	private cloneNotebookPage(page: NotebookPage, title?: string, includeAnnotations = true): NotebookPage {
		const clonedAnnotations = includeAnnotations
			? cloneAnnotationsForPage(page.strokes, page.textItems, page.shapes, 1)
			: { strokes: [], textItems: [], shapes: [] };
		return {
			id: generateId("page"),
			title: title ?? `${page.title} copy`,
			kind: page.kind,
			sourceLabel: page.sourceLabel,
			pdfSource: page.pdfSource ? { ...page.pdfSource } : undefined,
			template: page.template,
			paperColor: page.paperColor,
			pageSize: page.pageSize,
			strokes: clonedAnnotations.strokes,
			textItems: clonedAnnotations.textItems,
			shapes: clonedAnnotations.shapes
		};
	}

	private buildPdfBackedPageFromPreferredSource(title?: string): NotebookPage | null {
		const source = this.plugin.getPreferredPdfInsertionSource();
		if (!source) {
			return null;
		}
		return createPdfBackedNotebookPage(
			title ?? `${getBaseName(source.file)} page ${source.page}`,
			source.file,
			source.page,
			this.activePage?.pageSize ?? "a4",
			this.activePage?.paperColor ?? "#fffdf7"
		);
	}

	private async insertNotebookTextAtPoint(point: AnnotationPoint): Promise<void> {
		this.beginNotebookInlineTextEditor(point);
	}

	private beginNotebookInlineTextEditor(point: AnnotationPoint, existingItem?: TextAnnotation): void {
		const context = this.getNotebookContext();
		if (!context || this.notebookInlineTextEditorEl) {
			return;
		}
		const editor = createEl("textarea");
		editor.className = "annotator-notebook-inline-text-editor";
		const initialText = existingItem?.text ?? "";
		editor.value = initialText;
		const baseFontSize = existingItem?.fontScale
			? Math.max(12, existingItem.fontScale * context.width)
			: existingItem?.fontSize ?? 18;
		const layout = getInlineTextEditorLayout(point, context.width, context.height, existingItem);
		if (existingItem) {
			this.currentTextFontFamily = existingItem.fontFamily ?? this.currentTextFontFamily;
			this.currentTextFontSize = Math.round(baseFontSize);
			this.currentTextColor = existingItem.color ?? this.currentTextColor;
		}
		editor.wrap = "soft";
		editor.placeholder = "Type text";
		editor.dataset.textColor = existingItem?.color ?? this.currentTextColor;
		editor.dataset.fontSize = String(baseFontSize);
		editor.setCssStyles({
			left: `${layout.left}px`,
			top: `${layout.top}px`,
			width: `${layout.width}px`,
			color: existingItem?.color ?? this.currentTextColor,
			fontSize: `${baseFontSize}px`
		});
		context.surfaceEl.appendChild(editor);
		this.notebookInlineTextEditorEl = editor;
		this.notebookInlineTextTargetId = existingItem?.id ?? null;
		this.notebookInlineTextPoint = layout.point;
		const resizeEditor = (): void => {
			resizeInlineTextEditor(editor, context.height * 0.42);
		};
		const commit = (): void => {
			this.finishNotebookInlineTextEditor(true);
		};
		editor.addEventListener("input", resizeEditor);
		editor.addEventListener("blur", commit, { once: true });
		editor.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.finishNotebookInlineTextEditor(false);
				return;
			}
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				commit();
			}
		});
		resizeEditor();
		window.setTimeout(() => {
			editor.focus();
			editor.setSelectionRange(editor.value.length, editor.value.length);
		}, 0);
	}

	private finishNotebookInlineTextEditor(apply: boolean): void {
		const editor = this.notebookInlineTextEditorEl;
		const point = this.notebookInlineTextPoint;
		const page = this.activePage;
		const context = this.getNotebookContext();
		const targetId = this.notebookInlineTextTargetId;
		const value = (editor?.value ?? "").replace(/\r\n/g, "\n");
		const editorRect = editor?.getBoundingClientRect() ?? null;
		if (editor) {
			editor.remove();
		}
		this.notebookInlineTextEditorEl = null;
		this.notebookInlineTextPoint = null;
		this.notebookInlineTextTargetId = null;
		if (!apply || !page || !context || !point) {
			return;
		}
		if (!value.trim() && !targetId) {
			return;
		}
		this.pushNotebookHistory();
		if (targetId) {
			const existing = page.textItems.find((entry) => entry.id === targetId);
			if (existing) {
				if (!value.trim()) {
					page.textItems = page.textItems.filter((entry) => entry.id !== targetId);
					this.selectedTarget = null;
					this.selectedTargets = [];
					this.markNotebookDirty();
					this.renderNotebookToolbar();
					this.drawNotebookPage();
					return;
				}
				existing.text = value;
				existing.x = point.x;
				existing.y = point.y;
				existing.color = editor?.dataset.textColor || existing.color || this.currentTextColor;
				existing.boxWidthScale = editorRect ? editorRect.width / Math.max(context.width, 1) : existing.boxWidthScale;
				this.selectedTarget = { kind: "text", id: existing.id, page: 1 };
				this.selectedTargets = [this.selectedTarget];
			}
		} else if (value.trim()) {
			const fontSize = editor ? parseFloat(editor.dataset.fontSize ?? "") || 18 : 18;
			const nextText: TextAnnotation = {
				id: generateId("text"),
				page: 1,
				text: value,
				x: point.x,
				y: point.y,
				color: this.currentTextColor,
				fontSize,
				fontScale: fontSize / Math.max(context.width, 1),
				boxWidthScale: editorRect ? editorRect.width / Math.max(context.width, 1) : undefined,
				zIndex: this.getNextNotebookZIndex(page),
				createdAt: new Date().toISOString()
			};
			page.textItems.push(nextText);
			this.selectedTarget = { kind: "text", id: nextText.id, page: 1 };
			this.selectedTargets = [this.selectedTarget];
		}
		this.markNotebookDirty();
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private selectNotebookPage(pageId: string, direction: -1 | 0 | 1 = 0): void {
		if (!this.document || this.activePageId === pageId) {
			return;
		}
		this.activePageId = pageId;
		this.clearNotebookInteractionState();
		if (this.notebookFlowMode !== "single") {
			this.rerenderNotebookPreservingViewport();
		} else {
			this.render();
		}
		window.requestAnimationFrame(() => {
			const activeItem = this.contentEl.querySelector(".annotator-notebook-page-item.is-active");
			if (isHtmlElement(activeItem)) {
				activeItem.scrollIntoView({ block: "nearest" });
			}
			const selector = `.annotator-notebook-page[data-page-id="${pageId}"]`;
			const pageEl = this.contentEl.querySelector(selector) ?? this.contentEl.querySelector(".annotator-notebook-page");
			if (isHtmlElement(pageEl)) {
				if (this.notebookFlowMode === "continuous") {
					pageEl.scrollIntoView({ block: "nearest" });
				} else if (this.notebookFlowMode === "paged") {
					pageEl.scrollIntoView({ block: "center", behavior: "smooth" });
				} else {
					pageEl.classList.add(direction > 0 ? "is-enter-from-bottom" : direction < 0 ? "is-enter-from-top" : "is-enter-fade");
					window.requestAnimationFrame(() => {
						pageEl.classList.remove("is-enter-from-bottom", "is-enter-from-top", "is-enter-fade");
					});
				}
			}
		});
	}

	private rerenderNotebookPreservingViewport(): void {
		const viewport = this.pageViewportEl;
		const previousScrollTop = viewport?.scrollTop ?? 0;
		const previousScrollLeft = viewport?.scrollLeft ?? 0;
		this.render();
		window.requestAnimationFrame(() => {
			if (this.pageViewportEl) {
				this.pageViewportEl.scrollTop = previousScrollTop;
				this.pageViewportEl.scrollLeft = previousScrollLeft;
			}
		});
	}

	private refreshNotebookViewAfterStructureChange(): void {
		if (this.notebookFlowMode !== "single") {
			this.rerenderNotebookPreservingViewport();
			return;
		}
		this.render();
	}

	private focusNotebookSinglePage(pageId: string): void {
		if (!this.document) {
			return;
		}
		if (this.activePageId !== pageId) {
			this.activePageId = pageId;
			this.clearNotebookInteractionState();
		}
		this.notebookFlowMode = "single";
		this.render();
	}

	private navigateNotebookPage(offset: -1 | 1): void {
		if (!this.document) {
			return;
		}
		const nextIndex = this.activePageIndex + offset;
		if (nextIndex < 0 || nextIndex >= this.document.pages.length) {
			return;
		}
		const nextPage = this.document.pages[nextIndex];
		if (!nextPage) {
			return;
		}
		this.selectNotebookPage(nextPage.id, offset);
	}

	private scheduleAutosave(): void {
		if (this.autosaveHandle !== null) {
			window.clearTimeout(this.autosaveHandle);
		}
		this.autosaveHandle = window.setTimeout(() => {
			this.autosaveHandle = null;
			void this.flushSave();
		}, this.plugin.getAutosaveDelayMs());
	}

	private async flushSave(): Promise<void> {
		if (!this.isDirty) {
			return;
		}
		await this.saveNotebook();
	}

	private markNotebookDirty(): void {
		this.isDirty = true;
		this.scheduleAutosave();
	}

	private pushNotebookHistory(): void {
		if (!this.document) {
			return;
		}
		this.notebookUndoStack.push({
			document: cloneNotebookDocument(this.document),
			activePageId: this.activePageId
		});
		if (this.notebookUndoStack.length > MAX_HISTORY) {
			this.notebookUndoStack.shift();
		}
		this.notebookRedoStack = [];
	}

	private restoreNotebookHistoryState(state: NotebookHistoryState): void {
		this.document = cloneNotebookDocument(state.document);
		this.activePageId = state.activePageId ?? this.document.pages[0]?.id ?? null;
		if (this.activePageId && !this.document.pages.some((page) => page.id === this.activePageId)) {
			this.activePageId = this.document.pages[0]?.id ?? null;
		}
		this.clearNotebookInteractionState();
		this.currentStroke = null;
		this.currentShape = null;
		this.currentPointerId = null;
		this.notebookBridgedPointerId = null;
		this.isDirty = true;
		this.scheduleAutosave();
		this.render();
	}

	undoNotebook(): void {
		if (!this.document || this.notebookUndoStack.length === 0) {
			return;
		}
		this.notebookRedoStack.push({
			document: cloneNotebookDocument(this.document),
			activePageId: this.activePageId
		});
		const previous = this.notebookUndoStack.pop();
		if (!previous) {
			return;
		}
		this.restoreNotebookHistoryState(previous);
	}

	redoNotebook(): void {
		if (!this.document || this.notebookRedoStack.length === 0) {
			return;
		}
		this.notebookUndoStack.push({
			document: cloneNotebookDocument(this.document),
			activePageId: this.activePageId
		});
		const next = this.notebookRedoStack.pop();
		if (!next) {
			return;
		}
		this.restoreNotebookHistoryState(next);
	}

	private isNotebookInteractionActive(): boolean {
		return this.currentPointerId !== null || this.notebookBridgedPointerId !== null || this.notebookPanAnchor !== null;
	}

	private getNotebookContext():
		| {
			page: NotebookPage;
			surfaceEl: HTMLDivElement;
			backgroundEl: HTMLCanvasElement;
			committedEl: HTMLCanvasElement;
			overlayEl: HTMLCanvasElement;
			width: number;
			height: number;
		  }
		| null {
		if (!this.activePage || !this.pageSurfaceEl || !this.backgroundEl || !this.notebookCommittedEl || !this.overlayEl) {
			return null;
		}
		const rect = this.pageSurfaceEl.getBoundingClientRect();
		return {
			page: this.activePage,
			surfaceEl: this.pageSurfaceEl,
			backgroundEl: this.backgroundEl,
			committedEl: this.notebookCommittedEl,
			overlayEl: this.overlayEl,
			width: Math.max(1, Math.round(rect.width)),
			height: Math.max(1, Math.round(rect.height))
		};
	}

	private getNotebookPdfSourceKey(page: NotebookPage): string | null {
		return page.kind === "pdf" && page.pdfSource
			? `${page.pdfSource.filePath}::${page.pdfSource.page}`
			: null;
	}

	private getNotebookPdfRenderKey(page: NotebookPage, width: number, height: number): string | null {
		const sourceKey = this.getNotebookPdfSourceKey(page);
		return sourceKey ? `${sourceKey}::${width}x${height}` : null;
	}

	private async loadNotebookPdfCanvas(page: NotebookPage, width: number, height: number): Promise<HTMLCanvasElement | null> {
		if (page.kind !== "pdf" || !page.pdfSource) {
			return null;
		}
		const sourceFile = this.app.vault.getAbstractFileByPath(page.pdfSource.filePath);
		if (!(sourceFile instanceof TFile)) {
			return null;
		}
		const binary = await this.app.vault.adapter.readBinary(sourceFile.path);
		const pdfjsLib = getNativePdfJs();
		const loadingTask = pdfjsLib.getDocument({
			data: new Uint8Array(binary),
			disableWorker: true,
			isEvalSupported: false,
			useWorkerFetch: false
		});
		try {
			const pdfDocument = await loadingTask.promise;
			const pdfPage = await pdfDocument.getPage(page.pdfSource.page);
			const baseViewport = pdfPage.getViewport({ scale: 1 });
			const scale = Math.min(width / Math.max(baseViewport.width, 1), height / Math.max(baseViewport.height, 1));
			const viewport = pdfPage.getViewport({ scale });
			const canvas = createEl("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (!context) {
				await pdfDocument.destroy();
				return null;
			}
			context.fillStyle = page.paperColor;
			context.fillRect(0, 0, width, height);
			const offsetX = (width - viewport.width) / 2;
			const offsetY = (height - viewport.height) / 2;
			context.save();
			context.translate(offsetX, offsetY);
			await pdfPage.render({
				canvasContext: context,
				viewport
			}).promise;
			context.restore();
			this.notebookPdfAspectCache.set(this.getNotebookPdfSourceKey(page) ?? "", {
				width: baseViewport.width,
				height: baseViewport.height
			});
			await pdfDocument.destroy();
			return canvas;
		} finally {
			await loadingTask.destroy();
		}
	}

	private requestNotebookPdfCanvas(
		page: NotebookPage,
		width: number,
		height: number,
		onReady: () => void
	): HTMLCanvasElement | null {
		const cacheKey = this.getNotebookPdfRenderKey(page, width, height);
		if (!cacheKey) {
			return null;
		}
		const cached = this.notebookPdfRenderCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		if (!this.notebookPdfRenderPromises.has(cacheKey)) {
			const promise = this.loadNotebookPdfCanvas(page, width, height)
				.then((canvas) => {
					if (canvas) {
						this.notebookPdfRenderCache.set(cacheKey, canvas);
					}
					return canvas;
				})
				.catch((error) => {
					console.error("freedraw-pdf: failed to render notebook PDF page", error);
					return null;
				})
				.finally(() => {
					this.notebookPdfRenderPromises.delete(cacheKey);
					onReady();
				});
			this.notebookPdfRenderPromises.set(cacheKey, promise);
		}
		return null;
	}

	private resizeNotebookOverlay(): void {
		const context = this.getNotebookContext();
		if (!context) {
			return;
		}
		const ratio = window.devicePixelRatio || 1;
		for (const canvasEl of [context.backgroundEl, context.committedEl, context.overlayEl]) {
			canvasEl.width = Math.max(1, Math.round(context.width * ratio));
			canvasEl.height = Math.max(1, Math.round(context.height * ratio));
			canvasEl.setCssStyles({
				width: `${context.width}px`,
				height: `${context.height}px`
			});
		}
		this.renderNotebookBackgroundLayer();
		this.drawNotebookPage();
	}

	private readonly handleNotebookWheel = (event: WheelEvent): void => {
		if (!this.document || !this.pageViewportEl) {
			return;
		}
		if (this.currentPointerId !== null) {
			return;
		}
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			const direction = event.deltaY > 0 ? -0.06 : 0.06;
			if (this.activePage) {
				this.lastNotebookViewportPointer = { clientX: event.clientX, clientY: event.clientY };
				this.setNotebookZoom(this.getEffectiveNotebookZoom(this.activePage) + direction);
			}
			return;
		}
		if (this.notebookFlowMode === "continuous") {
			this.pageSwitchDelta = 0;
			return;
		}
		if (this.document.pages.length < 2) {
			return;
		}
		const viewport = this.pageViewportEl;
		const atTop = viewport.scrollTop <= 2;
		const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
		const wantsPrevious = event.deltaY < 0;
		const wantsNext = event.deltaY > 0;
		if ((wantsPrevious && !atTop) || (wantsNext && !atBottom)) {
			this.pageSwitchDelta = 0;
			return;
		}
		this.pageSwitchDelta += event.deltaY;
		if (Math.abs(this.pageSwitchDelta) < 140) {
			return;
		}
		event.preventDefault();
		const direction: -1 | 1 = this.pageSwitchDelta > 0 ? 1 : -1;
		this.pageSwitchDelta = 0;
		if (this.pageSwitchCooldownHandle !== null) {
			return;
		}
		this.navigateNotebookPage(direction);
		this.pageSwitchCooldownHandle = window.setTimeout(() => {
			this.pageSwitchCooldownHandle = null;
		}, 220);
	};

	private readonly handleNotebookViewportScroll = (): void => {
		this.scheduleNotebookPopoverReposition();
		if (this.notebookFlowMode === "single" || !this.pageViewportEl || !this.document) {
			return;
		}
		if (this.isNotebookInteractionActive()) {
			return;
		}
		if (this.notebookScrollSyncHandle !== null) {
			window.cancelAnimationFrame(this.notebookScrollSyncHandle);
		}
		this.notebookScrollSyncHandle = window.requestAnimationFrame(() => {
			this.notebookScrollSyncHandle = null;
			if (!this.pageViewportEl || !this.document || this.isNotebookInteractionActive()) {
				return;
			}
			const viewport = this.pageViewportEl;
			const viewportRect = viewport.getBoundingClientRect();
			const viewportCenter = viewportRect.top + viewportRect.height / 2;
			let bestPageId: string | null = null;
			let bestDistance = Number.POSITIVE_INFINITY;
			const pageElements = viewport.querySelectorAll(".annotator-notebook-page");
			pageElements.forEach((pageNode) => {
				if (!isHtmlDivElement(pageNode)) {
					return;
				}
				const rect = pageNode.getBoundingClientRect();
				const center = rect.top + rect.height / 2;
				const distance = Math.abs(center - viewportCenter);
				if (distance < bestDistance) {
					bestDistance = distance;
					bestPageId = pageNode.dataset.pageId ?? null;
				}
			});
			const pagePosition = this.contentEl.querySelector(".annotator-notebook-page-position[data-role='visible-page']");
			if (isHtmlDivElement(pagePosition) && bestPageId) {
				const index = this.document.pages.findIndex((page) => page.id === bestPageId);
				if (index >= 0) {
					pagePosition.textContent = this.notebookFlowMode === "paged"
						? `Page ${index + 1} of ${this.document.pages.length}`
						: `View ${index + 1} of ${this.document.pages.length}`;
					if (this.notebookFlowMode === "paged") {
						if (this.notebookScrollSettleHandle !== null) {
							window.clearTimeout(this.notebookScrollSettleHandle);
						}
						this.notebookScrollSettleHandle = window.setTimeout(() => {
							this.notebookScrollSettleHandle = null;
							if (!this.document || this.activePageId === bestPageId || this.isNotebookInteractionActive()) {
								return;
							}
							this.activePageId = bestPageId;
							this.renderNotebookToolbar();
						}, 90);
					}
				}
			}
		});
	};

	private readonly handleNotebookViewportPointerMove = (event: PointerEvent): void => {
		this.lastNotebookViewportPointer = {
			clientX: event.clientX,
			clientY: event.clientY
		};
	};

	private getNotebookBaseDimensions(page: NotebookPage): { width: number; height: number } {
		const base = getNotebookPageSizeDimensions(page.pageSize);
		const baseWidth = base.width;
		const baseHeight = base.height;
		if (page.kind === "pdf") {
			const sourceKey = this.getNotebookPdfSourceKey(page);
			const sourceAspect = sourceKey ? this.notebookPdfAspectCache.get(sourceKey) : null;
			if (sourceAspect && sourceAspect.width > 0 && sourceAspect.height > 0) {
				return {
					width: baseWidth,
					height: Math.round(baseWidth * (sourceAspect.height / sourceAspect.width))
				};
			}
		}
		return { width: baseWidth, height: baseHeight };
	}

	private getEffectiveNotebookZoom(page: NotebookPage): number {
		if ((this.notebookZoomMode === "fit-width" || this.notebookZoomMode === "fit-page") && this.pageViewportEl) {
			const base = this.getNotebookBaseDimensions(page);
			const horizontalPadding = this.notebookFlowMode === "continuous" ? 24 : 8;
			const availableWidth = Math.max(320, this.pageViewportEl.clientWidth - horizontalPadding);
			if (this.notebookZoomMode === "fit-page") {
				const availableHeight = Math.max(240, this.pageViewportEl.clientHeight - 12);
				return clamp(Math.min(availableWidth / base.width, availableHeight / base.height), 0.55, 2.4);
			}
			return clamp(availableWidth / base.width, 0.55, 2.4);
		}
		return this.notebookZoom;
	}

	private applyNotebookPageMetrics(): void {
		if (!this.document) {
			return;
		}
		const pageElements = this.contentEl.querySelectorAll(".annotator-notebook-page");
		pageElements.forEach((pageNode) => {
			if (!isHtmlDivElement(pageNode)) {
				return;
			}
			const pageId = pageNode.dataset.pageId;
			const page = this.document?.pages.find((entry) => entry.id === pageId);
			const pageSurface = pageNode.querySelector(".annotator-notebook-page-surface");
			if (!page || !isHtmlDivElement(pageSurface)) {
				return;
			}
			const base = this.getNotebookBaseDimensions(page);
			const zoom = this.getEffectiveNotebookZoom(page);
			pageNode.setCssStyles({ width: `${Math.round(base.width * zoom)}px` });
			pageSurface.setCssStyles({
				minHeight: `${Math.round(base.height * zoom)}px`,
				height: `${Math.round(base.height * zoom)}px`
			});
		});
	}

	private preserveNotebookViewportCenter(transform: () => void): void {
		const viewport = this.pageViewportEl;
		if (!viewport) {
			transform();
			return;
		}
		const previousScrollWidth = Math.max(1, viewport.scrollWidth);
		const previousScrollHeight = Math.max(1, viewport.scrollHeight);
		const centerXRatio = (viewport.scrollLeft + viewport.clientWidth / 2) / previousScrollWidth;
		const centerYRatio = (viewport.scrollTop + viewport.clientHeight / 2) / previousScrollHeight;
		transform();
		window.requestAnimationFrame(() => {
			const nextScrollWidth = Math.max(1, viewport.scrollWidth);
			const nextScrollHeight = Math.max(1, viewport.scrollHeight);
			viewport.scrollLeft = Math.max(0, centerXRatio * nextScrollWidth - viewport.clientWidth / 2);
			viewport.scrollTop = Math.max(0, centerYRatio * nextScrollHeight - viewport.clientHeight / 2);
		});
	}

	private preserveNotebookViewportAnchor(
		transform: () => void,
		anchorClientX?: number,
		anchorClientY?: number
	): void {
		const viewport = this.pageViewportEl;
		if (!viewport) {
			transform();
			return;
		}
		const viewportRect = viewport.getBoundingClientRect();
		const fallbackX = viewportRect.left + viewport.clientWidth / 2;
		const fallbackY = viewportRect.top + viewport.clientHeight / 2;
		const clientX = anchorClientX ?? this.lastNotebookViewportPointer?.clientX ?? fallbackX;
		const clientY = anchorClientY ?? this.lastNotebookViewportPointer?.clientY ?? fallbackY;
		const contentX = viewport.scrollLeft + (clientX - viewportRect.left);
		const contentY = viewport.scrollTop + (clientY - viewportRect.top);
		const anchorRatioX = contentX / Math.max(1, viewport.scrollWidth);
		const anchorRatioY = contentY / Math.max(1, viewport.scrollHeight);
		const viewportOffsetX = clamp(clientX - viewportRect.left, 0, viewport.clientWidth);
		const viewportOffsetY = clamp(clientY - viewportRect.top, 0, viewport.clientHeight);
		transform();
		window.requestAnimationFrame(() => {
			const nextScrollWidth = Math.max(1, viewport.scrollWidth);
			const nextScrollHeight = Math.max(1, viewport.scrollHeight);
			viewport.scrollLeft = Math.max(0, anchorRatioX * nextScrollWidth - viewportOffsetX);
			viewport.scrollTop = Math.max(0, anchorRatioY * nextScrollHeight - viewportOffsetY);
		});
	}

	private setNotebookZoom(nextZoom: number): void {
		this.preserveNotebookViewportAnchor(() => {
			this.notebookZoomMode = "custom";
			this.notebookZoom = clamp(nextZoom, 0.55, 2.4);
			this.applyNotebookPageMetrics();
			this.resizeNotebookOverlay();
			this.refreshNotebookStaticPages();
			this.renderNotebookToolbar();
		});
	}

	private fitNotebookToWidth(): void {
		this.preserveNotebookViewportAnchor(() => {
			this.notebookZoomMode = "fit-width";
			this.applyNotebookPageMetrics();
			this.resizeNotebookOverlay();
			this.refreshNotebookStaticPages();
			this.renderNotebookToolbar();
		});
	}

	private fitNotebookToPage(): void {
		this.preserveNotebookViewportAnchor(() => {
			this.notebookZoomMode = "fit-page";
			this.applyNotebookPageMetrics();
			this.resizeNotebookOverlay();
			this.refreshNotebookStaticPages();
			this.renderNotebookToolbar();
		});
	}

	private getNotebookPoint(event: PointerEvent): AnnotationPoint | null {
		if (!this.overlayEl) {
			return null;
		}
		const rect = this.overlayEl.getBoundingClientRect();
		const width = rect.width || 1;
		const height = rect.height || 1;
		const pressure = resolvePointerPressure(event, this.lastNotebookPoint, this.lastNotebookPointTime);
		const point = {
			x: clamp((event.clientX - rect.left) / width, 0, 1),
			y: clamp((event.clientY - rect.top) / height, 0, 1),
			pressure,
			t: event.timeStamp || performance.now()
		};
		this.lastNotebookPoint = { clientX: event.clientX, clientY: event.clientY };
		this.lastNotebookPointTime = event.timeStamp;
		return point;
	}

	private getNotebookPoints(event: PointerEvent): AnnotationPoint[] {
		return getCoalescedPointerEvents(event)
			.map((sample) => this.getNotebookPoint(sample))
			.filter((point): point is AnnotationPoint => !!point);
	}

	private drawNotebookPage(): void {
		const context = this.getNotebookContext();
		if (!context) {
			return;
		}
		const committedContext = context.committedEl.getContext("2d");
		if (!committedContext) {
			return;
		}
		const ratio = window.devicePixelRatio || 1;
		committedContext.setTransform(ratio, 0, 0, ratio, 0, 0);
		committedContext.clearRect(0, 0, context.width, context.height);
		for (const renderable of getAnnotationRenderables(context.page.strokes, context.page.textItems, context.page.shapes)) {
			if (renderable.kind === "stroke") {
				this.drawNotebookStroke(committedContext, context.width, context.height, renderable.annotation);
			} else if (renderable.kind === "text") {
				this.drawNotebookText(committedContext, context.width, context.height, renderable.annotation);
			} else {
				this.drawNotebookShape(committedContext, context.width, context.height, renderable.annotation);
			}
		}
		this.drawNotebookOverlayLayer();
	}

	private drawNotebookOverlayLayer(): void {
		const context = this.getNotebookContext();
		if (!context) {
			return;
		}
		const overlayContext = context.overlayEl.getContext("2d");
		if (!overlayContext) {
			return;
		}
		const ratio = window.devicePixelRatio || 1;
		overlayContext.setTransform(ratio, 0, 0, ratio, 0, 0);
		overlayContext.clearRect(0, 0, context.width, context.height);
		if (this.currentStroke) {
			this.drawNotebookStroke(overlayContext, context.width, context.height, this.currentStroke, true);
		}
		if (this.currentShape) {
			this.drawNotebookShape(overlayContext, context.width, context.height, this.currentShape);
		}
		if (this.selectedTargets.length > 0) {
			this.drawNotebookSelection(overlayContext, context.width, context.height, this.selectedTargets);
		}
		if (this.currentLasso) {
			this.drawNotebookLasso(overlayContext, context.width, context.height, this.currentLasso);
		}
	}

	private scheduleNotebookInkRedraw(): void {
		if (this.notebookInkRedrawHandle !== null) {
			return;
		}
		this.notebookInkRedrawHandle = window.requestAnimationFrame(() => {
			this.notebookInkRedrawHandle = null;
			this.drawNotebookOverlayLayer();
		});
	}

	private flushNotebookInkRedraw(): void {
		if (this.notebookInkRedrawHandle !== null) {
			window.cancelAnimationFrame(this.notebookInkRedrawHandle);
			this.notebookInkRedrawHandle = null;
		}
		this.drawNotebookOverlayLayer();
	}

	private renderNotebookBackgroundLayer(): void {
		const context = this.getNotebookContext();
		if (!context) {
			return;
		}
		const backgroundContext = context.backgroundEl.getContext("2d");
		if (!backgroundContext) {
			return;
		}
		const ratio = window.devicePixelRatio || 1;
		backgroundContext.setTransform(ratio, 0, 0, ratio, 0, 0);
		backgroundContext.clearRect(0, 0, context.width, context.height);
		this.renderNotebookPageBackground(
			backgroundContext,
			context.width,
			context.height,
			context.page
		);
	}

	private drawNotebookStroke(
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
		stroke: StrokeAnnotation,
		predictTail = false
	): void {
		if (stroke.points.length === 0) {
			return;
		}
		if (!stroke.widthScale || stroke.widthScale <= 0) {
			stroke.widthScale = stroke.width / Math.max(width, 1);
		}
		const baseWidth = stroke.widthScale ? Math.max(1, stroke.widthScale * width) : stroke.width;
		context.save();
		context.lineCap = "round";
		context.lineJoin = "round";
		context.strokeStyle = stroke.color;
		context.fillStyle = stroke.color;
		context.globalAlpha = stroke.tool === "highlighter" ? 0.24 : 0.96;
		if (stroke.tool === "highlighter") {
			drawSmoothInkStroke(context, stroke.points, width, height, baseWidth, false, predictTail);
			context.restore();
			return;
		}
		drawSmoothInkStroke(context, stroke.points, width, height, baseWidth, true, predictTail);
		context.restore();
	}

	private drawNotebookText(
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
		textItem: TextAnnotation
	): void {
		if (!textItem.fontScale || textItem.fontScale <= 0) {
			textItem.fontScale = textItem.fontSize / Math.max(width, 1);
		}
		context.save();
		context.fillStyle = textItem.color;
		const fontSize = textItem.fontScale ? Math.max(10, textItem.fontScale * width) : textItem.fontSize;
		const fontFamily = textItem.fontFamily ?? TEXT_FONT_FAMILIES[0];
		context.font = `${fontSize}px "${fontFamily}", sans-serif`;
		context.textBaseline = "top";
		const boxWidth = textItem.boxWidthScale && textItem.boxWidthScale > 0
			? textItem.boxWidthScale * width
			: width * 0.48;
		getWrappedCanvasTextLines(context, textItem.text, boxWidth).forEach((line, index) => {
			context.fillText(line, textItem.x * width, (textItem.y * height) + (index * fontSize * 1.35));
		});
		context.restore();
	}

	private drawNotebookShape(
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
		shape: ShapeAnnotation
	): void {
		if (!shape.widthScale || shape.widthScale <= 0) {
			shape.widthScale = shape.width / Math.max(width, 1);
		}
		const startX = shape.start.x * width;
		const startY = shape.start.y * height;
		const endX = shape.end.x * width;
		const endY = shape.end.y * height;
		context.save();
		context.strokeStyle = shape.color;
		context.lineWidth = shape.widthScale ? Math.max(1, shape.widthScale * width) : shape.width;
		context.globalAlpha = 0.96;
		context.lineCap = "round";
		context.lineJoin = "round";
		if (shape.tool === "line") {
			context.beginPath();
			context.moveTo(startX, startY);
			context.lineTo(endX, endY);
			context.stroke();
			context.restore();
			return;
		}
		if (shape.tool === "rectangle") {
			context.strokeRect(startX, startY, endX - startX, endY - startY);
			context.restore();
			return;
		}
		context.beginPath();
		context.ellipse(
			startX + (endX - startX) / 2,
			startY + (endY - startY) / 2,
			Math.abs(endX - startX) / 2,
			Math.abs(endY - startY) / 2,
			0,
			0,
			Math.PI * 2
		);
		context.stroke();
		context.restore();
	}

	private drawNotebookSelection(
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
		targets: SelectedTarget[]
	): void {
		context.save();
		for (const target of targets) {
			const bounds = this.getNotebookTargetBounds(target);
			if (!bounds) {
				continue;
			}
			context.strokeStyle = "#4da3ff";
			context.lineWidth = 1.5;
			context.setLineDash([6, 4]);
			context.strokeRect(
				bounds.left * width,
				bounds.top * height,
				(bounds.right - bounds.left) * width,
				(bounds.bottom - bounds.top) * height
			);
		}
		const bounds = targets.length === 1
			? this.getNotebookTargetBounds(targets[0])
			: this.getNotebookCombinedBounds(targets);
		if (bounds) {
			const handlePoints = this.getNotebookHandlePoints(bounds);
			for (const [handle, handlePoint] of Object.entries(handlePoints) as [ResizeHandle, AnnotationPoint][]) {
				const x = handlePoint.x * width;
				const y = handlePoint.y * height;
				context.setLineDash([]);
				context.lineWidth = 1.4;
				if (handle === "n" || handle === "e" || handle === "s" || handle === "w") {
					context.beginPath();
					context.fillStyle = "#4da3ff";
					context.strokeStyle = "#ffffff";
					context.arc(x, y, 5.5, 0, Math.PI * 2);
					context.fill();
					context.stroke();
					continue;
				}
				context.beginPath();
				context.fillStyle = "#ffffff";
				context.strokeStyle = "#4da3ff";
				context.rect(x - 5, y - 5, 10, 10);
				context.fill();
				context.stroke();
			}
		}
		context.restore();
	}

	private drawNotebookLasso(
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
		lasso: LassoSelection
	): void {
		if (lasso.points.length < 2) {
			return;
		}
		context.save();
		context.strokeStyle = "rgba(77, 163, 255, 0.92)";
		context.lineWidth = 1.5;
		context.setLineDash([7, 5]);
		context.beginPath();
		context.moveTo(lasso.points[0].x * width, lasso.points[0].y * height);
		for (let index = 1; index < lasso.points.length; index += 1) {
			const point = lasso.points[index];
			context.lineTo(point.x * width, point.y * height);
		}
		context.stroke();
		context.restore();
	}

	private eraseNotebookAtPoint(point: AnnotationPoint): boolean {
		const page = this.activePage;
		const context = this.getNotebookContext();
		if (!page || !context) {
			return false;
		}
		const threshold = Math.max(6, this.toolState.getWidth("eraser") / 2) / Math.max(context.width, 1);

		for (let index = page.textItems.length - 1; index >= 0; index -= 1) {
			const item = page.textItems[index];
			const bounds = getTextBounds(item);
			if (pointInBounds(point, bounds, threshold)) {
				page.textItems.splice(index, 1);
				return true;
			}
		}

		for (let index = page.strokes.length - 1; index >= 0; index -= 1) {
			const stroke = page.strokes[index];
			const touched = stroke.points.some((strokePoint) => distanceBetween(strokePoint, point) <= threshold);
			if (!touched) {
				continue;
			}
			if (this.toolState.eraserMode === "object") {
				page.strokes.splice(index, 1);
			} else {
				page.strokes.splice(index, 1, ...splitStrokeByEraser(stroke, point, threshold));
			}
			return true;
		}

		for (let index = page.shapes.length - 1; index >= 0; index -= 1) {
			const shape = page.shapes[index];
			const bounds = {
				left: Math.min(shape.start.x, shape.end.x),
				right: Math.max(shape.start.x, shape.end.x),
				top: Math.min(shape.start.y, shape.end.y),
				bottom: Math.max(shape.start.y, shape.end.y)
			};
			if (point.x >= bounds.left - threshold && point.x <= bounds.right + threshold && point.y >= bounds.top - threshold && point.y <= bounds.bottom + threshold) {
				page.shapes.splice(index, 1);
				return true;
			}
		}
		return false;
	}

	private eraseNotebookAlongPath(start: AnnotationPoint, end: AnnotationPoint): boolean {
		const page = this.activePage;
		const context = this.getNotebookContext();
		if (!page || !context) {
			return false;
		}
		const threshold = Math.max(6, this.toolState.getWidth("eraser") / 2) / Math.max(context.width, 1);
		if (this.toolState.eraserMode === "object") {
			const midpoint: AnnotationPoint = {
				x: (start.x + end.x) / 2,
				y: (start.y + end.y) / 2,
				pressure: 0.5
			};
			return this.eraseNotebookAtPoint(midpoint);
		}
		let changed = false;
		const textIdsToErase = new Set<string>();
		for (const item of page.textItems) {
			const bounds = getTextBounds(item);
			if (segmentIntersectsExpandedBounds(start, end, bounds, threshold)) {
				textIdsToErase.add(item.id);
			}
		}
		if (textIdsToErase.size > 0) {
			page.textItems = page.textItems.filter((item) => !textIdsToErase.has(item.id));
			changed = true;
		}
		const nextStrokes: StrokeAnnotation[] = [];
		for (const stroke of page.strokes) {
			const touched = stroke.points.some((strokePoint) => distanceToSegment(strokePoint, start, end) <= threshold);
			if (!touched) {
				nextStrokes.push(stroke);
				continue;
			}
			changed = true;
			nextStrokes.push(...splitStrokeByEraserPath(stroke, start, end, threshold));
		}
		if (changed) {
			page.strokes = nextStrokes;
		}
		return changed;
	}

	private applyColorToNotebookSelection(color: string, pushHistory = true): void {
		const page = this.activePage;
		if (!page || this.selectedTargets.length === 0) {
			return;
		}
		if (pushHistory) {
			this.pushNotebookHistory();
		}
		for (const target of this.selectedTargets) {
			if (target.kind === "stroke") {
				const stroke = page.strokes.find((entry) => entry.id === target.id);
				if (stroke) {
					stroke.color = color;
				}
				continue;
			}
			if (target.kind === "text") {
				const item = page.textItems.find((entry) => entry.id === target.id);
				if (item) {
					item.color = color;
				}
				continue;
			}
			const shape = page.shapes.find((entry) => entry.id === target.id);
			if (shape) {
				shape.color = color;
			}
		}
		this.markNotebookDirty();
		this.drawNotebookPage();
	}

	private applyWidthToNotebookSelection(width: number, pushHistory = true): void {
		const page = this.activePage;
		const context = this.getNotebookContext();
		if (!page || !context || this.selectedTargets.length === 0) {
			return;
		}
		if (pushHistory) {
			this.pushNotebookHistory();
		}
		for (const target of this.selectedTargets) {
			if (target.kind === "stroke") {
				const stroke = page.strokes.find((entry) => entry.id === target.id);
				if (stroke) {
					stroke.width = width;
					stroke.widthScale = width / Math.max(context.width, 1);
				}
				continue;
			}
			if (target.kind === "shape") {
				const shape = page.shapes.find((entry) => entry.id === target.id);
				if (shape) {
					shape.width = width;
					shape.widthScale = width / Math.max(context.width, 1);
				}
				continue;
			}
			const item = page.textItems.find((entry) => entry.id === target.id);
			if (item) {
				item.fontSize = clamp(width * 4, 10, 96);
				item.fontScale = item.fontSize / Math.max(context.width, 1);
			}
		}
		this.markNotebookDirty();
		this.drawNotebookPage();
	}

	private getNotebookSelectionWidthValue(): number {
		const page = this.activePage;
		if (!page || this.selectedTargets.length === 0) {
			return this.getActiveWidth();
		}
		const values: number[] = [];
		for (const target of this.selectedTargets) {
			if (target.kind === "stroke") {
				const stroke = page.strokes.find((entry) => entry.id === target.id);
				if (stroke) {
					values.push(stroke.width);
				}
				continue;
			}
			if (target.kind === "shape") {
				const shape = page.shapes.find((entry) => entry.id === target.id);
				if (shape) {
					values.push(shape.width);
				}
				continue;
			}
			const item = page.textItems.find((entry) => entry.id === target.id);
			if (item) {
				values.push(Math.max(1, Math.round(item.fontSize / 4)));
			}
		}
		return values.length > 0
			? Math.max(1, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length))
			: this.getActiveWidth();
	}

	private getNotebookTargetBounds(target: SelectedTarget): { left: number; right: number; top: number; bottom: number } | null {
		const page = this.activePage;
		if (!page) {
			return null;
		}
		if (target.kind === "stroke") {
			const stroke = page.strokes.find((entry) => entry.id === target.id);
			return stroke ? getStrokeBounds(stroke) : null;
		}
		if (target.kind === "text") {
			const item = page.textItems.find((entry) => entry.id === target.id);
			return item ? getTextBounds(item) : null;
		}
		const shape = page.shapes.find((entry) => entry.id === target.id);
		return shape ? getShapeBounds(shape) : null;
	}

	private getNotebookCombinedBounds(targets: SelectedTarget[]): { left: number; right: number; top: number; bottom: number } | null {
		const bounds = targets
			.map((target) => this.getNotebookTargetBounds(target))
			.filter((value): value is NonNullable<typeof value> => !!value);
		if (bounds.length === 0) {
			return null;
		}
		return {
			left: Math.min(...bounds.map((bound) => bound.left)),
			right: Math.max(...bounds.map((bound) => bound.right)),
			top: Math.min(...bounds.map((bound) => bound.top)),
			bottom: Math.max(...bounds.map((bound) => bound.bottom))
		};
	}

	private getNotebookHandlePoints(bounds: { left: number; right: number; top: number; bottom: number }): Record<ResizeHandle, AnnotationPoint> {
		const midX = (bounds.left + bounds.right) / 2;
		const midY = (bounds.top + bounds.bottom) / 2;
		return {
			nw: { x: bounds.left, y: bounds.top, pressure: 0.5 },
			n: { x: midX, y: bounds.top, pressure: 0.5 },
			ne: { x: bounds.right, y: bounds.top, pressure: 0.5 },
			e: { x: bounds.right, y: midY, pressure: 0.5 },
			se: { x: bounds.right, y: bounds.bottom, pressure: 0.5 },
			s: { x: midX, y: bounds.bottom, pressure: 0.5 },
			sw: { x: bounds.left, y: bounds.bottom, pressure: 0.5 },
			w: { x: bounds.left, y: midY, pressure: 0.5 }
		};
	}

	private getNotebookResizeHandle(point: AnnotationPoint): ResizeHandle | null {
		if (this.selectedTargets.length === 0) {
			return null;
		}
		const bounds = this.selectedTargets.length === 1
			? this.getNotebookTargetBounds(this.selectedTargets[0])
			: this.getNotebookCombinedBounds(this.selectedTargets);
		if (!bounds) {
			return null;
		}
		const threshold = 0.04;
		for (const [handle, handlePoint] of Object.entries(this.getNotebookHandlePoints(bounds)) as [ResizeHandle, AnnotationPoint][]) {
			if (distanceBetween(point, handlePoint) <= threshold) {
				return handle;
			}
		}
		return null;
	}

	private findNotebookSelectableTarget(point: AnnotationPoint, threshold = 0.03): SelectedTarget | null {
		const page = this.activePage;
		if (!page) {
			return null;
		}
		const candidates: HitCandidate[] = [];
		for (let index = page.textItems.length - 1; index >= 0; index -= 1) {
			const item = page.textItems[index];
			const bounds = getTextBounds(item);
			if (point.x >= bounds.left - threshold && point.x <= bounds.right + threshold && point.y >= bounds.top - threshold && point.y <= bounds.bottom + threshold) {
				candidates.push({ kind: "text", id: item.id, page: 1, score: 0.1 });
			}
		}
		for (let index = page.shapes.length - 1; index >= 0; index -= 1) {
			const shape = page.shapes[index];
			const distance = distanceToShape(point, shape);
			if (distance <= threshold) {
				candidates.push({ kind: "shape", id: shape.id, page: 1, score: distance });
			}
		}
		for (let index = page.strokes.length - 1; index >= 0; index -= 1) {
			const stroke = page.strokes[index];
			const distance = distanceToStroke(point, stroke);
			if (distance <= threshold) {
				candidates.push({ kind: "stroke", id: stroke.id, page: 1, score: distance });
			}
		}
		candidates.sort((first, second) => first.score - second.score);
		const hit = candidates[0];
		return hit ? { kind: hit.kind, id: hit.id, page: 1 } : null;
	}

	private findNotebookTargetsInLasso(lasso: LassoSelection): SelectedTarget[] {
		const page = this.activePage;
		if (!page || lasso.points.length < 3) {
			return [];
		}
		const bounds = getPolygonBounds(lasso.points);
		const matches: SelectedTarget[] = [];
		const addIfMatch = (target: SelectedTarget, targetBounds: { left: number; right: number; top: number; bottom: number }, pathPoints?: AnnotationPoint[]) => {
			const corners: AnnotationPoint[] = [
				{ x: targetBounds.left, y: targetBounds.top, pressure: 0.5 },
				{ x: targetBounds.right, y: targetBounds.top, pressure: 0.5 },
				{ x: targetBounds.right, y: targetBounds.bottom, pressure: 0.5 },
				{ x: targetBounds.left, y: targetBounds.bottom, pressure: 0.5 }
			];
			const lassoHitsBounds = corners.some((corner) => pointInPolygon(corner, lasso.points));
			const boundsHitLasso = lasso.points.some((point) => point.x >= targetBounds.left && point.x <= targetBounds.right && point.y >= targetBounds.top && point.y <= targetBounds.bottom);
			const edgeCross = polygonIntersectsBounds(lasso.points, targetBounds);
			const pathCross = pathPoints ? pathIntersectsPolygon(pathPoints, lasso.points) : false;
			if ((boundsOverlap(bounds, targetBounds) && (lassoHitsBounds || boundsHitLasso || edgeCross || pathCross))) {
				matches.push(target);
			}
		};
		for (const item of page.textItems) {
			addIfMatch({ kind: "text", id: item.id, page: 1 }, getTextBounds(item));
		}
		for (const shape of page.shapes) {
			const shapeBounds = getShapeBounds(shape);
			const pathPoints = shape.tool === "line" ? [shape.start, shape.end] : undefined;
			addIfMatch({ kind: "shape", id: shape.id, page: 1 }, shapeBounds, pathPoints);
		}
		for (const stroke of page.strokes) {
			addIfMatch({ kind: "stroke", id: stroke.id, page: 1 }, getStrokeBounds(stroke), stroke.points);
		}
		return matches;
	}

	private moveNotebookSelectedTarget(target: SelectedTarget, deltaX: number, deltaY: number): void {
		const page = this.activePage;
		if (!page) {
			return;
		}
		if (target.kind === "stroke") {
			const stroke = page.strokes.find((entry) => entry.id === target.id);
			if (stroke) {
				stroke.points = stroke.points.map((point) => ({
					...point,
					x: clamp(point.x + deltaX, 0, 1),
					y: clamp(point.y + deltaY, 0, 1)
				}));
			}
			return;
		}
		if (target.kind === "text") {
			const item = page.textItems.find((entry) => entry.id === target.id);
			if (item) {
				item.x = clamp(item.x + deltaX, 0, 1);
				item.y = clamp(item.y + deltaY, 0, 1);
			}
			return;
		}
		const shape = page.shapes.find((entry) => entry.id === target.id);
		if (shape) {
			shape.start = { ...shape.start, x: clamp(shape.start.x + deltaX, 0, 1), y: clamp(shape.start.y + deltaY, 0, 1) };
			shape.end = { ...shape.end, x: clamp(shape.end.x + deltaX, 0, 1), y: clamp(shape.end.y + deltaY, 0, 1) };
		}
	}

	private deleteNotebookSelection(): void {
		const page = this.activePage;
		if (!page || this.selectedTargets.length === 0) {
			return;
		}
		this.pushNotebookHistory();
		const strokeIds = new Set(this.selectedTargets.filter((target) => target.kind === "stroke").map((target) => target.id));
		const textIds = new Set(this.selectedTargets.filter((target) => target.kind === "text").map((target) => target.id));
		const shapeIds = new Set(this.selectedTargets.filter((target) => target.kind === "shape").map((target) => target.id));
		page.strokes = page.strokes.filter((stroke) => !strokeIds.has(stroke.id));
		page.textItems = page.textItems.filter((item) => !textIds.has(item.id));
		page.shapes = page.shapes.filter((shape) => !shapeIds.has(shape.id));
		this.selectedTarget = null;
		this.selectedTargets = [];
		this.markNotebookDirty();
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private clearNotebookSelection(): void {
		if (this.selectedTargets.length === 0 && !this.selectedTarget) {
			return;
		}
		this.selectedTarget = null;
		this.selectedTargets = [];
		this.activeResizeHandle = null;
		this.dragAnchor = null;
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private cancelActiveNotebookInteraction(): boolean {
		const hasActiveInteraction =
			this.currentStroke !== null ||
			this.currentShape !== null ||
			this.currentLasso !== null ||
			this.dragAnchor !== null ||
			this.activeResizeHandle !== null;
		if (!hasActiveInteraction) {
			return false;
		}
		const shouldRestoreHistory =
			this.currentTool === "eraser" ||
			(this.currentTool === "select" && this.dragAnchor !== null && this.currentLasso === null);
		const previous = shouldRestoreHistory ? this.notebookUndoStack.pop() : null;
		this.currentStroke = null;
		this.currentShape = null;
		this.currentPointerId = null;
		this.notebookBridgedPointerId = null;
		this.currentLasso = null;
		this.dragAnchor = null;
		this.activeResizeHandle = null;
		this.dragMoved = false;
		if (previous) {
			this.restoreNotebookHistoryState(previous);
		} else {
			if ((this.currentTool === "pen" || this.currentTool === "highlighter" || isShapeTool(this.currentTool)) && this.notebookUndoStack.length > 0) {
				this.notebookUndoStack.pop();
			}
			this.drawNotebookPage();
			this.renderNotebookToolbar();
		}
		new Notice("Cancelled interaction.");
		return true;
	}

	private selectAllNotebookPageAnnotations(): void {
		const page = this.activePage;
		if (!page) {
			return;
		}
		const nextSelections: SelectedTarget[] = [
			...page.strokes.map((stroke): SelectedTarget => ({ kind: "stroke", id: stroke.id, page: 1 })),
			...page.textItems.map((item): SelectedTarget => ({ kind: "text", id: item.id, page: 1 })),
			...page.shapes.map((shape): SelectedTarget => ({ kind: "shape", id: shape.id, page: 1 }))
		];
		this.selectedTargets = nextSelections;
		this.selectedTarget = nextSelections[0] ?? null;
		this.activeResizeHandle = null;
		this.dragAnchor = null;
		if (nextSelections.length === 0) {
			new Notice("No annotations on current page.");
		}
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private nudgeNotebookSelection(deltaX: number, deltaY: number, pushHistory = true): void {
		const page = this.activePage;
		if (!page || this.selectedTargets.length === 0) {
			return;
		}
		if (pushHistory) {
			this.pushNotebookHistory();
		}
		for (const target of this.selectedTargets) {
			this.moveNotebookSelectedTarget(target, deltaX, deltaY);
		}
		this.markNotebookDirty();
		this.drawNotebookPage();
	}

	private reorderNotebookSelection(direction: AnnotationReorderDirection): void {
		const page = this.activePage;
		if (!page || this.selectedTargets.length === 0) {
			return;
		}
		const selectedKeys = new Set(this.selectedTargets.map((target) => `${target.kind}:${target.id}`));
		const renderables = getAnnotationRenderables(page.strokes, page.textItems, page.shapes);
		const selectedRenderables = renderables.filter((renderable) => selectedKeys.has(`${renderable.kind}:${renderable.annotation.id}`));
		if (selectedRenderables.length === 0) {
			return;
		}
		this.pushNotebookHistory();
		if (!reorderRenderables(renderables, selectedKeys, direction)) {
			if (this.notebookUndoStack.length > 0) {
				this.notebookUndoStack.pop();
			}
			return;
		}
		this.markNotebookDirty();
		this.drawNotebookPage();
	}

	private getNextNotebookZIndex(page = this.activePage): number {
		if (!page) {
			return 0;
		}
		const renderables = getAnnotationRenderables(page.strokes, page.textItems, page.shapes);
		if (renderables.length === 0) {
			return 0;
		}
		return Math.max(...renderables.map((renderable) => getRenderableOrder(renderable))) + 1;
	}

	private duplicateNotebookSelection(): void {
		const page = this.activePage;
		if (!page || this.selectedTargets.length === 0) {
			return;
		}
		this.pushNotebookHistory();
		const offsetX = 0.018;
		const offsetY = 0.018;
		const nextSelections: SelectedTarget[] = [];
		let nextZIndex = this.getNextNotebookZIndex(page);
		for (const target of this.selectedTargets) {
			if (target.kind === "stroke") {
				const stroke = page.strokes.find((entry) => entry.id === target.id);
				if (!stroke) {
					continue;
				}
				const nextStroke: StrokeAnnotation = {
					...stroke,
					id: generateId("stroke"),
					points: stroke.points.map((point) => ({
						...point,
						x: clamp(point.x + offsetX, 0, 1),
						y: clamp(point.y + offsetY, 0, 1)
					})),
					zIndex: nextZIndex++,
					createdAt: new Date().toISOString()
				};
				page.strokes.push(nextStroke);
				nextSelections.push({ kind: "stroke", id: nextStroke.id, page: 1 });
				continue;
			}
			if (target.kind === "text") {
				const item = page.textItems.find((entry) => entry.id === target.id);
				if (!item) {
					continue;
				}
				const nextItem: TextAnnotation = {
					...item,
					id: generateId("text"),
					x: clamp(item.x + offsetX, 0, 1),
					y: clamp(item.y + offsetY, 0, 1),
					zIndex: nextZIndex++,
					createdAt: new Date().toISOString()
				};
				page.textItems.push(nextItem);
				nextSelections.push({ kind: "text", id: nextItem.id, page: 1 });
				continue;
			}
			const shape = page.shapes.find((entry) => entry.id === target.id);
			if (!shape) {
				continue;
			}
			const nextShape: ShapeAnnotation = {
				...shape,
				id: generateId("shape"),
				start: {
					...shape.start,
					x: clamp(shape.start.x + offsetX, 0, 1),
					y: clamp(shape.start.y + offsetY, 0, 1)
				},
				end: {
					...shape.end,
					x: clamp(shape.end.x + offsetX, 0, 1),
					y: clamp(shape.end.y + offsetY, 0, 1)
				},
				zIndex: nextZIndex++,
				createdAt: new Date().toISOString()
			};
			page.shapes.push(nextShape);
			nextSelections.push({ kind: "shape", id: nextShape.id, page: 1 });
		}
		this.selectedTargets = nextSelections;
		this.selectedTarget = nextSelections[0] ?? null;
		this.markNotebookDirty();
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private copyNotebookSelection(): void {
		const page = this.activePage;
		if (!page || this.selectedTargets.length === 0) {
			new Notice("Nothing selected.");
			return;
		}
		const strokeIds = new Set(this.selectedTargets.filter((target) => target.kind === "stroke").map((target) => target.id));
		const textIds = new Set(this.selectedTargets.filter((target) => target.kind === "text").map((target) => target.id));
		const shapeIds = new Set(this.selectedTargets.filter((target) => target.kind === "shape").map((target) => target.id));
		const payload: AnnotationClipboardPayload = {
			strokes: page.strokes.filter((stroke) => strokeIds.has(stroke.id)).map((stroke) => JSON.parse(JSON.stringify(stroke)) as StrokeAnnotation),
			textItems: page.textItems.filter((item) => textIds.has(item.id)).map((item) => JSON.parse(JSON.stringify(item)) as TextAnnotation),
			shapes: page.shapes.filter((shape) => shapeIds.has(shape.id)).map((shape) => JSON.parse(JSON.stringify(shape)) as ShapeAnnotation)
		};
		this.plugin.setClipboard(payload);
		const total = payload.strokes.length + payload.textItems.length + payload.shapes.length;
		new Notice(total === 1 ? "Copied selection." : `Copied ${total} selections.`);
		this.renderNotebookToolbar();
	}

	private cutNotebookSelection(): void {
		const page = this.activePage;
		if (!page || this.selectedTargets.length === 0) {
			new Notice("Nothing selected.");
			return;
		}
		const strokeIds = new Set(this.selectedTargets.filter((target) => target.kind === "stroke").map((target) => target.id));
		const textIds = new Set(this.selectedTargets.filter((target) => target.kind === "text").map((target) => target.id));
		const shapeIds = new Set(this.selectedTargets.filter((target) => target.kind === "shape").map((target) => target.id));
		const payload: AnnotationClipboardPayload = {
			strokes: page.strokes.filter((stroke) => strokeIds.has(stroke.id)).map((stroke) => JSON.parse(JSON.stringify(stroke)) as StrokeAnnotation),
			textItems: page.textItems.filter((item) => textIds.has(item.id)).map((item) => JSON.parse(JSON.stringify(item)) as TextAnnotation),
			shapes: page.shapes.filter((shape) => shapeIds.has(shape.id)).map((shape) => JSON.parse(JSON.stringify(shape)) as ShapeAnnotation)
		};
		const total = payload.strokes.length + payload.textItems.length + payload.shapes.length;
		if (total === 0) {
			new Notice("Nothing selected.");
			return;
		}
		this.plugin.setClipboard(payload);
		this.pushNotebookHistory();
		page.strokes = page.strokes.filter((stroke) => !strokeIds.has(stroke.id));
		page.textItems = page.textItems.filter((item) => !textIds.has(item.id));
		page.shapes = page.shapes.filter((shape) => !shapeIds.has(shape.id));
		this.selectedTarget = null;
		this.selectedTargets = [];
		this.markNotebookDirty();
		new Notice(total === 1 ? "Cut selection." : `Cut ${total} selections.`);
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private pasteNotebookClipboard(pasteInPlace = false): void {
		const page = this.activePage;
		if (!page) {
			return;
		}
		const clipboard = this.plugin.getClipboard();
		if (!clipboard) {
			new Notice("Clipboard is empty.");
			return;
		}
		this.pushNotebookHistory();
		const pastePoint = pasteInPlace ? null : this.getRecentNotebookPastePoint();
		const pasteOffset = pasteInPlace ? { x: 0, y: 0 } : getClipboardPasteOffset(clipboard, pastePoint);
		const nextSelections: SelectedTarget[] = [];
		let nextZIndex = this.getNextNotebookZIndex(page);
		for (const stroke of clipboard.strokes) {
			const nextStroke: StrokeAnnotation = {
				...stroke,
				id: generateId("stroke"),
				page: 1,
				points: stroke.points.map((point) => ({
					...point,
					x: clamp(point.x + pasteOffset.x, 0, 1),
					y: clamp(point.y + pasteOffset.y, 0, 1)
				})),
				zIndex: nextZIndex++,
				createdAt: new Date().toISOString()
			};
			page.strokes.push(nextStroke);
			nextSelections.push({ kind: "stroke", id: nextStroke.id, page: 1 });
		}
		for (const item of clipboard.textItems) {
			const nextItem: TextAnnotation = {
				...item,
				id: generateId("text"),
				page: 1,
				x: clamp(item.x + pasteOffset.x, 0, 1),
				y: clamp(item.y + pasteOffset.y, 0, 1),
				zIndex: nextZIndex++,
				createdAt: new Date().toISOString()
			};
			page.textItems.push(nextItem);
			nextSelections.push({ kind: "text", id: nextItem.id, page: 1 });
		}
		for (const shape of clipboard.shapes) {
			const nextShape: ShapeAnnotation = {
				...shape,
				id: generateId("shape"),
				page: 1,
				start: {
					...shape.start,
					x: clamp(shape.start.x + pasteOffset.x, 0, 1),
					y: clamp(shape.start.y + pasteOffset.y, 0, 1)
				},
				end: {
					...shape.end,
					x: clamp(shape.end.x + pasteOffset.x, 0, 1),
					y: clamp(shape.end.y + pasteOffset.y, 0, 1)
				},
				zIndex: nextZIndex++,
				createdAt: new Date().toISOString()
			};
			page.shapes.push(nextShape);
			nextSelections.push({ kind: "shape", id: nextShape.id, page: 1 });
		}
		if (nextSelections.length === 0) {
			if (this.notebookUndoStack.length > 0) {
				this.notebookUndoStack.pop();
			}
			new Notice("Clipboard is empty.");
			return;
		}
		this.selectedTargets = nextSelections;
		this.selectedTarget = nextSelections[0] ?? null;
		this.markNotebookDirty();
		new Notice(nextSelections.length === 1 ? "Pasted selection." : `Pasted ${nextSelections.length} selections.`);
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private getRecentNotebookPastePoint(): AnnotationPoint | null {
		if (!this.overlayEl || !this.lastNotebookPoint) {
			return null;
		}
		if (performance.now() - this.lastNotebookPointTime > 8000) {
			return null;
		}
		const rect = this.overlayEl.getBoundingClientRect();
		if (
			this.lastNotebookPoint.clientX < rect.left ||
			this.lastNotebookPoint.clientX > rect.right ||
			this.lastNotebookPoint.clientY < rect.top ||
			this.lastNotebookPoint.clientY > rect.bottom
		) {
			return null;
		}
		return {
			x: clamp((this.lastNotebookPoint.clientX - rect.left) / Math.max(rect.width, 1), 0, 1),
			y: clamp((this.lastNotebookPoint.clientY - rect.top) / Math.max(rect.height, 1), 0, 1),
			pressure: 0.5
		};
	}

	private renderNotebookPageBackground(
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
		page: NotebookPage
	): void {
		const base = this.getNotebookBaseDimensions(page);
		const scaleX = width / Math.max(base.width, 1);
		const scaleY = height / Math.max(base.height, 1);
		context.save();
		context.fillStyle = page.paperColor;
		context.fillRect(0, 0, width, height);
		if (page.kind === "pdf") {
			const pdfCanvas = this.requestNotebookPdfCanvas(page, width, height, () => {
				if (this.activePage?.id === page.id) {
					this.applyNotebookPageMetrics();
					this.resizeNotebookOverlay();
				} else {
					this.render();
				}
			});
			if (pdfCanvas) {
				context.drawImage(pdfCanvas, 0, 0, width, height);
			} else {
				context.fillStyle = "rgba(18, 24, 33, 0.04)";
				context.fillRect(0, 0, width, height);
				context.strokeStyle = "rgba(77, 163, 255, 0.18)";
				context.lineWidth = 2;
				context.setLineDash([10, 8]);
				context.strokeRect(12, 12, Math.max(0, width - 24), Math.max(0, height - 24));
				context.setLineDash([]);
				context.fillStyle = "rgba(58, 71, 88, 0.78)";
				context.font = '600 18px "Segoe UI", sans-serif';
				context.textAlign = "center";
				context.textBaseline = "middle";
				context.fillText(page.sourceLabel ?? "Loading PDF page...", width / 2, height / 2 - 12);
				context.font = '14px "Segoe UI", sans-serif';
				context.fillStyle = "rgba(58, 71, 88, 0.58)";
				context.fillText("Rendering PDF page into notebook view...", width / 2, height / 2 + 16);
			}
			context.restore();
			return;
		}
		context.scale(scaleX, scaleY);
		drawTemplatePageBackground(context, base.width, base.height, page);
		context.restore();
	}

	private renderNotebookPageToCanvas(page: NotebookPage, width: number, height: number): HTMLCanvasElement {
		const exportCanvas = createEl("canvas");
		exportCanvas.width = width;
		exportCanvas.height = height;
		const context = exportCanvas.getContext("2d");
		if (!context) {
			return exportCanvas;
		}
		this.renderNotebookPageBackground(context, width, height, page);
		for (const stroke of page.strokes) {
			this.drawNotebookStroke(context, width, height, stroke);
		}
		for (const textItem of page.textItems) {
			this.drawNotebookText(context, width, height, textItem);
		}
		for (const shape of page.shapes) {
			this.drawNotebookShape(context, width, height, shape);
		}
		return exportCanvas;
	}

	private renderNotebookThumbnailDataUrl(page: NotebookPage): string {
		const thumbnailWidth = 160;
		const thumbnailHeight = 96;
		const canvas = this.renderNotebookPageToCanvas(page, thumbnailWidth, thumbnailHeight);
		return canvas.toDataURL("image/png");
	}

	private getNotebookPageExportBaseName(): string {
		if (!this.file || !this.activePage) {
			return "Notebook page";
		}
		return `${getBaseName(this.file)} ${this.activePage.title}`;
	}

	private getNotebookPageById(pageId: string): NotebookPage | null {
		return this.document?.pages.find((page) => page.id === pageId) ?? null;
	}

	private buildNotebookPdfPageLink(page: NotebookPage): string | null {
		if (!page.pdfSource) {
			return null;
		}
		return `[[${page.pdfSource.filePath}#page=${page.pdfSource.page}]]`;
	}

	private getNotebookPageRenderSize(page: NotebookPage): { width: number; height: number } {
		const base = this.getNotebookBaseDimensions(page);
		const zoom = this.getEffectiveNotebookZoom(page);
		return {
			width: Math.max(1, Math.round(base.width * zoom)),
			height: Math.max(1, Math.round(base.height * zoom))
		};
	}

	private async exportNotebookPageSnapshot(): Promise<TFile | null> {
		const context = this.getNotebookContext();
		if (!context || !this.file) {
			return null;
		}
		const exportCanvas = this.renderNotebookPageToCanvas(context.page, context.width, context.height);
		const folderPrefix = this.file.parent?.path ? `${this.file.parent.path}/` : "";
		const baseName = `${this.getNotebookPageExportBaseName()} snapshot`;
		let imagePath = `${folderPrefix}${baseName}.png`;
		let counter = 2;
		while (this.plugin.app.vault.getAbstractFileByPath(imagePath)) {
			imagePath = `${folderPrefix}${baseName} ${counter}.png`;
			counter += 1;
		}
		const buffer = dataUrlToArrayBuffer(exportCanvas.toDataURL("image/png"));
		const imageFile = await this.plugin.app.vault.createBinary(imagePath, buffer);
		new Notice(`Exported ${imageFile.name}`);
		return imageFile;
	}

	private async exportNotebookPageSnapshotFor(pageId: string): Promise<TFile | null> {
		if (!this.file) {
			return null;
		}
		const page = this.getNotebookPageById(pageId);
		if (!page) {
			return null;
		}
		const { width, height } = this.activePage?.id === pageId && this.getNotebookContext()
			? {
				width: this.getNotebookContext()!.width,
				height: this.getNotebookContext()!.height
			}
			: this.getNotebookPageRenderSize(page);
		const exportCanvas = this.renderNotebookPageToCanvas(page, width, height);
		const folderPrefix = this.file.parent?.path ? `${this.file.parent.path}/` : "";
		const baseName = `${getBaseName(this.file)} ${page.title} snapshot`;
		let imagePath = `${folderPrefix}${baseName}.png`;
		let counter = 2;
		while (this.plugin.app.vault.getAbstractFileByPath(imagePath)) {
			imagePath = `${folderPrefix}${baseName} ${counter}.png`;
			counter += 1;
		}
		const buffer = dataUrlToArrayBuffer(exportCanvas.toDataURL("image/png"));
		const imageFile = await this.plugin.app.vault.createBinary(imagePath, buffer);
		new Notice(`Exported ${imageFile.name}`);
		return imageFile;
	}

	private async copyNotebookPdfSourceLink(pageId: string): Promise<void> {
		const page = this.getNotebookPageById(pageId);
		const link = page ? this.buildNotebookPdfPageLink(page) : null;
		if (!link) {
			return;
		}
		try {
			await writeClipboardText(link);
			new Notice("Copied source PDF link");
		} catch {
			new Notice("Could not copy source PDF link.");
		}
	}

	private async openNotebookPdfSourcePage(pageId: string): Promise<void> {
		const page = this.getNotebookPageById(pageId);
		if (!page?.pdfSource) {
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(page.pdfSource.filePath);
		if (!(file instanceof TFile)) {
			new Notice("The source PDF for this page could not be found in the vault.");
			return;
		}
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		await this.plugin.syncSessionsForNotebook();
		const session = this.plugin.getSessionForLeafForNotebook(leaf);
		if (session) {
			session.focusRegion(page.pdfSource.page, {
				left: 0.08,
				top: 0.08,
				right: 0.92,
				bottom: 0.92
			});
		}
	}

	private async exportNotebookSelectionSnapshot(): Promise<TFile | null> {
		const context = this.getNotebookContext();
		if (!context || !this.file || this.selectedTargets.length === 0) {
			return null;
		}
		const bounds = this.getNotebookCombinedBounds(this.selectedTargets);
		if (!bounds) {
			return null;
		}
		const exportCanvas = this.renderNotebookPageToCanvas(context.page, context.width, context.height);
		const cropLeft = Math.max(0, Math.floor(bounds.left * exportCanvas.width) - 20);
		const cropTop = Math.max(0, Math.floor(bounds.top * exportCanvas.height) - 20);
		const cropRight = Math.min(exportCanvas.width, Math.ceil(bounds.right * exportCanvas.width) + 20);
		const cropBottom = Math.min(exportCanvas.height, Math.ceil(bounds.bottom * exportCanvas.height) + 20);
		const cropWidth = Math.max(1, cropRight - cropLeft);
		const cropHeight = Math.max(1, cropBottom - cropTop);
		const croppedCanvas = createEl("canvas");
		croppedCanvas.width = cropWidth;
		croppedCanvas.height = cropHeight;
		const cropContext = croppedCanvas.getContext("2d");
		if (!cropContext) {
			return null;
		}
		cropContext.drawImage(exportCanvas, cropLeft, cropTop, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
		const folderPrefix = this.file.parent?.path ? `${this.file.parent.path}/` : "";
		const baseName = `${this.getNotebookPageExportBaseName()} selection`;
		let imagePath = `${folderPrefix}${baseName}.png`;
		let counter = 2;
		while (this.plugin.app.vault.getAbstractFileByPath(imagePath)) {
			imagePath = `${folderPrefix}${baseName} ${counter}.png`;
			counter += 1;
		}
		const buffer = dataUrlToArrayBuffer(croppedCanvas.toDataURL("image/png"));
		const imageFile = await this.plugin.app.vault.createBinary(imagePath, buffer);
		new Notice(`Exported ${imageFile.name}`);
		return imageFile;
	}

	private resizeNotebookSelectedTargets(targets: SelectedTarget[], handle: ResizeHandle, deltaX: number, deltaY: number): void {
		const page = this.activePage;
		const context = this.getNotebookContext();
		const originalBounds = this.getNotebookCombinedBounds(targets);
		if (!page || !context || !originalBounds) {
			return;
		}
		const nextBounds = { ...originalBounds };
		if (handle.includes("n")) {
			nextBounds.top = clamp(nextBounds.top + deltaY, 0, nextBounds.bottom - 0.01);
		}
		if (handle.includes("s")) {
			nextBounds.bottom = clamp(nextBounds.bottom + deltaY, nextBounds.top + 0.01, 1);
		}
		if (handle.includes("w")) {
			nextBounds.left = clamp(nextBounds.left + deltaX, 0, nextBounds.right - 0.01);
		}
		if (handle.includes("e")) {
			nextBounds.right = clamp(nextBounds.right + deltaX, nextBounds.left + 0.01, 1);
		}
		const originalWidth = Math.max(0.0001, originalBounds.right - originalBounds.left);
		const originalHeight = Math.max(0.0001, originalBounds.bottom - originalBounds.top);
		const isCornerHandle = handle.length === 2;
		let scaleX = (nextBounds.right - nextBounds.left) / originalWidth;
		let scaleY = (nextBounds.bottom - nextBounds.top) / originalHeight;
		if (isCornerHandle) {
			const uniformScale = Math.max(0.1, Math.abs(scaleX) >= Math.abs(scaleY) ? scaleX : scaleY);
			scaleX = uniformScale;
			scaleY = uniformScale;
			if (handle.includes("w")) {
				nextBounds.left = nextBounds.right - originalWidth * uniformScale;
			} else {
				nextBounds.right = nextBounds.left + originalWidth * uniformScale;
			}
			if (handle.includes("n")) {
				nextBounds.top = nextBounds.bottom - originalHeight * uniformScale;
			} else {
				nextBounds.bottom = nextBounds.top + originalHeight * uniformScale;
			}
		}
		for (const target of targets) {
			if (target.kind === "stroke") {
				const stroke = page.strokes.find((entry) => entry.id === target.id);
				if (!stroke) {
					continue;
				}
				stroke.points = stroke.points.map((point) => ({
					...point,
					x: clamp(nextBounds.left + ((point.x - originalBounds.left) / originalWidth) * (nextBounds.right - nextBounds.left), 0, 1),
					y: clamp(nextBounds.top + ((point.y - originalBounds.top) / originalHeight) * (nextBounds.bottom - nextBounds.top), 0, 1)
				}));
				if (isCornerHandle) {
					stroke.widthScale = (stroke.widthScale ?? stroke.width / Math.max(context.width, 1)) * Math.max(scaleX, scaleY);
					stroke.width = Math.max(1, stroke.widthScale * context.width);
				}
				continue;
			}
			if (target.kind === "text") {
				const item = page.textItems.find((entry) => entry.id === target.id);
				if (!item) {
					continue;
				}
				item.x = clamp(nextBounds.left + ((item.x - originalBounds.left) / originalWidth) * (nextBounds.right - nextBounds.left), 0, 1);
				item.y = clamp(nextBounds.top + ((item.y - originalBounds.top) / originalHeight) * (nextBounds.bottom - nextBounds.top), 0, 1);
				if (isCornerHandle) {
					const nextFont = clamp(item.fontSize * Math.max(scaleX, scaleY), 10, 160);
					item.fontSize = nextFont;
					item.fontScale = nextFont / Math.max(context.width, 1);
				}
				continue;
			}
			const shape = page.shapes.find((entry) => entry.id === target.id);
			if (!shape) {
				continue;
			}
			shape.start = {
				...shape.start,
				x: clamp(nextBounds.left + ((shape.start.x - originalBounds.left) / originalWidth) * (nextBounds.right - nextBounds.left), 0, 1),
				y: clamp(nextBounds.top + ((shape.start.y - originalBounds.top) / originalHeight) * (nextBounds.bottom - nextBounds.top), 0, 1)
			};
			shape.end = {
				...shape.end,
				x: clamp(nextBounds.left + ((shape.end.x - originalBounds.left) / originalWidth) * (nextBounds.right - nextBounds.left), 0, 1),
				y: clamp(nextBounds.top + ((shape.end.y - originalBounds.top) / originalHeight) * (nextBounds.bottom - nextBounds.top), 0, 1)
			};
			if (isCornerHandle) {
				shape.widthScale = (shape.widthScale ?? shape.width / Math.max(context.width, 1)) * Math.max(scaleX, scaleY);
				shape.width = Math.max(1, shape.widthScale * context.width);
			}
		}
	}

	private beginNotebookInteraction(point: AnnotationPoint, pointerId: number, capturePointer: boolean, sourceEvent?: PointerEvent): void {
		const page = this.activePage;
		const context = this.getNotebookContext();
		if (!page || !context) {
			return;
		}
		this.currentPointerId = pointerId;
		if (capturePointer) {
			context.overlayEl.setPointerCapture(pointerId);
		}

		if (this.isNotebookPanActive()) {
			return;
		}

		if (this.currentTool === "select") {
			const resizeHandle = this.getNotebookResizeHandle(point);
			if (resizeHandle && this.selectedTargets.length > 0) {
				this.pushNotebookHistory();
				this.activeResizeHandle = resizeHandle;
				this.dragAnchor = point;
				this.dragMoved = false;
				return;
			}
			const selectedHit = this.selectedTargets.find((target) => {
				const bounds = this.getNotebookTargetBounds(target);
				return bounds
					? point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom
					: false;
			});
			if (selectedHit) {
				this.pushNotebookHistory();
				this.selectedTarget = selectedHit;
				this.dragAnchor = point;
				this.dragMoved = false;
				return;
			}
			if (this.toolState.selectionMode === "box") {
				this.currentSelectionAdditive = !!(sourceEvent?.shiftKey || sourceEvent?.ctrlKey || sourceEvent?.metaKey);
				this.currentLasso = { page: 1, points: getSelectionBoxPoints(point, point) };
				this.dragAnchor = point;
				this.dragMoved = false;
				this.activeResizeHandle = null;
				this.drawNotebookPage();
				return;
			}
			if (this.toolState.selectionMode === "lasso") {
				this.currentSelectionAdditive = !!(sourceEvent?.shiftKey || sourceEvent?.ctrlKey || sourceEvent?.metaKey);
				this.currentLasso = { page: 1, points: [point] };
				this.dragAnchor = null;
				this.activeResizeHandle = null;
				this.drawNotebookPage();
				return;
			}
			const hit = this.findNotebookSelectableTarget(point);
			if (!hit) {
				this.selectedTarget = null;
				this.selectedTargets = [];
				this.dragAnchor = null;
				this.activeResizeHandle = null;
				this.drawNotebookPage();
				return;
			}
			const shouldToggleSelection = !!(sourceEvent?.shiftKey || sourceEvent?.ctrlKey || sourceEvent?.metaKey);
			if (shouldToggleSelection) {
				const existing = this.selectedTargets.find((target) => target.id === hit.id && target.kind === hit.kind);
				this.selectedTargets = existing
					? this.selectedTargets.filter((target) => !(target.id === hit.id && target.kind === hit.kind))
					: [...this.selectedTargets, hit];
				this.selectedTarget = this.selectedTargets[0] ?? null;
			} else {
				this.selectedTarget = hit;
				this.selectedTargets = [hit];
			}
			this.dragAnchor = point;
			this.dragMoved = false;
			this.activeResizeHandle = null;
			this.drawNotebookPage();
			this.renderNotebookToolbar();
			return;
		}

		if (this.currentTool === "text") {
			const hit = this.findNotebookSelectableTarget(point, 0.04);
			if (hit?.kind === "text" && page) {
				const existing = page.textItems.find((entry) => entry.id === hit.id);
				if (existing) {
					this.currentPointerId = null;
					this.beginNotebookInlineTextEditor({ x: existing.x, y: existing.y, pressure: point.pressure }, existing);
					return;
				}
			}
			this.currentPointerId = null;
			void this.insertNotebookTextAtPoint(point);
			return;
		}

		if (this.currentTool === "eraser") {
			this.pushNotebookHistory();
			if (this.eraseNotebookAtPoint(point)) {
				this.markNotebookDirty();
				this.drawNotebookPage();
			}
			this.currentStroke = {
				id: "erase-preview",
				page: 1,
				tool: "pen",
				color: "transparent",
				width: 0,
				points: [point],
				createdAt: new Date().toISOString()
			};
			return;
		}

		if (isShapeTool(this.currentTool)) {
			const strokeWidth = this.toolState.getWidth("pen");
			this.pushNotebookHistory();
			const zIndex = this.getNextNotebookZIndex(context.page);
			this.currentShape = {
				id: generateId("shape"),
				page: 1,
				tool: this.currentTool,
				color: this.currentColor,
				width: strokeWidth,
				widthScale: strokeWidth / Math.max(context.width, 1),
				start: point,
				end: point,
				zIndex,
				createdAt: new Date().toISOString()
			};
			this.drawNotebookPage();
			return;
		}

		const strokeWidth = this.currentTool === "highlighter" ? this.toolState.getWidth("highlighter") : this.toolState.getWidth("pen");
		this.pushNotebookHistory();
		const zIndex = this.getNextNotebookZIndex(context.page);
		this.currentStroke = {
			id: generateId("stroke"),
			page: 1,
			tool: this.currentTool as "pen" | "highlighter",
			color: this.currentTextColor,
			width: strokeWidth,
			widthScale: strokeWidth / Math.max(context.width, 1),
			points: [point],
			zIndex,
			createdAt: new Date().toISOString()
		};
		this.drawNotebookPage();
	}

	private continueNotebookInteraction(point: AnnotationPoint): void {
		if (this.notebookPanAnchor && this.pageViewportEl) {
			return;
		}
		if (this.currentTool === "select" && this.dragAnchor && this.selectedTargets.length > 0) {
			const deltaX = point.x - this.dragAnchor.x;
			const deltaY = point.y - this.dragAnchor.y;
			if (Math.abs(deltaX) > 0 || Math.abs(deltaY) > 0) {
				this.dragMoved = true;
				if (this.activeResizeHandle) {
					this.resizeNotebookSelectedTargets(this.selectedTargets, this.activeResizeHandle, deltaX, deltaY);
				} else {
					for (const target of this.selectedTargets) {
						this.moveNotebookSelectedTarget(target, deltaX, deltaY);
					}
				}
				this.dragAnchor = point;
				this.drawNotebookPage();
			}
			return;
		}

		if (this.currentTool === "select" && this.currentLasso) {
			if (this.toolState.selectionMode === "box" && this.dragAnchor) {
				this.currentLasso.points = getSelectionBoxPoints(this.dragAnchor, point);
				this.dragMoved = this.dragMoved || distanceBetween(this.dragAnchor, point) >= 0.003;
				this.drawNotebookPage();
				return;
			}
			const previousPoint = this.currentLasso.points[this.currentLasso.points.length - 1];
			if (!previousPoint || distanceBetween(previousPoint, point) >= 0.003) {
				this.currentLasso.points.push(point);
				this.drawNotebookPage();
			}
			return;
		}

		if (this.currentTool === "eraser") {
			const previousPoint = this.currentStroke?.points[this.currentStroke.points.length - 1];
			if (previousPoint && this.eraseNotebookAlongPath(previousPoint, point)) {
				this.markNotebookDirty();
				this.drawNotebookPage();
			}
			if (this.currentStroke) {
				this.currentStroke.points.push(point);
			}
			return;
		}

		if (this.currentShape) {
			this.currentShape.end = point;
			this.drawNotebookPage();
			return;
		}

		if (!this.currentStroke) {
			return;
		}
		if (appendStrokePoints(this.currentStroke, [point])) {
			this.scheduleNotebookInkRedraw();
		}
	}

	private finishNotebookInteraction(pointerId: number): void {
		if (this.currentPointerId !== pointerId) {
			return;
		}
		this.flushNotebookInkRedraw();
		this.currentPointerId = null;
		this.notebookBridgedPointerId = null;
		try {
			this.overlayEl?.releasePointerCapture(pointerId);
		} catch {
			// noop
		}
		const page = this.activePage;
		if (!page) {
			this.currentStroke = null;
			this.currentShape = null;
			return;
		}

		if (this.notebookPanAnchor) {
			this.notebookPanAnchor = null;
			this.refreshNotebookCursor();
			return;
		}

		if (this.currentTool === "select") {
			if (this.currentLasso) {
				const lasso = this.currentLasso;
				const boxClickPoint = this.toolState.selectionMode === "box" && !this.dragMoved
					? (this.dragAnchor ?? lasso.points[0])
					: null;
				const boxClickHit = boxClickPoint ? this.findNotebookSelectableTarget(boxClickPoint) : null;
				const hits = boxClickHit ? [boxClickHit] : this.findNotebookTargetsInLasso(lasso);
				if (this.currentSelectionAdditive && hits.length > 0) {
					const existingKeys = new Set(this.selectedTargets.map((target) => `${target.kind}:${target.id}`));
					this.selectedTargets = [
						...this.selectedTargets,
						...hits.filter((target) => !existingKeys.has(`${target.kind}:${target.id}`))
					];
				} else {
					this.selectedTargets = hits;
				}
				this.selectedTarget = this.selectedTargets[0] ?? null;
				this.currentLasso = null;
				this.currentSelectionAdditive = false;
				this.dragAnchor = null;
				this.dragMoved = false;
				this.activeResizeHandle = null;
				this.renderNotebookToolbar();
				this.drawNotebookPage();
				return;
			}
			const changed = this.dragMoved;
			this.dragAnchor = null;
			this.activeResizeHandle = null;
			this.dragMoved = false;
			if (changed) {
				this.markNotebookDirty();
			}
			this.renderNotebookToolbar();
			this.drawNotebookPage();
			return;
		}

		if (this.currentTool === "eraser") {
			this.currentStroke = null;
			this.drawNotebookPage();
			return;
		}

		if (this.currentShape) {
			page.shapes.push(this.currentShape);
			this.currentShape = null;
			this.markNotebookDirty();
			this.drawNotebookPage();
			return;
		}

		if (this.currentStroke) {
			page.strokes.push(this.currentStroke);
			this.currentStroke = null;
			this.markNotebookDirty();
			this.drawNotebookPage();
		}
	}

	private readonly handleNotebookPointerDown = (event: PointerEvent): void => {
		const page = this.activePage;
		const context = this.getNotebookContext();
		if (!page || !context || event.button !== 0) {
			return;
		}
		if (shouldIgnoreInkPointerEvent(event, this.currentTool) && !this.shouldNotebookTouchPan(event)) {
			return;
		}
		const point = this.getNotebookPoint(event);
		if (!point) {
			return;
		}
		this.updateNotebookToolPreview(event.clientX, event.clientY, this.currentTool === "eraser");
		this.currentPointerId = event.pointerId;
		event.preventDefault();

		if (this.isNotebookPanActive() || this.shouldNotebookTouchPan(event)) {
			this.notebookPanAnchor = {
				clientX: event.clientX,
				clientY: event.clientY,
				scrollLeft: this.pageViewportEl?.scrollLeft ?? 0,
				scrollTop: this.pageViewportEl?.scrollTop ?? 0
			};
			this.refreshNotebookCursor();
			return;
		}
		this.beginNotebookInteraction(point, event.pointerId, true, event);
	};

	private readonly handleNotebookPointerMove = (event: PointerEvent): void => {
		if (this.currentPointerId !== event.pointerId) {
			if (this.currentPointerId === null) {
				const hoverPoint = this.getNotebookPoint(event);
				if (hoverPoint) {
					this.updateNotebookToolPreview(event.clientX, event.clientY, false);
					this.updateNotebookHoverCursor(hoverPoint);
				} else if (this.currentTool === "eraser") {
					this.hideNotebookToolPreview();
				}
			}
			return;
		}
		const points = this.getNotebookPoints(event);
		if (points.length === 0) {
			return;
		}
		const point = points[points.length - 1];
		this.updateNotebookToolPreview(event.clientX, event.clientY, this.currentTool === "eraser");
		event.preventDefault();

		if (this.notebookPanAnchor && this.pageViewportEl) {
			const deltaX = event.clientX - this.notebookPanAnchor.clientX;
			const deltaY = event.clientY - this.notebookPanAnchor.clientY;
			this.pageViewportEl.scrollLeft = this.notebookPanAnchor.scrollLeft - deltaX;
			this.pageViewportEl.scrollTop = this.notebookPanAnchor.scrollTop - deltaY;
			this.refreshNotebookCursor();
			return;
		}
		if ((this.currentTool === "pen" || this.currentTool === "highlighter") && this.currentStroke) {
			if (appendStrokePoints(this.currentStroke, points)) {
				this.scheduleNotebookInkRedraw();
			}
			return;
		}
		if (this.currentTool === "eraser" && this.currentStroke) {
			for (const sample of points) {
				this.continueNotebookInteraction(sample);
			}
			return;
		}
		this.continueNotebookInteraction(point);
	};

	private readonly handleNotebookPointerUp = (event: PointerEvent): void => {
		if (this.currentPointerId === event.pointerId && (this.currentTool === "pen" || this.currentTool === "highlighter") && this.currentStroke) {
			appendStrokePoints(this.currentStroke, this.getNotebookPoints(event));
		}
		this.finishNotebookInteraction(event.pointerId);
		if (this.currentTool === "eraser") {
			this.updateNotebookToolPreview(event.clientX, event.clientY, false);
		} else {
			this.hideNotebookToolPreview();
		}
	};

	private readonly handleNotebookPointerCancel = (event: PointerEvent): void => {
		if (this.currentPointerId !== event.pointerId) {
			return;
		}
		this.cancelActiveNotebookInteraction();
		this.hideNotebookToolPreview();
	};

	private readonly handleNotebookPointerLeave = (): void => {
		if (this.currentPointerId === null) {
			this.hideNotebookToolPreview();
		}
	};

	private readonly handleNotebookWindowPointerMove = (event: PointerEvent): void => {
		if (this.notebookBridgedPointerId !== event.pointerId) {
			return;
		}
		const points = this.getNotebookPointsFromClientEvent(event);
		if (points.length === 0) {
			return;
		}
		if ((this.currentTool === "pen" || this.currentTool === "highlighter") && this.currentStroke) {
			if (appendStrokePoints(this.currentStroke, points)) {
				this.scheduleNotebookInkRedraw();
			}
			return;
		}
		if (this.currentTool === "eraser" && this.currentStroke) {
			for (const point of points) {
				this.continueNotebookInteraction(point);
			}
			return;
		}
		this.continueNotebookInteraction(points[points.length - 1]);
	};

	private readonly handleNotebookWindowPointerUp = (event: PointerEvent): void => {
		if (this.notebookBridgedPointerId !== event.pointerId) {
			return;
		}
		if ((this.currentTool === "pen" || this.currentTool === "highlighter") && this.currentStroke) {
			appendStrokePoints(this.currentStroke, this.getNotebookPointsFromClientEvent(event));
		}
		this.finishNotebookInteraction(event.pointerId);
	};

	private readonly handleNotebookWindowPointerCancel = (event: PointerEvent): void => {
		if (this.notebookBridgedPointerId !== event.pointerId) {
			return;
		}
		this.cancelActiveNotebookInteraction();
		this.hideNotebookToolPreview();
	};

	private readonly handleNotebookKeyDown = (event: KeyboardEvent): void => {
		if (this.app.workspace.getActiveViewOfType(AnnotatorNotebookView) !== this) {
			return;
		}
		const target = event.target as HTMLElement | null;
		const tagName = target?.tagName?.toLowerCase();
		const isTypingTarget =
			tagName === "input" ||
			tagName === "textarea" ||
			tagName === "select" ||
			target?.isContentEditable;
		if (event.code === "Space" && !isTypingTarget) {
			this.notebookSpacePanActive = true;
			this.refreshNotebookCursor();
			event.preventDefault();
			return;
		}
		if (event.key === "Escape" && !isTypingTarget && this.cancelActiveNotebookInteraction()) {
			event.preventDefault();
			return;
		}
		if (isTypingTarget || this.currentTool !== "select" || this.hasOpenNotebookPopover()) {
			return;
		}
		const isModifierShortcut = event.ctrlKey || event.metaKey;
		if (isModifierShortcut && event.key.toLowerCase() === "a") {
			event.preventDefault();
			this.selectAllNotebookPageAnnotations();
			return;
		}
		if (this.selectedTargets.length === 0) {
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			this.clearNotebookSelection();
			return;
		}
		if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			this.deleteNotebookSelection();
			return;
		}
		if (isModifierShortcut && event.key.toLowerCase() === "c") {
			event.preventDefault();
			this.copyNotebookSelection();
			return;
		}
		if (isModifierShortcut && event.key.toLowerCase() === "x") {
			event.preventDefault();
			this.cutNotebookSelection();
			return;
		}
		if (isModifierShortcut && event.key === "]") {
			event.preventDefault();
			this.reorderNotebookSelection(event.shiftKey ? "front" : "forward");
			return;
		}
		if (isModifierShortcut && event.key === "[") {
			event.preventDefault();
			this.reorderNotebookSelection(event.shiftKey ? "back" : "backward");
			return;
		}
		if (isModifierShortcut && event.key.toLowerCase() === "v" && this.plugin.hasClipboard()) {
			event.preventDefault();
			this.pasteNotebookClipboard(event.shiftKey);
			return;
		}
		const nudgeAmount = this.getNotebookKeyboardNudgeAmount(event.shiftKey);
		const nudges: Record<string, { x: number; y: number }> = {
			ArrowLeft: { x: -nudgeAmount, y: 0 },
			ArrowRight: { x: nudgeAmount, y: 0 },
			ArrowUp: { x: 0, y: -nudgeAmount },
			ArrowDown: { x: 0, y: nudgeAmount }
		};
		const nudge = nudges[event.key];
		if (nudge) {
			event.preventDefault();
			this.nudgeNotebookSelection(nudge.x, nudge.y, !this.notebookKeyboardNudgeHistoryOpen);
			this.notebookKeyboardNudgeHistoryOpen = true;
		}
	};

	private hasOpenNotebookPopover(): boolean {
		return !!(
			this.notebookColorPopoverEl ||
			this.notebookStrokePopoverEl ||
			this.notebookConfirmPopoverEl ||
			this.notebookRenamePopoverEl ||
			this.notebookPaperColorPopoverEl
		);
	}

	private getNotebookKeyboardNudgeAmount(useLargeStep: boolean): number {
		const context = this.getNotebookContext();
		const minDimension = Math.min(context?.width ?? 0, context?.height ?? 0);
		const pixels = useLargeStep ? 10 : 2;
		if (!minDimension) {
			return useLargeStep ? 0.012 : 0.003;
		}
		return clamp(pixels / minDimension, 0.001, 0.03);
	}

	private readonly handleNotebookKeyUp = (event: KeyboardEvent): void => {
		if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
			this.notebookKeyboardNudgeHistoryOpen = false;
		}
		if (event.code !== "Space") {
			return;
		}
		this.notebookSpacePanActive = false;
		this.notebookPanAnchor = null;
		this.refreshNotebookCursor();
	};

	private readonly handleNotebookWindowBlur = (): void => {
		this.notebookKeyboardNudgeHistoryOpen = false;
		this.notebookSpacePanActive = false;
		this.notebookPanAnchor = null;
		this.refreshNotebookCursor();
	};

	private isNotebookPanActive(): boolean {
		return this.notebookPanMode || this.notebookSpacePanActive;
	}

	private shouldNotebookTouchPan(event: PointerEvent): boolean {
		if (!isTabletWebKitTouchDevice()) {
			return false;
		}
		const inputMethod = getInputMethod(event);
		if (inputMethod !== "touch") {
			return false;
		}
		return this.currentTool !== "select";
	}

	private refreshNotebookCursor(): void {
		if (!this.overlayEl) {
			return;
		}
		if (this.notebookPanAnchor) {
			this.overlayEl.setCssStyles({ cursor: "grabbing" });
			return;
		}
		if (this.isNotebookPanActive()) {
			this.overlayEl.setCssStyles({ cursor: "grab" });
			return;
		}
		this.overlayEl.setCssStyles({
			cursor: this.currentTool === "text"
				? "text"
				: this.currentTool === "eraser"
					? "cell"
					: "crosshair"
		});
	}

	private getNotebookToolPreviewRadius(): number {
		if (this.currentTool === "eraser") {
			return Math.max(6, this.toolState.getWidth("eraser") / 2);
		}
		return 0;
	}

	private updateNotebookToolPreview(clientX: number, clientY: number, active = false): void {
		if (!this.notebookToolPreviewEl || !this.pageSurfaceEl) {
			return;
		}
		this.notebookPreviewState.recordPointer(clientX, clientY);
		const radius = this.getNotebookToolPreviewRadius();
		if (radius <= 0 || this.currentTool !== "eraser") {
			this.hideNotebookToolPreview();
			return;
		}
		this.notebookPreviewState.show(radius, active);
		const rect = this.pageSurfaceEl.getBoundingClientRect();
		const size = radius * 2;
		this.notebookToolPreviewEl.classList.remove("is-hidden", "is-eraser", "is-active");
		this.notebookToolPreviewEl.classList.add("is-eraser");
		if (active) {
			this.notebookToolPreviewEl.classList.add("is-active");
		}
		this.notebookToolPreviewEl.setCssStyles({
			width: `${size}px`,
			height: `${size}px`,
			left: `${clientX - rect.left - radius}px`,
			top: `${clientY - rect.top - radius}px`
		});
	}

	private refreshNotebookToolPreviewFromLastPointer(active = false): void {
		const preview = this.notebookPreviewState.snapshot;
		if (preview.clientX === null || preview.clientY === null) {
			if (!active) {
				this.hideNotebookToolPreview();
			}
			return;
		}
		this.updateNotebookToolPreview(preview.clientX, preview.clientY, active);
	}

	private hideNotebookToolPreview(): void {
		this.notebookPreviewState.hide();
		this.notebookToolPreviewEl?.classList.add("is-hidden");
	}

	private getNotebookResizeCursor(handle: ResizeHandle): string {
		switch (handle) {
			case "n":
			case "s":
				return "ns-resize";
			case "e":
			case "w":
				return "ew-resize";
			case "ne":
			case "sw":
				return "nesw-resize";
			case "nw":
			case "se":
				return "nwse-resize";
		}
	}

	private updateNotebookHoverCursor(point: AnnotationPoint): void {
		if (!this.overlayEl) {
			return;
		}
		if (this.notebookInlineTextEditorEl) {
			this.overlayEl.setCssStyles({ cursor: "text" });
			return;
		}
		if (this.isNotebookPanActive() || this.notebookPanAnchor) {
			this.refreshNotebookCursor();
			return;
		}
		if (this.currentTool === "select") {
			const handle = this.getNotebookResizeHandle(point);
			if (handle && this.selectedTargets.length > 0) {
				this.overlayEl.setCssStyles({ cursor: this.getNotebookResizeCursor(handle) });
				return;
			}
			const selectedHit = this.selectedTargets.find((target) => {
				const bounds = this.getNotebookTargetBounds(target);
				return bounds
					? point.x >= bounds.left - 0.012 && point.x <= bounds.right + 0.012 && point.y >= bounds.top - 0.012 && point.y <= bounds.bottom + 0.012
					: false;
			});
			if (selectedHit) {
				this.overlayEl.setCssStyles({ cursor: "move" });
				return;
			}
			const hit = this.findNotebookSelectableTarget(point, 0.04);
			this.overlayEl.setCssStyles({ cursor: hit ? "pointer" : "default" });
			return;
		}
		this.refreshNotebookCursor();
	}

	private applyNotebookPreset(presetId: string): void {
		if (!this.toolState.applyPreset(presetId)) {
			return;
		}
		if (this.shouldApplyStyleToNotebookSelection()) {
			this.applyColorToNotebookSelection(this.currentColor);
			this.applyWidthToNotebookSelection(this.getActiveWidth());
		}
		this.persistToolDefaults();
		this.renderNotebookToolbar();
		this.drawNotebookPage();
	}

	private renderNotebookToolbar(): void {
		const toolbar = this.contentEl.querySelector(".annotator-notebook-toolbar-tools");
		if (!isHtmlDivElement(toolbar)) {
			return;
		}
		if (this.overlayEl) {
			this.refreshNotebookCursor();
		}
		this.closeNotebookColorPopover();
		this.closeNotebookStrokePopover();
		toolbar.replaceChildren();
		const group = toolbar.createDiv({ cls: "pdf-native-annotator-group" });
		let notebookSelectButton: HTMLButtonElement;
		notebookSelectButton = this.createNotebookIconButton("move", "Select", this.currentTool === "select", () => {
			if (this.currentTool === "select") {
				this.openNotebookSelectionMenu(notebookSelectButton);
				return;
			}
			this.setActiveTool("select");
		});
		group.appendChild(notebookSelectButton);
		if (this.currentTool === "select") {
			const selectionModeButton = this.createNotebookTextButton(
				this.toolState.selectionMode === "lasso" ? "Lasso" : this.toolState.selectionMode === "box" ? "Box" : "Single",
				false,
				() => {
					const targetButton = selectionModeButton;
					this.openNotebookSelectionMenu(targetButton);
				}
			);
			selectionModeButton.classList.add("pdf-native-annotator-mode-button");
			group.appendChild(selectionModeButton);
		}
		group.appendChild(this.createNotebookIconButton("pen-tool", "Pen", this.currentTool === "pen", () => this.setActiveTool("pen")));
		group.appendChild(this.createNotebookIconButton("highlighter", "Highlighter", this.currentTool === "highlighter", () => this.setActiveTool("highlighter")));
		group.appendChild(this.createNotebookIconButton("eraser", `Eraser (${this.toolState.eraserMode})`, this.currentTool === "eraser", () => {
			if (this.currentTool === "eraser") {
				this.toggleNotebookEraserMode();
				return;
			}
			this.setActiveTool("eraser");
		}));
		if (this.currentTool === "eraser") {
			const eraserModeButton = this.createNotebookTextButton(
				this.toolState.eraserMode === "segment" ? "Touch erase" : "Object erase",
				false,
				() => {
					this.toggleNotebookEraserMode();
				}
			);
			eraserModeButton.classList.add("pdf-native-annotator-mode-button");
			group.appendChild(eraserModeButton);
		}
		group.appendChild(this.createNotebookIconButton("type", "Text", this.currentTool === "text", () => this.setActiveTool("text")));
		group.appendChild(this.createNotebookIconButton("square", "Rectangle", this.currentTool === "rectangle", () => this.setActiveTool("rectangle")));
		group.appendChild(this.createNotebookIconButton("circle", "Ellipse", this.currentTool === "ellipse", () => this.setActiveTool("ellipse")));
		group.appendChild(this.createNotebookIconButton("minus", "Line", this.currentTool === "line", () => this.setActiveTool("line")));
		const activePresetKind = this.getNotebookActivePresetKind();
		if (activePresetKind) {
			const slots = createDiv();
			slots.className = "pdf-native-annotator-pen-slots";
			slots.classList.add(`is-${activePresetKind}`);
			for (const preset of this.toolState.getPresetsByKind(activePresetKind)) {
				slots.appendChild(this.createNotebookPresetButton(preset));
			}
			group.appendChild(slots);
		}
		if (this.currentTool !== "eraser") {
			group.appendChild(this.createNotebookColorPickerButton());
		}

		group.appendChild(this.createNotebookStrokeSizeButton());

		if (this.selectedTargets.length > 0) {
			const actionsButton = this.createNotebookTextButton(`Selection ${this.selectedTargets.length}`, false, () => {
				const targetButton = actionsButton;
				this.openNotebookSelectionActionsMenu(targetButton);
			});
			actionsButton.classList.add("pdf-native-annotator-mode-button");
			group.appendChild(actionsButton);
		}
		if (this.plugin.hasClipboard()) {
			group.appendChild(this.createNotebookIconButton("clipboard", "Paste selection", false, () => this.pasteNotebookClipboard()));
		}
		group.appendChild(this.createNotebookIconButton("undo-2", "Undo", false, () => this.undoNotebook()));
		group.appendChild(this.createNotebookIconButton("redo-2", "Redo", false, () => this.redoNotebook()));
		group.appendChild(this.createNotebookIconButton("save", "Save", false, () => {
			void this.flushSave();
		}));
		group.appendChild(this.createNotebookIconButton("image-file", "Export page snapshot", false, () => {
			void this.exportNotebookPageSnapshot();
		}));
	}

	private createNotebookIconButton(icon: string, label: string, active: boolean, onClick: () => void): HTMLButtonElement {
		const button = createEl("button");
		button.type = "button";
		button.className = "pdf-native-annotator-button clickable-icon pdf-native-annotator-icon-button";
		if (active) {
			button.classList.add("is-active");
		}
		button.setAttribute("aria-label", label);
		button.title = label;
		setIcon(button, icon);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", onClick);
		return button;
	}

	private createNotebookTextButton(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
		const button = createEl("button");
		button.type = "button";
		button.className = "pdf-native-annotator-button";
		if (active) {
			button.classList.add("is-active");
		}
		button.textContent = label;
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", onClick);
		return button;
	}

	private createNotebookPresetButton(preset: ToolPreset): HTMLButtonElement {
		const button = createEl("button");
		button.type = "button";
		button.className = "pdf-native-annotator-preset";
		button.classList.add(`is-${preset.kind}`);
		if (this.toolState.selectedPresetId === preset.id) {
			button.classList.add("is-active");
		}
		button.title = `${preset.label}: ${preset.kind} ${preset.width}`;
		const preview = createSpan();
		preview.className = "pdf-native-annotator-preset-preview";
		preview.setCssStyles({
			height: `${Math.max(4, Math.min(14, preset.width))}px`,
			width: `${Math.max(18, Math.min(34, preset.width * 2.6))}px`
		});
		if (preset.kind !== "eraser") {
			preview.setCssStyles({
				backgroundColor: preset.color,
				opacity: String(preset.opacity)
			});
		}
		button.appendChild(preview);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", () => {
			this.applyNotebookPreset(preset.id);
		});
		return button;
	}

	private createNotebookColorSwatch(color: string, label: string): HTMLButtonElement {
		const button = createEl("button");
		button.type = "button";
		button.className = "pdf-native-annotator-swatch";
		if (this.currentColor.toLowerCase() === color.toLowerCase()) {
			button.classList.add("is-active");
		}
		button.title = label;
		const inner = createSpan();
		inner.className = "pdf-native-annotator-swatch-inner";
		inner.setCssStyles({ backgroundColor: color });
		button.appendChild(inner);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", () => {
			if (this.shouldApplyStyleToNotebookSelection()) {
				this.applyColorToNotebookSelection(color);
			}
			this.setCurrentColor(color);
			this.renderNotebookToolbar();
			this.drawNotebookPage();
		});
		return button;
	}

	private createNotebookColorPickerButton(): HTMLButtonElement {
		const button = createEl("button");
		button.type = "button";
		button.className = "pdf-native-annotator-color-button";
		button.title = "Choose color";
		button.setAttribute("aria-label", "Choose notebook color");
		const preview = button.createSpan({ cls: "pdf-native-annotator-color-button-preview" });
		preview.setCssStyles({ backgroundColor: this.currentColor });
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openNotebookColorPopover(button);
		});
		return button;
	}

	private openNotebookColorPopover(anchor: HTMLElement): void {
		this.closeNotebookTransientPopovers("color");
		this.ensureNotebookPopoverBackdrop();
		const popover = createDiv();
		popover.className = "modal pdf-native-annotator-color-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-color-popover-title", text: "Ink color" });
		title.appendChild(this.createNotebookPopoverCloseButton(() => this.closeNotebookColorPopover()));
		const swatches = popover.createDiv({ cls: "pdf-native-annotator-color-popover-swatches" });
		for (const preset of [
			{ color: "#ff6b57", label: "Coral" },
			{ color: "#ffcb47", label: "Yellow" },
			{ color: "#55b4ff", label: "Blue" },
			{ color: "#6bcf8a", label: "Green" },
			{ color: "#d38cff", label: "Violet" }
		]) {
			const swatch = createEl("button");
			swatch.type = "button";
			swatch.className = "pdf-native-annotator-swatch";
			swatch.title = preset.label;
			if (this.currentColor.toLowerCase() === preset.color.toLowerCase()) {
				swatch.classList.add("is-active");
			}
			const inner = swatch.createSpan({ cls: "pdf-native-annotator-swatch-inner" });
			inner.setCssStyles({ backgroundColor: preset.color });
			swatch.addEventListener("click", () => {
				this.applyNotebookToolbarColor(preset.color);
				this.closeNotebookColorPopover();
				this.renderNotebookToolbar();
				this.drawNotebookPage();
			});
			swatches.appendChild(swatch);
		}
		const customRow = popover.createDiv({ cls: "pdf-native-annotator-color-popover-custom" });
		customRow.createSpan({ text: "Custom" });
		const colorInput = createEl("input");
		colorInput.type = "color";
		colorInput.value = this.currentColor;
		colorInput.className = "pdf-native-annotator-color";
		let historyCaptured = false;
		colorInput.addEventListener("input", () => {
			if (!historyCaptured && this.shouldApplyStyleToNotebookSelection()) {
				this.pushNotebookHistory();
				historyCaptured = true;
			}
			this.applyNotebookToolbarColor(colorInput.value);
			const preview = anchor.querySelector<HTMLElement>(".pdf-native-annotator-color-button-preview");
			if (preview) {
				preview.setCssStyles({ backgroundColor: colorInput.value });
			}
			this.drawNotebookPage();
		});
		colorInput.addEventListener("change", () => {
			this.closeNotebookColorPopover();
			this.renderNotebookToolbar();
		});
		customRow.appendChild(colorInput);
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendNotebookPopover(popover);
		this.positionNotebookPopover(anchor, popover);
		this.notebookColorPopoverEl = popover;
		this.notebookColorPopoverAnchorEl = anchor;
		window.addEventListener("keydown", this.handleNotebookPopoverKeyDown, { capture: true });
	}

	private applyNotebookToolbarColor(color: string): void {
		this.toolState.setColor(color);
		if (this.shouldApplyStyleToNotebookSelection()) {
			this.applyColorToNotebookSelection(color, false);
		}
		this.persistToolDefaults();
	}

	private createNotebookStrokeSizeButton(): HTMLButtonElement {
		const width = this.shouldApplyStyleToNotebookSelection() ? this.getNotebookSelectionWidthValue() : this.getActiveWidth();
		const button = createEl("button");
		button.type = "button";
		button.className = "pdf-native-annotator-stroke-button is-active";
		button.title = `${this.getNotebookStrokeTitle()}: ${width.toFixed(1)} px`;
		button.setAttribute("aria-label", `${this.getNotebookStrokeTitle()} ${width.toFixed(1)} px`);
		setIcon(button.createSpan({ cls: "pdf-native-annotator-stroke-icon" }), "sliders-horizontal");
		button.createSpan({ cls: "pdf-native-annotator-stroke-value", text: `${width.toFixed(1)}` });
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openNotebookStrokePopover(button);
		});
		return button;
	}

	private openNotebookStrokePopover(anchor: HTMLElement): void {
		this.closeNotebookTransientPopovers("stroke");
		this.ensureNotebookPopoverBackdrop();
		const popover = createDiv();
		popover.className = "modal pdf-native-annotator-stroke-popover";
		const targetTool = this.currentTool;
		const initialWidth = this.shouldApplyStyleToNotebookSelection() ? this.getNotebookSelectionWidthValue() : this.getActiveWidth();
		const title = popover.createDiv({ cls: "pdf-native-annotator-stroke-popover-title" });
		title.createSpan({ text: this.getNotebookStrokeTitle() });
		title.appendChild(this.createNotebookPopoverCloseButton(() => this.closeNotebookStrokePopover()));
		const previewWrap = popover.createDiv({ cls: "pdf-native-annotator-stroke-popover-preview" });
		const previewLine = previewWrap.createSpan({ cls: "pdf-native-annotator-stroke-popover-preview-line" });
		previewLine.setCssProps({ "--stroke-preview-size": `${initialWidth}px` });
		if (targetTool === "highlighter") {
			previewWrap.classList.add("is-highlighter");
			previewLine.setCssStyles({ backgroundColor: this.currentColor });
		} else if (targetTool === "eraser") {
			previewWrap.classList.add("is-eraser");
		} else {
			previewLine.setCssStyles({ backgroundColor: this.currentColor });
		}
		const body = popover.createDiv({ cls: "pdf-native-annotator-stroke-popover-body" });
		const valueLabel = body.createSpan({ cls: "pdf-native-annotator-stroke-popover-value", text: `${initialWidth.toFixed(1)} px` });
		const sliderWrap = body.createDiv({ cls: "pdf-native-annotator-stroke-slider-wrap" });
		const slider = sliderWrap.createEl("input", { type: "range" });
		slider.min = "1";
		slider.max = this.getNotebookWidthSliderMax(targetTool);
		slider.step = "0.5";
		slider.value = String(initialWidth);
		const tickRow = sliderWrap.createDiv({ cls: "pdf-native-annotator-stroke-ticks" });
		tickRow.createSpan({ text: "Thin" });
		tickRow.createSpan({ text: "Thick" });
		let historyCaptured = false;
		slider.addEventListener("input", () => {
			if (!historyCaptured && this.shouldApplyStyleToNotebookSelection()) {
				this.pushNotebookHistory();
				historyCaptured = true;
			}
			const width = Number(slider.value);
			valueLabel.textContent = `${width.toFixed(1)} px`;
			previewLine.setCssProps({ "--stroke-preview-size": `${width}px` });
			this.applyNotebookToolbarWidth(width, targetTool);
			const strokeValue = anchor.querySelector<HTMLElement>(".pdf-native-annotator-stroke-value");
			if (strokeValue) {
				strokeValue.textContent = width.toFixed(1);
			}
			this.drawNotebookPage();
		});
		slider.addEventListener("change", () => {
			this.closeNotebookStrokePopover();
			this.renderNotebookToolbar();
		});
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendNotebookPopover(popover);
		this.positionNotebookPopover(anchor, popover);
		this.notebookStrokePopoverEl = popover;
		this.notebookStrokePopoverAnchorEl = anchor;
		window.addEventListener("keydown", this.handleNotebookPopoverKeyDown, { capture: true });
	}

	private applyNotebookToolbarWidth(width: number, targetTool: AnnotationTool): void {
		if (this.shouldApplyStyleToNotebookSelection()) {
			this.applyWidthToNotebookSelection(width, false);
		}
		this.toolState.setWidth(width, isShapeTool(targetTool) ? "pen" : targetTool);
		this.persistToolDefaults();
		this.refreshNotebookToolPreviewFromLastPointer(this.currentTool === "eraser" && this.currentStroke !== null);
	}

	private getNotebookStrokeTitle(): string {
		if (this.currentTool === "eraser") {
			return "Eraser thickness";
		}
		if (this.currentTool === "highlighter") {
			return "Highlighter thickness";
		}
		if (this.currentTool === "line") {
			return "Line thickness";
		}
		if (this.currentTool === "rectangle" || this.currentTool === "ellipse") {
			return "Shape thickness";
		}
		if (this.currentTool === "select" && this.selectedTargets.length > 0) {
			return "Selection thickness";
		}
		return "Pen thickness";
	}

	private getNotebookWidthSliderMax(tool: AnnotationTool = this.currentTool): string {
		if (tool === "highlighter") {
			return "30";
		}
		if (tool === "eraser") {
			return "36";
		}
		if (isShapeTool(tool)) {
			return "24";
		}
		return "18";
	}

	private positionNotebookPopover(anchor: HTMLElement, popover: HTMLElement): void {
		const anchorRect = anchor.getBoundingClientRect();
		const popoverRect = popover.getBoundingClientRect();
		const left = clamp(anchorRect.left + (anchorRect.width / 2) - (popoverRect.width / 2), 12, window.innerWidth - popoverRect.width - 12);
		const top = clamp(anchorRect.bottom + 10, 12, window.innerHeight - popoverRect.height - 12);
		popover.setCssStyles({
			left: `${left}px`,
			top: `${top}px`
		});
	}

	private readonly scheduleNotebookPopoverReposition = (): void => {
		if (!this.notebookColorPopoverEl && !this.notebookStrokePopoverEl) {
			return;
		}
		if (this.notebookPopoverRepositionHandle !== null) {
			return;
		}
		this.notebookPopoverRepositionHandle = window.requestAnimationFrame(() => {
			this.notebookPopoverRepositionHandle = null;
			this.repositionNotebookPopovers();
		});
	};

	private repositionNotebookPopovers(): void {
		if (this.notebookColorPopoverEl && this.notebookColorPopoverAnchorEl?.isConnected) {
			this.positionNotebookPopover(this.notebookColorPopoverAnchorEl, this.notebookColorPopoverEl);
		}
		if (this.notebookStrokePopoverEl && this.notebookStrokePopoverAnchorEl?.isConnected) {
			this.positionNotebookPopover(this.notebookStrokePopoverAnchorEl, this.notebookStrokePopoverEl);
		}
	}

	private closeNotebookColorPopover(): void {
		this.notebookColorPopoverEl?.remove();
		this.notebookColorPopoverEl = null;
		this.notebookColorPopoverAnchorEl = null;
		this.removeNotebookPopoverKeyListenerIfIdle();
		this.removeNotebookPopoverBackdropIfIdle();
	}

	private closeNotebookStrokePopover(): void {
		this.notebookStrokePopoverEl?.remove();
		this.notebookStrokePopoverEl = null;
		this.notebookStrokePopoverAnchorEl = null;
		this.removeNotebookPopoverKeyListenerIfIdle();
		this.removeNotebookPopoverBackdropIfIdle();
	}

	private openNotebookEraserMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		menu.addItem((item) => {
			item
				.setTitle("Touch section erase")
				.setChecked(this.toolState.eraserMode === "segment")
				.onClick(() => {
					this.toolState.setEraserMode("segment");
					this.persistToolDefaults();
					this.renderNotebookToolbar();
				});
		});
		menu.addItem((item) => {
			item
				.setTitle("Whole object erase")
				.setChecked(this.toolState.eraserMode === "object")
				.onClick(() => {
					this.toolState.setEraserMode("object");
					this.persistToolDefaults();
					this.renderNotebookToolbar();
				});
		});
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private toggleNotebookEraserMode(): void {
		const nextMode: EraserMode = this.toolState.eraserMode === "segment" ? "object" : "segment";
		this.toolState.setEraserMode(nextMode);
		this.persistToolDefaults();
		this.renderNotebookToolbar();
		this.refreshNotebookToolPreviewFromLastPointer(false);
	}

	private openNotebookSelectionMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Single select").setChecked(this.toolState.selectionMode === "single").onClick(() => this.setSelectionMode("single")));
		menu.addItem((item) => item.setTitle("Box select").setChecked(this.toolState.selectionMode === "box").onClick(() => this.setSelectionMode("box")));
		menu.addItem((item) => item.setTitle("Lasso select").setChecked(this.toolState.selectionMode === "lasso").onClick(() => this.setSelectionMode("lasso")));
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openNotebookSelectionActionsMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Select all on page (Ctrl/Cmd+A)").setIcon("list-plus").onClick(() => this.selectAllNotebookPageAnnotations()));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Copy selection (Ctrl/Cmd+C)").setIcon("copy").onClick(() => this.copyNotebookSelection()));
		menu.addItem((item) => item.setTitle("Cut selection (Ctrl/Cmd+X)").setIcon("scissors").onClick(() => this.cutNotebookSelection()));
		menu.addItem((item) => item.setTitle("Paste selection (Ctrl/Cmd+V)").setIcon("clipboard").setDisabled(!this.plugin.hasClipboard()).onClick(() => this.pasteNotebookClipboard()));
		menu.addItem((item) => item.setTitle("Paste in place (Ctrl/Cmd+Shift+V)").setIcon("clipboard-copy").setDisabled(!this.plugin.hasClipboard()).onClick(() => this.pasteNotebookClipboard(true)));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Duplicate selection").setIcon("copy").onClick(() => this.duplicateNotebookSelection()));
		menu.addItem((item) => item.setTitle("Delete selection (Del)").setIcon("trash").onClick(() => this.deleteNotebookSelection()));
		menu.addItem((item) => item.setTitle("Nudge with arrow keys").setIcon("move").setDisabled(true));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Bring forward (Ctrl/Cmd+])").setIcon("bring-to-front").onClick(() => this.reorderNotebookSelection("forward")));
		menu.addItem((item) => item.setTitle("Send backward (Ctrl/Cmd+[)").setIcon("send-to-back").onClick(() => this.reorderNotebookSelection("backward")));
		menu.addItem((item) => item.setTitle("Bring to front (Ctrl/Cmd+Shift+])").setIcon("bring-to-front").onClick(() => this.reorderNotebookSelection("front")));
		menu.addItem((item) => item.setTitle("Send to back (Ctrl/Cmd+Shift+[)").setIcon("send-to-back").onClick(() => this.reorderNotebookSelection("back")));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Export selection snapshot").setIcon("image-file").onClick(() => void this.exportNotebookSelectionSnapshot()));
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openNotebookInlineAddMenu(button: HTMLButtonElement, referencePageId: string, position: "before" | "after"): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(position === "before" ? "Add template page before" : "Add template page after")
				.setIcon("plus")
				.onClick(() => position === "before" ? this.addPageBefore(referencePageId) : this.addPageAfter(referencePageId))
		);
		const pdfSource = this.plugin.getPreferredPdfInsertionSource();
		if (pdfSource) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(`${position === "before" ? "Add current PDF page before" : "Add current PDF page after"} (${pdfSource.file.name} p.${pdfSource.page})`)
					.setIcon("file-plus")
					.onClick(() => position === "before" ? this.insertCurrentPdfPageBefore(referencePageId) : this.insertCurrentPdfPageAfter(referencePageId))
			);
		}
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openNotebookPagePropertiesMenu(button: HTMLButtonElement, pageId: string): void {
		const page = this.getNotebookPageById(pageId);
		if (!page) {
			return;
		}
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Rename page").setIcon("pencil").onClick(() => void this.renamePage(pageId)));
		menu.addItem((item) => item.setTitle("Focus single page").setIcon("maximize").onClick(() => this.focusSinglePage(pageId)));
		menu.addSeparator();
		if (page.kind !== "pdf") {
			(["blank", "ruled", "grid", "dot"] as NotebookTemplate[]).forEach((template) => {
				menu.addItem((item) => item.setTitle(`Template: ${getNotebookTemplateLabel(template)}`).setChecked(page.template === template).onClick(() => void this.setPageTemplate(pageId, template)));
			});
			menu.addSeparator();
		}
		(["a4", "letter", "compact", "long"] as NotebookPageSize[]).forEach((size) => {
			menu.addItem((item) => item.setTitle(`Paper size: ${getNotebookPageSizeLabel(size)}`).setChecked(page.pageSize === size).onClick(() => void this.setPageSize(pageId, size)));
		});
		menu.addItem((item) => item.setTitle("Set paper color...").setIcon("palette").onClick(() => void this.setPagePaperColor(pageId)));
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openAddPageMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Insert page before current").setIcon("plus").onClick(() => this.addPageBeforeCurrent()));
		menu.addItem((item) => item.setTitle("Insert page after current").setIcon("plus").onClick(() => this.addPageAfterCurrent()));
		menu.addItem((item) => item.setTitle("Add page to end").setIcon("plus").onClick(() => this.addPageToEnd()));
		const pdfSource = this.plugin.getPreferredPdfInsertionSource();
		if (pdfSource) {
			menu.addSeparator();
			menu.addItem((item) => item.setTitle(`Insert current PDF page before (${pdfSource.file.name} p.${pdfSource.page})`).setIcon("file-plus").onClick(() => this.insertCurrentPdfPageBeforeCurrent()));
			menu.addItem((item) => item.setTitle(`Insert current PDF page after (${pdfSource.file.name} p.${pdfSource.page})`).setIcon("file-plus").onClick(() => this.insertCurrentPdfPageAfterCurrent()));
			menu.addItem((item) => item.setTitle(`Add current PDF page to end (${pdfSource.file.name} p.${pdfSource.page})`).setIcon("file-plus").onClick(() => this.insertCurrentPdfPageToEnd()));
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Duplicate current page").setIcon("copy").onClick(() => this.duplicateCurrentPage()));
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openCurrentNotebookPageMenu(button: HTMLButtonElement): void {
		if (!this.document || !this.activePageId) {
			return;
		}
		const index = this.document.pages.findIndex((page) => page.id === this.activePageId);
		if (index < 0) {
			return;
		}
		this.openNotebookPageItemMenu(button, this.activePageId, index);
	}

	private openCurrentNotebookPropertiesMenu(button: HTMLButtonElement): void {
		if (!this.activePageId) {
			return;
		}
		this.openNotebookPagePropertiesMenu(button, this.activePageId);
	}

	private openNotebookViewMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Fit width")
				.setIcon("arrow-left-right")
				.setChecked(this.notebookZoomMode === "fit-width")
				.onClick(() => this.fitNotebookToWidth())
		);
		menu.addItem((item) =>
			item
				.setTitle("Fit page")
				.setIcon("expand")
				.setChecked(this.notebookZoomMode === "fit-page")
				.onClick(() => this.fitNotebookToPage())
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Single-page mode")
				.setIcon("square")
				.setChecked(this.notebookFlowMode === "single")
				.onClick(() => this.setNotebookFlowMode("single"))
		);
		menu.addItem((item) =>
			item
				.setTitle("Paged mode")
				.setIcon("book-open")
				.setChecked(this.notebookFlowMode === "paged")
				.onClick(() => this.setNotebookFlowMode("paged"))
		);
		menu.addItem((item) =>
			item
				.setTitle("Continuous mode")
				.setIcon("rows-3")
				.setChecked(this.notebookFlowMode === "continuous")
				.onClick(() => this.setNotebookFlowMode("continuous"))
		);
		menu.addItem((item) =>
			item
				.setTitle(this.notebookPanMode ? "Disable hand mode" : "Enable hand mode")
				.setIcon("move")
				.setChecked(this.notebookPanMode)
				.onClick(() => this.toggleNotebookPanMode())
		);
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openNotebookPageItemMenu(button: HTMLButtonElement, pageId: string, index: number): void {
		const page = this.document?.pages[index];
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Open page").setIcon("file").onClick(() => this.selectNotebookPage(pageId)));
		menu.addItem((item) => item.setTitle("Rename page").setIcon("pencil").onClick(() => void this.renamePage(pageId)));
		if (page?.kind === "pdf" && page.pdfSource) {
			menu.addItem((item) => item.setTitle("Open source PDF page").setIcon("file-symlink").onClick(() => void this.openNotebookPdfSourcePage(pageId)));
			menu.addItem((item) => item.setTitle("Copy source PDF link").setIcon("link").onClick(() => void this.copyNotebookPdfSourceLink(pageId)));
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Export page snapshot").setIcon("image-file").onClick(() => void this.exportNotebookPageSnapshotFor(pageId)));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Move up").setIcon("arrow-up").onClick(() => void this.movePage(index, -1)));
		menu.addItem((item) => item.setTitle("Move down").setIcon("arrow-down").onClick(() => void this.movePage(index, 1)));
		menu.addItem((item) => item.setTitle("Move to top").setIcon("chevrons-up").onClick(() => void this.movePageToBoundary(pageId, "start")));
		menu.addItem((item) => item.setTitle("Move to bottom").setIcon("chevrons-down").onClick(() => void this.movePageToBoundary(pageId, "end")));
		menu.addItem((item) => item.setTitle("Duplicate page").setIcon("copy").onClick(() => void this.duplicatePage(pageId)));
		menu.addItem((item) => item.setTitle("Duplicate structure only").setIcon("copy").onClick(() => void this.duplicatePage(pageId, false)));
		if (page?.kind !== "pdf") {
			menu.addSeparator();
			(["blank", "ruled", "grid", "dot"] as NotebookTemplate[]).forEach((template) => {
				menu.addItem((item) => item.setTitle(`Template: ${getNotebookTemplateLabel(template)}`).setChecked(page?.template === template).onClick(() => void this.setPageTemplate(pageId, template)));
			});
		}
		menu.addSeparator();
		(["a4", "letter", "compact", "long"] as NotebookPageSize[]).forEach((size) => {
			menu.addItem((item) => item.setTitle(`Paper size: ${getNotebookPageSizeLabel(size)}`).setChecked(page?.pageSize === size).onClick(() => void this.setPageSize(pageId, size)));
		});
		menu.addItem((item) => item.setTitle("Set paper color...").setIcon("palette").onClick(() => void this.setPagePaperColor(pageId)));
		menu.addItem((item) => item.setTitle("Clear page contents").setIcon("eraser").onClick(() => void this.clearPageContents(pageId)));
		menu.addItem((item) => item.setTitle("Delete page").setIcon("trash").onClick(() => void this.deletePage(pageId)));
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private getNotebookPageMetaText(page: NotebookPage): string {
		return `${getNotebookPageKindLabel(page)} | ${getNotebookPageSourceSummary(page)} | ${page.pageSize}`;
	}

	private createNotebookPageFrame(container: HTMLElement, page: NotebookPage, interactive: boolean): HTMLDivElement {
		const pageCanvas = container.createDiv({
			cls: `annotator-notebook-page annotator-notebook-template-${page.template} annotator-notebook-page-size-${page.pageSize}`
		});
		pageCanvas.dataset.pageId = page.id;
		pageCanvas.setCssStyles({ backgroundColor: page.paperColor });
		if (page.id === this.activePageId) {
			pageCanvas.addClass("is-active-page");
		}
		if (this.notebookFlowMode === "continuous") {
			const chrome = pageCanvas.createDiv({ cls: "annotator-notebook-page-chrome" });
			const labelGroup = chrome.createDiv({ cls: "annotator-notebook-page-chip-group" });
			const label = labelGroup.createDiv({
				cls: "annotator-notebook-page-chip",
				text: page.id === this.activePageId ? `Editing ${page.title}` : page.title
			});
			label.title = this.getNotebookPageMetaText(page);
			label.addEventListener("click", (event) => {
				event.stopPropagation();
				if (this.activePageId !== page.id) {
					this.selectNotebookPage(page.id);
				}
			});
			if (page.kind === "pdf" && page.pdfSource) {
				const sourceBadge = labelGroup.createDiv({
					cls: "annotator-notebook-page-chip annotator-notebook-page-chip-source",
					text: getNotebookPageSourceSummary(page)
				});
				sourceBadge.title = this.getNotebookPageMetaText(page);
				sourceBadge.addEventListener("click", (event) => {
					event.stopPropagation();
					this.openPdfSourceForPage(page.id);
				});
			}
			const actionsRow = chrome.createDiv({ cls: "annotator-notebook-page-chip-actions" });
			const pageIndex = this.document?.pages.findIndex((entry) => entry.id === page.id) ?? -1;
			const beforeButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "Before"
			});
			beforeButton.title = "Add page before";
			beforeButton.addEventListener("click", (event) => {
				event.stopPropagation();
				this.addPageMenuBefore(beforeButton, page.id);
			});
			const soloButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "Solo"
			});
			soloButton.title = "Focus this page in single-page mode";
			soloButton.addEventListener("click", (event) => {
				event.stopPropagation();
				this.focusSinglePage(page.id);
			});
			const moveUpButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "↑"
			});
			moveUpButton.title = "Move page up";
			moveUpButton.disabled = pageIndex <= 0;
			moveUpButton.addEventListener("click", (event) => {
				event.stopPropagation();
				if (pageIndex > 0) {
					void this.movePage(pageIndex, -1);
				}
			});
			const moveDownButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "↓"
			});
			moveDownButton.title = "Move page down";
			moveDownButton.disabled = !this.document || pageIndex < 0 || pageIndex >= this.document.pages.length - 1;
			moveDownButton.addEventListener("click", (event) => {
				event.stopPropagation();
				if (this.document && pageIndex >= 0 && pageIndex < this.document.pages.length - 1) {
					void this.movePage(pageIndex, 1);
				}
			});
			if (page.kind === "pdf" && page.pdfSource) {
				const sourceButton = actionsRow.createEl("button", {
					cls: "annotator-notebook-page-chip-button",
					text: "PDF"
				});
				sourceButton.title = `Open source PDF page (${page.sourceLabel ?? getNotebookPageSourceSummary(page)})`;
				sourceButton.addEventListener("click", (event) => {
					event.stopPropagation();
					this.openPdfSourceForPage(page.id);
				});
				const linkButton = actionsRow.createEl("button", {
					cls: "annotator-notebook-page-chip-button",
					text: "Link"
				});
				linkButton.title = "Copy source PDF link";
				linkButton.addEventListener("click", (event) => {
					event.stopPropagation();
					void this.copyNotebookPdfSourceLink(page.id);
				});
			}
			const addButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "+"
			});
			addButton.title = "Add page after";
			addButton.addEventListener("click", (event) => {
				event.stopPropagation();
				this.addPageMenuAfter(addButton, page.id);
			});
			const duplicateButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "Copy"
			});
			duplicateButton.title = "Duplicate page";
			duplicateButton.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.duplicatePage(page.id);
			});
			const cloneButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "Clone"
			});
			cloneButton.title = "Duplicate structure only";
			cloneButton.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.duplicatePage(page.id, false);
			});
			const propsButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "Props"
			});
			propsButton.title = "Page properties";
			propsButton.addEventListener("click", (event) => {
				event.stopPropagation();
				this.openNotebookPagePropertiesMenu(propsButton, page.id);
			});
			const clearButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "Clear"
			});
			clearButton.title = "Clear page contents";
			clearButton.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.clearPageContents(page.id);
			});
			const snapshotButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "PNG"
			});
			snapshotButton.title = "Export page snapshot";
			snapshotButton.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.exportNotebookPageSnapshotFor(page.id);
			});
			const deleteButton = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button annotator-notebook-page-chip-button-danger",
				text: "Del"
			});
			deleteButton.title = "Delete page";
			deleteButton.disabled = !!this.document && this.document.pages.length <= 1;
			deleteButton.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.deletePage(page.id);
			});
			const actions = actionsRow.createEl("button", {
				cls: "annotator-notebook-page-chip-button",
				text: "..."
			});
			actions.title = "Page actions";
			actions.addEventListener("click", (event) => {
				event.stopPropagation();
				const index = this.document?.pages.findIndex((entry) => entry.id === page.id) ?? -1;
				if (index >= 0) {
					this.openNotebookPageItemMenu(actions, page.id, index);
				}
			});
		}
		pageCanvas.addEventListener("click", () => {
			if (this.activePageId !== page.id) {
				this.selectNotebookPage(page.id);
			}
		});
		const pageSurface = pageCanvas.createDiv({ cls: "annotator-notebook-page-surface" });
		pageSurface.dataset.pageId = page.id;
		if (interactive) {
			const background = pageSurface.createEl("canvas", { cls: "annotator-notebook-background-canvas" });
			const committed = pageSurface.createEl("canvas", { cls: "annotator-notebook-committed-canvas" });
			const overlay = pageSurface.createEl("canvas", { cls: "annotator-notebook-overlay" });
			const preview = pageSurface.createDiv({ cls: "pdf-native-annotator-tool-preview is-hidden" });
			this.pageSurfaceEl = pageSurface;
			this.backgroundEl = background;
			this.notebookCommittedEl = committed;
			this.overlayEl = overlay;
			this.notebookToolPreviewEl = preview;
		} else {
			pageSurface.createEl("canvas", { cls: "annotator-notebook-static-canvas" });
			pageSurface.addEventListener("pointerdown", (event) => this.handleNotebookInactivePagePointerDown(event, page.id, pageSurface));
		}
		return pageCanvas;
	}

	private createNotebookStackInsertControl(container: HTMLElement, referencePageId: string | null): void {
		const insertRow = container.createDiv({ cls: "annotator-notebook-stack-insert" });
		insertRow.classList.add(referencePageId ? "is-between-pages" : "is-end");
		const button = insertRow.createEl("button", {
			cls: "annotator-notebook-stack-insert-button",
			text: referencePageId ? "Insert page here" : "Add page to end"
		});
		button.addEventListener("click", () => this.openNotebookStackInsertMenu(button, referencePageId));
	}

	private openNotebookStackInsertMenu(button: HTMLButtonElement, referencePageId: string | null): void {
		const menu = new Menu();
		if (referencePageId) {
			menu.addItem((item) => item.setTitle("Insert template page here").setIcon("plus").onClick(() => this.addPageBefore(referencePageId)));
		} else {
			menu.addItem((item) => item.setTitle("Add template page to end").setIcon("plus").onClick(() => this.addPageToEnd()));
		}
		const pdfSource = this.plugin.getPreferredPdfInsertionSource();
		if (pdfSource) {
			menu.addSeparator();
			if (referencePageId) {
				menu.addItem((item) => item.setTitle(`Insert current PDF page here (${pdfSource.file.name} p.${pdfSource.page})`).setIcon("file-plus").onClick(() => this.insertCurrentPdfPageBefore(referencePageId)));
			} else {
				menu.addItem((item) => item.setTitle(`Add current PDF page to end (${pdfSource.file.name} p.${pdfSource.page})`).setIcon("file-plus").onClick(() => this.insertCurrentPdfPageToEnd()));
			}
		}
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private refreshNotebookStaticPages(): void {
		if (!this.document) {
			return;
		}
		const staticCanvases = this.contentEl.querySelectorAll(".annotator-notebook-static-canvas");
		staticCanvases.forEach((canvasNode) => {
			if (!isHtmlCanvasElement(canvasNode)) {
				return;
			}
			const surfaceEl = canvasNode.parentElement;
			const pageId = surfaceEl?.dataset.pageId;
			if (!isHtmlDivElement(surfaceEl) || !pageId) {
				return;
			}
			const page = this.document?.pages.find((entry) => entry.id === pageId);
			if (!page) {
				return;
			}
			const rect = surfaceEl.getBoundingClientRect();
			const width = Math.max(1, Math.round(rect.width));
			const height = Math.max(1, Math.round(rect.height));
			if (width <= 1 || height <= 1) {
				return;
			}
			const ratio = window.devicePixelRatio || 1;
			canvasNode.width = Math.max(1, Math.round(width * ratio));
			canvasNode.height = Math.max(1, Math.round(height * ratio));
			canvasNode.setCssStyles({
				width: `${width}px`,
				height: `${height}px`
			});
			const context = canvasNode.getContext("2d");
			if (!context) {
				return;
			}
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, height);
			const rendered = this.renderNotebookPageToCanvas(page, width, height);
			context.drawImage(rendered, 0, 0, width, height);
		});
	}

	private shouldBridgeNotebookToolAcrossPageActivation(): boolean {
		return !this.isNotebookPanActive();
	}

	private getNotebookPointFromClient(clientX: number, clientY: number, pressure = 0.5, timestamp = performance.now()): AnnotationPoint | null {
		if (!this.overlayEl) {
			return null;
		}
		const rect = this.overlayEl.getBoundingClientRect();
		const width = rect.width || 1;
		const height = rect.height || 1;
		return {
			x: clamp((clientX - rect.left) / width, 0, 1),
			y: clamp((clientY - rect.top) / height, 0, 1),
			pressure,
			t: timestamp
		};
	}

	private getNotebookPointsFromClientEvent(event: PointerEvent): AnnotationPoint[] {
		let previousPoint = this.lastNotebookPoint;
		let previousTime = this.lastNotebookPointTime;
		return getCoalescedPointerEvents(event)
			.map((sample) => {
				const pressure = resolvePointerPressure(sample, previousPoint, previousTime);
				const point = this.getNotebookPointFromClient(sample.clientX, sample.clientY, pressure, sample.timeStamp || performance.now());
				if (!point) {
					return null;
				}
				previousPoint = { clientX: sample.clientX, clientY: sample.clientY };
				previousTime = sample.timeStamp;
				return point;
			})
			.filter((point): point is AnnotationPoint => point !== null);
	}

	private handleNotebookInactivePagePointerDown(event: PointerEvent, pageId: string, surfaceEl: HTMLDivElement): void {
		if (this.notebookFlowMode !== "continuous" || event.button !== 0 || this.activePageId === pageId) {
			return;
		}
		if (this.isNotebookPanActive() || this.shouldNotebookTouchPan(event)) {
			this.currentPointerId = event.pointerId;
			this.notebookBridgedPointerId = null;
			this.notebookPanAnchor = {
				clientX: event.clientX,
				clientY: event.clientY,
				scrollLeft: this.pageViewportEl?.scrollLeft ?? 0,
				scrollTop: this.pageViewportEl?.scrollTop ?? 0
			};
			event.preventDefault();
			this.refreshNotebookCursor();
			return;
		}
		const rect = surfaceEl.getBoundingClientRect();
		const point: AnnotationPoint = {
			x: clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1),
			y: clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1),
			pressure: resolvePointerPressure(event, this.lastNotebookPoint, this.lastNotebookPointTime)
		};
		const pointerId = event.pointerId;
		const shouldBridge = this.shouldBridgeNotebookToolAcrossPageActivation();
		event.preventDefault();
		this.activePageId = pageId;
		this.clearNotebookInteractionState();
		this.rerenderNotebookPreservingViewport();
		window.requestAnimationFrame(() => {
			if (!this.activePage || this.activePage.id !== pageId) {
				return;
			}
			if (shouldBridge) {
				this.notebookBridgedPointerId = pointerId;
				this.beginNotebookInteraction(point, pointerId, false);
				this.refreshNotebookCursor();
				return;
			}
			this.refreshNotebookCursor();
		});
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("annotator-notebook-view");
		if (!this.document || !this.file) {
			contentEl.createEl("div", { text: "Notebook not loaded." });
			return;
		}

		const shell = contentEl.createDiv({ cls: "annotator-notebook-shell" });
		const sidebar = shell.createDiv({ cls: "annotator-notebook-sidebar" });
		const header = sidebar.createDiv({ cls: "annotator-notebook-sidebar-header" });
		header.createEl("h3", { text: this.document.title });
		const addButton = header.createEl("button", { cls: "mod-cta", text: "Add page" });
		addButton.addEventListener("click", () => {
			this.openAddPageMenu(addButton);
		});

		const pageList = sidebar.createDiv({ cls: "annotator-notebook-page-list" });
		this.document.pages.forEach((page, index) => {
			const item = pageList.createDiv({ cls: "annotator-notebook-page-item" });
			if (page.id === this.activePageId) {
				item.addClass("is-active");
			}
			item.addEventListener("click", () => {
				this.selectNotebookPage(page.id);
			});
			const info = item.createDiv({ cls: "annotator-notebook-page-info" });
			const thumb = info.createDiv({ cls: "annotator-notebook-page-thumb" });
			thumb.setCssStyles({
				backgroundImage: `url("${this.renderNotebookThumbnailDataUrl(page)}")`,
				backgroundSize: "cover",
				backgroundPosition: "center"
			});
			thumb.createDiv({ cls: "annotator-notebook-page-thumb-index", text: String(index + 1) });
			info.createDiv({ cls: "annotator-notebook-page-title", text: page.title });
			info.createDiv({ cls: "annotator-notebook-page-meta", text: this.getNotebookPageMetaText(page) });

			const controls = item.createDiv({ cls: "annotator-notebook-page-controls" });
			const up = controls.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Move page up" } });
			up.title = "Move page up";
			setIcon(up, "arrow-up");
			up.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.movePage(index, -1);
			});
			const down = controls.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Move page down" } });
			down.title = "Move page down";
			setIcon(down, "arrow-down");
			down.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.movePage(index, 1);
			});
			const remove = controls.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Delete page" } });
			remove.title = "Delete page";
			setIcon(remove, "trash");
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.deletePage(page.id);
			});
			const more = controls.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Page actions" } });
			more.title = "Page actions";
			setIcon(more, "more-horizontal");
			more.addEventListener("click", (event) => {
				event.stopPropagation();
				this.openNotebookPageItemMenu(more, page.id, index);
			});
		});

		const main = shell.createDiv({ cls: "annotator-notebook-main" });
		const activePage = this.activePage;
		if (!activePage) {
			main.createDiv({ text: "No pages yet." });
			return;
		}

		const toolbar = main.createDiv({ cls: "annotator-notebook-toolbar" });
		const primaryRow = toolbar.createDiv({ cls: "annotator-notebook-toolbar-row annotator-notebook-toolbar-row-primary" });
		const viewRow = toolbar.createDiv({ cls: "annotator-notebook-toolbar-row annotator-notebook-toolbar-row-view" });
		const addPageButton = primaryRow.createEl("button", { cls: "annotator-notebook-nav-button mod-cta", text: "Add page" });
		addPageButton.addEventListener("click", () => this.openAddPageMenu(addPageButton));
		const pagePosition = primaryRow.createDiv({ cls: "annotator-notebook-page-position", text: `Page ${this.activePageIndex + 1} of ${this.document.pages.length}` });
		pagePosition.title = activePage.title;
		const visiblePageInfo = primaryRow.createDiv({
			cls: "annotator-notebook-page-position",
			text: this.notebookFlowMode === "continuous"
				? `View ${this.activePageIndex + 1} of ${this.document.pages.length}`
				: this.notebookFlowMode === "paged"
					? `Page ${this.activePageIndex + 1} of ${this.document.pages.length}`
					: activePage.kind === "pdf" ? (activePage.sourceLabel ?? "PDF page") : "Template page"
		});
		visiblePageInfo.dataset.role = "visible-page";
		visiblePageInfo.title = this.getNotebookPageMetaText(activePage);
		const previousPageButton = primaryRow.createEl("button", { cls: "annotator-notebook-nav-button", text: "Prev" });
		previousPageButton.disabled = this.activePageIndex === 0;
		previousPageButton.addEventListener("click", () => this.navigateNotebookPage(-1));
		const nextPageButton = primaryRow.createEl("button", { cls: "annotator-notebook-nav-button", text: "Next" });
		nextPageButton.disabled = this.activePageIndex >= this.document.pages.length - 1;
		nextPageButton.addEventListener("click", () => this.navigateNotebookPage(1));
		const zoomOutButton = viewRow.createEl("button", { cls: "annotator-notebook-nav-button", text: "-" });
		zoomOutButton.addEventListener("click", () => this.setNotebookZoom(this.getEffectiveNotebookZoom(activePage) - 0.1));
		viewRow.createDiv({
			cls: "annotator-notebook-page-position",
			text: this.notebookZoomMode === "fit-width"
				? `Fit ${Math.round(this.getEffectiveNotebookZoom(activePage) * 100)}%`
				: this.notebookZoomMode === "fit-page"
					? `Page ${Math.round(this.getEffectiveNotebookZoom(activePage) * 100)}%`
				: `${Math.round(this.getEffectiveNotebookZoom(activePage) * 100)}%`
		});
		const zoomInButton = viewRow.createEl("button", { cls: "annotator-notebook-nav-button", text: "+" });
		zoomInButton.addEventListener("click", () => this.setNotebookZoom(this.getEffectiveNotebookZoom(activePage) + 0.1));
		const viewButton = viewRow.createEl("button", {
			cls: `annotator-notebook-nav-button${this.notebookPanMode || this.notebookFlowMode !== "single" || this.notebookZoomMode !== "custom" ? " is-active" : ""}`,
			text: "View"
		});
		viewButton.title = "View and navigation options";
		viewButton.addEventListener("click", () => this.openNotebookViewMenu(viewButton));
		const pageActionsButton = primaryRow.createEl("button", {
			cls: "annotator-notebook-nav-button",
			text: "Page"
		});
		pageActionsButton.title = "Current page actions";
		pageActionsButton.addEventListener("click", () => this.openCurrentNotebookPageMenu(pageActionsButton));
		toolbar.createDiv({ cls: "annotator-notebook-toolbar-tools" });

		const viewport = main.createDiv({ cls: "annotator-notebook-viewport" });
		this.pageViewportEl = viewport;
		viewport.classList.toggle("is-single", this.notebookFlowMode === "single");
		this.pageSurfaceEl = null;
		this.backgroundEl = null;
		this.notebookCommittedEl = null;
		this.overlayEl = null;
		this.notebookToolPreviewEl = null;
		if (this.notebookFlowMode !== "single") {
			viewport.classList.toggle("is-paged", this.notebookFlowMode === "paged");
			viewport.classList.toggle("is-continuous", this.notebookFlowMode === "continuous");
			const stack = viewport.createDiv({ cls: `annotator-notebook-stack annotator-notebook-stack-${this.notebookFlowMode}` });
			this.document.pages.forEach((page, index) => {
				if (index === 0) {
					this.createNotebookStackInsertControl(stack, page.id);
				}
				this.createNotebookPageFrame(stack, page, page.id === activePage.id);
				const nextPage = this.document?.pages[index + 1];
				this.createNotebookStackInsertControl(stack, nextPage?.id ?? null);
			});
		} else {
			this.createNotebookPageFrame(viewport, activePage, true);
		}
		const overlayEl = this.overlayEl as HTMLCanvasElement | null;
		const pageSurfaceEl = this.pageSurfaceEl as HTMLDivElement | null;
		if (!overlayEl || !pageSurfaceEl) {
			main.createDiv({ text: "Could not prepare the active notebook page surface." });
			return;
		}
		overlayEl.addEventListener("pointerdown", this.handleNotebookPointerDown);
		overlayEl.addEventListener("pointermove", this.handleNotebookPointerMove);
		overlayEl.addEventListener("pointerup", this.handleNotebookPointerUp);
		overlayEl.addEventListener("pointercancel", this.handleNotebookPointerCancel);
		overlayEl.addEventListener("pointerleave", this.handleNotebookPointerLeave);
		viewport.addEventListener("wheel", this.handleNotebookWheel, { passive: false });
		viewport.addEventListener("scroll", this.handleNotebookViewportScroll, { passive: true });
		viewport.addEventListener("pointermove", this.handleNotebookViewportPointerMove, { passive: true });
		this.resizeObserver?.disconnect();
		this.viewportResizeObserver?.disconnect();
		this.resizeObserver = new ResizeObserver(() => {
			this.resizeNotebookOverlay();
		});
		this.viewportResizeObserver = new ResizeObserver(() => {
			if (this.notebookZoomMode === "fit-width" || this.notebookZoomMode === "fit-page") {
				this.applyNotebookPageMetrics();
				this.resizeNotebookOverlay();
				this.refreshNotebookStaticPages();
				this.renderNotebookToolbar();
			}
			this.scheduleNotebookPopoverReposition();
		});
		this.viewportResizeObserver.observe(viewport);
		this.resizeObserver.observe(pageSurfaceEl);
		this.renderNotebookToolbar();
		this.applyNotebookPageMetrics();
		this.resizeNotebookOverlay();
		this.refreshNotebookStaticPages();
		this.refreshNotebookCursor();
	}

	private async insertTemplatePage(position: "before" | "after" | "end", referencePageId?: string): Promise<void> {
		if (!this.document) {
			return;
		}
		const nextPage = this.buildTemplatePageFromActive();
		if (position === "end") {
			this.document.pages.push(nextPage);
		} else {
			const currentIndex = referencePageId
				? this.document.pages.findIndex((page) => page.id === referencePageId)
				: this.activePageIndex;
			if (currentIndex < 0) {
				return;
			}
			const insertIndex = position === "before" ? currentIndex : currentIndex + 1;
			this.document.pages.splice(insertIndex, 0, nextPage);
		}
		this.activePageId = nextPage.id;
		this.clearNotebookInteractionState();
		await this.saveNotebook();
		this.render();
	}

	private async insertPdfBackedPage(position: "before" | "after" | "end", referencePageId?: string): Promise<void> {
		if (!this.document) {
			return;
		}
		const nextPage = this.buildPdfBackedPageFromPreferredSource();
		if (!nextPage) {
			new Notice("Open a PDF in Obsidian first so a PDF page can be inserted into the notebook.");
			return;
		}
		if (position === "end") {
			this.document.pages.push(nextPage);
		} else {
			const currentIndex = referencePageId
				? this.document.pages.findIndex((page) => page.id === referencePageId)
				: this.activePageIndex;
			if (currentIndex < 0) {
				return;
			}
			const insertIndex = position === "before" ? currentIndex : currentIndex + 1;
			this.document.pages.splice(insertIndex, 0, nextPage);
		}
		this.activePageId = nextPage.id;
		this.clearNotebookInteractionState();
		await this.saveNotebook();
		this.render();
	}

	private async duplicateActivePage(includeAnnotations = true): Promise<void> {
		if (!this.document || !this.activePage) {
			return;
		}
		const nextPage = this.cloneNotebookPage(this.activePage, undefined, includeAnnotations);
		this.document.pages.splice(this.activePageIndex + 1, 0, nextPage);
		this.activePageId = nextPage.id;
		this.clearNotebookInteractionState();
		await this.saveNotebook();
		this.render();
	}

	private async duplicatePage(pageId: string, includeAnnotations = true): Promise<void> {
		if (!this.document) {
			return;
		}
		const index = this.document.pages.findIndex((page) => page.id === pageId);
		if (index < 0) {
			return;
		}
		const source = this.document.pages[index];
		const nextPage = this.cloneNotebookPage(source, undefined, includeAnnotations);
		this.document.pages.splice(index + 1, 0, nextPage);
		this.activePageId = nextPage.id;
		this.clearNotebookInteractionState();
		await this.saveNotebook();
		this.refreshNotebookViewAfterStructureChange();
	}

	private async clearPageContents(pageId: string): Promise<void> {
		if (!this.document) {
			return;
		}
		const page = this.document.pages.find((entry) => entry.id === pageId);
		if (!page) {
			return;
		}
		if (page.strokes.length === 0 && page.textItems.length === 0 && page.shapes.length === 0) {
			return;
		}
		this.requestNotebookDangerConfirmation(
			"Clear page?",
			`All annotations on ${page.title} will be removed, but the page itself will stay.`,
			"Clear page",
			async () => {
				page.strokes = [];
				page.textItems = [];
				page.shapes = [];
				if (this.activePageId === pageId) {
					this.clearNotebookInteractionState();
				}
				await this.saveNotebook();
				this.refreshNotebookViewAfterStructureChange();
			}
		);
	}

	private async clearActivePageContents(): Promise<void> {
		if (!this.activePage) {
			return;
		}
		await this.clearPageContents(this.activePage.id);
	}

	private async deletePage(pageId: string): Promise<void> {
		if (!this.document || this.document.pages.length === 1) {
			new Notice("Notebook must keep at least one page.");
			return;
		}
		const page = this.document.pages.find((entry) => entry.id === pageId);
		if (!page) {
			return;
		}
		this.requestNotebookDangerConfirmation(
			"Delete page?",
			`${page.title} will be removed from this notebook.`,
			"Delete page",
			async () => {
				if (!this.document) {
					return;
				}
				const pageIndex = this.document.pages.findIndex((entry) => entry.id === pageId);
				this.document.pages = this.document.pages.filter((entry) => entry.id !== pageId);
				const fallbackPage = this.document.pages[Math.max(0, pageIndex - 1)] ?? this.document.pages[0] ?? null;
				this.activePageId = fallbackPage?.id ?? null;
				this.clearNotebookInteractionState();
				await this.saveNotebook();
				this.refreshNotebookViewAfterStructureChange();
			}
		);
	}

	private async movePage(index: number, offset: -1 | 1): Promise<void> {
		if (!this.document) {
			return;
		}
		const nextIndex = index + offset;
		if (nextIndex < 0 || nextIndex >= this.document.pages.length) {
			return;
		}
		const [page] = this.document.pages.splice(index, 1);
		this.document.pages.splice(nextIndex, 0, page);
		await this.saveNotebook();
		this.refreshNotebookViewAfterStructureChange();
	}

	private async movePageToBoundary(pageId: string, target: "start" | "end"): Promise<void> {
		if (!this.document) {
			return;
		}
		const index = this.document.pages.findIndex((page) => page.id === pageId);
		if (index < 0) {
			return;
		}
		const [page] = this.document.pages.splice(index, 1);
		if (target === "start") {
			this.document.pages.unshift(page);
		} else {
			this.document.pages.push(page);
		}
		await this.saveNotebook();
		this.refreshNotebookViewAfterStructureChange();
	}

	private async renamePage(pageId: string): Promise<void> {
		if (!this.document) {
			return;
		}
		const page = this.document.pages.find((entry) => entry.id === pageId);
		if (!page) {
			return;
		}
		this.openNotebookRenamePopover(pageId);
	}

	private async setPageTemplate(pageId: string, template: NotebookTemplate): Promise<void> {
		if (!this.document) {
			return;
		}
		const page = this.document.pages.find((entry) => entry.id === pageId);
		if (!page || page.kind === "pdf" || page.template === template) {
			return;
		}
		page.template = template;
		await this.saveNotebook();
		this.refreshNotebookViewAfterStructureChange();
	}

	private async setPageSize(pageId: string, pageSize: NotebookPageSize): Promise<void> {
		if (!this.document) {
			return;
		}
		const page = this.document.pages.find((entry) => entry.id === pageId);
		if (!page || page.pageSize === pageSize) {
			return;
		}
		page.pageSize = pageSize;
		await this.saveNotebook();
		this.refreshNotebookViewAfterStructureChange();
	}

	private async setPagePaperColor(pageId: string): Promise<void> {
		if (!this.document) {
			return;
		}
		const page = this.document.pages.find((entry) => entry.id === pageId);
		if (!page) {
			return;
		}
		this.openNotebookPaperColorPopover(pageId);
	}

	private openNotebookRenamePopover(pageId: string): void {
		const page = this.document?.pages.find((entry) => entry.id === pageId);
		if (!page) {
			return;
		}
		this.closeNotebookTransientPopovers("rename");
		this.ensureNotebookPopoverBackdrop();
		const popover = createDiv();
		popover.className = "modal pdf-native-annotator-rename-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-color-popover-title", text: "Page name" });
		title.appendChild(this.createNotebookPopoverCloseButton(() => this.closeNotebookRenamePopover()));
		const form = popover.createEl("form", { cls: "pdf-native-annotator-rename-form" });
		const input = form.createEl("input", { type: "text", placeholder: "Page name" });
		input.value = page.title;
		input.className = "pdf-native-annotator-rename-input";
		const actions = form.createDiv({ cls: "pdf-native-annotator-confirm-actions" });
		const cancelButton = actions.createEl("button", { type: "button", text: "Cancel" });
		const saveButton = actions.createEl("button", { type: "submit", text: "Save", cls: "mod-cta" });
		const commit = (): void => {
			void this.commitNotebookPageRename(pageId, input.value);
		};
		cancelButton.addEventListener("click", () => this.closeNotebookRenamePopover());
		saveButton.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			commit();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commit();
			}
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeNotebookRenamePopover();
			}
			event.stopPropagation();
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			commit();
		});
		popover.addEventListener("pointerdown", (event) => event.stopPropagation());
		this.appendNotebookPopover(popover);
		this.positionNotebookCenteredPopover(popover);
		this.notebookRenamePopoverEl = popover;
		window.addEventListener("keydown", this.handleNotebookPopoverKeyDown, { capture: true });
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	private async commitNotebookPageRename(pageId: string, rawTitle: string): Promise<void> {
		const page = this.document?.pages.find((entry) => entry.id === pageId);
		const title = rawTitle.trim();
		if (!page) {
			this.closeNotebookRenamePopover();
			return;
		}
		if (!title) {
			new Notice("Page name cannot be empty.");
			return;
		}
		if (title === page.title) {
			this.closeNotebookRenamePopover();
			return;
		}
		page.title = title;
		await this.saveNotebook();
		this.closeNotebookRenamePopover();
		this.refreshNotebookViewAfterStructureChange();
		new Notice(`Renamed page to "${title}"`);
	}

	private openNotebookPaperColorPopover(pageId: string): void {
		const page = this.document?.pages.find((entry) => entry.id === pageId);
		if (!page) {
			return;
		}
		this.closeNotebookTransientPopovers("paper");
		this.ensureNotebookPopoverBackdrop();
		const popover = createDiv();
		popover.className = "modal pdf-native-annotator-color-popover pdf-native-annotator-paper-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-color-popover-title", text: "Paper color" });
		title.appendChild(this.createNotebookPopoverCloseButton(() => this.closeNotebookPaperColorPopover()));
		const swatches = popover.createDiv({ cls: "pdf-native-annotator-color-popover-swatches" });
		for (const preset of PAPER_COLOR_PRESETS) {
			const swatch = createEl("button");
			swatch.type = "button";
			swatch.className = "pdf-native-annotator-swatch";
			swatch.title = preset.label;
			if (page.paperColor.toLowerCase() === preset.color.toLowerCase()) {
				swatch.classList.add("is-active");
			}
			const inner = swatch.createSpan({ cls: "pdf-native-annotator-swatch-inner" });
			inner.setCssStyles({ backgroundColor: preset.color });
			swatch.addEventListener("click", () => {
				void this.commitNotebookPagePaperColor(pageId, preset.color);
			});
			swatches.appendChild(swatch);
		}
		const customRow = popover.createDiv({ cls: "pdf-native-annotator-color-popover-custom" });
		customRow.createSpan({ text: "Custom" });
		const colorInput = createEl("input");
		colorInput.type = "color";
		colorInput.value = page.paperColor;
		colorInput.className = "pdf-native-annotator-color";
		colorInput.addEventListener("input", () => {
			void this.commitNotebookPagePaperColor(pageId, colorInput.value, false);
		});
		colorInput.addEventListener("change", () => this.closeNotebookPaperColorPopover());
		customRow.appendChild(colorInput);
		popover.addEventListener("pointerdown", (event) => event.stopPropagation());
		this.appendNotebookPopover(popover);
		this.positionNotebookCenteredPopover(popover);
		this.notebookPaperColorPopoverEl = popover;
		window.addEventListener("keydown", this.handleNotebookPopoverKeyDown, { capture: true });
	}

	private async commitNotebookPagePaperColor(pageId: string, color: string, closeAfterSave = true): Promise<void> {
		const page = this.document?.pages.find((entry) => entry.id === pageId);
		if (!page || page.paperColor.toLowerCase() === color.toLowerCase()) {
			return;
		}
		page.paperColor = color;
		await this.saveNotebook();
		this.refreshNotebookViewAfterStructureChange();
		if (closeAfterSave) {
			this.closeNotebookPaperColorPopover();
		}
	}

	private requestNotebookDangerConfirmation(title: string, message: string, confirmText: string, onConfirm: () => void | Promise<void>): void {
		this.closeNotebookTransientPopovers("confirm");
		this.ensureNotebookPopoverBackdrop();
		const popover = createDiv();
		popover.className = "modal pdf-native-annotator-confirm-popover";
		const header = popover.createDiv({ cls: "pdf-native-annotator-confirm-title" });
		setIcon(header.createSpan({ cls: "pdf-native-annotator-confirm-icon" }), "triangle-alert");
		header.createSpan({ text: title });
		header.appendChild(this.createNotebookPopoverCloseButton(() => this.closeNotebookConfirmPopover()));
		popover.createDiv({ cls: "pdf-native-annotator-confirm-message", text: message });
		const actions = popover.createDiv({ cls: "pdf-native-annotator-confirm-actions" });
		const cancelButton = actions.createEl("button", { type: "button", text: "Cancel" });
		const confirmButton = actions.createEl("button", { type: "button", text: confirmText, cls: "mod-warning" });
		cancelButton.addEventListener("click", () => this.closeNotebookConfirmPopover());
		confirmButton.addEventListener("click", () => {
			this.closeNotebookConfirmPopover();
			void onConfirm();
		});
		popover.addEventListener("pointerdown", (event) => event.stopPropagation());
		this.appendNotebookPopover(popover);
		this.positionNotebookCenteredPopover(popover);
		this.notebookConfirmPopoverEl = popover;
		window.addEventListener("keydown", this.handleNotebookPopoverKeyDown, { capture: true });
		window.setTimeout(() => confirmButton.focus(), 0);
	}

	private positionNotebookCenteredPopover(popover: HTMLElement): void {
		const rect = popover.getBoundingClientRect();
		const hostRect = this.contentEl.getBoundingClientRect();
		const preferredLeft = hostRect.left + (hostRect.width / 2) - (rect.width / 2);
		const preferredTop = Math.max(hostRect.top + 88, 24);
		popover.setCssStyles({
			left: `${clamp(preferredLeft, 12, window.innerWidth - rect.width - 12)}px`,
			top: `${clamp(preferredTop, 12, window.innerHeight - rect.height - 12)}px`
		});
	}

	private createNotebookPopoverCloseButton(onClick: () => void): HTMLButtonElement {
		const button = createEl("button");
		button.type = "button";
		button.className = "modal-close-button pdf-native-annotator-popover-close";
		button.setAttribute("aria-label", "Close");
		button.title = "Close";
		setIcon(button, "x");
		button.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick();
		});
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		return button;
	}

	private ensureNotebookPopoverBackdrop(): void {
		if (this.notebookPopoverBackdropEl) {
			return;
		}
		const backdrop = createDiv();
		backdrop.className = "modal-container pdf-native-annotator-popover-backdrop";
		backdrop.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.closeNotebookTransientPopovers();
		});
		document.body.appendChild(backdrop);
		this.notebookPopoverBackdropEl = backdrop;
	}

	private appendNotebookPopover(popover: HTMLElement): void {
		popover.addEventListener("pointerdown", (event) => event.stopPropagation());
		(this.notebookPopoverBackdropEl ?? document.body).appendChild(popover);
	}

	private removeNotebookPopoverBackdropIfIdle(): void {
		if (this.notebookColorPopoverEl || this.notebookStrokePopoverEl || this.notebookConfirmPopoverEl || this.notebookRenamePopoverEl || this.notebookPaperColorPopoverEl) {
			return;
		}
		this.forceRemoveNotebookPopoverBackdrop();
	}

	private forceRemoveNotebookPopoverBackdrop(): void {
		this.notebookPopoverBackdropEl?.remove();
		this.notebookPopoverBackdropEl = null;
	}

	private closeNotebookTransientPopovers(except?: "color" | "stroke" | "confirm" | "rename" | "paper"): void {
		if (except !== "color") {
			this.closeNotebookColorPopover();
		}
		if (except !== "stroke") {
			this.closeNotebookStrokePopover();
		}
		if (except !== "confirm") {
			this.closeNotebookConfirmPopover();
		}
		if (except !== "rename") {
			this.closeNotebookRenamePopover();
		}
		if (except !== "paper") {
			this.closeNotebookPaperColorPopover();
		}
	}

	private readonly handleNotebookPopoverKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") {
			return;
		}
		if (!this.notebookColorPopoverEl && !this.notebookStrokePopoverEl && !this.notebookConfirmPopoverEl && !this.notebookRenamePopoverEl && !this.notebookPaperColorPopoverEl) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.closeNotebookTransientPopovers();
	};

	private removeNotebookPopoverKeyListenerIfIdle(): void {
		if (this.notebookColorPopoverEl || this.notebookStrokePopoverEl || this.notebookConfirmPopoverEl || this.notebookRenamePopoverEl || this.notebookPaperColorPopoverEl) {
			return;
		}
		window.removeEventListener("keydown", this.handleNotebookPopoverKeyDown, { capture: true });
	}

	private closeNotebookConfirmPopover(): void {
		this.notebookConfirmPopoverEl?.remove();
		this.notebookConfirmPopoverEl = null;
		this.removeNotebookPopoverKeyListenerIfIdle();
		this.removeNotebookPopoverBackdropIfIdle();
	}

	private closeNotebookRenamePopover(): void {
		this.notebookRenamePopoverEl?.remove();
		this.notebookRenamePopoverEl = null;
		this.removeNotebookPopoverKeyListenerIfIdle();
		this.removeNotebookPopoverBackdropIfIdle();
	}

	private closeNotebookPaperColorPopover(): void {
		this.notebookPaperColorPopoverEl?.remove();
		this.notebookPaperColorPopoverEl = null;
		this.removeNotebookPopoverKeyListenerIfIdle();
		this.removeNotebookPopoverBackdropIfIdle();
	}
}
