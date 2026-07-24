import { App, FileView, MarkdownView, Menu, Modal, Notice, Plugin, Setting, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { getInputMethod } from "./src/utils/deviceUtils";
import { appendStrokePoints, drawSmoothInkStroke, getSmoothInkStrokePath, setInkRenderSettings } from "./src/ink/inkEngine";
import { boundsOverlap, distanceBetween, distanceToSegment, getPolygonBounds, pathIntersectsPolygon, pointInPolygon, segmentsIntersect } from "./src/annotation/geometry";
import { getAnnotationRenderables, getRenderableKey, getRenderableOrder, reorderRenderables } from "./src/annotation/renderOrder";
import type { AnnotationReorderDirection } from "./src/annotation/renderOrder";
import { getShapeBounds, getStrokeBounds, getTextBounds, getTextLines } from "./src/annotation/bounds";
import { cloneAnnotationsForPage, distanceBetweenSegments, distanceToBounds, distanceToRectEdge, distanceToShape, distanceToStroke, getClipboardPasteOffset, getSelectionBoxPoints, normalizeRect, parseRegionReference, pointInBounds, polygonIntersectsBounds, segmentIntersectsExpandedBounds, splitStrokeByEraser, splitStrokeByEraserPath } from "./src/annotation/interaction";
import { PAPER_TEMPLATE_DOT_COLOR, PAPER_TEMPLATE_GRID_COLOR, PAPER_TEMPLATE_LINE_COLOR, getPaperTemplateMetrics } from "./src/notebook/paperTemplates";
import { LRUCache } from "./src/utils/lruCache";
import {
	DEFAULT_TOOL_PRESETS,
	MAX_HISTORY,
	NOTEBOOK_EXTENSION,
	NOTEBOOK_VIEW_TYPE,
	OVERLAY_CLASS,
	PAGE_SELECTORS,
	PAGE_VIRTUALIZATION_MARGIN,
	PAPER_COLOR_PRESETS,
	SESSION_ROOT_CLASS,
	TEXT_COLOR_PRESETS,
	TEXT_FONT_FAMILIES,
	TEXT_FONT_SIZES,
	TOOLBAR_SELECTORS,
	ZOOM_SETTLE_DELAY_MS
} from "./src/config";
import { AnnotationStore, cloneDocument, createEmptyDocument, normalizeDocumentStrokeScales, normalizeDocumentZIndexes } from "./src/stores/annotationStore";
import { NotebookStore, cloneNotebookDocument, createEmptyNotebookDocument, normalizeNotebookZIndexes } from "./src/stores/notebookStore";
import { AnnotatedEmbedController } from "./src/markdown/annotatedEmbedController";
import { findScrollParent, getOverlayHost } from "./src/pdf/pdfDom";
import { dataUrlToArrayBuffer, clamp, generateId, getBaseName } from "./src/utils/general";
import { readClipboardText, writeClipboardText } from "./src/utils/clipboard";
import { createPdfBackedNotebookPage, createTemplateNotebookPage, getNotebookPageKindLabel, getNotebookPageRenderDimensions, getNotebookPageSizeDimensions, getNotebookPageSizeLabel, getNotebookPageSourceSummary, getNotebookTemplateLabel } from "./src/notebook/pageModel";
import { createTemplatePageBackgroundDataUrl, drawTemplatePageBackground } from "./src/notebook/templateCanvas";
import { getCoalescedPointerEvents, isInkDrawingTool, resolvePointerPressure, shouldIgnoreInkPointerEvent } from "./src/pointer/pointerInput";
import { PDFAnnotatorSettingsController } from "./src/settings/settingsController";
import { PDFAnnotatorSettingTab } from "./src/settings/settingTab";
import { registerNotebookCommands } from "./src/commands/notebookCommands";
import { createNativeMixedWorkingPdf, exportAnnotatedMixedDocumentPdf } from "./src/export/mixedDocumentExport";
import { buildPdfFromJpegPages } from "./src/export/simplePdfWriter";
import {
	INLINE_TEXT_BOX_PADDING_X,
	INLINE_TEXT_BOX_PADDING_Y,
	INLINE_TEXT_LINE_HEIGHT,
	getInlineTextEditorLayout,
	getWrappedCanvasTextLines,
	resizeInlineTextEditor
} from "./src/text/textLayout";
import { PreviewStateController, ToolStateController, isShapeTool } from "./src/tools/toolState";
import type {
	AnnotationClipboardPayload,
	AnnotationDocument,
	AnnotationLoadInfo,
	AnnotationPoint,
	AnnotationTool,
	EraserMode,
	HitCandidate,
	ImageAnnotation,
	InkInputPolicy,
	InkRenderSettings,
	LassoSelection,
	MixedPageEntry,
	NormalizedRect,
	NotebookDocument,
	NotebookHistoryState,
	NotebookPage,
	NotebookPageKind,
	NotebookPageSize,
	NotebookTemplate,
	PDFAnnotatorSettings,
	PageAnnotationBucket,
	PageSurface,
	PdfPageTemplate,
	PdfLikeView,
	RegionReference,
	RenderableAnnotation,
	ResizeHandle,
	SelectedTarget,
	SelectionMode,
	ShapeAnnotation,
	ShapeTool,
	StrokeAnnotation,
	TextAnnotation,
	ToolPreset,
	ToolPresetKind,
	ToolStateSnapshot
} from "./src/types";

import { AnnotatorNotebookView } from "./src/notebook/AnnotatorNotebookView";

const DEFAULT_STROKE_REFERENCE_WIDTH = 1524;
const MAX_STROKE_WIDTH_SCALE = 0.08;
const MAX_TEXT_FONT_SCALE = 0.08;
const SCALE_DRIFT_TOLERANCE = 2.25;
const BLANK_PDF_EXPORT_WIDTH_PX = 1600;

function isDomNode(value: unknown): value is Node {
	const candidate = value as { instanceOf?: <T>(type: { new (): T }) => boolean } | null;
	return typeof candidate?.instanceOf === "function" && candidate.instanceOf(Node);
}

function isDomElement(value: unknown): value is Element {
	return isDomNode(value) && value.instanceOf(Element);
}

function isHtmlElement(value: unknown): value is HTMLElement {
	return isDomNode(value) && value.instanceOf(HTMLElement);
}

function isHtmlCanvasElement(value: unknown): value is HTMLCanvasElement {
	return isDomNode(value) && value.instanceOf(HTMLCanvasElement);
}

interface BlankAnnotatablePdfOptions {
	title: string;
	pageCount: number;
	template: NotebookTemplate;
	pageSize: NotebookPageSize;
	paperColor: string;
}

interface NativeInsertPageOptions {
	title: string;
	template: NotebookTemplate;
	pageSize: NotebookPageSize;
	paperColor: string;
}

interface NativeInsertPageLocation {
	insertIndex: number;
	anchor: number;
	anchorLabel: string;
}

class BlankAnnotatablePdfModal extends Modal {
	private options: BlankAnnotatablePdfOptions = {
		title: "New annotatable PDF",
		pageCount: 1,
		template: "ruled",
		pageSize: "a4",
		paperColor: "#fffdf7"
	};

	constructor(app: App, private readonly onSubmit: (options: BlankAnnotatablePdfOptions) => void) {
		super(app);
		this.titleEl.setText("Create annotatable PDF");
		this.modalEl.addClass("pdf-native-annotator-native-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			text: "Creates a real PDF in the vault and opens it in Obsidian's native PDF viewer. No .annotbook file is used.",
			cls: "setting-item-description"
		});

		new Setting(contentEl)
			.setName("Title")
			.setDesc("The PDF filename.")
			.addText((text) => {
				text.setValue(this.options.title);
				text.onChange((value) => {
					this.options.title = value.trim() || "New annotatable PDF";
				});
			});

		new Setting(contentEl)
			.setName("Pages")
			.setDesc("Number of template pages to create.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "200";
				text.setValue(String(this.options.pageCount));
				text.onChange((value) => {
					const next = Math.round(Number(value));
					this.options.pageCount = clamp(Number.isFinite(next) ? next : 1, 1, 200);
				});
			});

		new Setting(contentEl)
			.setName("Template")
			.addDropdown((dropdown) => {
				(["blank", "ruled", "grid", "dot"] as NotebookTemplate[]).forEach((template) => {
					dropdown.addOption(template, getNotebookTemplateLabel(template));
				});
				dropdown.setValue(this.options.template);
				dropdown.onChange((value) => {
					this.options.template = value as NotebookTemplate;
				});
			});

		new Setting(contentEl)
			.setName("Paper size")
			.addDropdown((dropdown) => {
				(["a4", "letter", "compact", "long"] as NotebookPageSize[]).forEach((pageSize) => {
					dropdown.addOption(pageSize, getNotebookPageSizeLabel(pageSize));
				});
				dropdown.setValue(this.options.pageSize);
				dropdown.onChange((value) => {
					this.options.pageSize = value as NotebookPageSize;
				});
			});

		new Setting(contentEl)
			.setName("Paper color")
			.addDropdown((dropdown) => {
				PAPER_COLOR_PRESETS.forEach((preset) => {
					dropdown.addOption(preset.color, preset.label);
				});
				dropdown.setValue(this.options.paperColor);
				dropdown.onChange((value) => {
					this.options.paperColor = value;
				});
			});

		contentEl.createDiv("modal-button-container", (buttonContainer) => {
			buttonContainer.createEl("button", { cls: "mod-cta", text: "Create PDF" }, (button) => {
				button.addEventListener("click", () => {
					const options = { ...this.options };
					this.close();
					this.onSubmit(options);
				});
			});
			buttonContainer.createEl("button", { text: "Cancel" }, (button) => {
				button.addEventListener("click", () => this.close());
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class NativeInsertPageModal extends Modal {
	private options: NativeInsertPageOptions;

	constructor(
		app: App,
		private readonly position: "before" | "after",
		private readonly anchorLabel: string,
		defaults: NativeInsertPageOptions,
		private readonly onSubmit: (options: NativeInsertPageOptions) => void,
		private readonly mode: "temporary" | "native" = "native"
	) {
		super(app);
		this.options = { ...defaults };
		this.titleEl.setText(this.mode === "temporary" ? "Add notebook page" : "Insert native notebook page");
		this.modalEl.addClass("pdf-native-annotator-native-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(this.mode === "temporary" ? "Add notebook page" : "Insert native notebook page");
		contentEl.empty();
		contentEl.createEl("p", {
			text: this.mode === "temporary"
				? `Adds a temporary notebook page ${this.position} ${this.anchorLabel}. It stays editable and is included when you export the finished PDF.`
				: `Creates a new native working PDF with this notebook page inserted ${this.position} ${this.anchorLabel}. Existing annotations are remapped and remain editable.`,
			cls: "setting-item-description"
		});

		new Setting(contentEl)
			.setName("Page title")
			.addText((text) => {
				text.setValue(this.options.title);
				text.onChange((value) => {
					this.options.title = value.trim() || "Inserted notebook page";
				});
			});

		new Setting(contentEl)
			.setName("Template")
			.addDropdown((dropdown) => {
				(["blank", "ruled", "grid", "dot"] as NotebookTemplate[]).forEach((template) => {
					dropdown.addOption(template, getNotebookTemplateLabel(template));
				});
				dropdown.setValue(this.options.template);
				dropdown.onChange((value) => {
					this.options.template = value as NotebookTemplate;
				});
			});

		new Setting(contentEl)
			.setName("Paper size")
			.addDropdown((dropdown) => {
				(["a4", "letter", "compact", "long"] as NotebookPageSize[]).forEach((pageSize) => {
					dropdown.addOption(pageSize, getNotebookPageSizeLabel(pageSize));
				});
				dropdown.setValue(this.options.pageSize);
				dropdown.onChange((value) => {
					this.options.pageSize = value as NotebookPageSize;
				});
			});

		new Setting(contentEl)
			.setName("Paper color")
			.addDropdown((dropdown) => {
				PAPER_COLOR_PRESETS.forEach((preset) => {
					dropdown.addOption(preset.color, preset.label);
				});
				dropdown.setValue(this.options.paperColor);
				dropdown.onChange((value) => {
					this.options.paperColor = value;
				});
			});

		contentEl.createDiv("modal-button-container", (buttonContainer) => {
			buttonContainer.createEl("button", { cls: "mod-cta", text: "Insert page" }, (button) => {
				button.addEventListener("click", () => {
					const options = { ...this.options };
					this.close();
					this.onSubmit(options);
				});
			});
			buttonContainer.createEl("button", { text: "Cancel" }, (button) => {
				button.addEventListener("click", () => this.close());
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ImageInsertModal extends Modal {
	private selectedFile: File | null = null;
	private insertButtonEl: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(app: App, private readonly onSubmit: (file: File) => void) {
		super(app);
		this.titleEl.setText("Insert photo");
		this.modalEl.addClass("pdf-native-annotator-native-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			text: "Choose an image file to place on the current PDF or notebook page.",
			cls: "setting-item-description"
		});

		const fileSetting = new Setting(contentEl)
			.setName("Photo")
			.setDesc("PNG, JPEG, WebP, GIF, or any image format supported by Obsidian.");
		const input = fileSetting.controlEl.createEl("input", { type: "file" });
		input.accept = "image/*";
		input.addEventListener("change", () => {
			this.selectedFile = input.files?.[0] ?? null;
			this.statusEl?.setText(this.selectedFile ? this.selectedFile.name : "No image selected");
			if (this.insertButtonEl) {
				this.insertButtonEl.disabled = !this.selectedFile;
			}
		});

		this.statusEl = contentEl.createEl("p", {
			text: "No image selected",
			cls: "setting-item-description"
		});

		contentEl.createDiv("modal-button-container", (buttonContainer) => {
			this.insertButtonEl = buttonContainer.createEl("button", { cls: "mod-cta", text: "Insert" }, (button) => {
				button.disabled = true;
				button.addEventListener("click", () => {
					if (!this.selectedFile) {
						return;
					}
					const file = this.selectedFile;
					this.close();
					this.onSubmit(file);
				});
			});
			buttonContainer.createEl("button", { text: "Cancel" }, (button) => {
				button.addEventListener("click", () => this.close());
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class NativePdfAnnotatorSession {
	private file: TFile | null = null;
	private annotationDocument: AnnotationDocument | null = null;
	private annotationLoadInfo: AnnotationLoadInfo | null = null;
	private rootEl: HTMLDivElement | null = null;
	private toolbarEl: HTMLDivElement | null = null;
	private statusEl: HTMLDivElement | null = null;
	private strokePopoverEl: HTMLDivElement | null = null;
	private colorPopoverEl: HTMLDivElement | null = null;
	private fontPopoverEl: HTMLDivElement | null = null;
	private paperColorPopoverEl: HTMLDivElement | null = null;
	private confirmPopoverEl: HTMLDivElement | null = null;
	private renamePopoverEl: HTMLDivElement | null = null;
	private goToPagePopoverEl: HTMLDivElement | null = null;
	private pageListPopoverEl: HTMLDivElement | null = null;
	private pageListFilter: "all" | "annotated" | "added" | "pdf" = "all";
	private pageListQuery = "";
	private transientPopoverBackdropEl: HTMLDivElement | null = null;
	private inlineTextEditorEl: HTMLTextAreaElement | null = null;
	private inlineTextEditorFrameEl: HTMLDivElement | null = null;
	private inlineTextTargetId: string | null = null;
	private inlineTextPoint: AnnotationPoint | null = null;
	private inlineTextPageNumber: number | null = null;
	private toolPreviewEl: HTMLDivElement | null = null;
	private mutationObserver: MutationObserver | null = null;
	private viewResizeObserver: ResizeObserver | null = null;
	private syncHandle: number | null = null;
	private scrollHandle: number | null = null;
	private scrollIdleHandle: number | null = null;
	private redrawHandle: number | null = null;
	private interactionRedrawHandle: number | null = null;
	private popoverRepositionHandle: number | null = null;
	private layoutRefreshHandles: number[] = [];
	private zoomSettleHandle: number | null = null;
	private autosaveHandle: number | null = null;
	private statusResetHandle: number | null = null;
	private pointerPage: number | null = null;
	private activePdfPointerId: number | null = null;
	private activePdfPointerCanvas: HTMLCanvasElement | null = null;
	private currentStroke: StrokeAnnotation | null = null;
	private currentShape: ShapeAnnotation | null = null;
	private selectedTarget: SelectedTarget | null = null;
	private selectedTargets: SelectedTarget[] = [];
	private currentLasso: LassoSelection | null = null;
	private lastSelectionRegion: { page: number; rect: NormalizedRect } | null = null;
	private dragAnchor: AnnotationPoint | null = null;
	private dragMoved = false;
	private activeResizeHandle: ResizeHandle | null = null;
	private erasingSession = false;
	private lastEraserPoint: AnnotationPoint | null = null;
	private scrollParent: HTMLElement | null = null;
	private nativeEventBus: { on?: (name: string, callback: (data?: unknown) => void) => void; off?: (name: string, callback: (data?: unknown) => void) => void } | null = null;
	private nativeEventHandlers: { name: string; callback: (data?: unknown) => void }[] = [];
	private currentPage = 1;
	private visiblePageRange: { start: number; end: number } | null = null;
	private readonly toolState: ToolStateController;
	private readonly previewState = new PreviewStateController();
	private annotationMode = false;
	private isDirty = false;
	private undoStack: AnnotationDocument[] = [];
	private redoStack: AnnotationDocument[] = [];
	private pageSurfaces = new Map<number, PageSurface>();
	private pageResizeObservers = new Map<number, ResizeObserver>();
	private pendingRedrawPages = new Set<number>();
	private pendingInteractionRedrawPages = new Set<number>();
	private strokePathCache = new Map<string, { signature: string; path: Path2D }>();
	private imageElementCache = new Map<string, HTMLImageElement>();
	private zoomingPages = new Set<number>();
	private annotationPageCache: Map<number, PageAnnotationBucket> | null = null;
	private realPdfPageCount = 0;
	private syntheticPageContainer: HTMLElement | null = null;
	private isSyncingSyntheticPages = false;
	private isPdfScrolling = false;
	private needsToolbarRefreshAfterScroll = false;
	private startupErrorShown = false;
	private focusedRegion: RegionReference["rect"] | null = null;
	private focusedRegionPage: number | null = null;
	private focusedRegionHandle: number | null = null;
	private lastPdfPoint: { clientX: number; clientY: number } | null = null;
	private lastPdfPointTime: number = 0;
	private floatingToolbarOffset: { right: number; top: number } = { right: 12, top: 8 };
	private floatingToolbarDrag: { startX: number; startY: number; startRight: number; startTop: number } | null = null;
	private currentTextFontFamily = TEXT_FONT_FAMILIES[0];
	private currentTextFontSize = 18;
	private currentTextColor = TEXT_COLOR_PRESETS[0].color;
	private sessionKeyListenerBound = false;
	private keyboardNudgeHistoryOpen = false;

	constructor(
		private readonly plugin: PDFAnnotatorPlugin,
		private readonly leaf: WorkspaceLeaf,
		private readonly store: AnnotationStore
	) {
		this.toolState = new ToolStateController(this.plugin.getStoredPresets(), this.plugin.getToolDefaults());
	}

	get currentFile(): TFile | null {
		return this.file;
	}

	get activePage(): number {
		return this.currentPage;
	}

	isForLeaf(leaf: WorkspaceLeaf): boolean {
		return leaf === this.leaf;
	}

	isActive(): boolean {
		return !!this.file;
	}

	refreshUiState(): void {
		this.refreshToolbar();
	}

	refreshSettings(): void {
		this.mountUi();
		this.applyOverlayMode();
		this.refreshToolbar();
	}

	refreshLayout(): void {
		this.commitActiveInkBeforeLayoutRefresh();
		this.scheduleLayoutRefresh();
	}

	async refreshLayoutAndFlush(): Promise<void> {
		this.commitActiveInkBeforeLayoutRefresh();
		await this.flushSave();
		this.scheduleLayoutRefresh();
	}

	focusRegion(page: number, rect: RegionReference["rect"]): void {
		this.focusedRegionPage = page;
		this.focusedRegion = rect;
		const surface = this.pageSurfaces.get(page);
		if (surface) {
			surface.pageEl.scrollIntoView({ block: "center", behavior: "smooth" });
			this.currentPage = page;
			this.drawPageAnnotations(page);
		} else {
			this.scheduleSyncPages();
		}
		if (this.focusedRegionHandle !== null) {
			window.clearTimeout(this.focusedRegionHandle);
		}
		this.focusedRegionHandle = window.setTimeout(() => {
			this.focusedRegionHandle = null;
			this.focusedRegion = null;
			this.focusedRegionPage = null;
			this.drawAllAnnotations();
		}, 5000);
		this.refreshStatus(`Focused region on page ${page}`);
	}

	focusPage(page: number): void {
		this.goToMixedPage(page);
	}

	async attach(): Promise<void> {
		try {
			const nextFile = this.getPdfFile();
			if (!nextFile) {
				this.detach();
				return;
			}

			this.bindSessionKeyListener();
			const fileChanged = !this.file || this.file.path !== nextFile.path;
			this.file = nextFile;
			this.ensureUi();

			if (fileChanged) {
				const loadInfo = await this.store.loadWithInfo(nextFile);
				this.annotationDocument = loadInfo.document;
				this.annotationLoadInfo = loadInfo;
				this.isDirty = false;
				const zIndexesChanged = normalizeDocumentZIndexes(this.annotationDocument);
				const strokeScalesChanged = normalizeDocumentStrokeScales(this.annotationDocument);
				if (zIndexesChanged || strokeScalesChanged) {
					this.isDirty = true;
					this.scheduleSave();
				}
				this.invalidateAnnotationPageCache();
				this.undoStack = [];
				this.redoStack = [];
				this.currentPage = 1;
				this.realPdfPageCount = 0;
				this.startupErrorShown = false;
				const temporaryPageCount = this.getTemporarySidecarPageCount();
				this.refreshStatus(
					temporaryPageCount > 0
						? `${temporaryPageCount} temporary notebook page${temporaryPageCount === 1 ? "" : "s"} found. Export when you want a finished PDF.`
						: `Attached to native PDF viewer: ${nextFile.name}`,
					temporaryPageCount > 0 ? 8000 : 2500
				);
			}

			this.observePdfDom();
			this.bindNativePdfEvents();
			this.syncPages();
			this.refreshToolbar();
		} catch (error) {
			console.error("freedraw-pdf: failed to attach to PDF view", error);
			this.showStartupError("freedraw-pdf could not attach safely to this PDF view.");
		}
	}

	async flushSave(): Promise<void> {
		if (!this.file || !this.annotationDocument || !this.isDirty) {
			return;
		}

		if (this.autosaveHandle !== null) {
			window.clearTimeout(this.autosaveHandle);
			this.autosaveHandle = null;
		}

		try {
			await this.store.save(this.file, this.annotationDocument);
			this.isDirty = false;
			this.refreshStatus(`Saved ${this.store.getSidecarPath(this.file)}`);
		} catch (error) {
			console.error("freedraw-pdf: failed to save", error);
			new Notice("Could not save PDF annotations.");
			this.refreshStatus("Save failed");
		}
	}

	detach(): void {
		this.commitActiveInkBeforeLayoutRefresh();
		void this.flushSave();
		this.finishSessionInlineTextEditor(false);
		this.file = null;
		this.annotationDocument = null;
		this.annotationLoadInfo = null;
		this.invalidateAnnotationPageCache();
		this.currentStroke = null;
		this.currentShape = null;
		this.selectedTarget = null;
		this.selectedTargets = [];
		this.currentLasso = null;
		this.dragAnchor = null;
		this.dragMoved = false;
		this.activeResizeHandle = null;
		this.erasingSession = false;
		this.lastEraserPoint = null;
		this.previewState.hide();
		this.pointerPage = null;
		this.visiblePageRange = null;
		this.realPdfPageCount = 0;
		this.syntheticPageContainer?.remove();
		this.syntheticPageContainer = null;
		this.undoStack = [];
		this.redoStack = [];
		if (this.focusedRegionHandle !== null) {
			window.clearTimeout(this.focusedRegionHandle);
			this.focusedRegionHandle = null;
		}
		this.focusedRegion = null;
		this.focusedRegionPage = null;
		this.destroyObservers();
		this.unbindNativePdfEvents();
		this.destroyPageSurfaces();
		this.rootEl?.remove();
		this.rootEl = null;
		this.toolbarEl = null;
		this.statusEl = null;
		this.closeStrokePopover();
		this.closeColorPopover();
		this.closeFontPopover();
		this.closePaperColorPopover();
		this.closeConfirmPopover();
		this.closeRenamePopover();
		this.closeGoToPagePopover();
		this.closePageListPopover();
		this.forceRemoveTransientPopoverBackdrop();
		this.unbindSessionKeyListener();
	}

	private bindSessionKeyListener(): void {
		if (this.sessionKeyListenerBound) {
			return;
		}
		window.addEventListener("keydown", this.handleSessionKeyDown);
		window.addEventListener("keyup", this.handleSessionKeyUp);
		window.addEventListener("blur", this.handleSessionWindowBlur);
		this.sessionKeyListenerBound = true;
	}

	private unbindSessionKeyListener(): void {
		if (!this.sessionKeyListenerBound) {
			return;
		}
		window.removeEventListener("keydown", this.handleSessionKeyDown);
		window.removeEventListener("keyup", this.handleSessionKeyUp);
		window.removeEventListener("blur", this.handleSessionWindowBlur);
		this.keyboardNudgeHistoryOpen = false;
		this.sessionKeyListenerBound = false;
	}

	toggleAnnotationMode(): void {
		this.annotationMode = !this.annotationMode;
		if (!this.annotationMode) {
			this.finishSessionInlineTextEditor(true);
		}
		if (this.annotationMode && this.currentTool === "select") {
			this.setActiveTool("pen");
		}
		this.applyOverlayMode();
		this.refreshToolbar();
		this.syncPages();
		this.forceRedrawVisibleAnnotations();
		this.scheduleLayoutRefresh();
		this.refreshStatus(this.annotationMode ? "Annotation mode enabled" : "Annotation mode disabled");
	}

	async copyCurrentPageLink(): Promise<void> {
		await this.copyPageLink(this.currentPage);
	}

	private async copyPageLink(pageNumber: number): Promise<void> {
		if (!this.file) {
			new Notice("Open a PDF first.");
			return;
		}
		const link = this.buildPageLink(pageNumber);
		try {
			await writeClipboardText(link);
			new Notice(`Copied page ${pageNumber} link.`);
			this.refreshStatus(`Copied ${link}`);
		} catch (error) {
			console.error("freedraw-pdf: failed to copy link", error);
			new Notice(`Copy failed. Link: ${link}`);
		}
	}

	async copyCurrentPageEmbedBlock(): Promise<void> {
		if (!this.file) {
			new Notice("Open a PDF first.");
			return;
		}
		await this.plugin.copyAnnotatedPdfEmbedBlock(this.file, this.currentPage);
		this.refreshStatus(`Copied annotated embed for page ${this.currentPage}`);
	}

	async openAnnotationDataJson(): Promise<void> {
		if (!this.file) {
			new Notice("Open a PDF first.");
			return;
		}
		await this.flushSave();
		const sidecarPath = this.annotationLoadInfo?.sidecarPath ?? this.store.getSidecarPath(this.file);
		const sidecar = this.plugin.app.vault.getAbstractFileByPath(sidecarPath);
		if (sidecar instanceof TFile) {
			await this.plugin.app.workspace.getLeaf(true).openFile(sidecar);
			this.refreshStatus(`Opened ${sidecar.name}`);
			return;
		}
		if (await this.plugin.app.vault.adapter.exists(sidecarPath)) {
			await this.plugin.app.workspace.openLinkText(sidecarPath, "", true);
			this.refreshStatus(`Opened ${sidecarPath}`);
			return;
		}
		new Notice("Annotation data JSON does not exist yet.");
	}

	private shouldShowRelinkAnnotationDataAction(): boolean {
		return !!(
			this.annotationLoadInfo &&
			(this.annotationLoadInfo.recoveredFromDifferentPath || this.annotationLoadInfo.sourcePathMismatch)
		);
	}

	async relinkAnnotationDataToCurrentPdf(): Promise<void> {
		if (!this.file || !this.annotationDocument) {
			new Notice("Open a PDF first.");
			return;
		}
		const previousSidecarPath = this.annotationLoadInfo?.sidecarPath ?? null;
		try {
			const expectedSidecarPath = await this.store.relinkSidecarToFile(this.file, this.annotationDocument, previousSidecarPath);
			this.annotationLoadInfo = {
				document: this.annotationDocument,
				sidecarPath: expectedSidecarPath,
				expectedSidecarPath,
				recoveredFromDifferentPath: false,
				sourcePathMismatch: false,
				sourcePdfPath: this.file.path
			};
			this.isDirty = false;
			this.refreshStatus(`Relinked annotations to ${this.file.name}`);
			new Notice("Annotation data relinked to the current PDF.");
			this.plugin.refreshAnnotatedEmbedsForPath(this.file.path);
			if (previousSidecarPath) {
				this.plugin.refreshAnnotatedEmbedsForPath(previousSidecarPath);
			}
		} catch (error) {
			console.error("freedraw-pdf: failed to relink annotation data", error);
			new Notice("Could not relink annotation data JSON.");
		}
	}

	async exportCurrentPageSnapshot(): Promise<TFile | null> {
		return this.exportPageSnapshot(this.currentPage);
	}

	private insertPhotoOnCurrentPage(): void {
		if (!this.annotationDocument) {
			new Notice("Open an annotated PDF first.");
			return;
		}
		new ImageInsertModal(this.plugin.app, (file) => {
			void this.insertPhotoFileOnCurrentPage(file);
		}).open();
	}

	private async insertPhotoFileOnCurrentPage(file: File, placementPoint?: AnnotationPoint | null): Promise<void> {
		if (!this.annotationDocument) {
			new Notice("Open an annotated PDF first.");
			return;
		}
		try {
			const dataUrl = await this.readFileAsDataUrl(file);
			await this.insertImageDataUrlOnCurrentPage(dataUrl, file.name, placementPoint);
		} catch (error) {
			console.error("freedraw-pdf: failed to insert photo", error);
			new Notice("Could not insert the selected image.");
		}
	}

	private async insertImageDataUrlOnCurrentPage(dataUrl: string, name: string, placementPoint?: AnnotationPoint | null): Promise<void> {
		if (!this.annotationDocument) {
			new Notice("Open an annotated PDF first.");
			return;
		}
		try {
			const dimensions = await this.getImageDataUrlDimensions(dataUrl);
			const surface = this.pageSurfaces.get(this.currentPage);
			const pageAspect = surface && surface.lastWidth > 0 && surface.lastHeight > 0
				? surface.lastWidth / surface.lastHeight
				: 0.72;
			const imageAspect = dimensions.width / Math.max(1, dimensions.height);
			const widthScale = 0.38;
			const heightScale = Math.min(0.42, Math.max(0.08, (widthScale / imageAspect) * pageAspect));
			const point = placementPoint ?? this.getRecentPdfPastePoint(this.currentPage) ?? { x: 0.5, y: 0.5, pressure: 0.5 };
			const imageItem: ImageAnnotation = {
				id: generateId("image"),
				page: this.currentPage,
				name,
				dataUrl,
				x: clamp(point.x - (widthScale / 2), 0.02, 0.98 - widthScale),
				y: clamp(point.y - (heightScale / 2), 0.02, 0.98 - heightScale),
				widthScale,
				heightScale,
				zIndex: this.getNextPageZIndex(this.currentPage),
				createdAt: new Date().toISOString()
			};
			this.pushHistory();
			if (!Array.isArray(this.annotationDocument.imageItems)) {
				this.annotationDocument.imageItems = [];
			}
			this.annotationDocument.imageItems.push(imageItem);
			this.toolState.setActiveTool("select");
			this.selectedTarget = { kind: "image", id: imageItem.id, page: imageItem.page };
			this.selectedTargets = [this.selectedTarget];
			this.markDirtyAndRedraw(`Inserted ${name}`);
		} catch (error) {
			console.error("freedraw-pdf: failed to insert photo", error);
			new Notice("Could not insert the selected image.");
		}
	}

	private readFileAsDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image file."));
			reader.onerror = () => reject(reader.error ?? new Error("Could not read image file."));
			reader.readAsDataURL(file);
		});
	}

	private getImageDataUrlDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
			image.onerror = () => reject(new Error("Could not load selected image."));
			image.src = dataUrl;
		});
	}

	async exportAnnotatedMixedDocumentPdf(): Promise<TFile | null> {
		if (!this.file || !this.annotationDocument) {
			new Notice("Open a PDF first.");
			return null;
		}
		if (this.realPdfPageCount <= 0) {
			this.syncPages();
		}
		const entries = this.getMixedPageEntries();
		if (entries.length === 0) {
			new Notice("No pages available to export.");
			return null;
		}
		await this.flushSave();
		this.refreshStatus("Exporting annotated mixed PDF...", 6000);
		const outputFile = await exportAnnotatedMixedDocumentPdf(
			this.plugin.app,
			this.plugin,
			this.file,
			this.annotationDocument,
			entries,
			this.realPdfPageCount
		);
		if (outputFile) {
			this.refreshStatus(`Exported ${outputFile.name}`);
			await this.plugin.openPdfFileAtPage(outputFile, 1);
		}
		return outputFile;
	}

	async materializeNativeMixedWorkingPdf(): Promise<TFile | null> {
		if (!this.file || !this.annotationDocument) {
			new Notice("Open a PDF first.");
			return null;
		}
		if (this.realPdfPageCount <= 0) {
			this.syncPages();
		}
		const entries = this.getMixedPageEntries();
		if (entries.length === 0) {
			new Notice("No pages available to materialize.");
			return null;
		}
		await this.flushSave();
		this.refreshStatus("Creating native mixed working PDF...", 8000);
		return this.createNativeWorkingPdfFromDocument(this.annotationDocument, entries, this.currentPage);
	}

	openNativeTemplatePageInsertModal(position: "before" | "after"): void {
		if (!this.file || !this.annotationDocument) {
			new Notice("Open a PDF first.");
			return;
		}
		if (this.realPdfPageCount <= 0) {
			this.syncPages();
		}
		const location = this.getNativeInsertPageLocation(position);
		this.openNativeTemplatePageInsertModalAtLocation(position, location);
	}

	openTemplatePageInsertModal(position: "before" | "after"): void {
		if (!this.file || !this.annotationDocument) {
			new Notice("Open a PDF first.");
			return;
		}
		if (this.realPdfPageCount <= 0) {
			this.syncPages();
		}
		const location = this.getNativeInsertPageLocation(position);
		this.openTemplatePageInsertModalAtLocation(position, location);
	}

	private openNativeTemplatePageInsertModalAtLocation(position: "before" | "after", location: NativeInsertPageLocation, defaultsOverride?: NativeInsertPageOptions): void {
		if (!this.file || !this.annotationDocument) {
			new Notice("Open a PDF first.");
			return;
		}
		const defaults = defaultsOverride ?? this.getNativeInsertPageDefaults(position, location);
		new NativeInsertPageModal(
			this.plugin.app,
			position,
			location.anchorLabel,
			defaults,
			(options) => {
				void this.insertNativeTemplatePageAtLocation(location, options);
			}
		).open();
	}

	private openTemplatePageInsertModalAtLocation(position: "before" | "after", location: NativeInsertPageLocation, defaultsOverride?: NativeInsertPageOptions): void {
		if (!this.file || !this.annotationDocument) {
			new Notice("Open a PDF first.");
			return;
		}
		const defaults = defaultsOverride ?? this.getNativeInsertPageDefaults(position, location);
		new NativeInsertPageModal(
			this.plugin.app,
			position,
			location.anchorLabel,
			defaults,
			(options) => {
				this.insertTemplatePageAtLocation(location, options);
			},
			"temporary"
		).open();
	}

	async insertNativeTemplatePageAfterCurrent(options?: NativeInsertPageOptions): Promise<TFile | null> {
		return this.insertNativeTemplatePageNearCurrent("after", options);
	}

	async insertNativeTemplatePageBeforeCurrent(options?: NativeInsertPageOptions): Promise<TFile | null> {
		return this.insertNativeTemplatePageNearCurrent("before", options);
	}

	private getNativeInsertPageDefaults(position: "before" | "after", location = this.getNativeInsertPageLocation(position)): NativeInsertPageOptions {
		const currentSyntheticPage = this.getCurrentSyntheticPage();
		return {
			title: `Notebook page ${position} ${location.anchorLabel}`,
			template: currentSyntheticPage?.template ?? "ruled",
			pageSize: currentSyntheticPage?.pageSize ?? "a4",
			paperColor: currentSyntheticPage?.paperColor ?? "#fffdf7"
		};
	}

	private getNativeInsertPageLocation(position: "before" | "after"): NativeInsertPageLocation {
		const currentSyntheticIndex = this.getSyntheticPageIndex();
		if (currentSyntheticIndex >= 0) {
			const currentSyntheticPage = this.getAppendedPages()[currentSyntheticIndex];
			const anchor = this.getSyntheticPageInsertAfterPdfPage(currentSyntheticPage);
			return {
				insertIndex: position === "before" ? currentSyntheticIndex : currentSyntheticIndex + 1,
				anchor,
				anchorLabel: currentSyntheticPage.title.trim() || `added page ${this.currentPage}`
			};
		}
		if (position === "before") {
			const anchor = clamp(this.currentPage - 1, 0, Math.max(0, this.realPdfPageCount));
			return {
				insertIndex: this.findSyntheticInsertIndexAfterPdfPage(anchor),
				anchor,
				anchorLabel: `PDF page ${this.currentPage}`
			};
		}
		const anchor = clamp(this.currentPage, 0, Math.max(0, this.realPdfPageCount));
		return {
			insertIndex: this.findFirstSyntheticInsertIndexAfterPdfPage(anchor),
			anchor,
			anchorLabel: `PDF page ${this.currentPage}`
		};
	}

	private async insertNativeTemplatePageNearCurrent(position: "before" | "after", options?: NativeInsertPageOptions): Promise<TFile | null> {
		return this.insertNativeTemplatePageAtLocation(this.getNativeInsertPageLocation(position), options ?? this.getNativeInsertPageDefaults(position));
	}

	private async insertNativeTemplatePageAtLocation(location: NativeInsertPageLocation, options?: NativeInsertPageOptions): Promise<TFile | null> {
		if (!this.file || !this.annotationDocument) {
			new Notice("Open a PDF first.");
			return null;
		}
		if (this.realPdfPageCount <= 0) {
			this.syncPages();
		}
		const sourceDocument = cloneDocument(this.annotationDocument);
		if (!Array.isArray(sourceDocument.appendedPages)) {
			sourceDocument.appendedPages = [];
		}
		const fallbackOptions: NativeInsertPageOptions = {
			title: `Notebook page after ${location.anchorLabel}`,
			template: this.getCurrentSyntheticPage()?.template ?? "ruled",
			pageSize: this.getCurrentSyntheticPage()?.pageSize ?? "a4",
			paperColor: this.getCurrentSyntheticPage()?.paperColor ?? "#fffdf7"
		};
		const pageOptions = options ?? fallbackOptions;
		const insertIndex = clamp(location.insertIndex, 0, sourceDocument.appendedPages.length);
		const insertedPageNumber = this.realPdfPageCount + insertIndex + 1;
		const templatePage = createTemplateNotebookPage(
			pageOptions.title.trim() || fallbackOptions.title,
			pageOptions.template,
			pageOptions.pageSize,
			pageOptions.paperColor
		);
		templatePage.insertAfterPdfPage = location.anchor;
		sourceDocument.strokes = sourceDocument.strokes.map((stroke) => stroke.page >= insertedPageNumber ? { ...stroke, page: stroke.page + 1 } : stroke);
		sourceDocument.textItems = sourceDocument.textItems.map((item) => item.page >= insertedPageNumber ? { ...item, page: item.page + 1 } : item);
		sourceDocument.shapes = sourceDocument.shapes.map((shape) => shape.page >= insertedPageNumber ? { ...shape, page: shape.page + 1 } : shape);
		sourceDocument.imageItems = (sourceDocument.imageItems ?? []).map((image) => image.page >= insertedPageNumber ? { ...image, page: image.page + 1 } : image);
		sourceDocument.appendedPages.splice(insertIndex, 0, templatePage);
		const entries = this.getMixedPageEntries(sourceDocument);
		await this.flushSave();
		this.refreshStatus("Creating native PDF with inserted page...", 8000);
		return this.createNativeWorkingPdfFromDocument(sourceDocument, entries, insertedPageNumber);
	}

	private async createNativeWorkingPdfFromDocument(
		document: AnnotationDocument,
		entries: MixedPageEntry[],
		targetPage: number
	): Promise<TFile | null> {
		if (!this.file) {
			new Notice("Open a PDF first.");
			return null;
		}
		const result = await createNativeMixedWorkingPdf(
			this.plugin.app,
			this.plugin,
			this.file,
			document,
			entries,
			this.realPdfPageCount
		);
		if (!result) {
			return null;
		}
		const nextDocument = cloneDocument(document);
		const mapPage = (pageNumber: number): number => result.pageMap.get(pageNumber) ?? pageNumber;
		nextDocument.strokes = nextDocument.strokes.map((stroke) => ({ ...stroke, page: mapPage(stroke.page) }));
		nextDocument.textItems = nextDocument.textItems.map((item) => ({ ...item, page: mapPage(item.page) }));
		nextDocument.shapes = nextDocument.shapes.map((shape) => ({ ...shape, page: mapPage(shape.page) }));
		nextDocument.imageItems = (nextDocument.imageItems ?? []).map((image) => ({ ...image, page: mapPage(image.page) }));
		nextDocument.appendedPages = [];
		nextDocument.sourceFile = result.file.path;
		nextDocument.updatedAt = new Date().toISOString();
		await this.store.save(result.file, nextDocument);
		const mappedTargetPage = mapPage(targetPage);
		this.refreshStatus(`Created ${result.file.name}`);
		await this.plugin.openPdfFileAtPage(result.file, mappedTargetPage);
		return result.file;
	}

	private async exportPageSnapshot(pageNumber: number): Promise<TFile | null> {
		if (!this.file) {
			new Notice("Open a PDF first.");
			return null;
		}

		const surface = this.pageSurfaces.get(pageNumber);
		if (!surface) {
			new Notice("That page is not ready to export yet.");
			return null;
		}

		const pdfCanvas = surface.hostEl.querySelector("canvas");
		const syntheticPage = this.getSyntheticPageIndex(pageNumber) >= 0
			? this.getAppendedPages()[this.getSyntheticPageIndex(pageNumber)] ?? null
			: null;
		if (!isHtmlCanvasElement(pdfCanvas) && !syntheticPage) {
			new Notice("Could not find the native PDF page canvas for export.");
			return null;
		}

		const exportCanvas = document.createElement("canvas");
		const ratio = window.devicePixelRatio || 1;
		const exportWidth = isHtmlCanvasElement(pdfCanvas) ? pdfCanvas.width : Math.max(1, Math.floor(surface.lastWidth * ratio));
		const exportHeight = isHtmlCanvasElement(pdfCanvas) ? pdfCanvas.height : Math.max(1, Math.floor(surface.lastHeight * ratio));
		exportCanvas.width = exportWidth;
		exportCanvas.height = exportHeight;
		const context = exportCanvas.getContext("2d");
		if (!context) {
			new Notice("Could not create export canvas.");
			return null;
		}

		if (isHtmlCanvasElement(pdfCanvas)) {
			context.drawImage(pdfCanvas, 0, 0);
		} else if (syntheticPage) {
			this.drawSyntheticSnapshotBackground(context, exportWidth, exportHeight, syntheticPage);
		}
		context.drawImage(surface.overlayEl, 0, 0, exportCanvas.width, exportCanvas.height);

		const folderPrefix = this.file.parent?.path ? `${this.file.parent.path}/` : "";
		const baseName = `${getBaseName(this.file)} page ${pageNumber} annotated`;
		let imagePath = `${folderPrefix}${baseName}.png`;
		let counter = 2;
		while (this.plugin.app.vault.getAbstractFileByPath(imagePath)) {
			imagePath = `${folderPrefix}${baseName} ${counter}.png`;
			counter += 1;
		}

		const buffer = dataUrlToArrayBuffer(exportCanvas.toDataURL("image/png"));
		const imageFile = await this.plugin.app.vault.createBinary(imagePath, buffer);
		this.refreshStatus(`Exported ${imageFile.name}`);
		new Notice(`Exported ${imageFile.name}`);
		return imageFile;
	}

	private drawSyntheticSnapshotBackground(context: CanvasRenderingContext2D, width: number, height: number, page: NotebookPage): void {
		drawTemplatePageBackground(context, width, height, page);
	}

	async exportSelectionSnapshot(): Promise<TFile | null> {
		const region = this.getSelectionRegion();
		if (!region) {
			new Notice("Drag a box region first.");
			return null;
		}

		const selectionPage = region.page;
		const bounds = region.rect;
		const surface = this.pageSurfaces.get(selectionPage);
		if (!surface) {
			new Notice("Selection snapshot is not ready yet.");
			return null;
		}

		const pdfCanvas = surface.hostEl.querySelector("canvas");
		if (!isHtmlCanvasElement(pdfCanvas)) {
			new Notice("Could not find the native PDF page canvas for selection export.");
			return null;
		}

		const cropLeft = Math.max(0, Math.floor(bounds.left * pdfCanvas.width) - 20);
		const cropTop = Math.max(0, Math.floor(bounds.top * pdfCanvas.height) - 20);
		const cropRight = Math.min(pdfCanvas.width, Math.ceil(bounds.right * pdfCanvas.width) + 20);
		const cropBottom = Math.min(pdfCanvas.height, Math.ceil(bounds.bottom * pdfCanvas.height) + 20);
		const cropWidth = Math.max(1, cropRight - cropLeft);
		const cropHeight = Math.max(1, cropBottom - cropTop);

		const exportCanvas = document.createElement("canvas");
		exportCanvas.width = cropWidth;
		exportCanvas.height = cropHeight;
		const context = exportCanvas.getContext("2d");
		if (!context) {
			new Notice("Could not create selection export canvas.");
			return null;
		}

		context.drawImage(pdfCanvas, cropLeft, cropTop, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
		context.drawImage(surface.overlayEl, cropLeft, cropTop, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

		const file = this.file;
		if (!file) {
			new Notice("Open a PDF before exporting a selection snapshot.");
			return null;
		}
		const folderPrefix = file.parent?.path ? `${file.parent.path}/` : "";
		const baseName = `${getBaseName(file)} page ${selectionPage} selection`;
		let imagePath = `${folderPrefix}${baseName}.png`;
		let counter = 2;
		while (this.plugin.app.vault.getAbstractFileByPath(imagePath)) {
			imagePath = `${folderPrefix}${baseName} ${counter}.png`;
			counter += 1;
		}

		const buffer = dataUrlToArrayBuffer(exportCanvas.toDataURL("image/png"));
		const imageFile = await this.plugin.app.vault.createBinary(imagePath, buffer);
		this.refreshStatus(`Exported ${imageFile.name}`);
		new Notice(`Exported ${imageFile.name}`);
		return imageFile;
	}

	async copySelectionRegionReference(): Promise<void> {
		const reference = this.buildSelectionRegionReference();
		if (!reference) {
			new Notice("Drag a box region on one page first.");
			return;
		}
		try {
			await this.plugin.writeClipboardText(reference);
			new Notice("Copied selection region reference.");
			this.refreshStatus(`Copied ${reference}`);
		} catch (error) {
			console.error("freedraw-pdf: failed to copy selection region reference", error);
			new Notice(`Copy failed. Region: ${reference}`);
		}
	}

	async copySelectionAnnotatedEmbedBlock(): Promise<void> {
		const region = this.getSelectionRegion();
		if (!region) {
			new Notice("Drag a box region on one page first.");
			return;
		}
		await this.plugin.copyAnnotatedPdfEmbedBlock(region.file, region.page, region.rect);
		this.refreshStatus(`Copied region embed for page ${region.page}`);
	}

	getActiveRegionEmbedSource(): { file: TFile; page: number; rect: NormalizedRect } | null {
		return this.getSelectionRegion();
	}

	copySelectedTargets(): void {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			this.refreshStatus("Nothing selected");
			return;
		}

		const strokeIds = new Set(this.selectedTargets.filter((target) => target.kind === "stroke").map((target) => target.id));
		const textIds = new Set(this.selectedTargets.filter((target) => target.kind === "text").map((target) => target.id));
		const shapeIds = new Set(this.selectedTargets.filter((target) => target.kind === "shape").map((target) => target.id));
		const imageIds = new Set(this.selectedTargets.filter((target) => target.kind === "image").map((target) => target.id));

		const payload: AnnotationClipboardPayload = {
			strokes: this.annotationDocument.strokes
				.filter((stroke) => strokeIds.has(stroke.id))
				.map((stroke) => cloneDocument({
					version: 4,
					sourceFile: "",
					updatedAt: "",
					strokes: [stroke],
					textItems: [],
					shapes: []
				}).strokes[0]),
			textItems: this.annotationDocument.textItems
				.filter((item) => textIds.has(item.id))
				.map((item) => cloneDocument({
					version: 4,
					sourceFile: "",
					updatedAt: "",
					strokes: [],
					textItems: [item],
					shapes: []
				}).textItems[0]),
			shapes: this.annotationDocument.shapes
				.filter((shape) => shapeIds.has(shape.id))
				.map((shape) => cloneDocument({
					version: 4,
					sourceFile: "",
					updatedAt: "",
					strokes: [],
					textItems: [],
					shapes: [shape]
				}).shapes[0]),
			imageItems: (this.annotationDocument.imageItems ?? [])
				.filter((image) => imageIds.has(image.id))
				.map((image) => JSON.parse(JSON.stringify(image)) as ImageAnnotation)
		};

		this.plugin.setClipboard(payload);
		const total = payload.strokes.length + payload.textItems.length + payload.shapes.length + (payload.imageItems?.length ?? 0);
		this.refreshStatus(total === 1 ? "Copied selection" : `Copied ${total} selections`);
	}

	cutSelectedTargets(): void {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			this.refreshStatus("Nothing selected");
			return;
		}
		const strokeIds = new Set(this.selectedTargets.filter((target) => target.kind === "stroke").map((target) => target.id));
		const textIds = new Set(this.selectedTargets.filter((target) => target.kind === "text").map((target) => target.id));
		const shapeIds = new Set(this.selectedTargets.filter((target) => target.kind === "shape").map((target) => target.id));
		const imageIds = new Set(this.selectedTargets.filter((target) => target.kind === "image").map((target) => target.id));
		const payload: AnnotationClipboardPayload = {
			strokes: this.annotationDocument.strokes
				.filter((stroke) => strokeIds.has(stroke.id))
				.map((stroke) => cloneDocument({
					version: 4,
					sourceFile: "",
					updatedAt: "",
					strokes: [stroke],
					textItems: [],
					shapes: []
				}).strokes[0]),
			textItems: this.annotationDocument.textItems
				.filter((item) => textIds.has(item.id))
				.map((item) => cloneDocument({
					version: 4,
					sourceFile: "",
					updatedAt: "",
					strokes: [],
					textItems: [item],
					shapes: []
				}).textItems[0]),
			shapes: this.annotationDocument.shapes
				.filter((shape) => shapeIds.has(shape.id))
				.map((shape) => cloneDocument({
					version: 4,
					sourceFile: "",
					updatedAt: "",
					strokes: [],
					textItems: [],
					shapes: [shape]
				}).shapes[0]),
			imageItems: (this.annotationDocument.imageItems ?? [])
				.filter((image) => imageIds.has(image.id))
				.map((image) => JSON.parse(JSON.stringify(image)) as ImageAnnotation)
		};
		const total = payload.strokes.length + payload.textItems.length + payload.shapes.length + (payload.imageItems?.length ?? 0);
		if (total === 0) {
			this.refreshStatus("Nothing selected");
			return;
		}
		this.plugin.setClipboard(payload);
		this.pushHistory();
		this.annotationDocument.strokes = this.annotationDocument.strokes.filter((stroke) => !strokeIds.has(stroke.id));
		this.annotationDocument.textItems = this.annotationDocument.textItems.filter((item) => !textIds.has(item.id));
		this.annotationDocument.shapes = this.annotationDocument.shapes.filter((shape) => !shapeIds.has(shape.id));
		this.annotationDocument.imageItems = (this.annotationDocument.imageItems ?? []).filter((image) => !imageIds.has(image.id));
		this.selectedTarget = null;
		this.selectedTargets = [];
		this.lastSelectionRegion = null;
		this.markDirtyAndRedraw(total === 1 ? "Cut selection" : `Cut ${total} selections`);
		this.refreshToolbar();
	}

	pasteClipboard(pasteInPlace = false): void {
		if (!this.annotationDocument) {
			this.refreshStatus("Open a PDF first.");
			return;
		}
		const clipboard = this.plugin.getClipboard();
		if (!clipboard) {
			this.refreshStatus("Clipboard is empty");
			return;
		}

		const pastePoint = pasteInPlace ? null : this.getRecentPdfPastePoint(this.currentPage);
		const pasteOffset = pasteInPlace ? { x: 0, y: 0 } : getClipboardPasteOffset(clipboard, pastePoint);
		const nextSelections: SelectedTarget[] = [];
		let nextZIndex = this.getNextPageZIndex(this.currentPage);
		this.pushHistory();

		for (const stroke of clipboard.strokes) {
			const nextStroke: StrokeAnnotation = {
				...stroke,
				id: generateId("stroke"),
				page: this.currentPage,
				points: stroke.points.map((point) => ({
					...point,
					x: clamp(point.x + pasteOffset.x, 0, 1),
					y: clamp(point.y + pasteOffset.y, 0, 1)
				})),
				zIndex: nextZIndex++,
				createdAt: new Date().toISOString()
			};
			this.annotationDocument.strokes.push(nextStroke);
			nextSelections.push({ kind: "stroke", id: nextStroke.id, page: nextStroke.page });
		}

		for (const item of clipboard.textItems) {
			const nextItem: TextAnnotation = {
				...item,
				id: generateId("text"),
				page: this.currentPage,
				x: clamp(item.x + pasteOffset.x, 0, 1),
				y: clamp(item.y + pasteOffset.y, 0, 1),
				zIndex: nextZIndex++,
				createdAt: new Date().toISOString()
			};
			this.annotationDocument.textItems.push(nextItem);
			nextSelections.push({ kind: "text", id: nextItem.id, page: nextItem.page });
		}

		for (const shape of clipboard.shapes) {
			const nextShape: ShapeAnnotation = {
				...shape,
				id: generateId("shape"),
				page: this.currentPage,
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
			this.annotationDocument.shapes.push(nextShape);
			nextSelections.push({ kind: "shape", id: nextShape.id, page: nextShape.page });
		}

		for (const image of clipboard.imageItems ?? []) {
			const nextImage: ImageAnnotation = {
				...image,
				id: generateId("image"),
				page: this.currentPage,
				x: clamp(image.x + pasteOffset.x, 0, Math.max(0, 1 - image.widthScale)),
				y: clamp(image.y + pasteOffset.y, 0, Math.max(0, 1 - image.heightScale)),
				zIndex: nextZIndex++,
				createdAt: new Date().toISOString()
			};
			if (!Array.isArray(this.annotationDocument.imageItems)) {
				this.annotationDocument.imageItems = [];
			}
			this.annotationDocument.imageItems.push(nextImage);
			nextSelections.push({ kind: "image", id: nextImage.id, page: nextImage.page });
		}

		if (nextSelections.length === 0) {
			if (this.undoStack.length > 0) {
				this.undoStack.pop();
			}
			this.refreshStatus("Clipboard is empty");
			return;
		}

		this.selectedTargets = nextSelections;
		this.selectedTarget = nextSelections[0] ?? null;
		this.lastSelectionRegion = null;
		this.markDirtyAndRedraw(nextSelections.length === 1 ? "Pasted selection" : `Pasted ${nextSelections.length} selections`);
		this.refreshToolbar();
	}

	private getRecentPdfPastePoint(pageNumber: number): AnnotationPoint | null {
		const surface = this.pageSurfaces.get(pageNumber);
		if (!surface || !this.lastPdfPoint) {
			return null;
		}
		if (performance.now() - this.lastPdfPointTime > 8000) {
			return null;
		}
		const rect = surface.overlayEl.getBoundingClientRect();
		if (
			this.lastPdfPoint.clientX < rect.left ||
			this.lastPdfPoint.clientX > rect.right ||
			this.lastPdfPoint.clientY < rect.top ||
			this.lastPdfPoint.clientY > rect.bottom
		) {
			return null;
		}
		return {
			x: clamp((this.lastPdfPoint.clientX - rect.left) / Math.max(rect.width, 1), 0, 1),
			y: clamp((this.lastPdfPoint.clientY - rect.top) / Math.max(rect.height, 1), 0, 1),
			pressure: 0.5
		};
	}

	deleteSelectedTargets(): void {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			this.refreshStatus("Nothing selected");
			return;
		}

		this.pushHistory();
		const selectedStrokeIds = new Set(this.selectedTargets.filter((target) => target.kind === "stroke").map((target) => target.id));
		const selectedTextIds = new Set(this.selectedTargets.filter((target) => target.kind === "text").map((target) => target.id));
		const selectedShapeIds = new Set(this.selectedTargets.filter((target) => target.kind === "shape").map((target) => target.id));
		const selectedImageIds = new Set(this.selectedTargets.filter((target) => target.kind === "image").map((target) => target.id));
		const removedCount = selectedStrokeIds.size + selectedTextIds.size + selectedShapeIds.size + selectedImageIds.size;

		this.annotationDocument.strokes = this.annotationDocument.strokes.filter((stroke) => !selectedStrokeIds.has(stroke.id));
		this.annotationDocument.textItems = this.annotationDocument.textItems.filter((item) => !selectedTextIds.has(item.id));
		this.annotationDocument.shapes = this.annotationDocument.shapes.filter((shape) => !selectedShapeIds.has(shape.id));
		this.annotationDocument.imageItems = (this.annotationDocument.imageItems ?? []).filter((image) => !selectedImageIds.has(image.id));
		this.selectedTarget = null;
		this.selectedTargets = [];
		this.lastSelectionRegion = null;
		this.markDirtyAndRedraw(removedCount === 1 ? "Deleted selection" : `Deleted ${removedCount} selections`);
		this.refreshToolbar();
	}

	selectAllCurrentPageAnnotations(): void {
		if (!this.annotationDocument) {
			return;
		}
		const bucket = this.getPageAnnotationBucket(this.currentPage);
		const nextSelections: SelectedTarget[] = [
			...bucket.strokes.map((stroke): SelectedTarget => ({ kind: "stroke", id: stroke.id, page: stroke.page })),
			...bucket.textItems.map((item): SelectedTarget => ({ kind: "text", id: item.id, page: item.page })),
			...bucket.shapes.map((shape): SelectedTarget => ({ kind: "shape", id: shape.id, page: shape.page })),
			...bucket.imageItems.map((image): SelectedTarget => ({ kind: "image", id: image.id, page: image.page }))
		];
		this.selectedTargets = nextSelections;
		this.selectedTarget = nextSelections[0] ?? null;
		this.activeResizeHandle = null;
		this.dragAnchor = null;
		this.drawPageAnnotations(this.currentPage);
		this.refreshToolbar();
		this.refreshStatus(nextSelections.length === 0 ? "No annotations on current page" : `Selected ${nextSelections.length} annotations on page ${this.currentPage}`);
	}

	private clearSelection(message = "Selection cleared"): void {
		if (this.selectedTargets.length === 0 && !this.selectedTarget && !this.lastSelectionRegion) {
			return;
		}
		const pages = new Set(this.selectedTargets.map((target) => target.page));
		if (this.lastSelectionRegion) {
			pages.add(this.lastSelectionRegion.page);
		}
		this.selectedTarget = null;
		this.selectedTargets = [];
		this.lastSelectionRegion = null;
		this.activeResizeHandle = null;
		this.dragAnchor = null;
		if (pages.size > 0) {
			for (const page of pages) {
				this.drawPageAnnotations(page);
			}
		} else {
			this.drawAllAnnotations();
		}
		this.refreshToolbar();
		this.refreshStatus(message);
	}

	private clearRegion(): void {
		if (!this.lastSelectionRegion) {
			return;
		}
		const page = this.lastSelectionRegion.page;
		this.lastSelectionRegion = null;
		this.drawPageAnnotations(page);
		this.refreshToolbar();
		this.refreshStatus("Region cleared");
	}

	private cancelActiveSessionInteraction(): boolean {
		this.unbindPdfPointerDocumentTracking();
		const hasActiveInteraction =
			this.currentStroke !== null ||
			this.currentShape !== null ||
			this.currentLasso !== null ||
			this.dragAnchor !== null ||
			this.activeResizeHandle !== null ||
			this.erasingSession;
		if (!hasActiveInteraction) {
			return false;
		}
		const shouldRestoreHistory =
			this.erasingSession ||
			(this.currentTool === "select" && this.dragAnchor !== null && this.currentLasso === null);
		const previous = shouldRestoreHistory ? this.undoStack.pop() : null;
		const affectedPage = this.pointerPage ?? this.currentStroke?.page ?? this.currentShape?.page ?? this.currentLasso?.page ?? this.currentPage;
		this.currentStroke = null;
		this.currentShape = null;
		this.currentLasso = null;
		this.dragAnchor = null;
		this.activeResizeHandle = null;
		this.dragMoved = false;
		this.erasingSession = false;
		this.lastEraserPoint = null;
		this.pointerPage = null;
		if (previous) {
			this.annotationDocument = previous;
			this.invalidateAnnotationPageCache();
			this.isDirty = true;
			this.scheduleSave();
			this.drawAllAnnotations();
		} else {
			if ((this.currentTool === "pen" || this.currentTool === "highlighter" || isShapeTool(this.currentTool)) && this.undoStack.length > 0) {
				this.undoStack.pop();
			}
			this.drawPageAnnotations(affectedPage);
		}
		this.refreshStatus("Cancelled interaction");
		this.refreshToolPreviewFromLastPointer(false);
		return true;
	}

	private nudgeSelectedTargets(deltaX: number, deltaY: number, pushHistory = true): void {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			return;
		}
		if (pushHistory) {
			this.pushHistory();
		}
		const pages = new Set(this.selectedTargets.map((target) => target.page));
		for (const target of this.selectedTargets) {
			this.moveSelectedTarget(target, deltaX, deltaY);
		}
		this.invalidateAnnotationPageCache();
		this.isDirty = true;
		this.scheduleSave();
		for (const page of pages) {
			this.drawPageAnnotations(page);
		}
		this.refreshStatus(this.selectedTargets.length === 1 ? "Selection nudged" : `Nudged ${this.selectedTargets.length} selections`);
	}

	reorderSelectedTargets(direction: AnnotationReorderDirection): void {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			this.refreshStatus("Nothing selected");
			return;
		}
		const selectedByPage = new Map<number, Set<string>>();
		for (const target of this.selectedTargets) {
			let keys = selectedByPage.get(target.page);
			if (!keys) {
				keys = new Set<string>();
				selectedByPage.set(target.page, keys);
			}
			keys.add(`${target.kind}:${target.id}`);
		}
		this.pushHistory();
		let changed = false;
		for (const [pageNumber, selectedKeys] of selectedByPage.entries()) {
			const bucket = this.getPageAnnotationBucket(pageNumber);
			const renderables = getAnnotationRenderables(bucket.strokes, bucket.textItems, bucket.shapes);
			if (reorderRenderables(renderables, selectedKeys, direction)) {
				changed = true;
			}
		}
		if (!changed) {
			if (this.undoStack.length > 0) {
				this.undoStack.pop();
			}
			this.refreshStatus("Nothing selected");
			return;
		}
		const message = direction === "front"
			? "Brought selection to front"
			: direction === "back"
				? "Sent selection to back"
				: direction === "forward"
					? "Brought selection forward"
					: "Sent selection backward";
		this.markDirtyAndRedraw(message);
		this.refreshToolbar();
	}

	private getNextPageZIndex(pageNumber: number): number {
		const bucket = this.getPageAnnotationBucket(pageNumber);
		const renderables = getAnnotationRenderables(bucket.strokes, bucket.textItems, bucket.shapes);
		const imageOrders = bucket.imageItems.map((image) => image.zIndex ?? 0);
		if (renderables.length === 0 && imageOrders.length === 0) {
			return 0;
		}
		return Math.max(...renderables.map((renderable) => getRenderableOrder(renderable)), ...imageOrders) + 1;
	}

	duplicateSelectedTargets(): void {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			this.refreshStatus("Nothing selected");
			return;
		}

		const offsetX = 0.018;
		const offsetY = 0.018;
		const nextSelections: SelectedTarget[] = [];
		const nextZIndexByPage = new Map<number, number>();
		this.pushHistory();
		const takeNextZIndex = (pageNumber: number): number => {
			const next = nextZIndexByPage.get(pageNumber) ?? this.getNextPageZIndex(pageNumber);
			nextZIndexByPage.set(pageNumber, next + 1);
			return next;
		};

		for (const target of this.selectedTargets) {
			if (target.kind === "stroke") {
				const stroke = this.annotationDocument.strokes.find((entry) => entry.id === target.id);
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
					zIndex: takeNextZIndex(stroke.page),
					createdAt: new Date().toISOString()
				};
				this.annotationDocument.strokes.push(nextStroke);
				nextSelections.push({ kind: "stroke", id: nextStroke.id, page: nextStroke.page });
				continue;
			}

			if (target.kind === "text") {
				const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
				if (!item) {
					continue;
				}
				const nextItem: TextAnnotation = {
					...item,
					id: generateId("text"),
					x: clamp(item.x + offsetX, 0, 1),
					y: clamp(item.y + offsetY, 0, 1),
					zIndex: takeNextZIndex(item.page),
					createdAt: new Date().toISOString()
				};
				this.annotationDocument.textItems.push(nextItem);
				nextSelections.push({ kind: "text", id: nextItem.id, page: nextItem.page });
				continue;
			}

			const shape = this.annotationDocument.shapes.find((entry) => entry.id === target.id);
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
				zIndex: takeNextZIndex(shape.page),
				createdAt: new Date().toISOString()
			};
			this.annotationDocument.shapes.push(nextShape);
			nextSelections.push({ kind: "shape", id: nextShape.id, page: nextShape.page });
		}

		if (nextSelections.length === 0) {
			if (this.undoStack.length > 0) {
				this.undoStack.pop();
			}
			this.refreshStatus("Nothing duplicated");
			return;
		}

		this.selectedTargets = nextSelections;
		this.selectedTarget = nextSelections[0] ?? null;
		this.lastSelectionRegion = null;
		this.markDirtyAndRedraw(nextSelections.length === 1 ? "Duplicated selection" : `Duplicated ${nextSelections.length} selections`);
		this.refreshToolbar();
	}

	undo(): void {
		if (!this.annotationDocument || this.undoStack.length === 0) {
			this.refreshStatus("Nothing to undo");
			return;
		}
		this.redoStack.push(cloneDocument(this.annotationDocument));
		const previous = this.undoStack.pop();
		if (!previous) {
			return;
		}
		this.annotationDocument = previous;
		this.lastSelectionRegion = null;
		this.invalidateAnnotationPageCache();
		this.isDirty = true;
		this.scheduleSave();
		this.scheduleSyncPages();
		this.drawAllAnnotations();
		this.refreshToolbar();
		this.refreshStatus("Undo applied");
	}

	redo(): void {
		if (!this.annotationDocument || this.redoStack.length === 0) {
			this.refreshStatus("Nothing to redo");
			return;
		}
		this.undoStack.push(cloneDocument(this.annotationDocument));
		const next = this.redoStack.pop();
		if (!next) {
			return;
		}
		this.annotationDocument = next;
		this.lastSelectionRegion = null;
		this.invalidateAnnotationPageCache();
		this.isDirty = true;
		this.scheduleSave();
		this.scheduleSyncPages();
		this.drawAllAnnotations();
		this.refreshToolbar();
		this.refreshStatus("Redo applied");
	}

	private getPdfFile(): TFile | null {
		const view = this.leaf.view as PdfLikeView;
		const file = view.file;
		return file && file.extension.toLowerCase() === "pdf" ? file : null;
	}

	private getViewContentEl(): HTMLElement | null {
		const view = this.leaf.view as PdfLikeView;
		return view.contentEl ?? view.containerEl.querySelector(".view-content") ?? view.containerEl;
	}

	private getNativeToolbarEl(): HTMLElement | null {
		if (!this.plugin.shouldPreferInlineToolbar()) {
			return null;
		}
		const viewContentEl = this.getViewContentEl();
		if (!viewContentEl) {
			return null;
		}

		return viewContentEl.querySelector<HTMLElement>(TOOLBAR_SELECTORS);
	}

	private getNativePdfEventBus(): { on?: (name: string, callback: (data?: unknown) => void) => void; off?: (name: string, callback: (data?: unknown) => void) => void } | null {
		const view = this.leaf.view as PdfLikeView & {
			viewer?: {
				child?: {
					pdfViewer?: {
						eventBus?: { on?: (name: string, callback: (data?: unknown) => void) => void; off?: (name: string, callback: (data?: unknown) => void) => void };
						pdfViewer?: { eventBus?: { on?: (name: string, callback: (data?: unknown) => void) => void; off?: (name: string, callback: (data?: unknown) => void) => void } };
					};
				};
			};
		};
		return view.viewer?.child?.pdfViewer?.eventBus ?? view.viewer?.child?.pdfViewer?.pdfViewer?.eventBus ?? null;
	}

	private bindNativePdfEvents(): void {
		const eventBus = this.getNativePdfEventBus();
		if (!eventBus || eventBus === this.nativeEventBus || typeof eventBus.on !== "function") {
			return;
		}
		this.unbindNativePdfEvents();
		this.nativeEventBus = eventBus;
		const addHandler = (name: string, callback: (data?: unknown) => void): void => {
			eventBus.on?.(name, callback);
			this.nativeEventHandlers.push({ name, callback });
		};
		addHandler("pagerendered", () => this.scheduleLayoutRefresh());
		addHandler("pagesloaded", () => this.scheduleLayoutRefresh());
		addHandler("pagechanging", (data?: unknown) => {
			const pageNumber = typeof data === "object" && data !== null && "pageNumber" in data
				? Number((data as { pageNumber?: unknown }).pageNumber)
				: NaN;
			if (Number.isFinite(pageNumber) && pageNumber > 0) {
				this.currentPage = pageNumber;
				this.refreshToolbar();
			}
		});
		addHandler("scalechanging", () => this.markRealPagesZooming());
		addHandler("scalechanged", () => {
			this.finishZoomingPages();
			this.scheduleLayoutRefresh();
		});
	}

	private unbindNativePdfEvents(): void {
		if (this.nativeEventBus?.off) {
			for (const { name, callback } of this.nativeEventHandlers) {
				this.nativeEventBus.off(name, callback);
			}
		}
		this.nativeEventBus = null;
		this.nativeEventHandlers = [];
	}

	private markRealPagesZooming(): void {
		for (const pageNumber of this.pageSurfaces.keys()) {
			this.zoomingPages.add(pageNumber);
		}
	}

	private ensureUi(): void {
		const viewContentEl = this.getViewContentEl();
		if (!viewContentEl || this.rootEl) {
			return;
		}

		viewContentEl.classList.add("pdf-native-annotator-host");

		this.rootEl = document.createElement("div");
		this.rootEl.className = SESSION_ROOT_CLASS;

		this.toolbarEl = document.createElement("div");
		this.toolbarEl.className = "pdf-native-annotator-toolbar";
		this.toolbarEl.title = "Drag empty space to move the annotation toolbar";
		this.toolbarEl.addEventListener("pointerdown", this.handleToolbarDragStart);

		this.statusEl = document.createElement("div");
		this.statusEl.className = "pdf-native-annotator-status";
		this.statusEl.textContent = "";

		this.toolPreviewEl = document.createElement("div");
		this.toolPreviewEl.className = "pdf-native-annotator-tool-preview is-hidden";

		this.rootEl.appendChild(this.toolbarEl);
		this.mountUi();
		viewContentEl.appendChild(this.toolPreviewEl);
		viewContentEl.addEventListener("pointerdown", this.handleViewPointerDown, { capture: true });
		viewContentEl.addEventListener("pointermove", this.handleViewPointerMove, { passive: true });
		viewContentEl.addEventListener("pointerleave", this.handleViewPointerLeave, { passive: true });
		document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
		window.addEventListener("resize", this.handleViewportResize, { passive: true });
	}

	private mountUi(): void {
		if (!this.rootEl) {
			return;
		}

		const nativeToolbarEl = this.getNativeToolbarEl();
		const viewContentEl = this.getViewContentEl();
		if (nativeToolbarEl) {
			this.rootEl.classList.add("is-inline");
			this.rootEl.classList.remove("is-floating");
			this.rootEl.setCssStyles({
				top: "",
				right: "",
				left: ""
			});
			if (this.rootEl.parentElement !== nativeToolbarEl) {
				nativeToolbarEl.appendChild(this.rootEl);
			}
			return;
		}

		if (viewContentEl) {
			viewContentEl.classList.add("pdf-native-annotator-host");
			this.rootEl.classList.add("is-floating");
			this.rootEl.classList.remove("is-inline");
			this.applyFloatingToolbarPosition();
			if (this.rootEl.parentElement !== viewContentEl) {
				viewContentEl.appendChild(this.rootEl);
			}
		}
	}

	private applyFloatingToolbarPosition(): void {
		if (!this.rootEl) {
			return;
		}
		this.rootEl.setCssStyles({
			top: `${this.floatingToolbarOffset.top}px`,
			right: `${this.floatingToolbarOffset.right}px`,
			left: "auto"
		});
	}

	private readonly handleToolbarDragStart = (event: PointerEvent): void => {
		if (!this.rootEl?.classList.contains("is-floating")) {
			return;
		}
		if (this.isToolbarInteractiveTarget(event.target)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.floatingToolbarDrag = {
			startX: event.clientX,
			startY: event.clientY,
			startRight: this.floatingToolbarOffset.right,
			startTop: this.floatingToolbarOffset.top
		};
		this.rootEl.classList.add("is-dragging");
		window.addEventListener("pointermove", this.handleToolbarDragMove, { passive: false });
		window.addEventListener("pointerup", this.handleToolbarDragEnd, { once: true });
		window.addEventListener("pointercancel", this.handleToolbarDragEnd, { once: true });
	};

	private isToolbarInteractiveTarget(target: EventTarget | null): boolean {
		const element = isDomElement(target) ? target : null;
		return !!element?.closest("button, input, select, textarea, a, .clickable-icon, .pdf-native-annotator-preset, .pdf-native-annotator-swatch");
	}

	private readonly handleToolbarDragMove = (event: PointerEvent): void => {
		if (!this.rootEl || !this.floatingToolbarDrag) {
			return;
		}
		event.preventDefault();
		const viewContentEl = this.getViewContentEl();
		const bounds = viewContentEl?.getBoundingClientRect();
		const toolbarRect = this.rootEl.getBoundingClientRect();
		const maxTop = Math.max(0, (bounds?.height ?? window.innerHeight) - toolbarRect.height - 8);
		const maxRight = Math.max(0, (bounds?.width ?? window.innerWidth) - Math.min(toolbarRect.width, bounds?.width ?? window.innerWidth) - 8);
		this.floatingToolbarOffset = {
			right: clamp(this.floatingToolbarDrag.startRight - (event.clientX - this.floatingToolbarDrag.startX), 8, maxRight),
			top: clamp(this.floatingToolbarDrag.startTop + (event.clientY - this.floatingToolbarDrag.startY), 8, maxTop)
		};
		this.applyFloatingToolbarPosition();
	};

	private readonly handleToolbarDragEnd = (): void => {
		this.rootEl?.classList.remove("is-dragging");
		this.floatingToolbarDrag = null;
		window.removeEventListener("pointermove", this.handleToolbarDragMove);
		window.removeEventListener("pointerup", this.handleToolbarDragEnd);
		window.removeEventListener("pointercancel", this.handleToolbarDragEnd);
	};

	private observePdfDom(): void {
		const viewContentEl = this.getViewContentEl();
		if (!viewContentEl) {
			return;
		}

		this.destroyObservers();

		this.mutationObserver = new MutationObserver((records) => {
			const externalChange = records.some((record) => this.isExternalPdfMutation(record));
			if (!externalChange) {
				return;
			}
			this.mountUi();
			this.scheduleLayoutRefresh();
		});
		this.mutationObserver.observe(viewContentEl, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class", "style", "width", "height", "data-loaded", "data-page-number"]
		});

		if (typeof ResizeObserver !== "undefined") {
			this.viewResizeObserver = new ResizeObserver(() => {
				this.scheduleRepositionOpenPopovers();
				this.scheduleLayoutRefresh();
			});
			this.viewResizeObserver.observe(viewContentEl);
			const scrollParent = findScrollParent(viewContentEl);
			if (scrollParent !== viewContentEl) {
				this.viewResizeObserver.observe(scrollParent);
			}
		}
	}

	private isExternalPdfMutation(record: MutationRecord): boolean {
		if (!isDomNode(record.target)) {
			return true;
		}
		if (record.type === "childList") {
			const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
			return changedNodes.some((node) => !this.isOwnedAnnotatorDom(node));
		}
		if (this.isOwnedAnnotatorDom(record.target)) {
			return false;
		}
		const element = isDomElement(record.target) ? record.target : record.target.parentElement;
		return !!element?.closest(".pdfViewer, .page[data-page-number], .pdf-page[data-page-number], .canvasWrapper");
	}

	private isOwnedAnnotatorDom(target: Node): boolean {
		if (this.isSyncingSyntheticPages) {
			return true;
		}
		if (this.rootEl?.contains(target)) {
			return true;
		}
		if (this.toolPreviewEl?.contains(target)) {
			return true;
		}
		const element = isDomElement(target) ? target : target.parentElement;
		return !!element?.closest(".pdf-native-annotator-synthetic-pages, .pdf-native-annotator-synthetic-page, .pdf-native-annotator-overlay, .pdf-native-annotator-transient, .pdf-native-annotator-template-background");
	}

	private destroyObservers(): void {
		if (this.syncHandle !== null) {
			window.cancelAnimationFrame(this.syncHandle);
			this.syncHandle = null;
		}
		if (this.scrollHandle !== null) {
			window.cancelAnimationFrame(this.scrollHandle);
			this.scrollHandle = null;
		}
		if (this.scrollIdleHandle !== null) {
			window.clearTimeout(this.scrollIdleHandle);
			this.scrollIdleHandle = null;
		}
		if (this.redrawHandle !== null) {
			window.cancelAnimationFrame(this.redrawHandle);
			this.redrawHandle = null;
		}
		if (this.interactionRedrawHandle !== null) {
			window.cancelAnimationFrame(this.interactionRedrawHandle);
			this.interactionRedrawHandle = null;
		}
		if (this.popoverRepositionHandle !== null) {
			window.cancelAnimationFrame(this.popoverRepositionHandle);
			this.popoverRepositionHandle = null;
		}
		this.clearLayoutRefreshHandles();
		if (this.zoomSettleHandle !== null) {
			window.clearTimeout(this.zoomSettleHandle);
			this.zoomSettleHandle = null;
		}
		if (this.statusResetHandle !== null) {
			window.clearTimeout(this.statusResetHandle);
			this.statusResetHandle = null;
		}
		this.mutationObserver?.disconnect();
		this.mutationObserver = null;
		this.viewResizeObserver?.disconnect();
		this.viewResizeObserver = null;
		for (const observer of this.pageResizeObservers.values()) {
			observer.disconnect();
		}
		this.pageResizeObservers.clear();
		this.pendingRedrawPages.clear();
		this.pendingInteractionRedrawPages.clear();
		this.zoomingPages.clear();
		this.isPdfScrolling = false;
		this.needsToolbarRefreshAfterScroll = false;
		if (this.scrollParent) {
			this.scrollParent.removeEventListener("scroll", this.handleScroll, { capture: false });
			this.scrollParent = null;
		}
		window.removeEventListener("resize", this.handleViewportResize);
	}

	private scheduleSyncPages(): void {
		if (this.syncHandle !== null) {
			return;
		}
		this.syncHandle = window.requestAnimationFrame(() => {
			this.syncHandle = null;
			this.syncPages();
		});
	}

	private syncPages(): void {
		if (!this.file || !this.annotationDocument) {
			return;
		}

		const viewContentEl = this.getViewContentEl();
		if (!viewContentEl) {
			return;
		}

		const rawRealPageEls = this.getRealPdfPageElements(viewContentEl);

		if (rawRealPageEls.length === 0) {
			this.refreshStatus(`Waiting for ${this.file.name} pages...`, 1800);
			return;
		}

		this.realPdfPageCount = rawRealPageEls.reduce((maxPage, entry) => Math.max(maxPage, entry.pageNumber), 0);
		this.applyDeletedPdfPageVisibility(rawRealPageEls);
		this.syncSyntheticPages(rawRealPageEls);
		const syntheticPageEls = Array.from(viewContentEl.querySelectorAll<HTMLElement>(".pdf-native-annotator-synthetic-page[data-page-number]"))
			.map((pageEl) => {
				const rawPage = Number(pageEl.getAttribute("data-page-number"));
				return Number.isFinite(rawPage) && rawPage > 0 ? { pageEl, pageNumber: rawPage } : null;
			})
			.filter((entry): entry is { pageEl: HTMLElement; pageNumber: number } => !!entry);
		const realPageEls = rawRealPageEls.filter((entry) => !this.isPdfPageDeleted(entry.pageNumber));
		const pageEls = [...realPageEls, ...syntheticPageEls];
		const nextPages = new Set<number>();
		for (const { pageEl, pageNumber } of pageEls) {
			nextPages.add(pageNumber);
			try {
				this.ensurePageSurface(pageEl, pageNumber);
			} catch (error) {
				console.error(`freedraw-pdf: failed to attach overlay to page ${pageNumber}`, error);
			}
		}

		for (const [pageNumber, surface] of this.pageSurfaces.entries()) {
			if (!nextPages.has(pageNumber)) {
				this.pageResizeObservers.get(pageNumber)?.disconnect();
				this.pageResizeObservers.delete(pageNumber);
				surface.overlayEl.remove();
				surface.transientEl.remove();
				this.pageSurfaces.delete(pageNumber);
			}
		}

		this.applyOverlayMode();
		this.bindScrollParent((realPageEls[0] ?? rawRealPageEls[0]).pageEl);
		this.updateCurrentPageFromScroll();
		this.updateVisiblePageRange();
		this.drawAllAnnotations();
		this.refreshToolbar();
	}

	private applyDeletedPdfPageVisibility(realPageEls: { pageEl: HTMLElement; pageNumber: number }[]): void {
		for (const { pageEl, pageNumber } of realPageEls) {
			const isDeleted = this.isPdfPageDeleted(pageNumber);
			pageEl.classList.toggle("pdf-native-annotator-deleted-pdf-page", isDeleted);
			this.setStyleIfChanged(pageEl, "display", isDeleted ? "none" : "");
			pageEl.setAttribute("aria-hidden", isDeleted ? "true" : "false");
		}
	}

	private getPrimaryPdfViewerEl(viewContentEl: HTMLElement): HTMLElement | null {
		const viewers = Array.from(viewContentEl.querySelectorAll<HTMLElement>(".pdfViewer"));
		if (viewers.length === 0) {
			return null;
		}
		let bestViewer: { element: HTMLElement; score: number } | null = null;
		for (const viewer of viewers) {
			if (!viewer.isConnected) {
				continue;
			}
			const style = window.getComputedStyle(viewer);
			if (style.display === "none" || style.visibility === "hidden") {
				continue;
			}
			const rect = viewer.getBoundingClientRect();
			const pageCount = viewer.querySelectorAll(".page[data-page-number], .pdf-page[data-page-number]").length;
			if (pageCount === 0) {
				continue;
			}
			const area = Math.max(1, rect.width * rect.height);
			const score = area + (pageCount * 1000);
			if (!bestViewer || score > bestViewer.score) {
				bestViewer = { element: viewer, score };
			}
		}
		return bestViewer?.element ?? null;
	}

	private getRealPdfPageElements(viewContentEl: HTMLElement): { pageEl: HTMLElement; pageNumber: number }[] {
		const pdfViewerEl = this.getPrimaryPdfViewerEl(viewContentEl);
		const candidates = pdfViewerEl
			? Array.from(pdfViewerEl.querySelectorAll<HTMLElement>(".page[data-page-number], .pdf-page[data-page-number]"))
			: Array.from(viewContentEl.querySelectorAll<HTMLElement>(PAGE_SELECTORS));
		const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
		const bestByPage = new Map<number, { pageEl: HTMLElement; pageNumber: number; area: number; visibleScore: number; hasCanvas: boolean }>();
		for (const pageEl of candidates) {
			if (!pageEl.isConnected) {
				continue;
			}
			if (pageEl.classList.contains("pdf-native-annotator-synthetic-page")) {
				continue;
			}
			if (pageEl.closest(".pdf-native-annotator-synthetic-pages")) {
				continue;
			}
			const rawPage = Number(pageEl.getAttribute("data-page-number"));
			if (!Number.isFinite(rawPage) || rawPage <= 0) {
				continue;
			}
			const hostEl = getOverlayHost(pageEl);
			if (!hostEl.isConnected) {
				continue;
			}
			const isDeletedPdfPage = pageEl.classList.contains("pdf-native-annotator-deleted-pdf-page");
			const pageStyle = window.getComputedStyle(pageEl);
			const hostStyle = window.getComputedStyle(hostEl);
			if (
				!isDeletedPdfPage &&
				(pageStyle.display === "none" || hostStyle.display === "none" || pageStyle.visibility === "hidden" || hostStyle.visibility === "hidden")
			) {
				continue;
			}
			const canvas = hostEl.querySelector("canvas") ?? pageEl.querySelector("canvas");
			const rect = hostEl.getBoundingClientRect();
			const pageRect = pageEl.getBoundingClientRect();
			const width = Math.max(rect.width, pageRect.width, hostEl.clientWidth, pageEl.clientWidth, isHtmlCanvasElement(canvas) ? canvas.clientWidth : 0);
			const height = Math.max(rect.height, pageRect.height, hostEl.clientHeight, pageEl.clientHeight, isHtmlCanvasElement(canvas) ? canvas.clientHeight : 0);
			const hasCanvas = isHtmlCanvasElement(canvas);
			if (!isDeletedPdfPage && ((!hasCanvas && width < 180) || width <= 2 || height <= 2)) {
				continue;
			}
			const area = Math.max(1, width * height);
			const intersectsViewport = rect.bottom > 0 && (!viewportHeight || rect.top < viewportHeight);
			const visibleScore = (intersectsViewport ? 2 : 0) + (hasCanvas ? 1 : 0);
			const existing = bestByPage.get(rawPage);
			if (
				!existing ||
				visibleScore > existing.visibleScore ||
				(visibleScore === existing.visibleScore && area > existing.area)
			) {
				bestByPage.set(rawPage, { pageEl, pageNumber: rawPage, area, visibleScore, hasCanvas });
			}
		}
		return Array.from(bestByPage.values())
			.sort((first, second) => first.pageNumber - second.pageNumber)
			.map(({ pageEl, pageNumber }) => ({ pageEl, pageNumber }));
	}

	private syncSyntheticPages(realPageEls: { pageEl: HTMLElement; pageNumber: number }[]): void {
		if (!this.annotationDocument || realPageEls.length === 0) {
			return;
		}
		const pages = this.annotationDocument.appendedPages ?? [];
		const firstRealPage = realPageEls[0].pageEl;
		const pdfViewerEl = firstRealPage.closest<HTMLElement>(".pdfViewer");
		const pageContainer = this.getSyntheticPageContainer(firstRealPage);
		if (!pageContainer) {
			return;
		}
		this.syntheticPageContainer = pageContainer;
		this.isSyncingSyntheticPages = true;
		try {
			const existingPages = Array.from(pageContainer.querySelectorAll<HTMLElement>(".pdf-native-annotator-synthetic-page"));
			if (pdfViewerEl && pdfViewerEl !== pageContainer) {
				for (const stalePage of Array.from(pdfViewerEl.querySelectorAll<HTMLElement>(".pdf-native-annotator-synthetic-page"))) {
					stalePage.remove();
				}
			}
			for (const existingPage of existingPages) {
				const pageNumber = Number(existingPage.dataset.pageNumber);
				const index = pageNumber - this.realPdfPageCount - 1;
				if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
					existingPage.remove();
				}
			}
			const realPageByNumber = new Map(realPageEls.map((entry) => [entry.pageNumber, entry.pageEl] as const));
			const syntheticGroups = new Map<number, HTMLElement[]>();
			pages.forEach((page, index) => {
				const pageNumber = this.realPdfPageCount + index + 1;
				let pageEl = pageContainer.querySelector<HTMLElement>(`.pdf-native-annotator-synthetic-page[data-page-number="${pageNumber}"]`);
				if (!pageEl) {
					pageEl = document.createElement("div");
					pageEl.dataset.pageNumber = String(pageNumber);
				}
				pageEl.classList.remove("page");
				pageEl.classList.add("pdf-native-annotator-synthetic-page");
				const insertAfter = this.getSyntheticPageInsertAfterPdfPage(page);
				const referenceWidth = this.getSyntheticReferenceWidth(realPageEls, insertAfter);
				this.updateSyntheticPageElement(pageEl, page, pageNumber, referenceWidth);
				const group = syntheticGroups.get(insertAfter) ?? [];
				group.push(pageEl);
				syntheticGroups.set(insertAfter, group);
			});
			const insertGroupAfter = (anchorPageNumber: number, cursor: HTMLElement | null): HTMLElement | null => {
				const group = syntheticGroups.get(anchorPageNumber) ?? [];
				let nextCursor = cursor;
				for (const pageEl of group) {
					const beforeNode = nextCursor ? nextCursor.nextSibling : null;
					if (pageEl !== beforeNode) {
						pageContainer.insertBefore(pageEl, beforeNode);
					}
					nextCursor = pageEl;
				}
				return nextCursor;
			};
			insertGroupAfter(0, null);
			for (const realPage of realPageEls) {
				if (realPageByNumber.has(realPage.pageNumber)) {
					insertGroupAfter(realPage.pageNumber, null);
				}
			}
		} finally {
			this.isSyncingSyntheticPages = false;
		}
	}

	private getSyntheticPageContainer(firstRealPage: HTMLElement): HTMLElement | null {
		const pdfViewerEl = firstRealPage.closest<HTMLElement>(".pdfViewer");
		const anchorEl = pdfViewerEl ?? firstRealPage;
		const parentEl = anchorEl.parentElement;
		if (!parentEl) {
			return null;
		}
		let container = parentEl.querySelector<HTMLElement>(":scope > .pdf-native-annotator-synthetic-pages");
		if (!container) {
			container = document.createElement("div");
			container.className = "pdf-native-annotator-synthetic-pages";
			anchorEl.insertAdjacentElement("afterend", container);
		} else if (container.previousElementSibling !== anchorEl && container.parentElement === parentEl) {
			anchorEl.insertAdjacentElement("afterend", container);
		}
		return container;
	}

	private getSyntheticReferenceWidth(realPageEls: { pageEl: HTMLElement; pageNumber: number }[], anchorPageNumber: number): number {
		const exactAnchor = realPageEls.find((entry) => entry.pageNumber === anchorPageNumber);
		const previousAnchor = [...realPageEls].reverse().find((entry) => entry.pageNumber <= anchorPageNumber);
		const nextAnchor = realPageEls.find((entry) => entry.pageNumber >= anchorPageNumber);
		const anchor = exactAnchor ?? previousAnchor ?? nextAnchor ?? realPageEls[0];
		const width = anchor ? this.getRenderedPdfPageWidth(anchor.pageEl) : 0;
		if (width > 0) {
			return Math.floor(width);
		}
		const fallbackWidth = realPageEls.reduce((largest, entry) => Math.max(largest, this.getRenderedPdfPageWidth(entry.pageEl)), 0);
		return Math.max(24, Math.floor(fallbackWidth || 920));
	}

	private getRenderedPdfPageWidth(pageEl: HTMLElement): number {
		const hostEl = getOverlayHost(pageEl);
		const canvas = hostEl.querySelector("canvas") ?? pageEl.querySelector("canvas");
		const hostRect = hostEl.getBoundingClientRect();
		const pageRect = pageEl.getBoundingClientRect();
		return Math.max(
			hostRect.width,
			pageRect.width,
			hostEl.clientWidth,
			pageEl.clientWidth,
			isHtmlCanvasElement(canvas) ? canvas.clientWidth : 0
		);
	}

	private updateSyntheticPageElement(pageEl: HTMLElement, page: NotebookPage, pageNumber: number, referenceWidth: number): void {
		pageEl.dataset.pageNumber = String(pageNumber);
		pageEl.dataset.template = page.template;
		pageEl.dataset.pageSize = page.pageSize;
		pageEl.dataset.insertAfterPdfPage = String(this.getSyntheticPageInsertAfterPdfPage(page));
		const dimensions = getNotebookPageSizeDimensions(page.pageSize);
		const a4Dimensions = getNotebookPageSizeDimensions("a4");
		const scale = referenceWidth / a4Dimensions.width;
		const width = Math.max(24, Math.round(dimensions.width * scale));
		const height = Math.max(32, Math.round(dimensions.height * scale));
		this.setStyleIfChanged(pageEl, "width", `${width}px`);
		this.setStyleIfChanged(pageEl, "height", `${height}px`);
		this.setStyleIfChanged(pageEl, "aspectRatio", `${dimensions.width} / ${dimensions.height}`);
		this.applyPaperTemplateCssVariables(pageEl, width, page.paperColor);
		this.setStyleIfChanged(pageEl, "backgroundColor", page.paperColor);
		let hostEl = pageEl.querySelector<HTMLElement>(":scope > .canvasWrapper");
		if (!hostEl) {
			hostEl = document.createElement("div");
			hostEl.className = "canvasWrapper pdf-native-annotator-synthetic-wrapper";
			pageEl.appendChild(hostEl);
		}
		this.setStyleIfChanged(hostEl, "width", "100%");
		this.setStyleIfChanged(hostEl, "height", "100%");
		this.setStyleIfChanged(hostEl, "backgroundColor", page.paperColor);
		let backgroundEl = hostEl.querySelector<HTMLElement>(":scope > .pdf-native-annotator-synthetic-background");
		if (!backgroundEl) {
			backgroundEl = document.createElement("div");
			backgroundEl.className = "pdf-native-annotator-synthetic-background";
			hostEl.prepend(backgroundEl);
		}
		backgroundEl.dataset.template = page.template;
		this.applyRenderedTemplateBackground(backgroundEl, width, height, page);
		hostEl.querySelector<HTMLElement>(":scope > .pdf-native-annotator-synthetic-label")?.remove();
	}

	private applyPaperTemplateCssVariables(element: HTMLElement, width: number, paperColor: string): void {
		const metrics = getPaperTemplateMetrics(width);
		this.setStylePropertyIfChanged(element, "--annotator-template-step", `${Math.max(3, metrics.graphStep)}px`);
		this.setStylePropertyIfChanged(element, "--annotator-template-ruled-step", `${Math.max(4, metrics.ruledStep)}px`);
		this.setStylePropertyIfChanged(element, "--annotator-template-dot-step", `${Math.max(3, metrics.dotStep)}px`);
		this.setStylePropertyIfChanged(element, "--annotator-template-dot-size", `${metrics.dotRadius}px`);
		this.setStylePropertyIfChanged(element, "--annotator-template-ruled-offset", `${Math.max(8, metrics.ruledOffset)}px`);
		this.setStylePropertyIfChanged(element, "--annotator-template-line-width", `${Math.max(1, width / getNotebookPageSizeDimensions("a4").width)}px`);
		this.setStylePropertyIfChanged(element, "--annotator-template-line-color", PAPER_TEMPLATE_LINE_COLOR);
		this.setStylePropertyIfChanged(element, "--annotator-template-grid-color", PAPER_TEMPLATE_GRID_COLOR);
		this.setStylePropertyIfChanged(element, "--annotator-template-dot-color", PAPER_TEMPLATE_DOT_COLOR);
		this.setStylePropertyIfChanged(element, "--annotator-template-paper-color", paperColor);
	}

	private setStyleIfChanged(element: HTMLElement, property: keyof CSSStyleDeclaration, value: string): void {
		element.setCssStyles({ [property]: value } as Partial<CSSStyleDeclaration>);
	}

	private setStylePropertyIfChanged(element: HTMLElement, property: string, value: string): void {
		element.setCssProps({ [property]: value });
	}

	private ensurePageSurface(pageEl: HTMLElement, pageNumber: number): void {
		const hostEl = getOverlayHost(pageEl);
		if (!hostEl.isConnected) {
			return;
		}
		const existing = this.pageSurfaces.get(pageNumber);
		if (existing && existing.pageEl === pageEl && existing.hostEl === hostEl) {
			this.ensureOverlayLayerOrder(existing);
			this.resizeOverlay(existing);
			return;
		}
		if (existing) {
			this.pageResizeObservers.get(pageNumber)?.disconnect();
			this.pageResizeObservers.delete(pageNumber);
			existing.overlayEl.remove();
			existing.transientEl.remove();
		}

		if (window.getComputedStyle(hostEl).position === "static") {
			hostEl.setCssStyles({ position: "relative" });
		}

		let overlayEl = hostEl.querySelector<HTMLCanvasElement>(`:scope > .${OVERLAY_CLASS}`);
		if (!overlayEl) {
			overlayEl = document.createElement("canvas");
			overlayEl.className = OVERLAY_CLASS;
			hostEl.appendChild(overlayEl);
			overlayEl.addEventListener("pointerenter", this.handlePointerEnter);
			overlayEl.addEventListener("pointerdown", this.handlePointerDown);
			overlayEl.addEventListener("pointermove", this.handlePointerMove);
			overlayEl.addEventListener("pointerup", this.handlePointerUp);
			overlayEl.addEventListener("pointercancel", this.handlePointerCancel);
			overlayEl.addEventListener("pointerleave", this.handlePointerLeave);
		}
		overlayEl.dataset.pageNumber = String(pageNumber);
		let transientEl = hostEl.querySelector<HTMLCanvasElement>(":scope > .pdf-native-annotator-transient");
		if (!transientEl) {
			transientEl = document.createElement("canvas");
			transientEl.className = "pdf-native-annotator-transient";
			hostEl.appendChild(transientEl);
		}

		const surface: PageSurface = {
			pageNumber,
			pageEl,
			hostEl,
			overlayEl,
			transientEl,
			lastWidth: 0,
			lastHeight: 0,
			pendingWidth: 0,
			pendingHeight: 0
		};
		this.pageSurfaces.set(pageNumber, surface);
		this.observePageSurface(surface);
		this.ensureOverlayLayerOrder(surface);
		this.resizeOverlay(surface);
	}

	private ensureOverlayLayerOrder(surface: PageSurface): void {
		if (!surface.overlayEl.isConnected || surface.overlayEl.parentElement !== surface.hostEl) {
			surface.hostEl.appendChild(surface.overlayEl);
		}
		if (!surface.transientEl.isConnected || surface.transientEl.parentElement !== surface.hostEl) {
			surface.hostEl.appendChild(surface.transientEl);
		}
		if (surface.transientEl.previousElementSibling !== surface.overlayEl || surface.hostEl.lastElementChild !== surface.transientEl) {
			surface.hostEl.appendChild(surface.overlayEl);
			surface.hostEl.appendChild(surface.transientEl);
		}
		surface.overlayEl.setCssStyles({ zIndex: "9990" });
		surface.transientEl.setCssStyles({ zIndex: "9991" });
	}

	private observePageSurface(surface: PageSurface): void {
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		this.pageResizeObservers.get(surface.pageNumber)?.disconnect();
		const observer = new ResizeObserver(() => {
			this.previewResizeOverlay(surface);
			this.markPageZooming(surface.pageNumber);
		});
		observer.observe(surface.hostEl);
		this.pageResizeObservers.set(surface.pageNumber, observer);
	}

	private markPageZooming(pageNumber: number): void {
		this.zoomingPages.add(pageNumber);
		this.scheduleLayoutRefresh();
		const surface = this.pageSurfaces.get(pageNumber);
		if (surface) {
			surface.overlayEl.setCssStyles({ opacity: "0.96" });
		}
		if (this.zoomSettleHandle !== null) {
			window.clearTimeout(this.zoomSettleHandle);
		}
		this.zoomSettleHandle = window.setTimeout(() => {
			this.finishZoomingPages();
		}, ZOOM_SETTLE_DELAY_MS);
	}

	private finishZoomingPages(): void {
		if (this.zoomSettleHandle !== null) {
			window.clearTimeout(this.zoomSettleHandle);
			this.zoomSettleHandle = null;
		}
		const pages = Array.from(this.zoomingPages);
		this.zoomingPages.clear();
		for (const pageNumber of pages) {
			const surface = this.pageSurfaces.get(pageNumber);
			if (surface) {
				this.resizeOverlay(surface);
				surface.overlayEl.setCssStyles({ opacity: "1" });
			}
			this.schedulePageRedraw(pageNumber);
		}
		if (this.annotationDocument?.appendedPages?.length) {
			this.scheduleSyncPages();
		}
	}

	private previewResizeOverlay(surface: PageSurface): void {
		const size = this.getStableSurfaceSize(surface);
		if (!size) {
			return;
		}
		const { width, height } = size;
		surface.pendingWidth = width;
		surface.pendingHeight = height;
		surface.overlayEl.setCssStyles({
			width: `${width}px`,
			height: `${height}px`
		});
		surface.transientEl.setCssStyles({
			width: `${width}px`,
			height: `${height}px`
		});
	}

	private resizeOverlay(surface: PageSurface): void {
		const size = this.getStableSurfaceSize(surface, true);
		if (!size) {
			return;
		}
		const { width, height } = size;

		if (width === surface.lastWidth && height === surface.lastHeight) {
			return;
		}

		const ratio = window.devicePixelRatio || 1;
		surface.overlayEl.width = Math.floor(width * ratio);
		surface.overlayEl.height = Math.floor(height * ratio);
		surface.overlayEl.setCssStyles({
			width: `${width}px`,
			height: `${height}px`
		});
		surface.transientEl.width = Math.floor(width * ratio);
		surface.transientEl.height = Math.floor(height * ratio);
		surface.transientEl.setCssStyles({
			width: `${width}px`,
			height: `${height}px`
		});
		surface.lastWidth = width;
		surface.lastHeight = height;
		surface.pendingWidth = width;
		surface.pendingHeight = height;
		this.syncPdfPageTemplateBackground(surface, width, height);
	}

	private syncPdfPageTemplateBackground(surface: PageSurface, width: number, height: number): void {
		const pageTemplate = this.getPdfPageTemplate(surface.pageNumber);
		let backgroundEl = surface.hostEl.querySelector<HTMLElement>(":scope > .pdf-native-annotator-template-background");
		if (!pageTemplate) {
			backgroundEl?.remove();
			return;
		}
		if (!backgroundEl) {
			backgroundEl = document.createElement("div");
			backgroundEl.className = "pdf-native-annotator-template-background pdf-native-annotator-synthetic-background";
			surface.hostEl.insertBefore(backgroundEl, surface.overlayEl);
		}
		backgroundEl.dataset.template = pageTemplate.template;
		const templatePage: NotebookPage = {
			id: `pdf-template-${surface.pageNumber}`,
			title: `Page ${surface.pageNumber}`,
			kind: "template",
			sourceLabel: "Template page",
			template: pageTemplate.template,
			paperColor: pageTemplate.paperColor,
			pageSize: pageTemplate.pageSize,
			strokes: [],
			textItems: [],
			shapes: []
		};
		this.applyRenderedTemplateBackground(backgroundEl, width, height, templatePage);
		this.setStyleIfChanged(backgroundEl, "width", `${width}px`);
		this.setStyleIfChanged(backgroundEl, "height", `${height}px`);
	}

	private applyRenderedTemplateBackground(element: HTMLElement, width: number, height: number, page: NotebookPage): void {
		this.applyPaperTemplateCssVariables(element, width, page.paperColor);
		this.setStyleIfChanged(element, "backgroundColor", page.paperColor);
		const dataUrl = createTemplatePageBackgroundDataUrl(width, height, page);
		if (!dataUrl) {
			this.setStyleIfChanged(element, "backgroundImage", "");
			return;
		}
		this.setStyleIfChanged(element, "backgroundImage", `url("${dataUrl}")`);
		this.setStyleIfChanged(element, "backgroundSize", "100% 100%");
		this.setStyleIfChanged(element, "backgroundRepeat", "no-repeat");
		this.setStyleIfChanged(element, "backgroundPosition", "0 0");
	}

	private getPdfPageTemplate(pageNumber: number): PdfPageTemplate | null {
		const pageTemplates = this.annotationDocument?.pdfPageTemplates;
		if (!pageTemplates?.length || pageNumber < 1 || pageNumber > this.realPdfPageCount) {
			return null;
		}
		return pageTemplates.find((pageTemplate) => pageTemplate.page === pageNumber) ?? null;
	}

	private getStableSurfaceSize(surface: PageSurface, allowLastKnown = false): { width: number; height: number } | null {
		const rect = surface.hostEl.getBoundingClientRect();
		const width = Math.floor(rect.width || surface.hostEl.clientWidth || surface.pageEl.clientWidth || 0);
		const height = Math.floor(rect.height || surface.hostEl.clientHeight || surface.pageEl.clientHeight || 0);
		if (width > 2 && height > 2) {
			return { width, height };
		}
		if (allowLastKnown && surface.lastWidth > 2 && surface.lastHeight > 2) {
			return { width: surface.lastWidth, height: surface.lastHeight };
		}
		if (allowLastKnown && surface.pendingWidth > 2 && surface.pendingHeight > 2) {
			return { width: surface.pendingWidth, height: surface.pendingHeight };
		}
		return null;
	}

	private bindScrollParent(pageEl: HTMLElement): void {
		const nextScrollParent = findScrollParent(pageEl);
		if (this.scrollParent === nextScrollParent) {
			return;
		}
		if (this.scrollParent) {
			this.scrollParent.removeEventListener("scroll", this.handleScroll, { capture: false });
		}
		this.scrollParent = nextScrollParent;
		this.scrollParent.addEventListener("scroll", this.handleScroll, { passive: true });
	}

	private readonly handleScroll = (): void => {
		this.scheduleRepositionOpenPopovers();
		this.isPdfScrolling = true;
		if (this.scrollIdleHandle !== null) {
			window.clearTimeout(this.scrollIdleHandle);
		}
		this.scrollIdleHandle = window.setTimeout(() => {
			this.scrollIdleHandle = null;
			this.isPdfScrolling = false;
			this.updateCurrentPageFromScroll();
			if (this.needsToolbarRefreshAfterScroll) {
				this.needsToolbarRefreshAfterScroll = false;
				this.refreshToolbar();
			}
			this.updateVisiblePageRange(true);
			this.flushDeferredScrollRedraws();
		}, 160);
	};

	private readonly handleViewportResize = (): void => {
		this.scheduleRepositionOpenPopovers();
		this.scheduleLayoutRefresh();
	};

	private clearLayoutRefreshHandles(): void {
		for (const handle of this.layoutRefreshHandles) {
			window.clearTimeout(handle);
		}
		this.layoutRefreshHandles = [];
	}

	private scheduleLayoutRefresh(): void {
		if (!this.file || !this.annotationDocument) {
			return;
		}
		this.scheduleSyncPages();
		this.clearLayoutRefreshHandles();
		for (const delayMs of [80, 240, 600, 1200]) {
			const handle = window.setTimeout(() => {
				this.layoutRefreshHandles = this.layoutRefreshHandles.filter((pendingHandle) => pendingHandle !== handle);
				this.syncPages();
				this.forceRedrawAllAnnotations();
			}, delayMs);
			this.layoutRefreshHandles.push(handle);
		}
	}

	private forceRedrawAllAnnotations(): void {
		if (!this.annotationDocument) {
			return;
		}
		this.zoomingPages.clear();
		this.pendingRedrawPages.clear();
		this.updateCurrentPageFromScroll();
		this.updateVisiblePageRange(false);
		for (const [pageNumber, surface] of this.pageSurfaces.entries()) {
			surface.overlayEl.setCssStyles({ visibility: "visible" });
			this.ensureOverlayLayerOrder(surface);
			this.drawPageAnnotations(pageNumber);
		}
	}

	private forceRedrawVisibleAnnotations(): void {
		if (!this.annotationDocument) {
			return;
		}
		this.updateCurrentPageFromScroll();
		this.updateVisiblePageRange(false);
		let redrewAnyPage = false;
		for (const [pageNumber, surface] of this.pageSurfaces.entries()) {
			const shouldDraw =
				pageNumber === this.currentPage ||
				pageNumber === this.pointerPage ||
				this.isPageNearViewport(pageNumber) ||
				!!this.visiblePageRange && pageNumber >= this.visiblePageRange.start && pageNumber <= this.visiblePageRange.end;
			if (!shouldDraw) {
				continue;
			}
			redrewAnyPage = true;
			this.zoomingPages.delete(pageNumber);
			surface.overlayEl.setCssStyles({ visibility: "visible" });
			this.ensureOverlayLayerOrder(surface);
			this.drawPageAnnotations(pageNumber);
		}
		if (!redrewAnyPage) {
			this.syncPages();
			this.forceRedrawAllAnnotations();
		}
	}

	private schedulePageRedraw(pageNumber: number): void {
		if (!this.shouldKeepPageHot(pageNumber)) {
			return;
		}
		if (this.zoomingPages.has(pageNumber)) {
			return;
		}
		this.pendingRedrawPages.add(pageNumber);
		if (this.isPdfScrolling && !this.currentStroke && !this.currentShape && !this.currentLasso) {
			return;
		}
		if (this.redrawHandle !== null) {
			return;
		}
		this.redrawHandle = window.requestAnimationFrame(() => {
			this.redrawHandle = null;
			const pendingPages = Array.from(this.pendingRedrawPages);
			this.pendingRedrawPages.clear();
			for (const pendingPage of pendingPages) {
				const shouldDraw =
					pendingPage === this.currentPage ||
					pendingPage === this.pointerPage ||
					this.shouldKeepPageHot(pendingPage);
				if (shouldDraw) {
					this.drawPageAnnotations(pendingPage);
				}
			}
		});
	}

	private flushDeferredScrollRedraws(): void {
		if (this.redrawHandle !== null) {
			return;
		}
		const pendingPages = Array.from(this.pendingRedrawPages);
		this.pendingRedrawPages.clear();
		for (const pendingPage of pendingPages) {
			if (this.shouldKeepPageHot(pendingPage) && !this.zoomingPages.has(pendingPage)) {
				this.drawPageAnnotations(pendingPage);
			}
		}
	}

	private scheduleInteractionRedraw(pageNumber: number): void {
		if (this.currentStroke || this.currentShape || this.currentLasso) {
			this.pendingInteractionRedrawPages.add(pageNumber);
			if (this.interactionRedrawHandle !== null) {
				return;
			}
			this.interactionRedrawHandle = window.requestAnimationFrame(() => {
				this.interactionRedrawHandle = null;
				const pages = Array.from(this.pendingInteractionRedrawPages);
				this.pendingInteractionRedrawPages.clear();
				for (const pendingPage of pages) {
					this.drawTransientPageAnnotations(pendingPage);
				}
			});
			return;
		}
		this.pendingInteractionRedrawPages.add(pageNumber);
		if (this.interactionRedrawHandle !== null) {
			return;
		}
		this.interactionRedrawHandle = window.requestAnimationFrame(() => {
			this.interactionRedrawHandle = null;
			const pages = Array.from(this.pendingInteractionRedrawPages);
			this.pendingInteractionRedrawPages.clear();
			for (const pendingPage of pages) {
				this.drawPageAnnotations(pendingPage);
			}
		});
	}

	private flushInteractionRedraw(pageNumber?: number | null): void {
		if (this.interactionRedrawHandle !== null) {
			window.cancelAnimationFrame(this.interactionRedrawHandle);
			this.interactionRedrawHandle = null;
		}
		const pages = pageNumber ? [pageNumber] : Array.from(this.pendingInteractionRedrawPages);
		this.pendingInteractionRedrawPages.clear();
		for (const pendingPage of pages) {
			this.drawPageAnnotations(pendingPage);
		}
	}

	private cancelPendingInteractionRedraw(): void {
		if (this.interactionRedrawHandle !== null) {
			window.cancelAnimationFrame(this.interactionRedrawHandle);
			this.interactionRedrawHandle = null;
		}
		this.pendingInteractionRedrawPages.clear();
	}

	private isPageNearViewport(pageNumber: number): boolean {
		const surface = this.pageSurfaces.get(pageNumber);
		if (!surface || !this.scrollParent) {
			return false;
		}
		const containerRect = this.scrollParent.getBoundingClientRect();
		const rect = surface.pageEl.getBoundingClientRect();
		const margin = 120;
		return rect.bottom >= containerRect.top - margin && rect.top <= containerRect.bottom + margin;
	}

	private shouldKeepPageHot(pageNumber: number): boolean {
		if (pageNumber === this.currentPage || pageNumber === this.pointerPage) {
			return true;
		}
		if (this.visiblePageRange) {
			return pageNumber >= this.visiblePageRange.start && pageNumber <= this.visiblePageRange.end;
		}
		return this.isPageNearViewport(pageNumber);
	}

	private updateVisiblePageRange(allowRedraw = true): void {
		if (this.pageSurfaces.size === 0 || !this.scrollParent) {
			return;
		}

		const visiblePages = Array.from(this.pageSurfaces.keys())
			.filter((pageNumber) => this.isPageNearViewport(pageNumber))
			.sort((left, right) => left - right);

		if (visiblePages.length === 0) {
			return;
		}

		const previousRange = this.visiblePageRange;
		const nextRange = {
			start: Math.max(1, visiblePages[0] - PAGE_VIRTUALIZATION_MARGIN),
			end: visiblePages[visiblePages.length - 1] + PAGE_VIRTUALIZATION_MARGIN
		};
		if (previousRange && previousRange.start === nextRange.start && previousRange.end === nextRange.end) {
			return;
		}
		this.visiblePageRange = nextRange;

		for (const [pageNumber, surface] of this.pageSurfaces.entries()) {
			const hot = this.shouldKeepPageHot(pageNumber);
			surface.overlayEl.setCssStyles({ visibility: "visible" });
			const wasHot = previousRange
				? pageNumber >= previousRange.start && pageNumber <= previousRange.end
				: false;
			if (allowRedraw && hot && !wasHot) {
				this.schedulePageRedraw(pageNumber);
			}
		}
	}

	private updateCurrentPageFromScroll(): void {
		if (!this.scrollParent || this.pageSurfaces.size === 0) {
			return;
		}

		const containerRect = this.scrollParent.getBoundingClientRect();
		let nearestPage = this.currentPage;
		let nearestDistance = Number.POSITIVE_INFINITY;

		for (const [pageNumber, surface] of this.pageSurfaces.entries()) {
			const rect = surface.pageEl.getBoundingClientRect();
			const distance = Math.abs(rect.top - containerRect.top - 28);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestPage = pageNumber;
			}
		}

		if (nearestPage !== this.currentPage) {
			this.currentPage = nearestPage;
			if (this.isPdfScrolling) {
				this.needsToolbarRefreshAfterScroll = true;
				return;
			}
			this.refreshToolbar();
		}
	}

	private buildPageLink(pageNumber: number): string {
		if (!this.file) {
			return "";
		}
		return `[[${this.file.path}#page=${pageNumber}]]`;
	}

	private buildSelectionRegionReference(): string | null {
		const region = this.getSelectionRegion();
		if (!region) {
			return null;
		}
		const rect = [region.rect.left, region.rect.top, region.rect.right, region.rect.bottom]
			.map((value) => value.toFixed(4))
			.join(",");
		return `[[${region.file.path}#page=${region.page}]] ::region[page=${region.page};rect=${rect}]`;
	}

	private getSelectionRegion(): { file: TFile; page: number; rect: NormalizedRect } | null {
		if (!this.file) {
			return null;
		}
		if (this.lastSelectionRegion) {
			return { file: this.file, page: this.lastSelectionRegion.page, rect: this.lastSelectionRegion.rect };
		}
		if (this.selectedTargets.length === 0) {
			return null;
		}
		const selectionPage = this.getSelectionPage();
		if (!selectionPage) {
			return null;
		}
		const bounds = this.getCombinedBounds(this.selectedTargets.filter((target) => target.page === selectionPage));
		const rect = bounds ? normalizeRect(bounds) : null;
		return rect ? { file: this.file, page: selectionPage, rect } : null;
	}

	private async insertSessionTextAtPoint(pageNumber: number, point: AnnotationPoint, boxWidthScale?: number, boxHeightScale?: number): Promise<void> {
		this.beginSessionInlineTextEditor(pageNumber, point, undefined, boxWidthScale, boxHeightScale);
	}

	private beginSessionInlineTextEditor(pageNumber: number, point: AnnotationPoint, existingItem?: TextAnnotation, boxWidthScale?: number, boxHeightScale?: number): void {
		if (!this.annotationDocument) {
			return;
		}
		const surface = this.pageSurfaces.get(pageNumber);
		if (!surface || this.inlineTextEditorEl) {
			return;
		}
		const editingExistingText = !!existingItem;
		if (existingItem) {
			this.selectedTarget = { kind: "text", id: existingItem.id, page: pageNumber };
			this.selectedTargets = [this.selectedTarget];
		}
		const layoutSource = (boxWidthScale && boxWidthScale > 0) || (boxHeightScale && boxHeightScale > 0)
			? ({ ...existingItem, boxWidthScale, boxHeightScale } as TextAnnotation)
			: existingItem;
		const layout = getInlineTextEditorLayout(point, surface.lastWidth, surface.lastHeight, layoutSource);
		const frame = document.createElement("div");
		frame.className = "pdf-native-annotator-inline-text-frame";
		if (editingExistingText) {
			frame.classList.add("is-editing-selected");
		}
		frame.setCssStyles({
			left: `${layout.left}px`,
			top: `${layout.top}px`,
			width: `${layout.width}px`,
			height: `${layout.height}px`
		});
		frame.dataset.left = String(layout.left);
		frame.dataset.top = String(layout.top);
		frame.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
			if (event.target !== frame) {
				return;
			}
			event.preventDefault();
			const startClientX = event.clientX;
			const startClientY = event.clientY;
			const startLeft = Number(frame.dataset.left) || 0;
			const startTop = Number(frame.dataset.top) || 0;
			const frameRect = frame.getBoundingClientRect();
			const onMove = (moveEvent: PointerEvent): void => {
				moveEvent.preventDefault();
				const nextLeft = clamp(startLeft + (moveEvent.clientX - startClientX), 8, Math.max(8, surface.lastWidth - frameRect.width - 8));
				const nextTop = clamp(startTop + (moveEvent.clientY - startClientY), 8, Math.max(8, surface.lastHeight - frameRect.height - 8));
				frame.setCssStyles({
					left: `${nextLeft}px`,
					top: `${nextTop}px`
				});
				frame.dataset.left = String(nextLeft);
				frame.dataset.top = String(nextTop);
				this.inlineTextPoint = {
					x: clamp(nextLeft / Math.max(surface.lastWidth, 1), 0.01, 0.96),
					y: clamp(nextTop / Math.max(surface.lastHeight, 1), 0.01, 0.96),
					pressure: 0.5
				};
			};
			const onUp = (): void => {
				window.removeEventListener("pointermove", onMove, true);
				window.removeEventListener("pointerup", onUp, true);
			};
			window.addEventListener("pointermove", onMove, true);
			window.addEventListener("pointerup", onUp, true);
		});
		frame.addEventListener("click", (event) => {
			event.stopPropagation();
		});
		const editor = document.createElement("textarea");
		editor.className = "pdf-native-annotator-inline-text-editor";
		editor.value = existingItem?.text ?? "";
		const baseFontSize = existingItem?.fontScale
			? Math.max(10, existingItem.fontScale * surface.lastWidth)
			: existingItem?.fontSize ?? this.currentTextFontSize;
		const fontFamily = existingItem?.fontFamily ?? this.currentTextFontFamily;
		editor.wrap = "soft";
		editor.placeholder = "Type text";
		editor.spellcheck = false;
		editor.autocomplete = "off";
		editor.autocapitalize = "off";
		const textColor = existingItem?.color ?? this.currentTextColor;
		if (existingItem) {
			this.currentTextFontFamily = fontFamily;
			this.currentTextFontSize = Math.round(baseFontSize);
			this.currentTextColor = textColor;
		}
		editor.dataset.textColor = textColor;
		editor.setCssStyles({
			color: "transparent",
			fontSize: `${baseFontSize}px`,
			fontFamily: `"${fontFamily}", sans-serif`
		});
		editor.setCssProps({ "-webkit-text-fill-color": "transparent" });
		frame.appendChild(editor);
		this.addInlineTextFrameHandles(frame, editor, surface.lastWidth, surface.lastHeight);
		surface.hostEl.appendChild(frame);
		this.inlineTextEditorFrameEl = frame;
		this.inlineTextEditorEl = editor;
		this.inlineTextTargetId = existingItem?.id ?? null;
		this.inlineTextPoint = layout.point;
		this.inlineTextPageNumber = pageNumber;
		const resizeEditor = (): void => {
			if (editingExistingText || boxWidthScale || boxHeightScale) {
				editor.setCssStyles({ height: "100%" });
				return;
			}
			resizeInlineTextEditor(editor, surface.lastHeight * 0.42);
		};
		const commit = (): void => {
			this.finishSessionInlineTextEditor(true);
		};
		editor.addEventListener("input", resizeEditor);
		editor.addEventListener("input", () => {
			this.updateInlineTextEditorBoxFromContent(pageNumber);
			this.drawPageAnnotations(pageNumber);
		});
		editor.addEventListener("blur", commit, { once: true });
		editor.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				this.finishSessionInlineTextEditor(false);
				return;
			}
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				commit();
			}
		});
		resizeEditor();
		this.drawPageAnnotations(pageNumber);
		window.setTimeout(() => {
			editor.focus();
			editor.setSelectionRange(editor.value.length, editor.value.length);
		}, 0);
		this.refreshStatus("Type on page. Enter adds a line, Ctrl/Cmd+Enter saves, Esc cancels.");
	}

	private finishSessionInlineTextEditor(apply: boolean): void {
		const editor = this.inlineTextEditorEl;
		const frame = this.inlineTextEditorFrameEl;
		const point = this.inlineTextPoint;
		const pageNumber = this.inlineTextPageNumber;
		const targetId = this.inlineTextTargetId;
		const value = editor?.value.trim() ?? "";
		const editorColor = editor?.dataset.textColor || this.currentTextColor;
		const frameRect = frame?.getBoundingClientRect() ?? null;
		const editorRect = editor?.getBoundingClientRect() ?? null;
		const preview = pageNumber === null ? null : this.getInlineTextPreviewItem(pageNumber);
		if (frame) {
			frame.remove();
		} else if (editor) {
			editor.remove();
		}
		this.inlineTextEditorEl = null;
		this.inlineTextEditorFrameEl = null;
		this.inlineTextTargetId = null;
		this.inlineTextPoint = null;
		this.inlineTextPageNumber = null;
		if (!apply || !this.annotationDocument || !point || pageNumber === null) {
			return;
		}
		const surface = this.pageSurfaces.get(pageNumber);
		const pageWidth = Math.max(surface?.lastWidth ?? 1, 1);
		const editorWidth = frameRect ? frameRect.width : editorRect ? editorRect.width : Number.NaN;
		const pageHeight = Math.max(surface?.lastHeight ?? 1, 1);
		const editorHeight = frameRect ? frameRect.height : editorRect ? editorRect.height : Number.NaN;
		const boxWidthScale = Number.isFinite(editorWidth) ? clamp(editorWidth / pageWidth, 0.04, 0.9) : undefined;
		const boxHeightScale = preview?.boxHeightScale ?? (Number.isFinite(editorHeight) ? clamp(editorHeight / pageHeight, 0.025, 0.9) : undefined);
		const nextX = clamp(point.x, 0.01, 0.96);
		const nextY = clamp(point.y, 0.01, 0.96);
		if (!value && !targetId) {
			return;
		}
		this.pushHistory();
		if (targetId) {
			const existing = this.annotationDocument.textItems.find((entry) => entry.id === targetId);
			if (existing) {
				if (!value.trim()) {
					this.annotationDocument.textItems = this.annotationDocument.textItems.filter((entry) => entry.id !== targetId);
					this.selectedTargets = this.selectedTargets.filter((target) => target.id !== targetId);
					this.markDirtyAndRedraw("Text annotation deleted");
					return;
				}
				existing.text = value;
				existing.x = nextX;
				existing.y = nextY;
				existing.color = editorColor || existing.color || this.currentTextColor;
				existing.fontFamily = this.currentTextFontFamily;
				existing.fontSize = this.currentTextFontSize;
				existing.fontScale = this.getStableTextFontScale(this.currentTextFontSize);
				existing.boxWidthScale = boxWidthScale ?? existing.boxWidthScale;
				existing.boxHeightScale = boxHeightScale ?? existing.boxHeightScale;
				this.selectedTarget = { kind: "text", id: existing.id, page: pageNumber };
				this.selectedTargets = [this.selectedTarget];
				this.markDirtyAndRedraw("Text annotation updated");
				return;
			}
		}
		if (!value.trim()) {
			return;
		}
		const nextText: TextAnnotation = {
			id: generateId("text"),
			page: pageNumber,
			text: value,
			x: nextX,
			y: nextY,
			color: editorColor || this.currentTextColor,
			fontSize: this.currentTextFontSize,
			fontFamily: this.currentTextFontFamily,
			fontScale: this.getStableTextFontScale(this.currentTextFontSize),
			boxWidthScale,
			boxHeightScale,
			zIndex: this.getNextPageZIndex(pageNumber),
			createdAt: new Date().toISOString()
		};
		this.annotationDocument.textItems.push(nextText);
		this.selectedTarget = { kind: "text", id: nextText.id, page: pageNumber };
		this.selectedTargets = [this.selectedTarget];
		this.markDirtyAndRedraw("Text annotation added");
	}

	private addInlineTextFrameHandles(frame: HTMLDivElement, editor: HTMLTextAreaElement, pageWidth: number, pageHeight: number): void {
		const handles: Array<{ name: ResizeHandle; cls: string }> = [
			{ name: "nw", cls: "is-nw" },
			{ name: "n", cls: "is-n" },
			{ name: "ne", cls: "is-ne" },
			{ name: "e", cls: "is-e" },
			{ name: "se", cls: "is-se" },
			{ name: "s", cls: "is-s" },
			{ name: "sw", cls: "is-sw" },
			{ name: "w", cls: "is-w" }
		];
		for (const handle of handles) {
			const handleEl = document.createElement("button");
			handleEl.type = "button";
			handleEl.className = `pdf-native-annotator-inline-text-handle ${handle.cls}`;
			handleEl.setAttribute("aria-label", `Resize text box ${handle.name}`);
			handleEl.addEventListener("pointerdown", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const startClientX = event.clientX;
				const startClientY = event.clientY;
				const startWidth = frame.getBoundingClientRect().width;
				const startHeight = frame.getBoundingClientRect().height;
				const startLeft = Number(frame.dataset.left) || 0;
				const startTop = Number(frame.dataset.top) || 0;
				const onMove = (moveEvent: PointerEvent): void => {
					moveEvent.preventDefault();
					const delta = moveEvent.clientX - startClientX;
					const deltaY = moveEvent.clientY - startClientY;
					let nextLeft = startLeft;
					let nextTop = startTop;
					let nextWidth = startWidth;
					let nextHeight = startHeight;
					if (handle.name.includes("e")) {
						nextWidth = clamp(startWidth + delta, 180, Math.max(180, pageWidth - startLeft - 12));
					}
					if (handle.name.includes("w")) {
						nextLeft = clamp(startLeft + delta, 8, startLeft + startWidth - 180);
						nextWidth = clamp(startWidth - (nextLeft - startLeft), 180, Math.max(180, pageWidth - 12));
					}
					if (handle.name.includes("s")) {
						nextHeight = clamp(startHeight + deltaY, 36, Math.max(36, pageHeight - startTop - 12));
					}
					if (handle.name.includes("n")) {
						nextTop = clamp(startTop + deltaY, 8, startTop + startHeight - 36);
						nextHeight = clamp(startHeight - (nextTop - startTop), 36, Math.max(36, pageHeight - 12));
					}
					frame.setCssStyles({
						left: `${nextLeft}px`,
						top: `${nextTop}px`,
						width: `${nextWidth}px`,
						height: `${nextHeight}px`
					});
					frame.dataset.left = String(nextLeft);
					frame.dataset.top = String(nextTop);
					editor.setCssStyles({ height: `${Math.max(36, nextHeight)}px` });
					if (this.inlineTextPoint) {
						this.inlineTextPoint = {
							...this.inlineTextPoint,
							x: clamp(nextLeft / Math.max(pageWidth, 1), 0.01, 0.96),
							y: clamp(nextTop / Math.max(pageHeight, 1), 0.01, 0.96)
						};
					}
				};
				const onUp = (): void => {
					window.removeEventListener("pointermove", onMove, true);
					window.removeEventListener("pointerup", onUp, true);
					editor.focus();
				};
				window.addEventListener("pointermove", onMove, true);
				window.addEventListener("pointerup", onUp, true);
			});
			frame.appendChild(handleEl);
		}
	}

	private get currentTool(): AnnotationTool {
		return this.toolState.activeTool;
	}

	private get eraserMode(): EraserMode {
		return this.toolState.eraserMode;
	}

	private get currentColor(): string {
		return this.toolState.activeColor;
	}

	private getStableAnnotationWidthScale(width: number): number {
		return clamp(width / DEFAULT_STROKE_REFERENCE_WIDTH, 0.0005, MAX_STROKE_WIDTH_SCALE);
	}

	private getStableTextFontScale(fontSize: number): number {
		return clamp(fontSize / DEFAULT_STROKE_REFERENCE_WIDTH, 0.004, MAX_TEXT_FONT_SCALE);
	}

	private resolveStoredScale(width: number, storedScale: number | undefined, maxScale: number): number {
		const fallbackScale = width > 0
			? clamp(width / DEFAULT_STROKE_REFERENCE_WIDTH, 0.0005, maxScale)
			: 0.0005;
		if (
			typeof storedScale === "number" &&
			Number.isFinite(storedScale) &&
			storedScale > 0 &&
			storedScale <= maxScale &&
			storedScale <= fallbackScale * SCALE_DRIFT_TOLERANCE
		) {
			return storedScale;
		}
		return fallbackScale;
	}

	private resolveStoredFontScale(textItem: TextAnnotation): number {
		const fallbackScale = this.getStableTextFontScale(textItem.fontSize);
		const storedScale = textItem.fontScale;
		if (
			typeof storedScale === "number" &&
			Number.isFinite(storedScale) &&
			storedScale > 0 &&
			storedScale <= MAX_TEXT_FONT_SCALE &&
			storedScale <= fallbackScale * SCALE_DRIFT_TOLERANCE
		) {
			return storedScale;
		}
		return fallbackScale;
	}

	private setActiveTool(tool: AnnotationTool): void {
		if (this.inlineTextEditorEl && tool !== "text") {
			this.finishSessionInlineTextEditor(true);
		}
		if (tool !== "select" && this.selectedTargets.length > 0) {
			this.clearSelection();
		}
		this.toolState.setActiveTool(tool);
		if (!this.annotationMode) {
			this.annotationMode = true;
			this.applyOverlayMode();
			this.refreshStatus("Annotation mode enabled");
		}
		this.persistToolDefaults();
	}

	private setCurrentColor(color: string): void {
		this.toolState.setColor(color);
		this.persistToolDefaults();
		this.updateInlineTextEditorStyle();
	}

	private shouldApplyStyleToSelection(): boolean {
		return this.currentTool === "select" && this.selectedTargets.length > 0;
	}

	private hasSelectedText(): boolean {
		return this.selectedTargets.some((target) => target.kind === "text");
	}

	private shouldApplyTextStyleToSelection(): boolean {
		return this.selectedTargets.some((target) => target.kind === "text");
	}

	private applyColorToSelection(color: string, pushHistory = true): void {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			return;
		}
		if (pushHistory) {
			this.pushHistory();
		}
		for (const target of this.selectedTargets) {
			if (target.kind === "stroke") {
				const stroke = this.annotationDocument.strokes.find((entry) => entry.id === target.id);
				if (stroke) {
					stroke.color = color;
				}
				continue;
			}
			if (target.kind === "text") {
				const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
				if (item) {
					item.color = color;
				}
				continue;
			}
			const shape = this.annotationDocument.shapes.find((entry) => entry.id === target.id);
			if (shape) {
				shape.color = color;
			}
		}
		this.markDirtyAndRedraw(this.selectedTargets.length === 1 ? "Selection color updated" : `Updated ${this.selectedTargets.length} selection colors`);
	}

	private applyTextColorToSelection(color: string, pushHistory = true): void {
		if (!this.annotationDocument || !this.hasSelectedText()) {
			return;
		}
		if (pushHistory) {
			this.pushHistory();
		}
		for (const target of this.selectedTargets) {
			if (target.kind !== "text") {
				continue;
			}
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			if (item) {
				item.color = color;
			}
		}
		this.markDirtyAndRedraw("Text color updated");
	}

	private applyWidthToSelection(width: number, pushHistory = true): void {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			return;
		}
		if (pushHistory) {
			this.pushHistory();
		}
		for (const target of this.selectedTargets) {
			if (target.kind === "stroke") {
				const stroke = this.annotationDocument.strokes.find((entry) => entry.id === target.id);
				if (stroke) {
					stroke.width = width;
					stroke.widthScale = this.getStableAnnotationWidthScale(width);
				}
				continue;
			}
			if (target.kind === "shape") {
				const shape = this.annotationDocument.shapes.find((entry) => entry.id === target.id);
				if (shape) {
					shape.width = width;
					shape.widthScale = this.getStableAnnotationWidthScale(width);
				}
				continue;
			}
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			if (item) {
				item.fontSize = clamp(width * 4, 10, 96);
				item.fontScale = this.getStableTextFontScale(item.fontSize);
			}
		}
		this.markDirtyAndRedraw(this.selectedTargets.length === 1 ? "Selection width updated" : `Updated ${this.selectedTargets.length} selection widths`);
	}

	private applyFontFamilyToSelection(fontFamily: string): void {
		if (!this.annotationDocument || !this.hasSelectedText()) {
			return;
		}
		this.pushHistory();
		for (const target of this.selectedTargets) {
			if (target.kind !== "text") {
				continue;
			}
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			if (item) {
				item.fontFamily = fontFamily;
			}
		}
		this.markDirtyAndRedraw("Text font updated");
	}

	private applyTextSizeToSelection(fontSize: number): void {
		if (!this.annotationDocument || !this.hasSelectedText()) {
			return;
		}
		this.pushHistory();
		for (const target of this.selectedTargets) {
			if (target.kind !== "text") {
				continue;
			}
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			if (item) {
				item.fontSize = fontSize;
				item.fontScale = this.getStableTextFontScale(fontSize);
			}
		}
		this.markDirtyAndRedraw("Text size updated");
	}

	private applyTextBoxWidthToSelection(widthPx: number, pushHistory = true): void {
		if (!this.annotationDocument || !this.hasSelectedText()) {
			return;
		}
		if (pushHistory) {
			this.pushHistory();
		}
		for (const target of this.selectedTargets) {
			if (target.kind !== "text") {
				continue;
			}
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			const pageWidth = Math.max(this.pageSurfaces.get(target.page)?.lastWidth ?? 1, 1);
			if (item) {
				item.boxWidthScale = clamp(widthPx / pageWidth, 0.04, 0.9);
			}
		}
		this.markDirtyAndRedraw("Text box width updated");
	}

	private setTextFontFamily(fontFamily: string): void {
		this.currentTextFontFamily = fontFamily;
		this.updateInlineTextEditorStyle();
		if (this.shouldApplyTextStyleToSelection()) {
			this.applyFontFamilyToSelection(fontFamily);
		}
		this.refreshToolbar();
	}

	private setTextFontSize(fontSize: number): void {
		this.currentTextFontSize = fontSize;
		this.updateInlineTextEditorStyle();
		if (this.shouldApplyTextStyleToSelection()) {
			this.applyTextSizeToSelection(fontSize);
		}
		this.refreshToolbar();
	}

	private setTextColor(color: string, pushHistory = true): void {
		this.currentTextColor = color;
		if (this.inlineTextEditorEl) {
			this.inlineTextEditorEl.dataset.textColor = color;
			this.inlineTextEditorEl.setCssStyles({ color: "transparent" });
			this.inlineTextEditorEl.setCssProps({ "-webkit-text-fill-color": "transparent" });
			if (this.inlineTextPageNumber !== null) {
				this.drawPageAnnotations(this.inlineTextPageNumber);
			}
		}
		if (this.shouldApplyTextStyleToSelection()) {
			this.applyTextColorToSelection(color, pushHistory);
		}
		this.refreshToolbar();
	}

	private setTextBoxWidth(widthPx: number, pushHistory = true): void {
		const safeWidth = clamp(Math.round(widthPx), 160, 760);
		if (this.inlineTextEditorFrameEl && this.inlineTextEditorEl) {
			this.inlineTextEditorFrameEl.setCssStyles({ width: `${safeWidth}px` });
			const surface = this.inlineTextPageNumber ? this.pageSurfaces.get(this.inlineTextPageNumber) : null;
			if (this.inlineTextEditorFrameEl.classList.contains("is-editing-selected")) {
				this.inlineTextEditorEl.setCssStyles({ height: "100%" });
			} else {
				resizeInlineTextEditor(this.inlineTextEditorEl, (surface?.lastHeight ?? 600) * 0.42);
			}
		}
		if (this.shouldApplyTextStyleToSelection()) {
			this.applyTextBoxWidthToSelection(safeWidth, pushHistory);
		}
	}

	private updateInlineTextEditorStyle(): void {
		if (!this.inlineTextEditorEl) {
			return;
		}
		this.inlineTextEditorEl.dataset.textColor = this.currentTextColor;
		this.inlineTextEditorEl.setCssStyles({
			color: "transparent",
			fontFamily: `"${this.currentTextFontFamily}", sans-serif`,
			fontSize: `${this.currentTextFontSize}px`
		});
		this.inlineTextEditorEl.setCssProps({ "-webkit-text-fill-color": "transparent" });
		const surface = this.inlineTextPageNumber ? this.pageSurfaces.get(this.inlineTextPageNumber) : null;
		if (this.inlineTextEditorFrameEl?.classList.contains("is-editing-selected")) {
			this.inlineTextEditorEl.setCssStyles({ height: "100%" });
		} else {
			resizeInlineTextEditor(this.inlineTextEditorEl, (surface?.lastHeight ?? 600) * 0.42);
		}
		if (this.inlineTextPageNumber !== null) {
			this.drawPageAnnotations(this.inlineTextPageNumber);
		}
	}

	private applyPreset(presetId: string): void {
		if (!this.toolState.applyPreset(presetId)) {
			return;
		}
		if (!this.annotationMode) {
			this.annotationMode = true;
			this.refreshStatus("Annotation mode enabled");
		}
		if (this.shouldApplyStyleToSelection()) {
			this.applyColorToSelection(this.currentColor);
			this.applyWidthToSelection(this.getActiveWidth());
		}
		this.persistToolDefaults();
		this.applyOverlayMode();
		this.refreshToolbar();
		this.refreshStatus(`Preset: ${this.toolState.allPresets.find((preset) => preset.id === presetId)?.label ?? "Custom"}`);
	}

	private setSelectionMode(mode: SelectionMode): void {
		this.toolState.setSelectionMode(mode);
		this.persistToolDefaults();
		if (mode !== "lasso") {
			this.currentLasso = null;
		}
		this.drawAllAnnotations();
		this.refreshToolbar();
	}

	private persistToolDefaults(): void {
		this.plugin.updateToolPreferences(this.toolState.snapshot, this.toolState.presetsSnapshot);
	}

	private getAppendedPages(): NotebookPage[] {
		if (!this.annotationDocument) {
			return [];
		}
		if (!Array.isArray(this.annotationDocument.appendedPages)) {
			this.annotationDocument.appendedPages = [];
		}
		return this.annotationDocument.appendedPages;
	}

	private getTemporarySidecarPageCount(): number {
		return this.annotationDocument?.appendedPages?.length ?? 0;
	}

	private getDeletedPdfPages(): number[] {
		if (!this.annotationDocument) {
			return [];
		}
		if (!Array.isArray(this.annotationDocument.deletedPdfPages)) {
			this.annotationDocument.deletedPdfPages = [];
		}
		return this.annotationDocument.deletedPdfPages;
	}

	private isPdfPageDeleted(pageNumber: number, document = this.annotationDocument): boolean {
		return !!document?.deletedPdfPages?.includes(pageNumber);
	}

	private getSyntheticPageIndex(pageNumber = this.currentPage): number {
		return pageNumber > this.realPdfPageCount ? pageNumber - this.realPdfPageCount - 1 : -1;
	}

	private getCurrentSyntheticPage(): NotebookPage | null {
		const index = this.getSyntheticPageIndex();
		return index >= 0 ? this.getAppendedPages()[index] ?? null : null;
	}

	private getSyntheticPageById(pageId: string): { page: NotebookPage; index: number; pageNumber: number } | null {
		const pages = this.getAppendedPages();
		const index = pages.findIndex((page) => page.id === pageId);
		if (index < 0) {
			return null;
		}
		return {
			page: pages[index],
			index,
			pageNumber: this.realPdfPageCount + index + 1
		};
	}

	private getSyntheticPageInsertAfterPdfPage(page: NotebookPage): number {
		const rawAnchor = typeof page.insertAfterPdfPage === "number" ? page.insertAfterPdfPage : this.realPdfPageCount;
		return clamp(Math.round(rawAnchor), 0, Math.max(0, this.realPdfPageCount));
	}

	private findSyntheticInsertIndexAfterPdfPage(pdfPageNumber: number): number {
		const anchor = clamp(Math.round(pdfPageNumber), 0, Math.max(0, this.realPdfPageCount));
		const pages = this.getAppendedPages();
		let lastMatchingIndex = -1;
		for (let index = 0; index < pages.length; index += 1) {
			const pageAnchor = this.getSyntheticPageInsertAfterPdfPage(pages[index]);
			if (pageAnchor === anchor) {
				lastMatchingIndex = index;
			}
			if (lastMatchingIndex < 0 && pageAnchor > anchor) {
				return index;
			}
		}
		return lastMatchingIndex >= 0 ? lastMatchingIndex + 1 : pages.length;
	}

	private findFirstSyntheticInsertIndexAfterPdfPage(pdfPageNumber: number): number {
		const anchor = clamp(Math.round(pdfPageNumber), 0, Math.max(0, this.realPdfPageCount));
		const pages = this.getAppendedPages();
		for (let index = 0; index < pages.length; index += 1) {
			const pageAnchor = this.getSyntheticPageInsertAfterPdfPage(pages[index]);
			if (pageAnchor >= anchor) {
				return index;
			}
		}
		return pages.length;
	}

	private getCurrentPageButtonLabel(): string {
		const page = this.getCurrentSyntheticPage();
		if (!page) {
			return `Page ${this.currentPage}`;
		}
		const title = page.title.trim() || `Page ${this.currentPage}`;
		return title.length > 18 ? `${title.slice(0, 17)}...` : title;
	}

	private getCurrentPageButtonTitle(): string {
		const page = this.getCurrentSyntheticPage();
		if (!page) {
			return `Copy link to PDF page ${this.currentPage}`;
		}
		return `Added page ${this.currentPage}: ${page.title} (${getNotebookTemplateLabel(page.template)}, ${getNotebookPageSizeLabel(page.pageSize)})`;
	}

	private getPageMenuAnchor(): HTMLElement | null {
		return this.toolbarEl?.querySelector<HTMLElement>(".pdf-native-annotator-page-menu-button")
			?? this.toolbarEl?.querySelector<HTMLElement>(".pdf-native-annotator-page-chip")
			?? this.toolbarEl;
	}

	private getMixedPageCount(): number {
		return Math.max(this.realPdfPageCount, 0) + this.getAppendedPages().length;
	}

	private getAnnotationCountForPage(pageNumber: number, document = this.annotationDocument): number {
		return this.getAnnotationBreakdownForPage(pageNumber, document).total;
	}

	private getAnnotationBreakdownForPage(pageNumber: number, document = this.annotationDocument): { strokes: number; text: number; shapes: number; images: number; total: number } {
		const strokes = document?.strokes.filter((stroke) => stroke.page === pageNumber).length ?? 0;
		const text = document?.textItems.filter((item) => item.page === pageNumber).length ?? 0;
		const shapes = document?.shapes.filter((shape) => shape.page === pageNumber).length ?? 0;
		const images = document?.imageItems?.filter((image) => image.page === pageNumber).length ?? 0;
		return {
			strokes,
			text,
			shapes,
			images,
			total: strokes + text + shapes + images
		};
	}

	private formatAnnotationCount(pageNumber: number): string {
		const count = this.getAnnotationBreakdownForPage(pageNumber).total;
		if (count === 0) {
			return "No annotations";
		}
		return count === 1 ? "1 annotation" : `${count} annotations`;
	}

	private formatAnnotationBreakdown(pageNumber: number, document = this.annotationDocument): string {
		const breakdown = this.getAnnotationBreakdownForPage(pageNumber, document);
		if (breakdown.total === 0) {
			return "No annotations";
		}
		return `${breakdown.total} total, ${breakdown.strokes} ink, ${breakdown.text} text, ${breakdown.shapes} shapes, ${breakdown.images} images`;
	}

	private getSyntheticPageForPageNumber(pageNumber: number): NotebookPage | null {
		const index = this.getSyntheticPageIndex(pageNumber);
		return index >= 0 ? this.getAppendedPages()[index] ?? null : null;
	}

	private getMixedPageEntries(document = this.annotationDocument): MixedPageEntry[] {
		const entries: MixedPageEntry[] = [];
		const addedEntriesByAnchor = new Map<number, MixedPageEntry[]>();
		const appendedPages = document?.appendedPages ?? [];
		appendedPages.forEach((page, index) => {
			const pageNumber = this.realPdfPageCount + index + 1;
			const annotationCount = this.getAnnotationCountForPage(pageNumber, document);
			const insertAfter = this.getSyntheticPageInsertAfterPdfPage(page);
			const group = addedEntriesByAnchor.get(insertAfter) ?? [];
			group.push({
				pageNumber,
				label: page.title.trim() || `Added page ${index + 1}`,
				detail: `${getNotebookTemplateLabel(page.template)} - ${getNotebookPageSizeLabel(page.pageSize)} - ${page.title.trim() || `Added page ${index + 1}`}`,
				isAdded: true,
				annotationCount,
				pageId: page.id,
				template: page.template,
				pageSize: page.pageSize,
				paperColor: page.paperColor
			});
			addedEntriesByAnchor.set(insertAfter, group);
		});
		entries.push(...(addedEntriesByAnchor.get(0) ?? []));
		for (let pageNumber = 1; pageNumber <= this.realPdfPageCount; pageNumber += 1) {
			if (this.isPdfPageDeleted(pageNumber, document)) {
				entries.push(...(addedEntriesByAnchor.get(pageNumber) ?? []));
				continue;
			}
			const annotationCount = this.getAnnotationCountForPage(pageNumber, document);
			entries.push({
				pageNumber,
				label: `Page ${pageNumber}`,
				detail: `PDF page - Page ${pageNumber}`,
				isAdded: false,
				annotationCount
			});
			entries.push(...(addedEntriesByAnchor.get(pageNumber) ?? []));
		}
		return entries;
	}

	private canNavigateMixedPage(direction: -1 | 1): boolean {
		const entries = this.getMixedPageEntries();
		const index = entries.findIndex((entry) => entry.pageNumber === this.currentPage);
		const nextIndex = index + direction;
		return index >= 0 && nextIndex >= 0 && nextIndex < entries.length;
	}

	private navigateMixedPage(direction: -1 | 1): void {
		const entries = this.getMixedPageEntries();
		if (entries.length === 0) {
			return;
		}
		const index = entries.findIndex((entry) => entry.pageNumber === this.currentPage);
		const nextEntry = entries[clamp((index >= 0 ? index : 0) + direction, 0, entries.length - 1)];
		if (!nextEntry || nextEntry.pageNumber === this.currentPage) {
			return;
		}
		this.goToMixedPage(nextEntry.pageNumber);
	}

	private goToMixedPage(pageNumber: number): void {
		const totalPages = this.getMixedPageCount();
		if (totalPages <= 0) {
			return;
		}
		const nextPage = clamp(Math.round(pageNumber), 1, totalPages);
		this.currentPage = nextPage;
		const surface = this.pageSurfaces.get(nextPage);
		if (surface) {
			surface.pageEl.scrollIntoView({ block: "center", behavior: "smooth" });
		} else {
			this.scheduleSyncPages();
		}
		this.refreshToolbar();
		this.refreshStatus(this.getCurrentSyntheticPage() ? `Added page ${nextPage}` : `PDF page ${nextPage}`);
	}

	hasCurrentAddedPage(): boolean {
		return !!this.getCurrentSyntheticPage();
	}

	addTemplatePageBeforeCurrent(): void {
		this.insertTemplatePageBeforeCurrent();
	}

	addTemplatePageAfterCurrent(): void {
		this.insertTemplatePageAfterCurrent();
	}

	addTemplatePageToEnd(): void {
		this.insertTemplatePageAtEnd();
	}

	duplicateCurrentAddedPage(includeAnnotations = true): void {
		this.duplicateCurrentTemplatePage(includeAnnotations);
	}

	clearCurrentAddedPageContents(): void {
		this.clearCurrentTemplatePageContents();
	}

	deleteCurrentAddedPage(): void {
		this.deleteCurrentTemplatePage();
	}

	deleteCurrentPage(): void {
		if (this.getCurrentSyntheticPage()) {
			this.deleteCurrentTemplatePage();
			return;
		}
		this.deleteCurrentPdfPageFromSession();
	}

	canNavigatePage(direction: -1 | 1): boolean {
		return this.canNavigateMixedPage(direction);
	}

	goToPreviousPage(): void {
		this.navigateMixedPage(-1);
	}

	goToNextPage(): void {
		this.navigateMixedPage(1);
	}

	openMixedPageList(): void {
		const anchor = this.getPageMenuAnchor();
		if (!anchor) {
			new Notice("The PDF toolbar is not ready yet.");
			return;
		}
		this.openPageListPopover(anchor);
	}

	openGoToPage(): void {
		const anchor = this.getPageMenuAnchor();
		if (!anchor) {
			new Notice("The PDF toolbar is not ready yet.");
			return;
		}
		this.openGoToPagePopover(anchor);
	}

	private renumberTemplatePageTitles(): void {
		this.getAppendedPages().forEach((page, index) => {
			if (/^Page \d+( copy)?$/.test(page.title)) {
				page.title = `Page ${this.realPdfPageCount + index + 1}`;
			}
		});
	}

	private refreshSyntheticPages(targetPageNumber?: number): void {
		this.finishSessionInlineTextEditor(true);
		this.renumberTemplatePageTitles();
		this.syncPages();
		if (targetPageNumber) {
			this.currentPage = targetPageNumber;
			const surface = this.pageSurfaces.get(targetPageNumber);
			if (surface) {
				surface.overlayEl.setCssStyles({ visibility: "visible" });
				surface.pageEl.scrollIntoView({ block: "center", behavior: "smooth" });
				this.resizeOverlay(surface);
				this.applyOverlayMode();
				this.drawPageAnnotations(targetPageNumber);
			}
		}
		this.refreshToolbar();
	}

	private insertTemplatePageAtIndex(insertIndex: number, insertAfterPdfPage?: number | null, options?: NativeInsertPageOptions): void {
		if (!this.annotationDocument) {
			return;
		}
		this.finishSessionInlineTextEditor(true);
		const pages = this.getAppendedPages();
		const boundedInsertIndex = clamp(insertIndex, 0, pages.length);
		const anchor = insertAfterPdfPage === undefined
			? this.realPdfPageCount
			: clamp(Math.round(insertAfterPdfPage ?? this.realPdfPageCount), 0, Math.max(0, this.realPdfPageCount));
		const pageOptions = options ?? {
			title: `Page ${this.realPdfPageCount + pages.length + 1}`,
			template: this.getCurrentSyntheticPage()?.template ?? "ruled",
			pageSize: this.getCurrentSyntheticPage()?.pageSize ?? "a4",
			paperColor: this.getCurrentSyntheticPage()?.paperColor ?? "#fffdf7"
		};
		const nextPage = createTemplateNotebookPage(
			pageOptions.title.trim() || `Page ${this.realPdfPageCount + pages.length + 1}`,
			pageOptions.template,
			pageOptions.pageSize,
			pageOptions.paperColor
		);
		nextPage.insertAfterPdfPage = anchor;
		this.pushHistory();
		const insertedPageNumber = this.realPdfPageCount + boundedInsertIndex + 1;
		this.annotationDocument.strokes = this.annotationDocument.strokes.map((stroke) => stroke.page >= insertedPageNumber ? { ...stroke, page: stroke.page + 1 } : stroke);
		this.annotationDocument.textItems = this.annotationDocument.textItems.map((item) => item.page >= insertedPageNumber ? { ...item, page: item.page + 1 } : item);
		this.annotationDocument.shapes = this.annotationDocument.shapes.map((shape) => shape.page >= insertedPageNumber ? { ...shape, page: shape.page + 1 } : shape);
		this.annotationDocument.imageItems = (this.annotationDocument.imageItems ?? []).map((image) => image.page >= insertedPageNumber ? { ...image, page: image.page + 1 } : image);
		this.selectedTargets = this.selectedTargets.map((target) => target.page >= insertedPageNumber ? { ...target, page: target.page + 1 } : target);
		pages.splice(boundedInsertIndex, 0, nextPage);
		this.currentPage = insertedPageNumber;
		this.annotationMode = true;
		this.markDirtyAndRedraw("Added template page to PDF");
		this.refreshSyntheticPages(insertedPageNumber);
	}

	private insertTemplatePageAtLocation(location: NativeInsertPageLocation, options?: NativeInsertPageOptions): void {
		const insertIndex = clamp(location.insertIndex, 0, this.getAppendedPages().length);
		this.insertTemplatePageAtIndex(insertIndex, location.anchor, options);
	}

	private insertTemplatePageAfterCurrent(): void {
		const currentSyntheticIndex = this.getSyntheticPageIndex();
		if (currentSyntheticIndex >= 0) {
			const currentSyntheticPage = this.getAppendedPages()[currentSyntheticIndex];
			this.insertTemplatePageAtIndex(currentSyntheticIndex + 1, this.getSyntheticPageInsertAfterPdfPage(currentSyntheticPage));
			return;
		}
		const anchor = clamp(this.currentPage, 0, Math.max(0, this.realPdfPageCount));
		this.insertTemplatePageAtIndex(this.findSyntheticInsertIndexAfterPdfPage(anchor), anchor);
	}

	private insertTemplatePageAfterPageId(pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		this.closePageListPopover();
		this.insertTemplatePageAtIndex(target.index + 1, this.getSyntheticPageInsertAfterPdfPage(target.page));
	}

	private openNativeTemplatePageInsertModalAfterPageId(pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		this.closePageListPopover();
		this.openNativeTemplatePageInsertModalAtLocation("after", {
			insertIndex: target.index + 1,
			anchor: this.getSyntheticPageInsertAfterPdfPage(target.page),
			anchorLabel: target.page.title.trim() || `added page ${target.pageNumber}`
		}, {
			title: `Notebook page after ${target.page.title.trim() || `added page ${target.pageNumber}`}`,
			template: target.page.template,
			pageSize: target.page.pageSize,
			paperColor: target.page.paperColor
		});
	}

	private openTemplatePageInsertModalAfterPageId(pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		this.closePageListPopover();
		this.openTemplatePageInsertModalAtLocation("after", {
			insertIndex: target.index + 1,
			anchor: this.getSyntheticPageInsertAfterPdfPage(target.page),
			anchorLabel: target.page.title.trim() || `added page ${target.pageNumber}`
		}, {
			title: `Notebook page after ${target.page.title.trim() || `added page ${target.pageNumber}`}`,
			template: target.page.template,
			pageSize: target.page.pageSize,
			paperColor: target.page.paperColor
		});
	}

	private insertTemplatePageAfterPdfPage(pdfPageNumber: number): void {
		const anchor = clamp(Math.round(pdfPageNumber), 0, Math.max(0, this.realPdfPageCount));
		this.closePageListPopover();
		this.insertTemplatePageAtIndex(this.findSyntheticInsertIndexAfterPdfPage(anchor), anchor);
	}

	private openNativeTemplatePageInsertModalAfterPdfPage(pdfPageNumber: number): void {
		const anchor = clamp(Math.round(pdfPageNumber), 0, Math.max(0, this.realPdfPageCount));
		this.closePageListPopover();
		this.openNativeTemplatePageInsertModalAtLocation("after", {
			insertIndex: this.findFirstSyntheticInsertIndexAfterPdfPage(anchor),
			anchor,
			anchorLabel: `PDF page ${anchor}`
		});
	}

	private openTemplatePageInsertModalAfterPdfPage(pdfPageNumber: number): void {
		const anchor = clamp(Math.round(pdfPageNumber), 0, Math.max(0, this.realPdfPageCount));
		this.closePageListPopover();
		this.openTemplatePageInsertModalAtLocation("after", {
			insertIndex: this.findFirstSyntheticInsertIndexAfterPdfPage(anchor),
			anchor,
			anchorLabel: `PDF page ${anchor}`
		});
	}

	private insertTemplatePageBeforeCurrent(): void {
		const currentSyntheticIndex = this.getSyntheticPageIndex();
		if (currentSyntheticIndex < 0) {
			const anchor = clamp(this.currentPage - 1, 0, Math.max(0, this.realPdfPageCount));
			this.insertTemplatePageAtIndex(this.findSyntheticInsertIndexAfterPdfPage(anchor), anchor);
			return;
		}
		const currentSyntheticPage = this.getAppendedPages()[currentSyntheticIndex];
		this.insertTemplatePageAtIndex(currentSyntheticIndex, this.getSyntheticPageInsertAfterPdfPage(currentSyntheticPage));
	}

	private insertTemplatePageAtEnd(): void {
		this.insertTemplatePageAtIndex(this.getAppendedPages().length, this.realPdfPageCount);
	}

	private addTemplatePageFromToolbar(): void {
		this.insertTemplatePageAfterCurrent();
	}

	private deleteCurrentTemplatePage(): void {
		if (!this.annotationDocument) {
			return;
		}
		this.finishSessionInlineTextEditor(false);
		const pageIndex = this.getSyntheticPageIndex();
		const pages = this.getAppendedPages();
		if (pageIndex < 0 || pageIndex >= pages.length) {
			new Notice("Only added template pages can be deleted here.");
			return;
		}
		const pageNumber = this.realPdfPageCount + pageIndex + 1;
		const title = pages[pageIndex].title;
		this.requestDangerConfirmation(
			"Delete added page?",
			`${title} and its annotations will be removed from this PDF annotation session.`,
			"Delete page",
			() => {
				if (!this.annotationDocument) {
					return;
				}
				this.pushHistory();
				pages.splice(pageIndex, 1);
				this.annotationDocument.strokes = this.annotationDocument.strokes
					.filter((stroke) => stroke.page !== pageNumber)
					.map((stroke) => stroke.page > pageNumber ? { ...stroke, page: stroke.page - 1 } : stroke);
				this.annotationDocument.textItems = this.annotationDocument.textItems
					.filter((item) => item.page !== pageNumber)
					.map((item) => item.page > pageNumber ? { ...item, page: item.page - 1 } : item);
				this.annotationDocument.shapes = this.annotationDocument.shapes
					.filter((shape) => shape.page !== pageNumber)
					.map((shape) => shape.page > pageNumber ? { ...shape, page: shape.page - 1 } : shape);
				this.annotationDocument.imageItems = (this.annotationDocument.imageItems ?? [])
					.filter((image) => image.page !== pageNumber)
					.map((image) => image.page > pageNumber ? { ...image, page: image.page - 1 } : image);
				this.selectedTargets = [];
				this.selectedTarget = null;
				this.currentPage = Math.max(1, Math.min(pageNumber, this.realPdfPageCount + pages.length));
				this.markDirtyAndRedraw("Deleted template page");
				this.refreshSyntheticPages(this.currentPage);
			}
		);
	}

	private deleteCurrentPdfPageFromSession(): void {
		if (!this.annotationDocument || this.currentPage < 1 || this.currentPage > this.realPdfPageCount) {
			new Notice("Open a PDF page first.");
			return;
		}
		const pageNumber = this.currentPage;
		if (this.isPdfPageDeleted(pageNumber)) {
			new Notice(`PDF page ${pageNumber} is already hidden from this session.`);
			return;
		}
		this.finishSessionInlineTextEditor(false);
		this.requestDangerConfirmation(
			"Delete PDF page from session?",
			`PDF page ${pageNumber} and its annotations will be hidden from this annotation session and omitted from exported mixed PDFs. The original PDF file will not be overwritten.`,
			"Delete page",
			() => {
				if (!this.annotationDocument) {
					return;
				}
				this.pushHistory();
				const deletedPages = this.getDeletedPdfPages();
				if (!deletedPages.includes(pageNumber)) {
					deletedPages.push(pageNumber);
					deletedPages.sort((a, b) => a - b);
				}
				this.annotationDocument.strokes = this.annotationDocument.strokes.filter((stroke) => stroke.page !== pageNumber);
				this.annotationDocument.textItems = this.annotationDocument.textItems.filter((item) => item.page !== pageNumber);
				this.annotationDocument.shapes = this.annotationDocument.shapes.filter((shape) => shape.page !== pageNumber);
				this.annotationDocument.imageItems = (this.annotationDocument.imageItems ?? []).filter((image) => image.page !== pageNumber);
				this.selectedTargets = [];
				this.selectedTarget = null;
				const entries = this.getMixedPageEntries();
				const nextEntry = entries.find((entry) => entry.pageNumber > pageNumber) ?? entries[entries.length - 1];
				this.currentPage = nextEntry?.pageNumber ?? 1;
				this.markDirtyAndRedraw(`Deleted PDF page ${pageNumber} from session`);
				this.syncPages();
				this.goToMixedPage(this.currentPage);
			}
		);
	}

	private deleteAddedPageById(pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		this.closePageListPopover();
		this.currentPage = target.pageNumber;
		this.deleteCurrentTemplatePage();
	}

	private duplicateCurrentTemplatePage(includeAnnotations = true): void {
		if (!this.annotationDocument) {
			return;
		}
		this.finishSessionInlineTextEditor(true);
		const pageIndex = this.getSyntheticPageIndex();
		const pages = this.getAppendedPages();
		if (pageIndex < 0 || pageIndex >= pages.length) {
			new Notice("Only added template pages can be duplicated here.");
			return;
		}
		const sourcePage = pages[pageIndex];
		const insertIndex = pageIndex + 1;
		const sourcePageNumber = this.realPdfPageCount + pageIndex + 1;
		const insertedPageNumber = this.realPdfPageCount + insertIndex + 1;
		const sourceStrokes = this.annotationDocument.strokes.filter((stroke) => stroke.page === sourcePageNumber);
		const sourceTextItems = this.annotationDocument.textItems.filter((item) => item.page === sourcePageNumber);
		const sourceShapes = this.annotationDocument.shapes.filter((shape) => shape.page === sourcePageNumber);
		const sourceImages = (this.annotationDocument.imageItems ?? []).filter((image) => image.page === sourcePageNumber);
		this.pushHistory();
		this.annotationDocument.strokes = this.annotationDocument.strokes.map((stroke) => stroke.page >= insertedPageNumber ? { ...stroke, page: stroke.page + 1 } : stroke);
		this.annotationDocument.textItems = this.annotationDocument.textItems.map((item) => item.page >= insertedPageNumber ? { ...item, page: item.page + 1 } : item);
		this.annotationDocument.shapes = this.annotationDocument.shapes.map((shape) => shape.page >= insertedPageNumber ? { ...shape, page: shape.page + 1 } : shape);
		this.annotationDocument.imageItems = (this.annotationDocument.imageItems ?? []).map((image) => image.page >= insertedPageNumber ? { ...image, page: image.page + 1 } : image);
		const nextPage: NotebookPage = {
			...sourcePage,
			id: generateId("page"),
			title: `${sourcePage.title} copy`,
			strokes: [],
			textItems: [],
			shapes: [],
			imageItems: []
		};
		pages.splice(insertIndex, 0, nextPage);
		if (includeAnnotations) {
			const clonedAnnotations = cloneAnnotationsForPage(sourceStrokes, sourceTextItems, sourceShapes, insertedPageNumber);
			this.annotationDocument.strokes.push(...clonedAnnotations.strokes);
			this.annotationDocument.textItems.push(...clonedAnnotations.textItems);
			this.annotationDocument.shapes.push(...clonedAnnotations.shapes);
			if (!Array.isArray(this.annotationDocument.imageItems)) {
				this.annotationDocument.imageItems = [];
			}
			this.annotationDocument.imageItems.push(...sourceImages.map((image) => ({
				...JSON.parse(JSON.stringify(image)) as ImageAnnotation,
				id: generateId("image"),
				page: insertedPageNumber,
				zIndex: this.getNextPageZIndex(insertedPageNumber)
			})));
		}
		this.selectedTargets = [];
		this.selectedTarget = null;
		this.currentPage = insertedPageNumber;
		this.markDirtyAndRedraw(includeAnnotations ? "Duplicated added page" : "Duplicated page structure");
		this.refreshSyntheticPages(insertedPageNumber);
	}

	private duplicateAddedPageById(pageId: string, includeAnnotations = true): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		this.closePageListPopover();
		this.currentPage = target.pageNumber;
		this.duplicateCurrentTemplatePage(includeAnnotations);
	}

	private clearCurrentTemplatePageContents(): void {
		if (!this.annotationDocument) {
			return;
		}
		this.finishSessionInlineTextEditor(false);
		const pageIndex = this.getSyntheticPageIndex();
		const pages = this.getAppendedPages();
		if (pageIndex < 0 || pageIndex >= pages.length) {
			new Notice("Only added template pages can be cleared here.");
			return;
		}
		const page = pages[pageIndex];
		const pageNumber = this.realPdfPageCount + pageIndex + 1;
		const hasContents =
			this.annotationDocument.strokes.some((stroke) => stroke.page === pageNumber) ||
			this.annotationDocument.textItems.some((item) => item.page === pageNumber) ||
			this.annotationDocument.shapes.some((shape) => shape.page === pageNumber) ||
			(this.annotationDocument.imageItems ?? []).some((image) => image.page === pageNumber);
		if (!hasContents) {
			return;
		}
		this.requestDangerConfirmation(
			"Clear added page?",
			`All annotations on ${page.title} will be removed, but the page itself will stay.`,
			"Clear page",
			() => {
				if (!this.annotationDocument) {
					return;
				}
				this.pushHistory();
				this.annotationDocument.strokes = this.annotationDocument.strokes.filter((stroke) => stroke.page !== pageNumber);
				this.annotationDocument.textItems = this.annotationDocument.textItems.filter((item) => item.page !== pageNumber);
				this.annotationDocument.shapes = this.annotationDocument.shapes.filter((shape) => shape.page !== pageNumber);
				this.annotationDocument.imageItems = (this.annotationDocument.imageItems ?? []).filter((image) => image.page !== pageNumber);
				this.selectedTargets = [];
				this.selectedTarget = null;
				this.markDirtyAndRedraw("Cleared added page");
				this.refreshSyntheticPages(pageNumber);
			}
		);
	}

	private clearAddedPageById(pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		this.closePageListPopover();
		this.currentPage = target.pageNumber;
		this.clearCurrentTemplatePageContents();
	}

	private setCurrentTemplatePageTemplate(template: NotebookTemplate): void {
		const page = this.getCurrentSyntheticPage();
		if (!page || page.template === template) {
			return;
		}
		this.pushHistory();
		page.template = template;
		this.markDirtyAndRedraw(`Template changed to ${template}`);
		this.refreshSyntheticPages(this.currentPage);
	}

	private setCurrentTemplatePageSize(pageSize: NotebookPageSize): void {
		const page = this.getCurrentSyntheticPage();
		if (!page || page.pageSize === pageSize) {
			return;
		}
		this.pushHistory();
		page.pageSize = pageSize;
		this.markDirtyAndRedraw(`Page size changed to ${pageSize}`);
		this.refreshSyntheticPages(this.currentPage);
	}

	private cycleAddedPageTemplateById(pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		const templates: NotebookTemplate[] = ["blank", "ruled", "grid", "dot"];
		const currentIndex = templates.indexOf(target.page.template);
		const nextTemplate = templates[(currentIndex + 1 + templates.length) % templates.length];
		this.pushHistory();
		target.page.template = nextTemplate;
		this.markDirtyAndRedraw(`Template changed to ${getNotebookTemplateLabel(nextTemplate)}`);
		this.refreshSyntheticPages(target.pageNumber);
	}

	private cycleAddedPageSizeById(pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		const sizes: NotebookPageSize[] = ["a4", "letter", "compact", "long"];
		const currentIndex = sizes.indexOf(target.page.pageSize);
		const nextSize = sizes[(currentIndex + 1 + sizes.length) % sizes.length];
		this.pushHistory();
		target.page.pageSize = nextSize;
		this.markDirtyAndRedraw(`Page size changed to ${getNotebookPageSizeLabel(nextSize)}`);
		this.refreshSyntheticPages(target.pageNumber);
	}

	private cycleAddedPagePaperColorById(pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		const colors = PAPER_COLOR_PRESETS.map((preset) => preset.color);
		const currentIndex = colors.findIndex((color) => color.toLowerCase() === target.page.paperColor.toLowerCase());
		const nextColor = colors[(currentIndex + 1 + colors.length) % colors.length];
		this.pushHistory();
		target.page.paperColor = nextColor;
		this.markDirtyAndRedraw("Paper color changed");
		this.refreshSyntheticPages(target.pageNumber);
	}

	private openNativePageMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		const currentSyntheticPage = this.getCurrentSyntheticPage();
		menu.addItem((item) => item
			.setTitle(`Go to page... (${this.currentPage} of ${Math.max(1, this.getMixedPageCount())})`)
			.setIcon("arrow-right-square")
			.onClick(() => this.openGoToPagePopover(button)));
		menu.addItem((item) => item
			.setTitle("Page list...")
			.setIcon("list")
			.onClick(() => this.openPageListPopover(button)));
		menu.addSeparator();
		if (currentSyntheticPage) {
			menu.addItem((item) => item
				.setTitle(`${currentSyntheticPage.title} (${getNotebookTemplateLabel(currentSyntheticPage.template)}, ${getNotebookPageSizeLabel(currentSyntheticPage.pageSize)})`)
				.setDisabled(true));
			menu.addSeparator();
			menu.addItem((item) => item.setTitle("Add notebook page before...").setIcon("file-plus").onClick(() => this.openTemplatePageInsertModal("before")));
			menu.addItem((item) => item.setTitle("Add notebook page after...").setIcon("file-plus").onClick(() => this.openTemplatePageInsertModal("after")));
			menu.addItem((item) => item.setTitle("Export finished annotated PDF").setIcon("file-output").onClick(() => void this.exportAnnotatedMixedDocumentPdf()));
			menu.addItem((item) => item.setTitle("Create blank annotatable PDF...").setIcon("file-plus-2").onClick(() => this.plugin.openBlankAnnotatablePdfModal()));
		} else {
			menu.addItem((item) => item.setTitle("Add notebook page before current PDF page...").setIcon("file-plus").onClick(() => this.openTemplatePageInsertModal("before")));
			menu.addItem((item) => item.setTitle("Add notebook page after current PDF page...").setIcon("file-plus").onClick(() => this.openTemplatePageInsertModal("after")));
			menu.addItem((item) => item.setTitle("Export finished annotated PDF").setIcon("file-output").onClick(() => void this.exportAnnotatedMixedDocumentPdf()));
			menu.addItem((item) => item.setTitle("Create blank annotatable PDF...").setIcon("file-plus-2").onClick(() => this.plugin.openBlankAnnotatablePdfModal()));
		}
		if (currentSyntheticPage) {
			menu.addSeparator();
			menu.addItem((item) => item.setTitle("Rename added page...").setIcon("pencil").onClick(() => this.openRenameAddedPagePopover(button, currentSyntheticPage.id)));
			menu.addItem((item) => item.setTitle("Duplicate added page").setIcon("copy").onClick(() => this.duplicateCurrentTemplatePage()));
			menu.addItem((item) => item.setTitle("Duplicate structure only").setIcon("copy").onClick(() => this.duplicateCurrentTemplatePage(false)));
			menu.addItem((item) => item.setTitle("Clear page contents").setIcon("eraser").onClick(() => this.clearCurrentTemplatePageContents()));
			menu.addSeparator();
			(["blank", "ruled", "grid", "dot"] as NotebookTemplate[]).forEach((template) => {
				menu.addItem((item) => item
					.setTitle(`Template: ${getNotebookTemplateLabel(template)}`)
					.setChecked(currentSyntheticPage.template === template)
					.onClick(() => this.setCurrentTemplatePageTemplate(template)));
			});
			menu.addSeparator();
			(["a4", "letter", "compact", "long"] as NotebookPageSize[]).forEach((pageSize) => {
				menu.addItem((item) => item
					.setTitle(`Paper size: ${getNotebookPageSizeLabel(pageSize)}`)
					.setChecked(currentSyntheticPage.pageSize === pageSize)
					.onClick(() => this.setCurrentTemplatePageSize(pageSize)));
			});
			menu.addSeparator();
			for (const preset of PAPER_COLOR_PRESETS) {
				menu.addItem((item) => item
					.setTitle(`Paper: ${preset.label}`)
					.setIcon("palette")
					.setChecked(currentSyntheticPage.paperColor.toLowerCase() === preset.color.toLowerCase())
					.onClick(() => this.setCurrentTemplatePageColorValue(preset.color)));
			}
			menu.addItem((item) => item.setTitle("Custom paper color...").setIcon("palette").onClick(() => this.openPaperColorPopover(button)));
			menu.addItem((item) => item.setTitle("Delete current page").setIcon("trash").onClick(() => this.deleteCurrentPage()));
		}
		if (!currentSyntheticPage) {
			menu.addSeparator();
			menu.addItem((item) => item.setTitle("Delete current PDF page from session").setIcon("trash").onClick(() => this.deleteCurrentPage()));
		}
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openGoToPagePopover(anchor: HTMLElement): void {
		const totalPages = this.getMixedPageCount();
		if (totalPages <= 0) {
			return;
		}
		this.closeTransientPopovers("goto");
		this.ensureTransientPopoverBackdrop();
		const popover = document.createElement("div");
		popover.className = "modal pdf-native-annotator-rename-popover pdf-native-annotator-goto-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-color-popover-title", text: "Go to page" });
		title.appendChild(this.createPopoverCloseButton(() => this.closeGoToPagePopover()));
		const form = popover.createEl("form", { cls: "pdf-native-annotator-rename-form" });
		const input = form.createEl("input", {
			type: "number",
			placeholder: `1-${totalPages}`
		});
		input.className = "pdf-native-annotator-rename-input";
		input.min = "1";
		input.max = String(totalPages);
		input.step = "1";
		input.value = String(clamp(this.currentPage, 1, totalPages));
		form.createDiv({ cls: "pdf-native-annotator-popover-hint", text: `${totalPages} pages including added notebook pages` });
		const actions = form.createDiv({ cls: "pdf-native-annotator-confirm-actions" });
		const cancelButton = actions.createEl("button", { type: "button", text: "Cancel" });
		const goButton = actions.createEl("button", { type: "submit", text: "Go", cls: "mod-cta" });
		const commit = (): void => {
			const requestedPage = Number(input.value);
			if (!Number.isFinite(requestedPage) || requestedPage < 1 || requestedPage > totalPages) {
				new Notice(`Enter a page from 1 to ${totalPages}.`);
				return;
			}
			this.closeGoToPagePopover();
			this.goToMixedPage(requestedPage);
		};
		cancelButton.addEventListener("click", () => this.closeGoToPagePopover());
		goButton.addEventListener("pointerdown", (event) => {
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
				this.closeGoToPagePopover();
			}
			event.stopPropagation();
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			commit();
		});
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendTransientPopover(popover);
		this.positionPopoverNearAnchor(popover, anchor);
		this.goToPagePopoverEl = popover;
		window.addEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	private openPageListPopover(anchor: HTMLElement): void {
		const entries = this.getMixedPageEntries();
		if (entries.length === 0) {
			return;
		}
		this.closeTransientPopovers("pagelist");
		this.ensureTransientPopoverBackdrop();
		const popover = document.createElement("div");
		popover.className = "modal pdf-native-annotator-page-list-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-color-popover-title", text: "Pages" });
		title.appendChild(this.createPopoverCloseButton(() => this.closePageListPopover()));
		const countByFilter = {
			all: entries.length,
			annotated: entries.filter((entry) => entry.annotationCount > 0).length,
			added: entries.filter((entry) => entry.isAdded).length,
			pdf: entries.filter((entry) => !entry.isAdded).length
		};
		const overview = popover.createDiv({ cls: "pdf-native-annotator-page-list-overview" });
		overview.createSpan({ text: `${countByFilter.all} pages` });
		overview.createSpan({ text: `${countByFilter.annotated} annotated` });
		overview.createSpan({ text: `${countByFilter.added} added` });
		const filters = popover.createDiv({ cls: "pdf-native-annotator-page-list-filters" });
		const searchWrap = popover.createDiv({ cls: "pdf-native-annotator-page-list-search" });
		const searchInput = searchWrap.createEl("input", {
			type: "search",
			placeholder: "Search pages"
		});
		searchInput.value = this.pageListQuery;
		const summary = popover.createDiv({ cls: "pdf-native-annotator-page-list-summary" });
		const list = popover.createDiv({ cls: "pdf-native-annotator-page-list" });
		let currentFilteredEntries: typeof entries = [];
		const renderList = (): void => {
			list.replaceChildren();
			const filteredEntries = entries.filter((entry) => {
				if (this.pageListFilter === "annotated") {
					return entry.annotationCount > 0;
				}
				if (this.pageListFilter === "added") {
					return entry.isAdded;
				}
				if (this.pageListFilter === "pdf") {
					return !entry.isAdded;
				}
				return true;
			}).filter((entry) => {
				const query = this.pageListQuery.trim().toLowerCase();
				if (!query) {
					return true;
				}
				return String(entry.pageNumber).includes(query) ||
					entry.label.toLowerCase().includes(query) ||
					entry.detail.toLowerCase().includes(query);
			});
			currentFilteredEntries = filteredEntries;
			summary.textContent = `${filteredEntries.length} of ${entries.length} pages - Enter opens first result, Arrow keys move rows`;
			if (filteredEntries.length === 0) {
				list.createDiv({ cls: "pdf-native-annotator-page-list-empty", text: "No pages match this filter." });
				return;
			}
			for (const entry of filteredEntries) {
				const button = document.createElement("div");
				button.className = "menu-item pdf-native-annotator-page-list-item";
				button.setAttribute("role", "button");
				button.setAttribute("aria-label", `${entry.label}. ${entry.detail}`);
				button.tabIndex = 0;
				if (entry.pageNumber === this.currentPage) {
					button.classList.add("is-active", "is-selected");
				}
				if (entry.isAdded) {
					button.classList.add("is-added");
				}
				if (entry.annotationCount > 0) {
					button.classList.add("has-annotations");
				}
				const thumbnail = button.createSpan({ cls: "menu-item-icon pdf-native-annotator-page-list-thumbnail" });
				thumbnail.classList.add(entry.isAdded ? "is-added" : "is-pdf");
				if (entry.template) {
					thumbnail.classList.add(`is-template-${entry.template}`);
				}
				if (entry.paperColor) {
					thumbnail.setCssProps({ "--page-list-paper": entry.paperColor });
				}
				const sheet = thumbnail.createSpan({ cls: "pdf-native-annotator-page-list-thumbnail-sheet" });
				sheet.createSpan({ cls: "pdf-native-annotator-page-list-thumbnail-pattern" });
				if (!entry.isAdded) {
					sheet.createSpan({ cls: "pdf-native-annotator-page-list-thumbnail-pdf", text: "PDF" });
				}
				if (entry.annotationCount > 0) {
					thumbnail.createSpan({ cls: "pdf-native-annotator-page-list-thumbnail-count", text: String(entry.annotationCount) });
				}
				const number = button.createSpan({ cls: "pdf-native-annotator-page-list-number", text: String(entry.pageNumber) });
				number.setAttribute("aria-hidden", "true");
				const text = button.createSpan({ cls: "menu-item-title pdf-native-annotator-page-list-text" });
				text.createSpan({ cls: "pdf-native-annotator-page-list-label", text: entry.label });
				text.createSpan({ cls: "pdf-native-annotator-page-list-detail", text: entry.detail });
				const jump = (): void => {
					this.closePageListPopover();
					this.goToMixedPage(entry.pageNumber);
				};
				button.addEventListener("click", jump);
				button.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						jump();
					}
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						const rows = Array.from(list.querySelectorAll<HTMLElement>(".pdf-native-annotator-page-list-item"));
						const currentIndex = rows.indexOf(button);
						const offset = event.key === "ArrowDown" ? 1 : -1;
						const nextIndex = clamp(currentIndex + offset, 0, rows.length - 1);
						rows[nextIndex]?.focus();
					}
				});
				const actions = button.createSpan({ cls: "menu-item-flair pdf-native-annotator-page-list-actions" });
				actions.addEventListener("click", (event) => event.stopPropagation());
				actions.addEventListener("keydown", (event) => event.stopPropagation());
				const moreButton = this.createPageListActionButton("more-horizontal", `Actions for ${entry.label}`, (event) => {
					const menu = new Menu();
					menu.addItem((item) => item
						.setTitle("Open page")
						.setIcon("arrow-right")
						.onClick(jump));
					menu.addItem((item) => item
						.setTitle("Copy page link")
						.setIcon("link")
						.onClick(() => void this.copyPageLink(entry.pageNumber)));
					menu.addItem((item) => item
						.setTitle("Export page snapshot")
						.setIcon("image-file")
						.onClick(() => void this.exportPageSnapshot(entry.pageNumber)));
					menu.addSeparator();
					if (entry.pageId) {
						menu.addItem((item) => item
							.setTitle("Add notebook page after")
							.setIcon("plus")
							.onClick(() => this.openTemplatePageInsertModalAfterPageId(entry.pageId!)));
						menu.addItem((item) => item
							.setTitle("Rename added page...")
							.setIcon("pencil")
							.onClick(() => this.openRenameAddedPagePopover(anchor, entry.pageId!)));
						menu.addItem((item) => item
							.setTitle("Duplicate added page")
							.setIcon("copy")
							.onClick(() => this.duplicateAddedPageById(entry.pageId!)));
						menu.addSeparator();
						menu.addItem((item) => item
							.setTitle("Cycle page template")
							.setIcon("rows-3")
							.onClick(() => {
								this.cycleAddedPageTemplateById(entry.pageId!);
								renderList();
							}));
						menu.addItem((item) => item
							.setTitle("Cycle page size")
							.setIcon("maximize-2")
							.onClick(() => {
								this.cycleAddedPageSizeById(entry.pageId!);
								renderList();
							}));
						menu.addItem((item) => item
							.setTitle("Cycle paper color")
							.setIcon("palette")
							.onClick(() => {
								this.cycleAddedPagePaperColorById(entry.pageId!);
								renderList();
							}));
						menu.addSeparator();
						menu.addItem((item) => item
							.setTitle("Clear added page")
							.setIcon("eraser")
							.onClick(() => this.clearAddedPageById(entry.pageId!)));
						menu.addItem((item) => item
							.setTitle("Delete added page")
							.setIcon("trash")
							.onClick(() => this.deleteAddedPageById(entry.pageId!)));
					} else {
						menu.addItem((item) => item
							.setTitle("Add notebook page after this PDF page")
							.setIcon("plus")
							.onClick(() => this.openTemplatePageInsertModalAfterPdfPage(entry.pageNumber)));
						menu.addItem((item) => item
							.setTitle("Delete PDF page from session")
							.setIcon("trash")
							.onClick(() => {
								this.closePageListPopover();
								this.currentPage = entry.pageNumber;
								this.deleteCurrentPage();
							}));
					}
					menu.showAtMouseEvent(event);
				});
				actions.append(moreButton);
				list.appendChild(button);
			}
		};
		const renderFilters = (): void => {
			filters.replaceChildren();
			for (const filter of [
				{ id: "all", label: "All", count: countByFilter.all },
				{ id: "annotated", label: "Annotated", count: countByFilter.annotated },
				{ id: "added", label: "Added", count: countByFilter.added },
				{ id: "pdf", label: "PDF", count: countByFilter.pdf }
			] as const) {
				const button = filters.createEl("button", { type: "button" });
				button.className = "pdf-native-annotator-page-list-filter";
				button.createSpan({ text: filter.label });
				if (this.pageListFilter === filter.id) {
					button.classList.add("is-active");
				}
				button.addEventListener("click", () => {
					this.pageListFilter = filter.id;
					renderFilters();
					renderList();
				});
			}
		};
		searchInput.addEventListener("input", () => {
			this.pageListQuery = searchInput.value;
			renderList();
		});
		searchInput.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				if (searchInput.value) {
					event.preventDefault();
					this.pageListQuery = "";
					searchInput.value = "";
					renderList();
					return;
				}
				this.closePageListPopover();
			}
			if (event.key === "Enter" && currentFilteredEntries.length > 0) {
				event.preventDefault();
				this.closePageListPopover();
				this.goToMixedPage(currentFilteredEntries[0].pageNumber);
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				list.querySelector<HTMLElement>(".pdf-native-annotator-page-list-item")?.focus();
			}
		});
		renderFilters();
		renderList();
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendTransientPopover(popover);
		this.positionPopoverNearAnchor(popover, anchor, "left");
		this.pageListPopoverEl = popover;
		window.addEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
		window.setTimeout(() => list.querySelector<HTMLElement>(".pdf-native-annotator-page-list-item.is-active")?.scrollIntoView({ block: "nearest" }), 0);
	}

	private openPaperColorPopover(anchor: HTMLElement): void {
		const page = this.getCurrentSyntheticPage();
		if (!page) {
			return;
		}
		this.closeTransientPopovers("paper");
		this.ensureTransientPopoverBackdrop();
		const popover = document.createElement("div");
		popover.className = "modal pdf-native-annotator-color-popover pdf-native-annotator-paper-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-color-popover-title", text: "Paper color" });
		title.appendChild(this.createPopoverCloseButton(() => this.closePaperColorPopover()));
		const swatches = popover.createDiv({ cls: "pdf-native-annotator-color-popover-swatches" });
		for (const preset of PAPER_COLOR_PRESETS) {
			const swatch = document.createElement("button");
			swatch.type = "button";
			swatch.className = "pdf-native-annotator-swatch";
			swatch.title = preset.label;
			swatch.setAttribute("aria-label", `${preset.label} paper`);
			if (page.paperColor.toLowerCase() === preset.color.toLowerCase()) {
				swatch.classList.add("is-active");
			}
			const inner = swatch.createSpan({ cls: "pdf-native-annotator-swatch-inner" });
			inner.setCssStyles({ backgroundColor: preset.color });
			swatch.addEventListener("click", () => {
				this.setCurrentTemplatePageColorValue(preset.color);
				this.closePaperColorPopover();
			});
			swatches.appendChild(swatch);
		}
		const customRow = popover.createDiv({ cls: "pdf-native-annotator-color-popover-custom" });
		customRow.createSpan({ text: "Custom" });
		const colorInput = document.createElement("input");
		colorInput.type = "color";
		colorInput.value = page.paperColor;
		colorInput.className = "pdf-native-annotator-color";
		let historyCaptured = false;
		colorInput.addEventListener("input", () => {
			if (!historyCaptured) {
				this.pushHistory();
				historyCaptured = true;
			}
			this.setCurrentTemplatePageColorValue(colorInput.value, false);
		});
		colorInput.addEventListener("change", () => {
			this.closePaperColorPopover();
		});
		customRow.appendChild(colorInput);
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendTransientPopover(popover);
		this.positionPopoverNearAnchor(popover, anchor);
		this.paperColorPopoverEl = popover;
		window.addEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
	}

	private openRenameAddedPagePopover(anchor: HTMLElement, pageId: string): void {
		const target = this.getSyntheticPageById(pageId);
		if (!target) {
			new Notice("That added page is no longer available.");
			return;
		}
		const anchorRect = anchor.getBoundingClientRect();
		this.closeTransientPopovers("rename");
		this.ensureTransientPopoverBackdrop();
		const popover = document.createElement("div");
		popover.className = "modal pdf-native-annotator-rename-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-color-popover-title", text: "Page name" });
		title.appendChild(this.createPopoverCloseButton(() => this.closeRenamePopover()));
		const form = popover.createEl("form", { cls: "pdf-native-annotator-rename-form" });
		const input = form.createEl("input", {
			type: "text",
			placeholder: "Page name"
		});
		input.value = target.page.title;
		input.className = "pdf-native-annotator-rename-input";
		const actions = form.createDiv({ cls: "pdf-native-annotator-confirm-actions" });
		const cancelButton = actions.createEl("button", { type: "button", text: "Cancel" });
		const saveButton = actions.createEl("button", { type: "submit", text: "Save", cls: "mod-cta" });
		const commitRename = (): void => {
			this.renameAddedPage(pageId, input.value);
		};
		cancelButton.addEventListener("click", () => this.closeRenamePopover());
		saveButton.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			commitRename();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commitRename();
			}
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeRenamePopover();
			}
			event.stopPropagation();
		});
		input.addEventListener("change", commitRename);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			commitRename();
		});
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendTransientPopover(popover);
		this.positionPopoverNearRect(popover, anchorRect);
		this.renamePopoverEl = popover;
		window.addEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	private renameAddedPage(pageId: string, rawTitle: string): boolean {
		const target = this.getSyntheticPageById(pageId);
		const title = rawTitle.trim();
		if (!target) {
			new Notice("That added page is no longer available.");
			this.closeRenamePopover();
			return false;
		}
		if (!title) {
			new Notice("Page name cannot be empty.");
			return false;
		}
		if (title === target.page.title) {
			this.closeRenamePopover();
			return false;
		}
		this.pushHistory();
		target.page.title = title;
		this.currentPage = target.pageNumber;
		this.markDirtyAndRedraw("Renamed added page");
		this.refreshSyntheticPages(target.pageNumber);
		this.closeRenamePopover();
		new Notice(`Renamed page to "${title}"`);
		return true;
	}

	private showMenuBelowAnchor(menu: Menu, anchor: HTMLElement): void {
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openCurrentAddedPageTemplateMenu(anchor: HTMLElement): void {
		const page = this.getCurrentSyntheticPage();
		if (!page) {
			new Notice("Open an added template page first.");
			return;
		}
		const menu = new Menu();
		menu.addItem((item) => item
			.setTitle("Template")
			.setIcon("rows-3")
			.setDisabled(true));
		menu.addSeparator();
		(["blank", "ruled", "grid", "dot"] as NotebookTemplate[]).forEach((template) => {
			menu.addItem((item) => item
				.setTitle(getNotebookTemplateLabel(template))
				.setChecked(page.template === template)
				.onClick(() => this.setCurrentTemplatePageTemplate(template)));
		});
		this.showMenuBelowAnchor(menu, anchor);
	}

	private openCurrentAddedPageSizeMenu(anchor: HTMLElement): void {
		const page = this.getCurrentSyntheticPage();
		if (!page) {
			new Notice("Open an added template page first.");
			return;
		}
		const menu = new Menu();
		menu.addItem((item) => item
			.setTitle("Paper size")
			.setIcon("maximize-2")
			.setDisabled(true));
		menu.addSeparator();
		(["a4", "letter", "compact", "long"] as NotebookPageSize[]).forEach((pageSize) => {
			menu.addItem((item) => item
				.setTitle(getNotebookPageSizeLabel(pageSize))
				.setChecked(page.pageSize === pageSize)
				.onClick(() => this.setCurrentTemplatePageSize(pageSize)));
		});
		this.showMenuBelowAnchor(menu, anchor);
	}

	private openCurrentAddedPagePaperColorMenu(anchor: HTMLElement): void {
		const page = this.getCurrentSyntheticPage();
		if (!page) {
			new Notice("Open an added template page first.");
			return;
		}
		const menu = new Menu();
		menu.addItem((item) => item
			.setTitle("Paper color")
			.setIcon("palette")
			.setDisabled(true));
		menu.addSeparator();
		for (const preset of PAPER_COLOR_PRESETS) {
			menu.addItem((item) => item
				.setTitle(preset.label)
				.setIcon("palette")
				.setChecked(page.paperColor.toLowerCase() === preset.color.toLowerCase())
				.onClick(() => this.setCurrentTemplatePageColorValue(preset.color)));
		}
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle("Custom color...")
			.setIcon("palette")
			.onClick(() => this.openPaperColorPopover(anchor)));
		this.showMenuBelowAnchor(menu, anchor);
	}

	private openDocumentActionsMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		const currentSyntheticPage = this.getCurrentSyntheticPage();
		menu.addItem((item) => item
			.setTitle(`Go to mixed page... (${this.currentPage} of ${Math.max(1, this.getMixedPageCount())})`)
			.setIcon("arrow-right-square")
			.onClick(() => this.openGoToPagePopover(button)));
		menu.addItem((item) => item
			.setTitle("Open mixed page list...")
			.setIcon("list")
			.onClick(() => this.openPageListPopover(button)));
		menu.addItem((item) => item
			.setTitle("Create blank annotatable PDF...")
			.setIcon("file-plus-2")
			.onClick(() => this.plugin.openBlankAnnotatablePdfModal()));
		menu.addItem((item) => item
			.setTitle("Insert photo...")
			.setIcon("image-file")
			.onClick(() => void this.insertPhotoOnCurrentPage()));
		if (!this.plugin.shouldShowRegionToolbarButton()) {
			menu.addItem((item) => item
				.setTitle("Use region embed tool")
				.setIcon("crop")
				.onClick(() => {
					this.setActiveTool("region");
					this.applyOverlayMode();
					this.refreshToolbar();
					this.refreshStatus("Region tool: drag a crop box, then Copy embed");
				}));
		}
		if (currentSyntheticPage) {
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle(`${currentSyntheticPage.title} (${getNotebookTemplateLabel(currentSyntheticPage.template)}, ${getNotebookPageSizeLabel(currentSyntheticPage.pageSize)})`)
				.setDisabled(true));
			menu.addItem((item) => item.setTitle("Rename added page...").setIcon("pencil").onClick(() => this.openRenameAddedPagePopover(button, currentSyntheticPage.id)));
			menu.addItem((item) => item.setTitle("Add notebook page before...").setIcon("file-plus").onClick(() => this.openTemplatePageInsertModal("before")));
			menu.addItem((item) => item.setTitle("Add notebook page after...").setIcon("file-plus").onClick(() => this.openTemplatePageInsertModal("after")));
			menu.addItem((item) => item.setTitle("Duplicate added page").setIcon("copy").onClick(() => this.duplicateCurrentTemplatePage()));
			menu.addItem((item) => item.setTitle("Duplicate structure only").setIcon("copy").onClick(() => this.duplicateCurrentTemplatePage(false)));
			menu.addItem((item) => item.setTitle("Clear added page contents").setIcon("eraser").onClick(() => this.clearCurrentTemplatePageContents()));
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle(`Template... (${getNotebookTemplateLabel(currentSyntheticPage.template)})`)
				.setIcon("rows-3")
				.onClick(() => this.openCurrentAddedPageTemplateMenu(button)));
			menu.addItem((item) => item
				.setTitle(`Paper size... (${getNotebookPageSizeLabel(currentSyntheticPage.pageSize)})`)
				.setIcon("maximize-2")
				.onClick(() => this.openCurrentAddedPageSizeMenu(button)));
			const currentPaper = PAPER_COLOR_PRESETS.find((preset) => preset.color.toLowerCase() === currentSyntheticPage.paperColor.toLowerCase())?.label ?? "Custom";
			menu.addItem((item) => item
				.setTitle(`Paper color... (${currentPaper})`)
				.setIcon("palette")
				.onClick(() => this.openCurrentAddedPagePaperColorMenu(button)));
			menu.addItem((item) => item.setTitle("Delete current page").setIcon("trash").onClick(() => this.deleteCurrentPage()));
		}
		if (!currentSyntheticPage) {
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle("Add notebook page before current PDF page...")
				.setIcon("file-plus")
				.onClick(() => this.openTemplatePageInsertModal("before")));
			menu.addItem((item) => item
				.setTitle("Add notebook page after current PDF page...")
				.setIcon("file-plus")
				.onClick(() => this.openTemplatePageInsertModal("after")));
			menu.addItem((item) => item
				.setTitle("Delete current PDF page from session")
				.setIcon("trash")
				.onClick(() => this.deleteCurrentPage()));
		}
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle("Open annotation data JSON")
			.setIcon("database")
			.onClick(() => void this.openAnnotationDataJson()));
		if (this.shouldShowRelinkAnnotationDataAction()) {
			menu.addItem((item) => item
				.setTitle("Relink annotation data to this PDF")
				.setIcon("replace")
				.onClick(() => void this.relinkAnnotationDataToCurrentPdf()));
		}
		menu.addItem((item) => item
			.setTitle("Copy current page link")
			.setIcon("link")
			.onClick(() => void this.copyCurrentPageLink()));
		menu.addItem((item) => item
			.setTitle("Copy annotated page embed")
			.setIcon("code")
			.onClick(() => void this.copyCurrentPageEmbedBlock()));
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle("Export current page snapshot")
			.setIcon("image-file")
			.onClick(() => void this.exportCurrentPageSnapshot()));
		menu.addItem((item) => item
			.setTitle("Export annotated mixed PDF")
			.setIcon("file-output")
			.onClick(() => void this.exportAnnotatedMixedDocumentPdf()));
		menu.addItem((item) => item
			.setTitle("Advanced: create native mixed working PDF")
			.setIcon("file-plus-2")
			.onClick(() => void this.materializeNativeMixedWorkingPdf()));
		if (this.selectedTargets.length > 0) {
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle("Copy selection")
				.setIcon("copy")
				.onClick(() => this.copySelectedTargets()));
			menu.addItem((item) => item
				.setTitle("Duplicate selection")
				.setIcon("copy-plus")
				.onClick(() => this.duplicateSelectedTargets()));
			menu.addItem((item) => item
				.setTitle("Delete selection")
				.setIcon("trash")
				.onClick(() => this.deleteSelectedTargets()));
		}
		if (this.plugin.hasClipboard()) {
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle("Paste copied annotations")
				.setIcon("clipboard")
				.onClick(() => this.pasteClipboard()));
		}
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openAddPageMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		menu.addItem((item) => item
			.setTitle("Add notebook page after current...")
			.setIcon("file-plus")
			.onClick(() => this.openTemplatePageInsertModal("after")));
		menu.addItem((item) => item
			.setTitle("Add notebook page before current...")
			.setIcon("file-plus")
			.onClick(() => this.openTemplatePageInsertModal("before")));
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle("Quick add after current")
			.setIcon("plus")
			.onClick(() => this.insertTemplatePageAfterCurrent()));
		menu.addItem((item) => item
			.setTitle("Quick add before current")
			.setIcon("plus")
			.onClick(() => this.insertTemplatePageBeforeCurrent()));
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle("Export finished annotated PDF")
			.setIcon("file-output")
			.onClick(() => void this.exportAnnotatedMixedDocumentPdf()));
		menu.addItem((item) => item
			.setTitle("Create blank annotatable PDF...")
			.setIcon("file-plus-2")
			.onClick(() => this.plugin.openBlankAnnotatablePdfModal()));
		menu.addItem((item) => item
			.setTitle("Insert photo...")
			.setIcon("image-file")
			.onClick(() => void this.insertPhotoOnCurrentPage()));
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private requestDangerConfirmation(title: string, message: string, confirmText: string, onConfirm: () => void): void {
		this.closeConfirmPopover();
		this.ensureTransientPopoverBackdrop();
		const popover = document.createElement("div");
		popover.className = "modal pdf-native-annotator-confirm-popover";
		const header = popover.createDiv({ cls: "pdf-native-annotator-confirm-title" });
		setIcon(header.createSpan({ cls: "pdf-native-annotator-confirm-icon" }), "triangle-alert");
		header.createSpan({ text: title });
		header.appendChild(this.createPopoverCloseButton(() => this.closeConfirmPopover()));
		popover.createDiv({ cls: "pdf-native-annotator-confirm-message", text: message });
		const actions = popover.createDiv({ cls: "pdf-native-annotator-confirm-actions" });
		const cancelButton = actions.createEl("button", { type: "button", text: "Cancel" });
		const confirmButton = actions.createEl("button", { type: "button", text: confirmText, cls: "mod-warning" });
		cancelButton.addEventListener("click", () => this.closeConfirmPopover());
		confirmButton.addEventListener("click", () => {
			this.closeConfirmPopover();
			onConfirm();
		});
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendTransientPopover(popover);
		const popoverRect = popover.getBoundingClientRect();
		const left = clamp((window.innerWidth / 2) - (popoverRect.width / 2), 12, window.innerWidth - popoverRect.width - 12);
		const top = clamp(88, 12, window.innerHeight - popoverRect.height - 12);
		popover.setCssStyles({
			left: `${left}px`,
			top: `${top}px`
		});
		this.confirmPopoverEl = popover;
		window.addEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
		window.setTimeout(() => confirmButton.focus(), 0);
	}

	private setCurrentTemplatePageColorValue(color: string, pushHistory = true): void {
		const page = this.getCurrentSyntheticPage();
		if (!page || page.paperColor.toLowerCase() === color.toLowerCase()) {
			return;
		}
		if (pushHistory) {
			this.pushHistory();
		}
		page.paperColor = color;
		this.markDirtyAndRedraw("Paper color changed");
		this.refreshSyntheticPages(this.currentPage);
	}

	private openTextStyleMenu(button: HTMLButtonElement): void {
		this.closeTransientPopovers("font");
		this.ensureTransientPopoverBackdrop();
		const popover = document.createElement("div");
		popover.className = "modal pdf-native-annotator-font-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-font-popover-title", text: "Font" });
		title.appendChild(this.createPopoverCloseButton(() => this.closeFontPopover()));
		const preview = popover.createDiv({ cls: "pdf-native-annotator-font-preview", text: "The quick brown fox" });
		const selectionSummary = popover.createDiv({ cls: "pdf-native-annotator-font-selection-summary" });
		const colorButtons: HTMLButtonElement[] = [];
		let fontSelect: HTMLSelectElement | null = null;
		let sizeInput: HTMLInputElement | null = null;
		let colorInput: HTMLInputElement | null = null;
		const syncPopoverState = (): void => {
			const family = this.getCurrentTextFontFamilyForMenu();
			const size = this.getCurrentTextSizeForMenu();
			const color = this.getCurrentTextColorForMenu();
			const summary = this.getTextSelectionStyleSummary();
			preview.setCssStyles({
				fontFamily: `"${family}", sans-serif`,
				fontSize: `${clamp(size, 12, 40)}px`,
				color
			});
			selectionSummary.textContent = summary;
			selectionSummary.classList.toggle("is-hidden", summary.length === 0);
			if (fontSelect && fontSelect !== document.activeElement) {
				fontSelect.value = family;
			}
			for (const colorButton of colorButtons) {
				colorButton.classList.toggle("is-active", colorButton.dataset.color?.toLowerCase() === color.toLowerCase());
			}
			if (sizeInput && sizeInput !== document.activeElement) {
				sizeInput.value = String(size);
			}
			if (colorInput && colorInput !== document.activeElement && /^#[0-9a-f]{6}$/i.test(color)) {
				colorInput.value = color;
			}
		};
		const fontRow = popover.createDiv({ cls: "pdf-native-annotator-font-select-row" });
		fontSelect = fontRow.createEl("select", { cls: "dropdown pdf-native-annotator-font-select" });
		for (const fontFamily of TEXT_FONT_FAMILIES) {
			const option = fontSelect.createEl("option", { text: fontFamily, value: fontFamily });
			option.setCssStyles({ fontFamily: `"${fontFamily}", sans-serif` });
		}
		fontSelect.value = this.getCurrentTextFontFamilyForMenu();
		fontSelect.addEventListener("change", () => {
			this.setTextFontFamily(fontSelect?.value ?? this.currentTextFontFamily);
			syncPopoverState();
		});
		const customSizeRow = popover.createDiv({ cls: "pdf-native-annotator-font-control-row" });
		customSizeRow.createSpan({ text: "Font size" });
		sizeInput = customSizeRow.createEl("input", {
			type: "number",
			cls: "pdf-native-annotator-font-number-input",
			attr: {
				min: "8",
				max: "96",
				step: "1"
			}
		});
		sizeInput.value = String(this.getCurrentTextSizeForMenu());
		sizeInput.addEventListener("change", () => {
			const nextSize = clamp(Math.round(Number(sizeInput?.value ?? this.currentTextFontSize)), 8, 96);
			this.setTextFontSize(nextSize);
			syncPopoverState();
		});
		popover.createDiv({ cls: "pdf-native-annotator-font-popover-title", text: "Color" });
		const colorList = popover.createDiv({ cls: "pdf-native-annotator-font-color-list" });
		for (const preset of TEXT_COLOR_PRESETS) {
			const colorButton = document.createElement("button");
			colorButton.type = "button";
			colorButton.className = "pdf-native-annotator-font-color-option";
			colorButton.title = preset.label;
			colorButton.dataset.color = preset.color;
			colorButton.setCssStyles({ backgroundColor: preset.color });
			colorButton.addEventListener("click", () => {
				this.setTextColor(preset.color);
				syncPopoverState();
			});
			colorButtons.push(colorButton);
			colorList.appendChild(colorButton);
		}
		const customColorRow = popover.createDiv({ cls: "pdf-native-annotator-font-control-row" });
		customColorRow.createSpan({ text: "Custom color" });
		colorInput = customColorRow.createEl("input", { type: "color", cls: "pdf-native-annotator-color" });
		colorInput.value = /^#[0-9a-f]{6}$/i.test(this.getCurrentTextColorForMenu()) ? this.getCurrentTextColorForMenu() : this.currentTextColor;
		let colorHistoryCaptured = false;
		colorInput.addEventListener("input", () => {
			if (this.shouldApplyTextStyleToSelection() && !colorHistoryCaptured) {
				this.pushHistory();
				colorHistoryCaptured = true;
			}
			this.setTextColor(colorInput?.value ?? this.currentTextColor, false);
			syncPopoverState();
		});
		colorInput.addEventListener("change", () => {
			colorHistoryCaptured = false;
			syncPopoverState();
		});
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendTransientPopover(popover);
		syncPopoverState();
		this.positionPopoverNearAnchor(popover, button, "left");
		this.fontPopoverEl = popover;
		window.addEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
	}

	private getSelectedTextItems(): TextAnnotation[] {
		if (!this.annotationDocument) {
			return [];
		}
		const selectedTextIds = new Set(this.selectedTargets.filter((target) => target.kind === "text").map((target) => target.id));
		return this.annotationDocument.textItems.filter((item) => selectedTextIds.has(item.id));
	}

	private getTextSelectionStyleSummary(): string {
		const items = this.getSelectedTextItems();
		if (items.length <= 1) {
			return "";
		}
		const families = new Set(items.map((item) => item.fontFamily ?? this.currentTextFontFamily));
		const sizes = new Set(items.map((item) => Math.round(item.fontSize)));
		const colors = new Set(items.map((item) => (item.color ?? this.currentTextColor).toLowerCase()));
		const widths = new Set(items.map((item) => item.boxWidthScale ? item.boxWidthScale.toFixed(4) : "auto"));
		const mixed = [
			families.size > 1 ? "font" : null,
			sizes.size > 1 ? "size" : null,
			colors.size > 1 ? "color" : null,
			widths.size > 1 ? "box" : null
		].filter((entry): entry is string => !!entry);
		return mixed.length > 0
			? `${items.length} text boxes selected; mixed ${mixed.join(", ")}. Changes apply to all selected text boxes.`
			: `${items.length} text boxes selected. Changes apply to all selected text boxes.`;
	}

	private getCurrentTextFontFamilyForMenu(): string {
		if (this.annotationDocument && this.hasSelectedText()) {
			const item = this.getSelectedTextItems()[0] ?? null;
			return item?.fontFamily ?? this.currentTextFontFamily;
		}
		return this.currentTextFontFamily;
	}

	private getCurrentTextSizeForMenu(): number {
		if (this.annotationDocument && this.hasSelectedText()) {
			const item = this.getSelectedTextItems()[0] ?? null;
			return item ? Math.round(item.fontSize) : this.currentTextFontSize;
		}
		return this.currentTextFontSize;
	}

	private getCurrentTextColorForMenu(): string {
		if (this.annotationDocument && this.hasSelectedText()) {
			const item = this.getSelectedTextItems()[0] ?? null;
			return item?.color ?? this.currentTextColor;
		}
		return this.currentTextColor;
	}

	private getCurrentTextBoxWidthForMenu(): number {
		if (this.inlineTextEditorFrameEl) {
			const width = this.inlineTextEditorFrameEl.getBoundingClientRect().width;
			return Number.isFinite(width) ? Math.round(width) : 280;
		}
		if (this.annotationDocument && this.hasSelectedText()) {
			const target = this.selectedTargets.find((entry) => entry.kind === "text");
			const item = this.getSelectedTextItems()[0] ?? null;
			const pageWidth = target ? Math.max(this.pageSurfaces.get(target.page)?.lastWidth ?? 1, 1) : 1;
			if (item?.boxWidthScale && item.boxWidthScale > 0) {
				return Math.round(clamp(item.boxWidthScale * pageWidth, 160, 760));
			}
			return Math.round(clamp(pageWidth * 0.48, 180, 520));
		}
		const surface = this.pageSurfaces.get(this.currentPage);
		return Math.round(clamp((surface?.lastWidth ?? 680) * 0.44, 180, 520));
	}

	private getActivePresetKind(): ToolPresetKind | null {
		if (this.currentTool === "pen" || this.currentTool === "highlighter" || this.currentTool === "eraser") {
			return this.currentTool;
		}
		return null;
	}

	private isStrokeSizedTool(): boolean {
		return this.currentTool === "pen" ||
			this.currentTool === "highlighter" ||
			this.currentTool === "eraser" ||
			isShapeTool(this.currentTool);
	}

	private refreshToolbar(): void {
		if (!this.toolbarEl) {
			return;
		}

		this.toolbarEl.replaceChildren();

		const leftGroup = document.createElement("div");
		leftGroup.className = "pdf-native-annotator-group";

		leftGroup.appendChild(this.createButton(this.annotationMode ? "Finish" : "Annotate", this.annotationMode, () => {
			this.toggleAnnotationMode();
		}));
		if (!this.annotationMode) {
			const readModeHint = document.createElement("span");
			readModeHint.className = "pdf-native-annotator-read-mode-hint";
			readModeHint.textContent = "Read mode";
			leftGroup.appendChild(readModeHint);

			const rightGroup = document.createElement("div");
			rightGroup.className = "pdf-native-annotator-group";
			const addPageButton = this.createButton("+ Page", false, () => {
				this.addTemplatePageFromToolbar();
			});
			addPageButton.classList.add("pdf-native-annotator-mode-button", "pdf-native-annotator-page-menu-button");
			addPageButton.title = "Add or insert a notebook page";
			rightGroup.appendChild(addPageButton);
			const moreButton = this.createIconButton("more-vertical", "More annotation actions", false, () => {
				this.openDocumentActionsMenu(moreButton);
			});
			rightGroup.appendChild(moreButton);

			this.toolbarEl.appendChild(leftGroup);
			this.toolbarEl.appendChild(rightGroup);
			this.repositionOpenPopovers();
			return;
		}
		let selectButton: HTMLButtonElement;
		selectButton = this.createIconButton("move", "Select", this.currentTool === "select", () => {
			if (this.currentTool === "select") {
				this.openSelectionMenu(selectButton);
				return;
			}
			this.setActiveTool("select");
			this.applyOverlayMode();
			this.refreshToolbar();
		});
		leftGroup.appendChild(selectButton);
		if (this.currentTool === "select") {
			const selectionModeButton = this.createButton(
				this.toolState.selectionMode === "lasso" ? "Lasso" : this.toolState.selectionMode === "box" ? "Box" : "Single",
				false,
				() => {
					const targetButton = selectionModeButton;
					this.openSelectionMenu(targetButton);
				}
			);
			selectionModeButton.classList.add("pdf-native-annotator-mode-button");
			leftGroup.appendChild(selectionModeButton);
		}
		if (this.plugin.shouldShowRegionToolbarButton()) {
			leftGroup.appendChild(this.createIconButton("crop", "Region embed", this.currentTool === "region", () => {
				this.setActiveTool("region");
				this.applyOverlayMode();
				this.refreshToolbar();
				this.refreshStatus("Region tool: drag a crop box, then Copy embed");
			}));
		}
		leftGroup.appendChild(this.createIconButton("pen-tool", "Pen", this.currentTool === "pen", () => {
			this.setActiveTool("pen");
			this.applyOverlayMode();
			this.refreshToolbar();
		}));
		leftGroup.appendChild(this.createIconButton("highlighter", "Highlighter", this.currentTool === "highlighter", () => {
			this.setActiveTool("highlighter");
			this.applyOverlayMode();
			this.refreshToolbar();
		}));
		leftGroup.appendChild(this.createIconButton("eraser", `Eraser (${this.eraserMode})`, this.currentTool === "eraser", () => {
			if (this.currentTool === "eraser") {
				this.toggleEraserMode();
				return;
			}
			this.setActiveTool("eraser");
			this.applyOverlayMode();
			this.refreshToolbar();
			this.refreshStatus(`Tool: Eraser (${this.eraserMode})`);
		}));
		if (this.currentTool === "eraser") {
			const eraserModeButton = this.createButton(
				this.eraserMode === "segment" ? "Touch erase" : "Object erase",
				false,
				() => {
					this.toggleEraserMode();
				}
			);
			eraserModeButton.classList.add("pdf-native-annotator-mode-button");
			leftGroup.appendChild(eraserModeButton);
		}
		leftGroup.appendChild(this.createIconButton("type", "Text", this.currentTool === "text", () => {
			this.setActiveTool("text");
			this.applyOverlayMode();
			this.refreshToolbar();
		}));
		leftGroup.appendChild(this.createIconButton("square", "Rectangle", this.currentTool === "rectangle", () => {
			this.setActiveTool("rectangle");
			this.applyOverlayMode();
			this.refreshToolbar();
		}));
		leftGroup.appendChild(this.createIconButton("circle", "Ellipse", this.currentTool === "ellipse", () => {
			this.setActiveTool("ellipse");
			this.applyOverlayMode();
			this.refreshToolbar();
		}));
		leftGroup.appendChild(this.createIconButton("minus", "Line", this.currentTool === "line", () => {
			this.setActiveTool("line");
			this.applyOverlayMode();
			this.refreshToolbar();
		}));

		const activePresetKind = this.getActivePresetKind();
		if (activePresetKind) {
			const slots = document.createElement("div");
			slots.className = "pdf-native-annotator-pen-slots";
			slots.classList.add(`is-${activePresetKind}`);
			for (const preset of this.toolState.getPresetsByKind(activePresetKind)) {
				slots.appendChild(this.createPresetButton(preset));
			}
			leftGroup.appendChild(slots);
		}

		if (this.currentTool !== "eraser" && this.currentTool !== "region") {
			leftGroup.appendChild(this.createColorPickerButton());
		}

		if (this.isStrokeSizedTool() || this.shouldApplyStyleToSelection()) {
			const strokeControl = document.createElement("div");
			strokeControl.className = "pdf-native-annotator-stroke-control";
			strokeControl.appendChild(this.createStrokeSizeButton());
			leftGroup.appendChild(strokeControl);
		}

		if (this.currentTool === "text" || (this.currentTool === "select" && this.hasSelectedText())) {
			const textStyleButton = this.createButton("Font", false, () => {
				this.openTextStyleMenu(textStyleButton);
			});
			textStyleButton.classList.add("pdf-native-annotator-mode-button", "pdf-native-annotator-font-button");
			leftGroup.appendChild(textStyleButton);
		}

		const rightGroup = document.createElement("div");
		rightGroup.className = "pdf-native-annotator-group";

		if (this.selectedTargets.length > 0) {
			const selectionLabel = `Selection ${this.selectedTargets.length}`;
			const selectionActionsButton = this.createButton(selectionLabel, false, () => {
				this.openSelectionActionsMenu(selectionActionsButton);
			});
			selectionActionsButton.classList.add("pdf-native-annotator-mode-button");
			rightGroup.appendChild(selectionActionsButton);
		}
		if (this.lastSelectionRegion) {
			const regionActionsButton = this.createButton("Region", false, () => {
				this.openRegionActionsMenu(regionActionsButton);
			});
			regionActionsButton.classList.add("pdf-native-annotator-mode-button");
			rightGroup.appendChild(regionActionsButton);
		}
		if (this.lastSelectionRegion && this.plugin.shouldShowCopyEmbedToolbarButton()) {
			const copyRegionButton = this.createButton("Copy embed", false, () => {
				void this.copySelectionAnnotatedEmbedBlock();
			});
			copyRegionButton.classList.add("pdf-native-annotator-mode-button");
			copyRegionButton.title = "Copy an annotated markdown embed for the selected box region";
			rightGroup.appendChild(copyRegionButton);
		}
		if (this.plugin.hasClipboard()) {
			rightGroup.appendChild(this.createIconButton("clipboard", "Paste copied annotations", false, () => this.pasteClipboard()));
		}
		rightGroup.appendChild(this.createIconButton("undo-2", "Undo", false, () => this.undo()));
		rightGroup.appendChild(this.createIconButton("redo-2", "Redo", false, () => this.redo()));
		const addPageButton = this.createButton("+ Page", false, () => {
			this.addTemplatePageFromToolbar();
		});
		addPageButton.classList.add("pdf-native-annotator-mode-button", "pdf-native-annotator-page-menu-button");
		addPageButton.title = "Add or insert a notebook page";
		rightGroup.appendChild(addPageButton);
		const moreButton = this.createIconButton("more-vertical", "More annotation actions", false, () => {
			this.openDocumentActionsMenu(moreButton);
		});
		rightGroup.appendChild(moreButton);

		this.toolbarEl.appendChild(leftGroup);
		this.toolbarEl.appendChild(rightGroup);
		this.repositionOpenPopovers();
	}

	private createButton(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pdf-native-annotator-button";
		if (active) {
			button.classList.add("is-active");
		}
		button.textContent = label;
		this.bindToolbarButtonActivation(button, onClick);
		return button;
	}

	private bindToolbarButtonActivation(button: HTMLButtonElement, onActivate: (event: Event) => void): void {
		let handledMousePointerUp = false;
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("pointerup", (event) => {
			event.stopPropagation();
			if (event.pointerType !== "mouse" || event.button !== 0 || button.disabled) {
				return;
			}
			handledMousePointerUp = true;
			event.preventDefault();
			onActivate(event);
			window.setTimeout(() => {
				handledMousePointerUp = false;
			}, 0);
		});
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			if (handledMousePointerUp) {
				event.preventDefault();
				return;
			}
			event.preventDefault();
			if (!button.disabled) {
				onActivate(event);
			}
		});
	}

	private createIconButton(icon: string, label: string, active: boolean, onClick: () => void): HTMLButtonElement {
		const button = this.createButton("", active, onClick);
		button.classList.add("clickable-icon", "pdf-native-annotator-icon-button");
		button.setAttribute("aria-label", label);
		button.title = label;
		setIcon(button, icon);
		return button;
	}

	private createPageListActionButton(icon: string, label: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pdf-native-annotator-page-list-action clickable-icon";
		button.setAttribute("aria-label", label);
		button.title = label;
		setIcon(button, icon);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick(event);
		});
		return button;
	}

	private createPopoverCloseButton(onClick: () => void): HTMLButtonElement {
		const button = document.createElement("button");
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

	private ensureTransientPopoverBackdrop(): void {
		if (this.transientPopoverBackdropEl) {
			return;
		}
		const backdrop = document.createElement("div");
		backdrop.className = "modal-container pdf-native-annotator-popover-backdrop";
		backdrop.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.closeTransientPopovers();
		});
		document.body.appendChild(backdrop);
		this.transientPopoverBackdropEl = backdrop;
	}

	private appendTransientPopover(popover: HTMLElement): void {
		popover.addEventListener("pointerdown", (event) => event.stopPropagation());
		(this.transientPopoverBackdropEl ?? document.body).appendChild(popover);
	}

	private removeTransientPopoverBackdropIfIdle(): void {
		if (this.strokePopoverEl || this.colorPopoverEl || this.fontPopoverEl || this.paperColorPopoverEl || this.renamePopoverEl || this.goToPagePopoverEl || this.pageListPopoverEl || this.confirmPopoverEl) {
			return;
		}
		this.forceRemoveTransientPopoverBackdrop();
	}

	private forceRemoveTransientPopoverBackdrop(): void {
		this.transientPopoverBackdropEl?.remove();
		this.transientPopoverBackdropEl = null;
	}

	private positionPopoverNearAnchor(popover: HTMLElement, anchor: HTMLElement, mode: "center" | "left" = "center"): void {
		this.positionPopoverNearRect(popover, anchor.getBoundingClientRect(), mode);
	}

	private positionPopoverNearRect(popover: HTMLElement, anchorRect: DOMRect, mode: "center" | "left" = "center"): void {
		const popoverRect = popover.getBoundingClientRect();
		const desiredLeft = mode === "left"
			? anchorRect.left
			: anchorRect.left + (anchorRect.width / 2) - (popoverRect.width / 2);
		const left = clamp(desiredLeft, 12, window.innerWidth - popoverRect.width - 12);
		const belowTop = anchorRect.bottom + 10;
		const aboveTop = anchorRect.top - popoverRect.height - 10;
		const belowSpace = window.innerHeight - anchorRect.bottom;
		const aboveSpace = anchorRect.top;
		const preferredTop = belowSpace >= popoverRect.height + 22 || belowSpace >= aboveSpace ? belowTop : aboveTop;
		const top = clamp(preferredTop, 12, window.innerHeight - popoverRect.height - 12);
		popover.setCssStyles({
			left: `${left}px`,
			top: `${top}px`
		});
	}

	private scheduleRepositionOpenPopovers(): void {
		if (this.popoverRepositionHandle !== null) {
			return;
		}
		this.popoverRepositionHandle = window.requestAnimationFrame(() => {
			this.popoverRepositionHandle = null;
			this.repositionOpenPopovers();
		});
	}

	private repositionOpenPopovers(): void {
		if (!this.toolbarEl) {
			return;
		}
		const strokeAnchor = this.toolbarEl.querySelector<HTMLElement>(".pdf-native-annotator-stroke-button");
		if (this.strokePopoverEl && strokeAnchor) {
			this.positionPopoverNearAnchor(this.strokePopoverEl, strokeAnchor);
		}
		const colorAnchor = this.toolbarEl.querySelector<HTMLElement>(".pdf-native-annotator-color-button");
		if (this.colorPopoverEl && colorAnchor) {
			this.positionPopoverNearAnchor(this.colorPopoverEl, colorAnchor);
		}
		const fontAnchor = this.toolbarEl.querySelector<HTMLElement>(".pdf-native-annotator-font-button");
		if (this.fontPopoverEl && fontAnchor) {
			this.positionPopoverNearAnchor(this.fontPopoverEl, fontAnchor, "left");
		}
		const pageAnchor = this.toolbarEl.querySelector<HTMLElement>(".pdf-native-annotator-page-menu-button");
		if (pageAnchor) {
			if (this.paperColorPopoverEl) {
				this.positionPopoverNearAnchor(this.paperColorPopoverEl, pageAnchor);
			}
			if (this.renamePopoverEl) {
				this.positionPopoverNearAnchor(this.renamePopoverEl, pageAnchor);
			}
			if (this.goToPagePopoverEl) {
				this.positionPopoverNearAnchor(this.goToPagePopoverEl, pageAnchor);
			}
			if (this.pageListPopoverEl) {
				this.positionPopoverNearAnchor(this.pageListPopoverEl, pageAnchor, "left");
			}
		}
	}

	private createPresetButton(preset: ToolPreset): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pdf-native-annotator-preset";
		button.classList.add(`is-${preset.kind}`);
		button.title = `${preset.label}: ${preset.kind} ${preset.width}`;
		button.setAttribute("aria-label", preset.label);
		if (this.toolState.selectedPresetId === preset.id) {
			button.classList.add("is-active");
		}
		const preview = document.createElement("span");
		preview.className = "pdf-native-annotator-preset-preview";
		preview.setCssStyles({
			backgroundColor: preset.kind === "eraser" ? "var(--text-muted)" : preset.color,
			opacity: String(preset.opacity),
			height: `${Math.max(4, Math.min(14, preset.width))}px`,
			width: `${Math.max(18, Math.min(34, preset.width * 2.6))}px`
		});
		button.appendChild(preview);
		this.bindToolbarButtonActivation(button, () => {
			this.applyPreset(preset.id);
		});
		return button;
	}

	private createColorSwatch(color: string, label: string): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pdf-native-annotator-swatch";
		button.title = label;
		button.setAttribute("aria-label", `${label} ink`);
		if (this.currentColor.toLowerCase() === color.toLowerCase()) {
			button.classList.add("is-active");
		}
		const inner = document.createElement("span");
		inner.className = "pdf-native-annotator-swatch-inner";
		inner.setCssStyles({ backgroundColor: color });
		button.appendChild(inner);
		this.bindToolbarButtonActivation(button, () => {
			if (this.shouldApplyStyleToSelection()) {
				this.applyColorToSelection(color);
			}
			this.setCurrentColor(color);
			this.refreshToolbar();
		});
		return button;
	}

	private createColorPickerButton(): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pdf-native-annotator-color-button";
		button.title = "Choose color";
		button.setAttribute("aria-label", "Choose ink color");
		const preview = button.createSpan({ cls: "pdf-native-annotator-color-button-preview" });
		preview.setCssStyles({ backgroundColor: this.currentColor });
		this.bindToolbarButtonActivation(button, () => {
			this.openColorPopover(button);
		});
		return button;
	}

	private openColorPopover(anchor: HTMLElement): void {
		this.closeTransientPopovers("color");
		this.ensureTransientPopoverBackdrop();
		const popover = document.createElement("div");
		popover.className = "modal pdf-native-annotator-color-popover";
		const title = popover.createDiv({ cls: "pdf-native-annotator-color-popover-title", text: "Ink color" });
		title.appendChild(this.createPopoverCloseButton(() => this.closeColorPopover()));
		const swatches = popover.createDiv({ cls: "pdf-native-annotator-color-popover-swatches" });
		for (const preset of [
			{ color: "#ff6b57", label: "Coral" },
			{ color: "#ffcb47", label: "Yellow" },
			{ color: "#55b4ff", label: "Blue" },
			{ color: "#6bcf8a", label: "Green" },
			{ color: "#d38cff", label: "Violet" }
		]) {
			const swatch = this.createColorSwatch(preset.color, preset.label);
			swatch.addEventListener("click", () => {
				this.closeColorPopover();
			});
			swatches.appendChild(swatch);
		}
		const customRow = popover.createDiv({ cls: "pdf-native-annotator-color-popover-custom" });
		customRow.createSpan({ text: "Custom" });
		const colorInput = document.createElement("input");
		colorInput.type = "color";
		colorInput.value = this.currentColor;
		colorInput.className = "pdf-native-annotator-color";
		let historyCaptured = false;
		colorInput.addEventListener("input", () => {
			if (this.shouldApplyStyleToSelection()) {
				if (!historyCaptured) {
					this.pushHistory();
					historyCaptured = true;
				}
				this.applyColorToSelection(colorInput.value, false);
			}
			this.setCurrentColor(colorInput.value);
			const preview = anchor.querySelector<HTMLElement>(".pdf-native-annotator-color-button-preview");
			if (preview) {
				preview.setCssStyles({ backgroundColor: colorInput.value });
			}
		});
		colorInput.addEventListener("change", () => {
			this.closeColorPopover();
			this.refreshToolbar();
		});
		customRow.appendChild(colorInput);
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendTransientPopover(popover);
		this.positionPopoverNearAnchor(popover, anchor);
		this.colorPopoverEl = popover;
		window.addEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
	}

	private createStrokeSizeButton(): HTMLButtonElement {
		const width = this.shouldApplyStyleToSelection() ? this.getSelectionWidthValue() : this.getActiveWidth();
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pdf-native-annotator-stroke-button";
		button.classList.add("is-active");
		button.title = `${this.getStrokePopoverTitle()}: ${width.toFixed(1)} px`;
		button.setAttribute("aria-label", `${this.getStrokePopoverTitle()} ${width.toFixed(1)} px`);
		setIcon(button.createSpan({ cls: "pdf-native-annotator-stroke-icon" }), "sliders-horizontal");
		button.createSpan({ cls: "pdf-native-annotator-stroke-value", text: `${width.toFixed(1)}` });
		this.bindToolbarButtonActivation(button, () => {
			this.openStrokeThicknessPopover(button);
		});
		return button;
	}

	private updateStrokePreviewElement(anchor: HTMLElement, width: number): void {
		const strokeValue = anchor.querySelector<HTMLElement>(".pdf-native-annotator-stroke-value");
		if (strokeValue) {
			strokeValue.textContent = width.toFixed(1);
		}
		anchor.setAttribute("aria-label", `${this.getStrokePopoverTitle()} ${width.toFixed(1)} px`);
		anchor.setAttribute("title", `${this.getStrokePopoverTitle()}: ${width.toFixed(1)} px`);

		const activePresetPreview = this.toolbarEl?.querySelector<HTMLElement>(".pdf-native-annotator-preset.is-active .pdf-native-annotator-preset-preview");
		this.updatePresetPreviewElement(activePresetPreview, width);
	}

	private updateActivePresetPreview(width: number): void {
		const activePresetPreview = this.toolbarEl?.querySelector<HTMLElement>(".pdf-native-annotator-preset.is-active .pdf-native-annotator-preset-preview");
		this.updatePresetPreviewElement(activePresetPreview, width);
	}

	private updatePresetPreviewElement(preview: HTMLElement | null | undefined, width: number): void {
		if (!preview) {
			return;
		}
		preview.setCssStyles({
			height: `${Math.max(4, Math.min(14, width))}px`,
			width: `${Math.max(18, Math.min(34, width * 2.6))}px`
		});
	}

	private getWidthStorageTool(tool: AnnotationTool = this.currentTool): AnnotationTool {
		return isShapeTool(tool) ? "pen" : tool;
	}

	private setToolbarWidth(width: number, refresh = true, targetTool: AnnotationTool = this.currentTool, pushSelectionHistory = true): void {
		if (this.shouldApplyStyleToSelection()) {
			this.applyWidthToSelection(width, pushSelectionHistory);
		}
		this.toolState.setWidth(width, this.getWidthStorageTool(targetTool));
		this.persistToolDefaults();
		this.refreshToolPreviewFromLastPointer(this.currentTool === "eraser" && this.erasingSession);
		if (refresh) {
			this.refreshToolbar();
		}
	}

	private openStrokeThicknessPopover(anchor: HTMLElement): void {
		this.closeTransientPopovers("stroke");
		this.ensureTransientPopoverBackdrop();
		const popover = document.createElement("div");
		popover.className = "modal pdf-native-annotator-stroke-popover";
		const targetTool = this.currentTool;
		const initialWidth = this.shouldApplyStyleToSelection() ? this.getSelectionWidthValue() : this.getActiveWidth();
		const title = popover.createDiv({ cls: "pdf-native-annotator-stroke-popover-title" });
		title.createSpan({ text: this.getStrokePopoverTitle() });
		title.appendChild(this.createPopoverCloseButton(() => this.closeStrokePopover()));
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
		slider.max = this.getWidthSliderMax(targetTool);
		slider.step = "0.5";
		slider.value = String(initialWidth);
		const tickRow = sliderWrap.createDiv({ cls: "pdf-native-annotator-stroke-ticks" });
		tickRow.createSpan({ text: "Thin" });
		tickRow.createSpan({ text: "Thick" });
		let historyCaptured = false;
		slider.addEventListener("input", () => {
			if (!historyCaptured && this.shouldApplyStyleToSelection()) {
				this.pushHistory();
				historyCaptured = true;
			}
			const width = Number(slider.value);
			valueLabel.textContent = `${width.toFixed(1)} px`;
			previewLine.setCssProps({ "--stroke-preview-size": `${width}px` });
			this.setToolbarWidth(width, false, targetTool, false);
			this.updateStrokePreviewElement(anchor, width);
		});
		slider.addEventListener("change", () => {
			const width = Number(slider.value);
			this.setToolbarWidth(width, true, targetTool, !historyCaptured);
		});
		popover.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		this.appendTransientPopover(popover);
		this.positionPopoverNearAnchor(popover, anchor);
		this.strokePopoverEl = popover;
		window.addEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
	}

	private closeStrokePopover(): void {
		this.strokePopoverEl?.remove();
		this.strokePopoverEl = null;
		this.removeTransientPopoverKeyListenerIfIdle();
		this.removeTransientPopoverBackdropIfIdle();
	}

	private closeTransientPopovers(except?: "stroke" | "color" | "font" | "paper" | "rename" | "goto" | "pagelist" | "confirm"): void {
		if (except !== "stroke") {
			this.closeStrokePopover();
		}
		if (except !== "color") {
			this.closeColorPopover();
		}
		if (except !== "font") {
			this.closeFontPopover();
		}
		if (except !== "paper") {
			this.closePaperColorPopover();
		}
		if (except !== "rename") {
			this.closeRenamePopover();
		}
		if (except !== "goto") {
			this.closeGoToPagePopover();
		}
		if (except !== "pagelist") {
			this.closePageListPopover();
		}
		if (except !== "confirm") {
			this.closeConfirmPopover();
		}
	}

	private closeColorPopover(): void {
		this.colorPopoverEl?.remove();
		this.colorPopoverEl = null;
		this.removeTransientPopoverKeyListenerIfIdle();
		this.removeTransientPopoverBackdropIfIdle();
	}

	private readonly handleTransientPopoverKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") {
			return;
		}
		if (!this.strokePopoverEl && !this.colorPopoverEl && !this.fontPopoverEl && !this.paperColorPopoverEl && !this.renamePopoverEl && !this.goToPagePopoverEl && !this.pageListPopoverEl && !this.confirmPopoverEl) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.closeTransientPopovers();
	};

	private removeTransientPopoverKeyListenerIfIdle(): void {
		if (this.strokePopoverEl || this.colorPopoverEl || this.fontPopoverEl || this.paperColorPopoverEl || this.renamePopoverEl || this.goToPagePopoverEl || this.pageListPopoverEl || this.confirmPopoverEl) {
			return;
		}
		window.removeEventListener("keydown", this.handleTransientPopoverKeyDown, { capture: true });
	}

	private closePaperColorPopover(): void {
		this.paperColorPopoverEl?.remove();
		this.paperColorPopoverEl = null;
		this.removeTransientPopoverKeyListenerIfIdle();
		this.removeTransientPopoverBackdropIfIdle();
	}

	private closeConfirmPopover(): void {
		this.confirmPopoverEl?.remove();
		this.confirmPopoverEl = null;
		this.removeTransientPopoverKeyListenerIfIdle();
		this.removeTransientPopoverBackdropIfIdle();
	}

	private closeRenamePopover(): void {
		this.renamePopoverEl?.remove();
		this.renamePopoverEl = null;
		this.removeTransientPopoverKeyListenerIfIdle();
		this.removeTransientPopoverBackdropIfIdle();
	}

	private closeGoToPagePopover(): void {
		this.goToPagePopoverEl?.remove();
		this.goToPagePopoverEl = null;
		this.removeTransientPopoverKeyListenerIfIdle();
		this.removeTransientPopoverBackdropIfIdle();
	}

	private closePageListPopover(): void {
		this.pageListPopoverEl?.remove();
		this.pageListPopoverEl = null;
		this.removeTransientPopoverKeyListenerIfIdle();
		this.removeTransientPopoverBackdropIfIdle();
	}

	private closeFontPopover(): void {
		this.fontPopoverEl?.remove();
		this.fontPopoverEl = null;
		this.removeTransientPopoverKeyListenerIfIdle();
		this.removeTransientPopoverBackdropIfIdle();
	}

	private getActiveWidth(): number {
		return this.toolState.getWidth();
	}

	private getStrokePopoverTitle(): string {
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
		return "Pen thickness";
	}

	private getWidthSliderMax(tool: AnnotationTool = this.currentTool): string {
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

	private getWidthLabelText(): string {
		if (this.currentTool === "select" && this.selectedTargets.length > 0) {
			return `Selection ${this.getSelectionWidthValue()}`;
		}
		if (this.currentTool === "highlighter") {
			return `Glow ${this.toolState.getWidth("highlighter")}`;
		}
		if (this.currentTool === "eraser") {
			return `Erase ${this.toolState.getWidth("eraser")}`;
		}
		if (this.currentTool === "line") {
			return `Line ${this.toolState.getWidth("pen")}`;
		}
		if (this.currentTool === "rectangle" || this.currentTool === "ellipse") {
			return `Shape ${this.toolState.getWidth("pen")}`;
		}
		return `Width ${this.toolState.getWidth("pen")}`;
	}

	private getSelectionWidthValue(): number {
		if (!this.annotationDocument || this.selectedTargets.length === 0) {
			return this.getActiveWidth();
		}
		const values: number[] = [];
		for (const target of this.selectedTargets) {
			if (target.kind === "stroke") {
				const stroke = this.annotationDocument.strokes.find((entry) => entry.id === target.id);
				if (stroke) {
					values.push(stroke.width);
				}
				continue;
			}
			if (target.kind === "shape") {
				const shape = this.annotationDocument.shapes.find((entry) => entry.id === target.id);
				if (shape) {
					values.push(shape.width);
				}
				continue;
			}
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			if (item) {
				values.push(Math.max(1, Math.round(item.fontSize / 4)));
			}
		}
		if (values.length === 0) {
			return this.getActiveWidth();
		}
		return Math.max(1, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));
	}

	private refreshToolPreviewFromLastPointer(active = false): void {
		const preview = this.previewState.snapshot;
		if (preview.clientX === null || preview.clientY === null) {
			if (!active) {
				this.hideToolPreview();
			}
			return;
		}
		this.updateToolPreview(preview.clientX, preview.clientY, active);
	}

	private getToolPreviewRadius(): number {
		if (this.currentTool === "eraser") {
			return Math.max(6, this.toolState.getWidth("eraser") / 2);
		}
		return 0;
	}

	private getEraserThreshold(pageNumber: number): number {
		const surface = this.pageSurfaces.get(pageNumber);
		const pageWidth = Math.max(surface?.lastWidth ?? 1, 1);
		return (this.getToolPreviewRadius() / pageWidth);
	}

	private updateToolPreview(clientX: number, clientY: number, active = false): void {
		const viewContentEl = this.getViewContentEl();
		if (!this.toolPreviewEl || !this.annotationMode || !viewContentEl) {
			return;
		}
		this.previewState.recordPointer(clientX, clientY);
		const radius = this.getToolPreviewRadius();
		if (radius <= 0 || this.currentTool !== "eraser") {
			this.hideToolPreview();
			return;
		}
		this.previewState.show(radius, active);

		this.toolPreviewEl.classList.remove("is-hidden", "is-eraser", "is-active");
		this.toolPreviewEl.classList.add("is-eraser");
		if (active) {
			this.toolPreviewEl.classList.add("is-active");
		}
		const size = radius * 2;
		const rect = viewContentEl.getBoundingClientRect();
		this.toolPreviewEl.setCssStyles({
			width: `${size}px`,
			height: `${size}px`,
			left: `${clientX - rect.left - radius}px`,
			top: `${clientY - rect.top - radius}px`
		});
	}

	private hideToolPreview(): void {
		this.previewState.hide();
		this.toolPreviewEl?.classList.add("is-hidden");
	}

	private openEraserMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		menu.addItem((item) => {
			item
				.setTitle("Touch section erase")
				.setChecked(this.eraserMode === "segment")
				.onClick(() => {
					this.toolState.setEraserMode("segment");
					this.persistToolDefaults();
					this.refreshToolbar();
					this.refreshStatus("Eraser mode: touch section");
				});
		});
		menu.addItem((item) => {
			item
				.setTitle("Whole object erase")
				.setChecked(this.eraserMode === "object")
				.onClick(() => {
					this.toolState.setEraserMode("object");
					this.persistToolDefaults();
					this.refreshToolbar();
					this.refreshStatus("Eraser mode: whole object");
				});
		});
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private toggleEraserMode(): void {
		const nextMode: EraserMode = this.eraserMode === "segment" ? "object" : "segment";
		this.toolState.setEraserMode(nextMode);
		this.persistToolDefaults();
		this.refreshToolbar();
		this.refreshToolPreviewFromLastPointer(false);
		this.refreshStatus(nextMode === "object" ? "Eraser mode: whole object" : "Eraser mode: touch section");
	}

	private openSelectionMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		menu.addItem((item) => {
			item
				.setTitle("Single select")
				.setChecked(this.toolState.selectionMode === "single")
				.onClick(() => {
					this.setSelectionMode("single");
					this.refreshStatus("Selection mode: single");
				});
		});
		menu.addItem((item) => {
			item
				.setTitle("Box select")
				.setChecked(this.toolState.selectionMode === "box")
				.onClick(() => {
					this.setSelectionMode("box");
					this.refreshStatus("Selection mode: box");
				});
		});
		menu.addItem((item) => {
			item
				.setTitle("Freehand lasso")
				.setChecked(this.toolState.selectionMode === "lasso")
				.onClick(() => {
					this.setSelectionMode("lasso");
					this.refreshStatus("Selection mode: lasso");
				});
		});
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openSelectionActionsMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		const hasAnnotationSelection = this.selectedTargets.length > 0;
		menu.addItem((item) => {
			item
				.setTitle("Select all on page (Ctrl/Cmd+A)")
				.setIcon("list-plus")
				.onClick(() => this.selectAllCurrentPageAnnotations());
		});
		if (hasAnnotationSelection) {
			menu.addSeparator();
			menu.addItem((item) => {
				item
					.setTitle("Copy selection (Ctrl/Cmd+C)")
					.setIcon("copy")
					.onClick(() => this.copySelectedTargets());
			});
			menu.addItem((item) => {
				item
					.setTitle("Cut selection (Ctrl/Cmd+X)")
					.setIcon("scissors")
					.onClick(() => this.cutSelectedTargets());
			});
			menu.addItem((item) => {
				item
					.setTitle("Duplicate selection")
					.setIcon("copy")
					.onClick(() => this.duplicateSelectedTargets());
			});
			menu.addItem((item) => {
				item
					.setTitle("Delete selection (Del)")
					.setIcon("trash")
					.onClick(() => this.deleteSelectedTargets());
			});
			menu.addSeparator();
			menu.addItem((item) => {
				item
					.setTitle("Bring to front (Ctrl/Cmd+])")
					.setIcon("bring-to-front")
					.onClick(() => this.reorderSelectedTargets("front"));
			});
			menu.addItem((item) => {
				item
					.setTitle("Send to back (Ctrl/Cmd+[)")
					.setIcon("send-to-back")
					.onClick(() => this.reorderSelectedTargets("back"));
			});
		}
		if (this.plugin.hasClipboard()) {
			menu.addSeparator();
			menu.addItem((item) => {
				item
					.setTitle("Paste copied annotations (Ctrl/Cmd+V)")
					.setIcon("clipboard")
					.onClick(() => this.pasteClipboard());
			});
			menu.addItem((item) => {
				item
					.setTitle("Paste copied annotation in place (Ctrl/Cmd+Shift+V)")
					.setIcon("clipboard-copy")
					.onClick(() => this.pasteClipboard(true));
			});
		}
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private openRegionActionsMenu(button: HTMLButtonElement): void {
		const menu = new Menu();
		const region = this.lastSelectionRegion;
		if (!region) {
			menu.addItem((item) => item
				.setTitle("No active region")
				.setIcon("info")
				.setDisabled(true));
			const emptyRect = button.getBoundingClientRect();
			menu.showAtPosition({ x: emptyRect.left, y: emptyRect.bottom + 6 });
			return;
		}
		menu.addItem((item) => item
			.setTitle("Copy region embed block")
			.setIcon("code")
			.onClick(() => void this.copySelectionAnnotatedEmbedBlock()));
		menu.addItem((item) => item
			.setTitle("Copy region reference")
			.setIcon("link")
			.onClick(() => void this.copySelectionRegionReference()));
		menu.addItem((item) => item
			.setTitle("Export region image")
			.setIcon("image-file")
			.onClick(() => void this.exportSelectionSnapshot()));
		menu.addItem((item) => item
			.setTitle("Open source page")
			.setIcon("file-text")
			.onClick(() => this.goToMixedPage(region.page)));
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle("Clear region")
			.setIcon("x")
			.onClick(() => this.clearRegion()));
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
	}

	private applyOverlayMode(): void {
		for (const surface of this.pageSurfaces.values()) {
			surface.overlayEl.classList.toggle("is-enabled", this.annotationMode);
			surface.overlayEl.setCssStyles({
				pointerEvents: this.annotationMode ? "auto" : "none",
				touchAction: this.annotationMode ? this.getOverlayTouchAction() : "",
				cursor: this.annotationMode
					? this.currentTool === "select"
						? "grab"
						: this.currentTool === "region"
						? "crosshair"
						: this.currentTool === "eraser"
						? "cell"
						: this.currentTool === "text"
							? "text"
							: "crosshair"
					: "default"
			});
		}
		if (!this.annotationMode) {
			this.hideToolPreview();
			return;
		}
		this.refreshToolPreviewFromLastPointer(this.currentTool === "eraser" && this.erasingSession);
	}

	private getOverlayTouchAction(): string {
		if (!isInkDrawingTool(this.currentTool)) {
			return "pan-x pan-y";
		}
		return this.getInkInputPolicy() === "allow-touch" ? "none" : "pan-x pan-y";
	}

	private getInkInputPolicy(): InkInputPolicy {
		return this.plugin.getInkInputPolicy();
	}

	private readonly handleSessionKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Escape" && this.isSessionEscapeEligible(event) && this.cancelActiveSessionInteraction()) {
			event.preventDefault();
			return;
		}
		if (!this.isSessionKeyboardActive(event)) {
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			this.clearSelection();
			return;
		}

		if ((event.key === "Delete" || event.key === "Backspace") && this.selectedTargets.length > 0) {
			event.preventDefault();
			this.deleteSelectedTargets();
			return;
		}

		if (event.key === "Enter" && this.selectedTargets.length === 1 && this.selectedTargets[0].kind === "text") {
			event.preventDefault();
			this.beginEditingSelectedTextTarget(this.selectedTargets[0]);
			return;
		}

		const isModifierShortcut = event.ctrlKey || event.metaKey;
		if (isModifierShortcut && event.key.toLowerCase() === "a") {
			event.preventDefault();
			this.selectAllCurrentPageAnnotations();
			return;
		}
		if (isModifierShortcut && event.key.toLowerCase() === "c" && this.selectedTargets.length > 0) {
			event.preventDefault();
			this.copySelectedTargets();
			return;
		}

		if (isModifierShortcut && event.key.toLowerCase() === "x" && this.selectedTargets.length > 0) {
			event.preventDefault();
			this.cutSelectedTargets();
			return;
		}

		if (isModifierShortcut && event.key === "]" && this.selectedTargets.length > 0) {
			event.preventDefault();
			this.reorderSelectedTargets(event.shiftKey ? "front" : "forward");
			return;
		}

		if (isModifierShortcut && event.key === "[" && this.selectedTargets.length > 0) {
			event.preventDefault();
			this.reorderSelectedTargets(event.shiftKey ? "back" : "backward");
			return;
		}

		const nudgeAmount = this.getKeyboardNudgeAmount(event.shiftKey);
		const nudges: Record<string, { x: number; y: number }> = {
			ArrowLeft: { x: -nudgeAmount, y: 0 },
			ArrowRight: { x: nudgeAmount, y: 0 },
			ArrowUp: { x: 0, y: -nudgeAmount },
			ArrowDown: { x: 0, y: nudgeAmount }
		};
		const nudge = nudges[event.key];
		if (nudge && this.selectedTargets.length > 0) {
			event.preventDefault();
			this.nudgeSelectedTargets(nudge.x, nudge.y, !this.keyboardNudgeHistoryOpen);
			this.keyboardNudgeHistoryOpen = true;
		}
	};

	private isSessionEscapeEligible(event: KeyboardEvent): boolean {
		if (!this.annotationMode || this.leaf !== this.plugin.app.workspace.activeLeaf) {
			return false;
		}
		const target = event.target;
		if (isHtmlElement(target)) {
			if (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']")) {
				return false;
			}
		}
		return !this.hasOpenTransientPopover();
	}

	private readonly handleSessionKeyUp = (event: KeyboardEvent): void => {
		if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
			this.keyboardNudgeHistoryOpen = false;
		}
	};

	private readonly handleSessionWindowBlur = (): void => {
		this.keyboardNudgeHistoryOpen = false;
	};

	private isSessionKeyboardActive(event: KeyboardEvent): boolean {
		if (!this.annotationMode || this.currentTool !== "select" || this.leaf !== this.plugin.app.workspace.activeLeaf) {
			return false;
		}
		if (this.hasOpenTransientPopover()) {
			return false;
		}
		const target = event.target;
		if (isHtmlElement(target)) {
			if (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']")) {
				return false;
			}
		}
		return true;
	}

	private beginEditingSelectedTextTarget(target: SelectedTarget): void {
		if (!this.annotationDocument || target.kind !== "text") {
			return;
		}
		const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
		if (!item) {
			return;
		}
		this.currentTextFontFamily = item.fontFamily ?? this.currentTextFontFamily;
		this.currentTextFontSize = Math.round(item.fontSize);
		this.currentTextColor = item.color ?? this.currentTextColor;
		this.beginSessionInlineTextEditor(target.page, { x: item.x, y: item.y, pressure: 0.5 }, item);
	}

	private hasOpenTransientPopover(): boolean {
		return !!(
			this.strokePopoverEl ||
			this.colorPopoverEl ||
			this.fontPopoverEl ||
			this.paperColorPopoverEl ||
			this.confirmPopoverEl ||
			this.renamePopoverEl ||
			this.goToPagePopoverEl ||
			this.pageListPopoverEl
		);
	}

	private getKeyboardNudgeAmount(useLargeStep: boolean): number {
		const selectedPage = this.getSelectionPage() ?? this.lastSelectionRegion?.page ?? this.currentPage;
		const surface = this.pageSurfaces.get(selectedPage);
		const minDimension = Math.min(surface?.lastWidth ?? 0, surface?.lastHeight ?? 0);
		const pixels = useLargeStep ? 10 : 2;
		if (!minDimension) {
			return useLargeStep ? 0.012 : 0.003;
		}
		return clamp(pixels / minDimension, 0.001, 0.03);
	}

	private readonly handleViewPointerMove = (event: PointerEvent): void => {
		if (!this.annotationMode) {
			return;
		}
		this.updateToolPreview(
			event.clientX,
			event.clientY,
			this.currentTool === "eraser" && this.erasingSession
		);
	};

	private readonly handleViewPointerLeave = (): void => {
		if (!this.erasingSession) {
			this.hideToolPreview();
		}
	};

	private readonly handleViewPointerDown = (event: PointerEvent): void => {
		this.handleFallbackPointerDown(event);
	};

	private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
		this.handleFallbackPointerDown(event);
	};

	private handleFallbackPointerDown(event: PointerEvent): void {
		this.forceFinishStalePdfInteraction("New stroke recovered previous input");
		if (!this.annotationMode || this.pointerPage !== null) {
			return;
		}
		const target = isDomElement(event.target) ? event.target : null;
		if (!target || target.closest(`.${SESSION_ROOT_CLASS}, .menu, .menu-item, .modal, .modal-container, .popover, .suggestion-container, .prompt, .pdf-native-annotator-popover-backdrop, .pdf-native-annotator-color-popover, .pdf-native-annotator-confirm-popover, .pdf-native-annotator-rename-popover, .pdf-native-annotator-font-popover, .pdf-native-annotator-stroke-popover, .pdf-native-annotator-page-list-popover, .pdf-native-annotator-inline-text-frame, .pdf-native-annotator-inline-text-editor, .pdf-native-annotator-inline-text-handle`)) {
			return;
		}
		if (target.closest(`.${OVERLAY_CLASS}`)) {
			return;
		}
		const surface = this.ensureSurfaceAtClientPoint(event.clientX, event.clientY);
		if (!surface) {
			this.refreshStatus(`Could not start ink: no page surface at pointer (${this.pageSurfaces.size} registered)`, 4000);
			this.scheduleSyncPages();
			return;
		}
		if (shouldIgnoreInkPointerEvent(event, this.currentTool, this.getInkInputPolicy())) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.handlePointerDownForCanvas(event, surface.overlayEl);
	}

	private getSurfaceAtClientPoint(clientX: number, clientY: number): PageSurface | null {
		let bestSurface: PageSurface | null = null;
		let bestArea = Number.POSITIVE_INFINITY;
		for (const surface of this.pageSurfaces.values()) {
			if (!surface.overlayEl.isConnected || window.getComputedStyle(surface.overlayEl).visibility === "hidden") {
				continue;
			}
			const rect = surface.overlayEl.getBoundingClientRect();
			if (
				clientX < rect.left ||
				clientX > rect.right ||
				clientY < rect.top ||
				clientY > rect.bottom
			) {
				continue;
			}
			const area = Math.max(1, rect.width * rect.height);
			if (area < bestArea) {
				bestArea = area;
				bestSurface = surface;
			}
		}
		return bestSurface;
	}

	private ensureSurfaceAtClientPoint(clientX: number, clientY: number): PageSurface | null {
		const existing = this.getSurfaceAtClientPoint(clientX, clientY);
		if (existing) {
			return existing;
		}
		const pageEntry = this.getPageElementAtClientPoint(clientX, clientY);
		if (!pageEntry) {
			return null;
		}
		try {
			this.ensurePageSurface(pageEntry.pageEl, pageEntry.pageNumber);
		} catch (error) {
			console.error(`freedraw-pdf: failed to create page surface for page ${pageEntry.pageNumber}`, error);
			return null;
		}
		this.applyOverlayMode();
		return this.pageSurfaces.get(pageEntry.pageNumber) ?? null;
	}

	private getPageElementAtClientPoint(clientX: number, clientY: number): { pageEl: HTMLElement; pageNumber: number } | null {
		const viewContentEl = this.getViewContentEl();
		if (!viewContentEl) {
			return null;
		}
		let bestEntry: { pageEl: HTMLElement; pageNumber: number; area: number } | null = null;
		const primaryViewerEl = this.getPrimaryPdfViewerEl(viewContentEl);
		const realPageEls = primaryViewerEl
			? Array.from(primaryViewerEl.querySelectorAll<HTMLElement>(".page[data-page-number], .pdf-page[data-page-number]"))
			: Array.from(viewContentEl.querySelectorAll<HTMLElement>(PAGE_SELECTORS));
		const syntheticPageEls = Array.from(viewContentEl.querySelectorAll<HTMLElement>(".pdf-native-annotator-synthetic-page[data-page-number]"));
		for (const pageEl of [...realPageEls, ...syntheticPageEls]) {
			if (pageEl.classList.contains("pdf-native-annotator-synthetic-page") && !pageEl.dataset.pageNumber) {
				continue;
			}
			const pageNumber = Number(pageEl.dataset.pageNumber);
			if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
				continue;
			}
			const rect = pageEl.getBoundingClientRect();
			if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
				continue;
			}
			const area = Math.max(1, rect.width * rect.height);
			if (!bestEntry || area < bestEntry.area) {
				bestEntry = { pageEl, pageNumber, area };
			}
		}
		return bestEntry ? { pageEl: bestEntry.pageEl, pageNumber: bestEntry.pageNumber } : null;
	}

	private getPageElementForPageNumber(pageNumber: number): { pageEl: HTMLElement; pageNumber: number } | null {
		const viewContentEl = this.getViewContentEl();
		const existingSurface = this.pageSurfaces.get(pageNumber);
		if (existingSurface?.pageEl.isConnected) {
			return { pageEl: existingSurface.pageEl, pageNumber };
		}
		if (!viewContentEl) {
			return null;
		}
		const syntheticPageEl = viewContentEl.querySelector<HTMLElement>(`.pdf-native-annotator-synthetic-page[data-page-number="${pageNumber}"]`);
		if (syntheticPageEl) {
			return { pageEl: syntheticPageEl, pageNumber };
		}
		const primaryViewerEl = this.getPrimaryPdfViewerEl(viewContentEl);
		const pageEl = (primaryViewerEl ?? viewContentEl).querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"], .pdf-page[data-page-number="${pageNumber}"]`);
		return pageEl ? { pageEl, pageNumber } : null;
	}

	private readonly handlePointerDown = (event: PointerEvent): void => {
		this.forceFinishStalePdfInteraction("New stroke recovered previous input");
		if (this.activePdfPointerId === event.pointerId) {
			return;
		}
		const canvas = isHtmlCanvasElement(event.currentTarget) ? event.currentTarget : null;
		if (!canvas) {
			this.refreshStatus("Could not start ink: pointer target is not the annotator canvas", 4000);
			return;
		}
		this.handlePointerDownForCanvas(event, canvas);
	};

	private handlePointerDownForCanvas(event: PointerEvent, canvas: HTMLCanvasElement): void {
		this.forceFinishStalePdfInteraction("New stroke recovered previous input");
		if (!this.annotationMode) {
			this.refreshStatus("Could not start ink: annotation mode is off", 4000);
			return;
		}
		if (!this.annotationDocument) {
			this.refreshStatus("Could not start ink: annotation document is not loaded yet", 4000);
			return;
		}

		const pageNumber = Number(canvas.dataset.pageNumber);
		if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
			this.refreshStatus("Could not start ink: page number is missing from the overlay", 4000);
			this.scheduleSyncPages();
			return;
		}
		const surface = this.pageSurfaces.get(pageNumber);
		if (!surface) {
			this.refreshStatus(`Could not start ink: page ${pageNumber} surface is not ready`, 4000);
			this.scheduleSyncPages();
			return;
		}
		canvas.setCssStyles({ touchAction: this.getOverlayTouchAction() });
		if (shouldIgnoreInkPointerEvent(event, this.currentTool, this.getInkInputPolicy())) {
			return;
		}
		if (isInkDrawingTool(this.currentTool)) {
			canvas.setCssStyles({ touchAction: "none" });
		}

		this.currentPage = pageNumber;
		this.refreshToolbar();
		this.lastPdfPoint = null;
		this.lastPdfPointTime = 0;
		const point = this.getNormalizedPoint(surface, event);
		if (this.inlineTextEditorEl) {
			this.finishSessionInlineTextEditor(true);
		}
		event.preventDefault();
		this.updateToolPreview(event.clientX, event.clientY, true);

		try {
			canvas.setPointerCapture(event.pointerId);
		} catch (error) {
			console.warn("freedraw-pdf: pointer capture unavailable", error);
		}
		this.bindPdfPointerDocumentTracking(event.pointerId, canvas);

		if (this.currentTool === "select") {
			const handle = this.getSelectionHandleHit(pageNumber, point);
			if (this.selectedTargets.length > 0 && handle) {
				this.pushHistory();
				this.dragAnchor = point;
				this.dragMoved = false;
				this.activeResizeHandle = handle;
				this.pointerPage = pageNumber;
				canvas.setCssStyles({ cursor: this.getCursorForHandle(handle) });
				this.refreshStatus("Resize handle selected");
				return;
			}
			const selectedHit = this.getSelectedTargetHit(pageNumber, point);
			if (this.selectedTargets.length > 0 && selectedHit) {
				this.pushHistory();
				this.dragAnchor = point;
				this.dragMoved = false;
				this.activeResizeHandle = null;
				this.pointerPage = pageNumber;
				canvas.setCssStyles({ cursor: "grabbing" });
				this.selectedTarget = selectedHit;
				this.refreshStatus(this.selectedTargets.length > 1 ? `Moving ${this.selectedTargets.length} selections` : "Moving selection");
				return;
			}
			if (this.toolState.selectionMode === "box") {
				this.lastSelectionRegion = null;
				this.currentLasso = { page: pageNumber, points: getSelectionBoxPoints(point, point) };
				this.dragAnchor = point;
				this.dragMoved = false;
				this.activeResizeHandle = null;
				this.pointerPage = pageNumber;
				this.drawPageAnnotations(pageNumber);
				this.refreshStatus("Drag box select");
				return;
			}
			if (this.toolState.selectionMode === "lasso") {
				this.lastSelectionRegion = null;
				this.currentLasso = { page: pageNumber, points: [point] };
				this.dragAnchor = null;
				this.pointerPage = pageNumber;
				this.drawPageAnnotations(pageNumber);
				this.refreshStatus("Tracing lasso");
				return;
			}
			const hit = this.findSelectableTarget(pageNumber, point);
			if (!hit) {
				this.selectedTarget = null;
				this.selectedTargets = [];
				this.dragAnchor = null;
				this.activeResizeHandle = null;
				this.drawPageAnnotations(pageNumber);
				this.refreshStatus("Nothing selected");
				return;
			}
			this.pushHistory();
			const shouldToggleSelection = event.shiftKey || event.ctrlKey || event.metaKey;
			if (shouldToggleSelection) {
				const existing = this.selectedTargets.find((target) => target.id === hit.id && target.kind === hit.kind && target.page === hit.page);
				this.selectedTargets = existing
					? this.selectedTargets.filter((target) => !(target.id === hit.id && target.kind === hit.kind && target.page === hit.page))
					: [...this.selectedTargets, hit];
				this.selectedTarget = this.selectedTargets[0] ?? null;
			} else {
				this.selectedTarget = hit;
				this.selectedTargets = [hit];
			}
			this.lastSelectionRegion = null;
			this.dragAnchor = point;
			this.dragMoved = false;
			this.activeResizeHandle = null;
			this.pointerPage = pageNumber;
			canvas.setCssStyles({ cursor: "grabbing" });
			this.drawPageAnnotations(pageNumber);
			this.refreshStatus(this.selectedTargets.length > 1 ? `Selected ${this.selectedTargets.length} objects` : `Selected ${hit.kind}`);
			return;
		}

		if (this.currentTool === "region") {
			this.lastSelectionRegion = null;
			this.currentLasso = { page: pageNumber, points: getSelectionBoxPoints(point, point) };
			this.dragAnchor = point;
			this.dragMoved = false;
			this.activeResizeHandle = null;
			this.pointerPage = pageNumber;
			this.drawPageAnnotations(pageNumber);
			this.refreshStatus("Drag region crop box");
			return;
		}

		if (this.currentTool === "text") {
			const hit = this.findSelectableTarget(pageNumber, point);
			if (hit?.kind === "text" && this.annotationDocument) {
				const existing = this.annotationDocument.textItems.find((entry) => entry.id === hit.id);
				if (existing) {
					const alreadySelected = this.selectedTargets.some((target) => target.kind === "text" && target.id === hit.id && target.page === pageNumber);
					if (!alreadySelected) {
						try {
							canvas.releasePointerCapture(event.pointerId);
						} catch {
							// noop
						}
						this.unbindPdfPointerDocumentTracking();
						this.selectedTarget = hit;
						this.selectedTargets = [hit];
						this.lastSelectionRegion = null;
						this.drawPageAnnotations(pageNumber);
						this.refreshToolbar();
						this.refreshStatus("Text box selected. Drag border/handles, or click again to edit.");
						return;
					}
					const handle = this.getSelectionHandleHit(pageNumber, point);
					if (handle) {
						this.pushHistory();
						this.dragAnchor = point;
						this.dragMoved = false;
						this.activeResizeHandle = handle;
						this.pointerPage = pageNumber;
						canvas.setCssStyles({ cursor: this.getCursorForHandle(handle) });
						this.refreshStatus("Resize text box");
						return;
					}
					if (this.isPointOnTextBoxBorder(existing, point, pageNumber)) {
						this.pushHistory();
						this.dragAnchor = point;
						this.dragMoved = false;
						this.activeResizeHandle = null;
						this.pointerPage = pageNumber;
						canvas.setCssStyles({ cursor: "grabbing" });
						this.refreshStatus("Moving text box");
						return;
					}
					this.currentTextFontFamily = existing.fontFamily ?? this.currentTextFontFamily;
					this.currentTextFontSize = Math.round(existing.fontSize);
					this.currentTextColor = existing.color ?? this.currentTextColor;
					try {
						canvas.releasePointerCapture(event.pointerId);
					} catch {
						// noop
					}
					this.unbindPdfPointerDocumentTracking();
					this.beginSessionInlineTextEditor(pageNumber, { x: existing.x, y: existing.y, pressure: point.pressure }, existing);
					return;
				}
			}
			const selectedTextTarget = this.selectedTargets.find((target) => target.kind === "text" && target.page === pageNumber);
			if (selectedTextTarget && this.annotationDocument) {
				const selectedText = this.annotationDocument.textItems.find((entry) => entry.id === selectedTextTarget.id);
				if (selectedText) {
					try {
						canvas.releasePointerCapture(event.pointerId);
					} catch {
						// noop
					}
					this.unbindPdfPointerDocumentTracking();
					this.currentTextFontFamily = selectedText.fontFamily ?? this.currentTextFontFamily;
					this.currentTextFontSize = Math.round(selectedText.fontSize);
					this.currentTextColor = selectedText.color ?? this.currentTextColor;
					this.beginSessionInlineTextEditor(pageNumber, { x: selectedText.x, y: selectedText.y, pressure: point.pressure }, selectedText);
					this.refreshStatus("Editing selected text box");
					return;
				}
			}
			this.currentLasso = { page: pageNumber, points: getSelectionBoxPoints(point, point) };
			this.dragAnchor = point;
			this.dragMoved = false;
			this.pointerPage = pageNumber;
			this.drawPageAnnotations(pageNumber);
			this.refreshStatus("Drag to draw a text box, release to type");
			return;
		}

		if (this.currentTool === "eraser") {
			this.pushHistory();
			this.erasingSession = true;
			this.lastEraserPoint = point;
			this.pointerPage = pageNumber;
			if (this.eraseAtPoint(pageNumber, point)) {
				this.drawPageAnnotations(pageNumber);
				this.refreshStatus(`Erasing (${this.eraserMode})`);
			} else if (this.undoStack.length > 0) {
				this.undoStack.pop();
			}
			return;
		}

		if (isShapeTool(this.currentTool)) {
			this.pushHistory();
			const zIndex = this.getNextPageZIndex(pageNumber);
			this.currentShape = {
				id: generateId("shape"),
				page: pageNumber,
				tool: this.currentTool,
				color: this.currentColor,
				width: this.toolState.getWidth("pen"),
				widthScale: this.getStableAnnotationWidthScale(this.toolState.getWidth("pen")),
				start: point,
				end: point,
				zIndex,
				createdAt: new Date().toISOString()
			};
			this.pointerPage = pageNumber;
			this.drawPageAnnotations(pageNumber);
			return;
		}

		this.pushHistory();
		const strokeWidth = this.currentTool === "highlighter" ? this.toolState.getWidth("highlighter") : this.toolState.getWidth("pen");
		const zIndex = this.getNextPageZIndex(pageNumber);
		this.currentStroke = {
			id: generateId("stroke"),
			page: pageNumber,
			tool: this.currentTool,
			color: this.currentColor,
			width: strokeWidth,
			widthScale: this.getStableAnnotationWidthScale(strokeWidth),
			points: [point],
			zIndex,
			createdAt: new Date().toISOString()
		};
		this.pointerPage = pageNumber;
		this.drawTransientPageAnnotations(pageNumber);
		this.refreshStatus(`Stroke started: ${this.currentTool}, page ${pageNumber}, points 1`, 5000);
	}

	private hasActivePdfPointerInteraction(): boolean {
		return !!(
			this.currentStroke ||
			this.currentShape ||
			this.currentLasso ||
			this.dragAnchor ||
			this.activeResizeHandle ||
			this.erasingSession
		);
	}

	private resetStalePdfPointerInteraction(): void {
		if (this.hasActivePdfPointerInteraction()) {
			return;
		}
		if (this.pointerPage !== null || this.activePdfPointerId !== null || this.activePdfPointerCanvas !== null) {
			this.unbindPdfPointerDocumentTracking();
			this.pointerPage = null;
			this.lastEraserPoint = null;
			this.dragMoved = false;
		}
	}

	private forceFinishStalePdfInteraction(message: string): void {
		if (!this.hasActivePdfPointerInteraction()) {
			this.resetStalePdfPointerInteraction();
			return;
		}
		const pageNumber = this.pointerPage ?? this.currentStroke?.page ?? this.currentShape?.page ?? this.currentLasso?.page ?? this.currentPage;
		if (this.currentStroke && this.annotationDocument && this.currentStroke.points.length > 0) {
			this.annotationDocument.strokes.push(this.currentStroke);
			this.currentStroke = null;
			this.currentShape = null;
			this.currentLasso = null;
			this.dragAnchor = null;
			this.activeResizeHandle = null;
			this.erasingSession = false;
			this.lastEraserPoint = null;
			this.pointerPage = null;
			this.dragMoved = false;
			this.unbindPdfPointerDocumentTracking();
			this.markDirtyAndRedraw(message);
			return;
		}
		if (this.currentShape && this.annotationDocument) {
			this.annotationDocument.shapes.push(this.currentShape);
			this.currentStroke = null;
			this.currentShape = null;
			this.currentLasso = null;
			this.dragAnchor = null;
			this.activeResizeHandle = null;
			this.erasingSession = false;
			this.lastEraserPoint = null;
			this.pointerPage = null;
			this.dragMoved = false;
			this.unbindPdfPointerDocumentTracking();
			this.markDirtyAndRedraw(message);
			return;
		}
		this.currentStroke = null;
		this.currentShape = null;
		this.currentLasso = null;
		this.dragAnchor = null;
		this.activeResizeHandle = null;
		this.erasingSession = false;
		this.lastEraserPoint = null;
		this.pointerPage = null;
		this.dragMoved = false;
		this.unbindPdfPointerDocumentTracking();
		if (pageNumber) {
			this.drawPageAnnotations(pageNumber);
		}
	}

	private commitActiveInkBeforeLayoutRefresh(): void {
		if (!this.annotationDocument) {
			return;
		}
		if (this.currentStroke && this.currentStroke.points.length > 0) {
			this.annotationDocument.strokes.push(this.currentStroke);
			const pageNumber = this.currentStroke.page;
			this.currentStroke = null;
			this.currentShape = null;
			this.currentLasso = null;
			this.dragAnchor = null;
			this.activeResizeHandle = null;
			this.erasingSession = false;
			this.lastEraserPoint = null;
			this.pointerPage = null;
			this.dragMoved = false;
			this.unbindPdfPointerDocumentTracking();
			this.invalidateAnnotationPageCache();
			this.isDirty = true;
			this.scheduleSave();
			this.drawPageAnnotations(pageNumber);
			return;
		}
		if (this.currentShape) {
			this.annotationDocument.shapes.push(this.currentShape);
			const pageNumber = this.currentShape.page;
			this.currentStroke = null;
			this.currentShape = null;
			this.currentLasso = null;
			this.dragAnchor = null;
			this.activeResizeHandle = null;
			this.erasingSession = false;
			this.lastEraserPoint = null;
			this.pointerPage = null;
			this.dragMoved = false;
			this.unbindPdfPointerDocumentTracking();
			this.invalidateAnnotationPageCache();
			this.isDirty = true;
			this.scheduleSave();
			this.drawPageAnnotations(pageNumber);
		}
	}

	private bindPdfPointerDocumentTracking(pointerId: number, canvas: HTMLCanvasElement): void {
		this.unbindPdfPointerDocumentTracking();
		this.activePdfPointerId = pointerId;
		this.activePdfPointerCanvas = canvas;
		document.addEventListener("pointermove", this.handleDocumentPointerMove, true);
		document.addEventListener("pointerup", this.handleDocumentPointerUp, true);
		document.addEventListener("pointercancel", this.handleDocumentPointerCancel, true);
	}

	private unbindPdfPointerDocumentTracking(): void {
		document.removeEventListener("pointermove", this.handleDocumentPointerMove, true);
		document.removeEventListener("pointerup", this.handleDocumentPointerUp, true);
		document.removeEventListener("pointercancel", this.handleDocumentPointerCancel, true);
		this.activePdfPointerId = null;
		this.activePdfPointerCanvas = null;
	}

	private shouldHandleDocumentPointer(event: PointerEvent): boolean {
		return this.activePdfPointerId === event.pointerId && this.activePdfPointerCanvas !== null;
	}

	private readonly handleDocumentPointerMove = (event: PointerEvent): void => {
		if (!this.shouldHandleDocumentPointer(event) || !this.activePdfPointerCanvas) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.handlePointerMoveForCanvas(event, this.activePdfPointerCanvas);
	};

	private readonly handleDocumentPointerUp = (event: PointerEvent): void => {
		if (!this.shouldHandleDocumentPointer(event) || !this.activePdfPointerCanvas) {
			return;
		}
		const canvas = this.activePdfPointerCanvas;
		event.preventDefault();
		event.stopPropagation();
		this.handlePointerUpForCanvas(event, canvas);
	};

	private readonly handleDocumentPointerCancel = (event: PointerEvent): void => {
		if (!this.shouldHandleDocumentPointer(event) || !this.activePdfPointerCanvas) {
			return;
		}
		const canvas = this.activePdfPointerCanvas;
		event.preventDefault();
		event.stopPropagation();
		this.handlePointerCancelForCanvas(event, canvas);
	};

	private readonly handlePointerMove = (event: PointerEvent): void => {
		if (this.shouldHandleDocumentPointer(event)) {
			return;
		}
		const canvas = isHtmlCanvasElement(event.currentTarget) ? event.currentTarget : null;
		if (!canvas) {
			return;
		}
		this.handlePointerMoveForCanvas(event, canvas);
	};

	private handlePointerMoveForCanvas(event: PointerEvent, canvas: HTMLCanvasElement): void {
		this.updateToolPreview(
			event.clientX,
			event.clientY,
			this.currentTool === "eraser" && this.erasingSession
		);
		const pageNumber = Number(canvas.dataset.pageNumber);
		if (this.pointerPage === null) {
			return;
		}
		if (pageNumber !== this.pointerPage) {
			return;
		}

		const surface = this.pageSurfaces.get(pageNumber);
		if (!surface) {
			return;
		}

		event.preventDefault();
		const points = this.getNormalizedPoints(surface, event);
		if (points.length === 0) {
			return;
		}
		const point = points[points.length - 1];
		if ((this.currentTool === "select" || this.currentTool === "text") && this.selectedTarget && this.dragAnchor && !this.currentLasso) {
			const deltaX = point.x - this.dragAnchor.x;
			const deltaY = point.y - this.dragAnchor.y;
			if (Math.abs(deltaX) > 0 || Math.abs(deltaY) > 0) {
				this.dragMoved = true;
				if (this.activeResizeHandle && this.selectedTargets.length > 0) {
					this.resizeSelectedTargets(this.selectedTargets, this.activeResizeHandle, deltaX, deltaY);
				} else {
					for (const target of this.selectedTargets) {
						this.moveSelectedTarget(target, deltaX, deltaY);
					}
				}
				this.dragAnchor = point;
				this.scheduleInteractionRedraw(pageNumber);
			}
			return;
		}
		if (this.currentTool === "select" && this.currentLasso && this.pointerPage === pageNumber) {
			if (this.toolState.selectionMode === "box" && this.dragAnchor) {
				this.currentLasso.points = getSelectionBoxPoints(this.dragAnchor, point);
				this.dragMoved = this.dragMoved || distanceBetween(this.dragAnchor, point) >= 0.003;
				this.scheduleInteractionRedraw(pageNumber);
				return;
			}
			const previousPoint = this.currentLasso.points[this.currentLasso.points.length - 1];
			if (!previousPoint || distanceBetween(previousPoint, point) >= 0.003) {
				this.currentLasso.points.push(point);
				this.scheduleInteractionRedraw(pageNumber);
			}
			return;
		}
		if (this.currentTool === "region" && this.currentLasso && this.dragAnchor && this.pointerPage === pageNumber) {
			this.currentLasso.points = getSelectionBoxPoints(this.dragAnchor, point);
			this.dragMoved = this.dragMoved || distanceBetween(this.dragAnchor, point) >= 0.003;
			this.scheduleInteractionRedraw(pageNumber);
			return;
		}
		if (this.currentTool === "text" && this.currentLasso && this.dragAnchor && this.pointerPage === pageNumber) {
			this.currentLasso.points = getSelectionBoxPoints(this.dragAnchor, point);
			this.dragMoved = this.dragMoved || distanceBetween(this.dragAnchor, point) >= 0.003;
			this.scheduleInteractionRedraw(pageNumber);
			return;
		}
		if (this.currentTool === "eraser" && this.erasingSession) {
			let changed = false;
			for (const sample of points) {
				if (this.lastEraserPoint && this.eraseAlongPath(pageNumber, this.lastEraserPoint, sample, false)) {
					changed = true;
				}
				this.lastEraserPoint = sample;
			}
			if (changed) {
				this.scheduleInteractionRedraw(pageNumber);
			}
			return;
		}
		if (!this.currentStroke && !this.currentShape) {
			return;
		}
		if (this.currentShape) {
			this.currentShape.end = point;
			this.scheduleInteractionRedraw(pageNumber);
			return;
		}

		if (this.currentStroke && appendStrokePoints(this.currentStroke, points, { mergeThreshold: this.getStrokeMergeThreshold(surface) })) {
			this.scheduleInteractionRedraw(pageNumber);
		}
	}

	private readonly handlePointerEnter = (event: PointerEvent): void => {
		this.handleViewPointerMove(event);
	};

	private readonly handlePointerUp = (event: PointerEvent): void => {
		if (this.shouldHandleDocumentPointer(event)) {
			return;
		}
		const canvas = isHtmlCanvasElement(event.currentTarget) ? event.currentTarget : null;
		this.handlePointerUpForCanvas(event, canvas);
	};

	private handlePointerUpForCanvas(event: PointerEvent, canvas: HTMLCanvasElement | null): void {
		const pageNumber = canvas ? Number(canvas.dataset.pageNumber) : this.pointerPage;
		if (canvas) {
			try {
				canvas.releasePointerCapture(event.pointerId);
			} catch {
				// noop
			}
			canvas.setCssStyles({ touchAction: this.getOverlayTouchAction() });
		}
		this.unbindPdfPointerDocumentTracking();

		const hasActiveInteraction =
			(this.currentTool === "select" && this.dragAnchor !== null) ||
			(this.currentTool === "select" && this.currentLasso !== null) ||
			(this.currentTool === "text" && this.dragAnchor !== null && this.selectedTarget !== null) ||
			(this.currentTool === "region" && this.currentLasso !== null) ||
			(this.currentTool === "text" && this.currentLasso !== null) ||
			(this.currentTool === "eraser" && this.erasingSession) ||
			this.currentStroke !== null ||
			this.currentShape !== null;
		if (!hasActiveInteraction || this.pointerPage === null || pageNumber !== this.pointerPage || !this.annotationDocument) {
			this.currentStroke = null;
			this.currentShape = null;
			this.dragAnchor = null;
			this.erasingSession = false;
			this.lastEraserPoint = null;
			this.pointerPage = null;
			return;
		}
		if (this.currentStroke && canvas) {
			const surface = this.pageSurfaces.get(pageNumber);
			if (surface) {
				appendStrokePoints(this.currentStroke, this.getNormalizedPoints(surface, event), {
					mergeThreshold: this.getStrokeMergeThreshold(surface)
				});
			}
		}
		if (this.currentStroke || this.currentShape) {
			this.cancelPendingInteractionRedraw();
		} else {
			this.flushInteractionRedraw(pageNumber);
		}

		if (this.currentTool === "region") {
			const lasso = this.currentLasso;
			this.currentLasso = null;
			this.pointerPage = null;
			this.activeResizeHandle = null;
			this.dragAnchor = null;
			const regionRect = lasso ? normalizeRect(getPolygonBounds(lasso.points)) : null;
			this.lastSelectionRegion = regionRect ? { page: pageNumber, rect: regionRect } : null;
			this.drawAllAnnotations();
			this.refreshStatus(this.lastSelectionRegion ? "Region captured. Use Copy embed." : "Region too small");
			this.refreshToolbar();
			this.refreshToolPreviewFromLastPointer(false);
			return;
		}

		if (this.currentTool === "text") {
			if (this.selectedTarget && this.dragAnchor && !this.currentLasso) {
				this.dragAnchor = null;
				this.pointerPage = null;
				this.activeResizeHandle = null;
				if (canvas) {
					canvas.setCssStyles({ cursor: "text" });
				}
				if (this.dragMoved) {
					this.markDirtyAndRedraw("Text box updated");
				} else {
					if (this.undoStack.length > 0) {
						this.undoStack.pop();
					}
					this.drawAllAnnotations();
				}
				this.dragMoved = false;
				this.refreshToolPreviewFromLastPointer(false);
				return;
			}
			const lasso = this.currentLasso;
			const start = this.dragAnchor;
			this.currentLasso = null;
			this.pointerPage = null;
			this.activeResizeHandle = null;
			this.dragAnchor = null;
			this.drawAllAnnotations();
			const surface = this.pageSurfaces.get(pageNumber);
			if (!surface || !start) {
				return;
			}
			const rect = lasso ? normalizeRect(getPolygonBounds(lasso.points)) : null;
			const boxWidthScale = rect && this.dragMoved
				? clamp(rect.right - rect.left, 0.04, 0.9)
				: undefined;
			const boxHeightScale = rect && this.dragMoved
				? clamp(rect.bottom - rect.top, 0.026, 0.9)
				: undefined;
			const point = rect && this.dragMoved
				? { x: rect.left, y: rect.top, pressure: 0.5 }
				: start;
			void this.insertSessionTextAtPoint(pageNumber, point, boxWidthScale, boxHeightScale);
			this.dragMoved = false;
			this.refreshToolPreviewFromLastPointer(false);
			return;
		}

		if (this.currentTool === "select") {
			if (this.currentLasso) {
				const lasso = this.currentLasso;
				const boxClickPoint = this.toolState.selectionMode === "box" && !this.dragMoved
					? (this.dragAnchor ?? lasso.points[0])
					: null;
				this.currentLasso = null;
				this.pointerPage = null;
				this.activeResizeHandle = null;
				this.lastSelectionRegion = null;
				const clickHit = boxClickPoint ? this.findSelectableTarget(pageNumber, boxClickPoint) : null;
				const hits = clickHit ? [clickHit] : this.findTargetsInLasso(lasso);
				if ((event.shiftKey || event.ctrlKey || event.metaKey) && hits.length > 0) {
					const existingKeys = new Set(this.selectedTargets.map((target) => `${target.kind}:${target.page}:${target.id}`));
					this.selectedTargets = [
						...this.selectedTargets,
						...hits.filter((target) => !existingKeys.has(`${target.kind}:${target.page}:${target.id}`))
					];
				} else {
					this.selectedTargets = hits;
				}
				this.selectedTarget = this.selectedTargets[0] ?? null;
				this.dragAnchor = null;
				this.dragMoved = false;
				this.drawAllAnnotations();
				const selectionVerb = this.toolState.selectionMode === "box" ? "Box selected" : "Lasso selected";
				const emptyMessage = this.toolState.selectionMode === "box" ? "Box found nothing" : "Lasso found nothing";
				this.refreshStatus(this.selectedTargets.length > 0 ? `${selectionVerb} ${this.selectedTargets.length} objects` : emptyMessage);
				this.refreshToolbar();
				this.refreshToolPreviewFromLastPointer(false);
				return;
			}
			this.dragAnchor = null;
			this.pointerPage = null;
			this.activeResizeHandle = null;
			if (canvas) {
				canvas.setCssStyles({ cursor: "grab" });
			}
			if (this.dragMoved) {
				this.markDirtyAndRedraw("Selection updated");
			} else {
				if (this.undoStack.length > 0) {
					this.undoStack.pop();
				}
				this.refreshStatus("Selection ready");
				this.drawAllAnnotations();
			}
			this.dragMoved = false;
			this.refreshToolPreviewFromLastPointer(false);
			return;
		}
		if (this.currentTool === "eraser") {
			this.erasingSession = false;
			this.lastEraserPoint = null;
			this.pointerPage = null;
			if (this.isDirty) {
				this.markDirtyAndRedraw(`Erased (${this.eraserMode})`);
			} else {
				if (this.undoStack.length > 0) {
					this.undoStack.pop();
				}
				this.refreshStatus("Eraser ready");
				this.drawAllAnnotations();
			}
			this.refreshToolPreviewFromLastPointer(false);
			return;
		}

		if (this.currentShape) {
			this.annotationDocument.shapes.push(this.currentShape);
		} else if (this.currentStroke && this.currentStroke.points.length > 0) {
			this.refreshStatus(`Saving stroke: ${this.currentStroke.points.length} points`, 3000);
			this.annotationDocument.strokes.push(this.currentStroke);
		}
		this.invalidateAnnotationPageCache();
		this.isDirty = true;
		this.scheduleSave();
		this.currentStroke = null;
		this.currentShape = null;
		this.pointerPage = null;
		this.refreshToolPreviewFromLastPointer(false);
		this.flushInteractionRedraw(pageNumber);
		this.refreshStatus(isShapeTool(this.currentTool) ? "Shape saved" : "Stroke saved");
	}

	private readonly handlePointerCancel = (event: PointerEvent): void => {
		if (this.shouldHandleDocumentPointer(event)) {
			return;
		}
		const canvas = isHtmlCanvasElement(event.currentTarget) ? event.currentTarget : null;
		this.handlePointerCancelForCanvas(event, canvas);
	};

	private handlePointerCancelForCanvas(event: PointerEvent, canvas: HTMLCanvasElement | null): void {
		if (canvas) {
			try {
				canvas.releasePointerCapture(event.pointerId);
			} catch {
				// noop
			}
			canvas.setCssStyles({ touchAction: this.getOverlayTouchAction() });
		}
		this.unbindPdfPointerDocumentTracking();
		this.cancelActiveSessionInteraction();
	}

	private readonly handlePointerLeave = (): void => {
		if (!this.erasingSession) {
			this.refreshToolPreviewFromLastPointer(false);
		}
	};

	private getNormalizedPoint(surface: PageSurface, event: PointerEvent): AnnotationPoint {
		const rect = surface.overlayEl.getBoundingClientRect();
		const width = rect.width || 1;
		const height = rect.height || 1;
		const pressure = resolvePointerPressure(event, this.lastPdfPoint, this.lastPdfPointTime);
		const point = {
			x: clamp((event.clientX - rect.left) / width, 0, 1),
			y: clamp((event.clientY - rect.top) / height, 0, 1),
			pressure,
			t: event.timeStamp || performance.now()
		};
		this.lastPdfPoint = { clientX: event.clientX, clientY: event.clientY };
		this.lastPdfPointTime = event.timeStamp;
		return point;
	}

	private getNormalizedPoints(surface: PageSurface, event: PointerEvent): AnnotationPoint[] {
		return getCoalescedPointerEvents(event)
			.map((sample) => this.getNormalizedPoint(surface, sample));
	}

	private getStrokeMergeThreshold(surface: PageSurface): number {
		return 1 / Math.max(surface.lastWidth || surface.overlayEl.getBoundingClientRect().width || 1, 1);
	}

	private eraseAtPoint(pageNumber: number, point: AnnotationPoint, pushHistory = true): boolean {
		if (!this.annotationDocument) {
			return false;
		}

		const threshold = this.getEraserThreshold(pageNumber);
		const hit = this.findSelectableTarget(pageNumber, point, threshold);
		if (!hit) {
			return false;
		}

		if (hit.kind === "text") {
			const textIndex = this.annotationDocument.textItems.findIndex((item) => item.id === hit.id);
			if (textIndex < 0) {
				return false;
			}
			if (pushHistory) {
				this.pushHistory();
			}
			this.annotationDocument.textItems.splice(textIndex, 1);
			this.invalidateAnnotationPageCache();
			this.isDirty = true;
			this.scheduleSave();
			return true;
		}

		if (hit.kind === "stroke") {
			const strokeIndex = this.annotationDocument.strokes.findIndex((stroke) => stroke.id === hit.id);
			if (strokeIndex < 0) {
				return false;
			}
			if (pushHistory) {
				this.pushHistory();
			}
			const stroke = this.annotationDocument.strokes[strokeIndex];
			if (this.eraserMode === "object") {
				this.annotationDocument.strokes.splice(strokeIndex, 1);
			} else {
				const remainingSegments = splitStrokeByEraser(stroke, point, 0.02);
				this.annotationDocument.strokes.splice(strokeIndex, 1, ...remainingSegments);
			}
			this.invalidateAnnotationPageCache();
			this.isDirty = true;
			this.scheduleSave();
			return true;
		}

		if (hit.kind === "image") {
			const imageIndex = (this.annotationDocument.imageItems ?? []).findIndex((image) => image.id === hit.id);
			if (imageIndex < 0) {
				return false;
			}
			if (pushHistory) {
				this.pushHistory();
			}
			this.annotationDocument.imageItems?.splice(imageIndex, 1);
			this.invalidateAnnotationPageCache();
			this.isDirty = true;
			this.scheduleSave();
			return true;
		}

		const shapeIndex = this.annotationDocument.shapes.findIndex((shape) => shape.id === hit.id);
		if (shapeIndex >= 0) {
			if (pushHistory) {
				this.pushHistory();
			}
			this.annotationDocument.shapes.splice(shapeIndex, 1);
			this.invalidateAnnotationPageCache();
			this.isDirty = true;
			this.scheduleSave();
			return true;
		}

		return false;
	}

	private eraseAlongPath(
		pageNumber: number,
		start: AnnotationPoint,
		end: AnnotationPoint,
		pushHistory = true
	): boolean {
		if (!this.annotationDocument) {
			return false;
		}

		let changed = false;
		const threshold = this.getEraserThreshold(pageNumber);
		const segmentHit = (point: AnnotationPoint) => distanceToSegment(point, start, end) <= threshold;

		if (this.eraserMode === "object") {
			return this.eraseObjectAlongPath(pageNumber, start, end, threshold, pushHistory);
		}

		const nextStrokes: StrokeAnnotation[] = [];
		const textIdsToErase = new Set<string>();
		for (const item of this.annotationDocument.textItems) {
			if (item.page !== pageNumber) {
				continue;
			}
			const bounds = getTextBounds(item);
			if (segmentIntersectsExpandedBounds(start, end, bounds, threshold)) {
				textIdsToErase.add(item.id);
			}
		}
		if (textIdsToErase.size > 0) {
			if (pushHistory && !changed) {
				this.pushHistory();
			}
			this.annotationDocument.textItems = this.annotationDocument.textItems.filter((item) => !textIdsToErase.has(item.id));
			changed = true;
		}
		for (const stroke of this.annotationDocument.strokes) {
			if (stroke.page !== pageNumber) {
				nextStrokes.push(stroke);
				continue;
			}
			const touched = stroke.points.some((strokePoint) => segmentHit(strokePoint));
			if (!touched) {
				nextStrokes.push(stroke);
				continue;
			}
			if (pushHistory && !changed) {
				this.pushHistory();
			}
			changed = true;
			nextStrokes.push(...splitStrokeByEraserPath(stroke, start, end, threshold));
		}

		if (changed) {
			this.invalidateAnnotationPageCache();
			this.annotationDocument.strokes = nextStrokes;
			this.isDirty = true;
			this.scheduleSave();
		}

		return changed;
	}

	private eraseObjectAlongPath(
		pageNumber: number,
		start: AnnotationPoint,
		end: AnnotationPoint,
		threshold: number,
		pushHistory = true
	): boolean {
		if (!this.annotationDocument) {
			return false;
		}

		const hit = this.findObjectEraseTargetAlongPath(pageNumber, start, end, threshold);
		if (!hit) {
			return false;
		}
		return this.eraseTarget(hit, pushHistory);
	}

	private findObjectEraseTargetAlongPath(
		pageNumber: number,
		start: AnnotationPoint,
		end: AnnotationPoint,
		threshold: number
	): SelectedTarget | null {
		if (!this.annotationDocument) {
			return null;
		}
		const candidates: HitCandidate[] = [];

		for (let index = this.annotationDocument.textItems.length - 1; index >= 0; index -= 1) {
			const item = this.annotationDocument.textItems[index];
			if (item.page !== pageNumber) {
				continue;
			}
			const bounds = getTextBounds(item);
			if (segmentIntersectsExpandedBounds(start, end, bounds, threshold)) {
				candidates.push({ kind: "text", id: item.id, page: pageNumber, score: distanceToRectEdge(start, bounds) });
			}
		}

		for (let index = (this.annotationDocument.imageItems ?? []).length - 1; index >= 0; index -= 1) {
			const image = this.annotationDocument.imageItems?.[index];
			if (!image || image.page !== pageNumber) {
				continue;
			}
			const bounds = this.getImageBounds(image);
			if (segmentIntersectsExpandedBounds(start, end, bounds, threshold)) {
				candidates.push({ kind: "image", id: image.id, page: pageNumber, score: distanceToRectEdge(start, bounds) });
			}
		}

		for (let index = this.annotationDocument.shapes.length - 1; index >= 0; index -= 1) {
			const shape = this.annotationDocument.shapes[index];
			if (shape.page !== pageNumber) {
				continue;
			}
			let score = Number.POSITIVE_INFINITY;
			if (shape.tool === "line") {
				score = distanceBetweenSegments(start, end, shape.start, shape.end);
			} else {
				const bounds = getShapeBounds(shape);
				if (segmentIntersectsExpandedBounds(start, end, bounds, threshold)) {
					score = Math.min(distanceToShape(start, shape), distanceToShape(end, shape));
				}
			}
			if (score <= threshold * 1.5) {
				candidates.push({ kind: "shape", id: shape.id, page: pageNumber, score });
			}
		}

		for (let index = this.annotationDocument.strokes.length - 1; index >= 0; index -= 1) {
			const stroke = this.annotationDocument.strokes[index];
			if (stroke.page !== pageNumber || stroke.points.length === 0) {
				continue;
			}
			let score = Math.min(distanceToSegment(stroke.points[0], start, end), distanceToStroke(start, stroke), distanceToStroke(end, stroke));
			for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex += 1) {
				score = Math.min(score, distanceBetweenSegments(start, end, stroke.points[pointIndex - 1], stroke.points[pointIndex]));
				if (score <= threshold) {
					break;
				}
			}
			if (score <= threshold) {
				candidates.push({ kind: "stroke", id: stroke.id, page: pageNumber, score });
			}
		}

		if (candidates.length === 0) {
			return null;
		}
		candidates.sort((left, right) => left.score - right.score);
		const best = candidates[0];
		return { kind: best.kind, id: best.id, page: best.page };
	}

	private eraseTarget(target: SelectedTarget, pushHistory = true): boolean {
		if (!this.annotationDocument) {
			return false;
		}
		if (target.kind === "text") {
			const textIndex = this.annotationDocument.textItems.findIndex((item) => item.id === target.id);
			if (textIndex < 0) {
				return false;
			}
			if (pushHistory) {
				this.pushHistory();
			}
			this.annotationDocument.textItems.splice(textIndex, 1);
		} else if (target.kind === "stroke") {
			const strokeIndex = this.annotationDocument.strokes.findIndex((stroke) => stroke.id === target.id);
			if (strokeIndex < 0) {
				return false;
			}
			if (pushHistory) {
				this.pushHistory();
			}
			this.annotationDocument.strokes.splice(strokeIndex, 1);
		} else if (target.kind === "shape") {
			const shapeIndex = this.annotationDocument.shapes.findIndex((shape) => shape.id === target.id);
			if (shapeIndex < 0) {
				return false;
			}
			if (pushHistory) {
				this.pushHistory();
			}
			this.annotationDocument.shapes.splice(shapeIndex, 1);
		} else {
			const imageIndex = (this.annotationDocument.imageItems ?? []).findIndex((image) => image.id === target.id);
			if (imageIndex < 0) {
				return false;
			}
			if (pushHistory) {
				this.pushHistory();
			}
			this.annotationDocument.imageItems?.splice(imageIndex, 1);
		}
		this.invalidateAnnotationPageCache();
		this.isDirty = true;
		this.scheduleSave();
		return true;
	}

	private drawAllAnnotations(): void {
		for (const pageNumber of this.pageSurfaces.keys()) {
			this.schedulePageRedraw(pageNumber);
		}
	}

	private invalidateAnnotationPageCache(): void {
		this.annotationPageCache = null;
		this.strokePathCache.clear();
	}

	private getPageAnnotationBucket(pageNumber: number): PageAnnotationBucket {
		if (!this.annotationDocument) {
			return { strokes: [], textItems: [], shapes: [], imageItems: [] };
		}
		if (!this.annotationPageCache) {
			const cache = new Map<number, PageAnnotationBucket>();
			const getBucket = (page: number): PageAnnotationBucket => {
				let bucket = cache.get(page);
				if (!bucket) {
					bucket = { strokes: [], textItems: [], shapes: [], imageItems: [] };
					cache.set(page, bucket);
				}
				return bucket;
			};
			for (const stroke of this.annotationDocument.strokes) {
				getBucket(stroke.page).strokes.push(stroke);
			}
			for (const textItem of this.annotationDocument.textItems) {
				getBucket(textItem.page).textItems.push(textItem);
			}
			for (const shape of this.annotationDocument.shapes) {
				getBucket(shape.page).shapes.push(shape);
			}
			for (const image of this.annotationDocument.imageItems ?? []) {
				getBucket(image.page).imageItems.push(image);
			}
			this.annotationPageCache = cache;
		}
		return this.annotationPageCache.get(pageNumber) ?? { strokes: [], textItems: [], shapes: [], imageItems: [] };
	}

	private drawPageAnnotations(pageNumber: number): void {
		if (!this.annotationDocument) {
			return;
		}

		const surface = this.pageSurfaces.get(pageNumber);
		if (!surface) {
			return;
		}

		if (!surface.overlayEl.isConnected || !surface.hostEl.isConnected) {
			return;
		}

		this.ensureOverlayLayerOrder(surface);
		this.resizeOverlay(surface);
		if (!surface.overlayEl.isConnected) {
			this.scheduleSyncPages();
			return;
		}
		const context = surface.overlayEl.getContext("2d");
		if (!context) {
			return;
		}

		const ratio = window.devicePixelRatio || 1;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, surface.lastWidth, surface.lastHeight);

		const bucket = this.getPageAnnotationBucket(pageNumber);
		for (const imageItem of bucket.imageItems) {
			this.drawImageAnnotation(context, surface, imageItem);
		}
		for (const renderable of getAnnotationRenderables(bucket.strokes, bucket.textItems, bucket.shapes)) {
			if (renderable.kind === "stroke") {
				this.drawStroke(context, surface, renderable.annotation);
			} else if (renderable.kind === "text") {
				if (this.inlineTextTargetId === renderable.annotation.id && this.inlineTextPageNumber === pageNumber) {
					continue;
				}
				this.drawText(context, surface, renderable.annotation);
			} else {
				this.drawShape(context, surface, renderable.annotation);
			}
		}
		const inlinePreviewText = this.getInlineTextPreviewItem(pageNumber);
		if (inlinePreviewText) {
			this.drawText(context, surface, inlinePreviewText);
		}
		const pageSelections = this.selectedTargets.filter((target) => target.page === pageNumber);
		if (pageSelections.length > 0) {
			this.drawSelection(context, surface, pageSelections);
		}
		if (this.lastSelectionRegion?.page === pageNumber) {
			this.drawFocusedRegion(context, surface, this.lastSelectionRegion.rect);
		}
		if (this.focusedRegion && this.focusedRegionPage === pageNumber) {
			this.drawFocusedRegion(context, surface, this.focusedRegion);
		}
		this.clearTransientLayer(surface);
		this.drawTransientPageAnnotations(pageNumber);
	}

	private drawImageAnnotation(context: CanvasRenderingContext2D, surface: PageSurface, imageItem: ImageAnnotation): void {
		const x = imageItem.x * surface.lastWidth;
		const y = imageItem.y * surface.lastHeight;
		const width = Math.max(1, imageItem.widthScale * surface.lastWidth);
		const height = Math.max(1, imageItem.heightScale * surface.lastHeight);
		let image = this.imageElementCache.get(imageItem.id);
		if (!image || image.src !== imageItem.dataUrl) {
			image = new Image();
			image.onload = () => this.drawPageAnnotations(imageItem.page);
			image.src = imageItem.dataUrl;
			this.imageElementCache.set(imageItem.id, image);
		}
		if (!image.complete || image.naturalWidth <= 0) {
			context.save();
			context.strokeStyle = "rgba(120, 120, 120, 0.45)";
			context.setLineDash([6, 4]);
			context.strokeRect(x, y, width, height);
			context.restore();
			return;
		}
		context.save();
		context.globalAlpha = 1;
		context.drawImage(image, x, y, width, height);
		context.restore();
	}

	private clearTransientLayer(surface: PageSurface): void {
		const context = surface.transientEl.getContext("2d");
		if (!context) {
			return;
		}
		const ratio = window.devicePixelRatio || 1;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, surface.lastWidth, surface.lastHeight);
	}

	private drawTransientPageAnnotations(pageNumber: number): void {
		const surface = this.pageSurfaces.get(pageNumber);
		if (!surface) {
			return;
		}
		this.ensureOverlayLayerOrder(surface);
		const context = surface.transientEl.getContext("2d");
		if (!context) {
			return;
		}
		const ratio = window.devicePixelRatio || 1;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, surface.lastWidth, surface.lastHeight);
		if (this.currentStroke?.page === pageNumber) {
			this.drawStroke(context, surface, this.currentStroke, true, true);
		}
		if (this.currentShape?.page === pageNumber) {
			this.drawShape(context, surface, this.currentShape);
		}
		if (this.currentLasso?.page === pageNumber) {
			this.drawLasso(context, surface, this.currentLasso);
		}
	}

	private drawStroke(
		context: CanvasRenderingContext2D,
		surface: PageSurface,
		stroke: StrokeAnnotation,
		predictTail = false,
		livePreview = false
	): void {
		if (stroke.points.length === 0) {
			return;
		}

		const widthScale = this.resolveStoredScale(stroke.width, stroke.widthScale, MAX_STROKE_WIDTH_SCALE);
		const baseWidth = Math.max(0.75, widthScale * surface.lastWidth);

		context.save();
		context.lineCap = "round";
		context.lineJoin = "round";
		context.strokeStyle = stroke.color;
		context.fillStyle = stroke.color;
		context.globalAlpha = stroke.tool === "highlighter" ? 0.24 : 0.96;
		context.globalCompositeOperation = "source-over";

		if (stroke.tool === "highlighter") {
			this.drawReliablePdfStroke(context, surface, stroke, baseWidth, false, predictTail, livePreview);
			context.restore();
			return;
		}

		this.drawReliablePdfStroke(context, surface, stroke, baseWidth, true, predictTail, livePreview);
		context.restore();
	}

	private drawReliablePdfStroke(
		context: CanvasRenderingContext2D,
		surface: PageSurface,
		stroke: StrokeAnnotation,
		baseWidth: number,
		usePressure: boolean,
		predictTail: boolean,
		livePreview = false
	): void {
		if (stroke.points.length === 0) {
			return;
		}
		if (!livePreview) {
			const cachedPath = this.getCachedStrokePath(surface, stroke, baseWidth, usePressure, predictTail);
			if (cachedPath) {
				context.fill(cachedPath);
				return;
			}
		}
		drawSmoothInkStroke(
			context,
			stroke.points,
			surface.lastWidth,
			surface.lastHeight,
			baseWidth,
			usePressure,
			predictTail,
			{ renderMode: livePreview ? "live" : "committed" }
		);
	}

	private getCachedStrokePath(
		surface: PageSurface,
		stroke: StrokeAnnotation,
		baseWidth: number,
		usePressure: boolean,
		predictTail: boolean
	): Path2D | null {
		if (predictTail || stroke.points.length < 4) {
			return null;
		}
		const first = stroke.points[0];
		const last = stroke.points[stroke.points.length - 1];
		const signature = [
			surface.lastWidth.toFixed(1),
			surface.lastHeight.toFixed(1),
			baseWidth.toFixed(2),
			usePressure ? "p" : "u",
			stroke.points.length,
			first.x.toFixed(5),
			first.y.toFixed(5),
			last.x.toFixed(5),
			last.y.toFixed(5),
			last.pressure.toFixed(3)
		].join(":");
		const key = stroke.id;
		const cached = this.strokePathCache.get(key);
		if (cached?.signature === signature) {
			return cached.path;
		}
		const pathData = getSmoothInkStrokePath(
			stroke.points,
			surface.lastWidth,
			surface.lastHeight,
			baseWidth,
			usePressure,
			false
		);
		if (!pathData) {
			this.strokePathCache.delete(key);
			return null;
		}
		const path = new Path2D(pathData);
		this.strokePathCache.set(key, { signature, path });
		return path;
	}

	private drawText(context: CanvasRenderingContext2D, surface: PageSurface, textItem: TextAnnotation): void {
		context.save();
		context.fillStyle = textItem.color;
		const fontSize = Math.max(10, this.resolveStoredFontScale(textItem) * surface.lastWidth);
		const fontFamily = textItem.fontFamily ?? TEXT_FONT_FAMILIES[0];
		context.font = `${fontSize}px "${fontFamily}", sans-serif`;
		context.textBaseline = "top";
		const boxWidth = textItem.boxWidthScale && textItem.boxWidthScale > 0
			? textItem.boxWidthScale * surface.lastWidth
			: surface.lastWidth * 0.48;
		const innerWidth = Math.max(24, boxWidth - (INLINE_TEXT_BOX_PADDING_X * 2));
		const textLeft = (textItem.x * surface.lastWidth) + INLINE_TEXT_BOX_PADDING_X;
		const textTop = (textItem.y * surface.lastHeight) + INLINE_TEXT_BOX_PADDING_Y;
		getWrappedCanvasTextLines(context, textItem.text, innerWidth).forEach((line, index) => {
			context.fillText(line, textLeft, textTop + (index * fontSize * INLINE_TEXT_LINE_HEIGHT));
		});
		context.restore();
	}

	private getInlineTextPreviewItem(pageNumber: number): TextAnnotation | null {
		if (!this.annotationDocument || this.inlineTextPageNumber !== pageNumber || !this.inlineTextEditorEl || !this.inlineTextPoint) {
			return null;
		}
		const value = this.inlineTextEditorEl.value;
		if (!value.trim()) {
			return null;
		}
		const surface = this.pageSurfaces.get(pageNumber);
		const pageWidth = Math.max(surface?.lastWidth ?? 1, 1);
		const pageHeight = Math.max(surface?.lastHeight ?? 1, 1);
		const frameRect = this.inlineTextEditorFrameEl?.getBoundingClientRect() ?? null;
		const existing = this.inlineTextTargetId
			? this.annotationDocument.textItems.find((entry) => entry.id === this.inlineTextTargetId)
			: null;
		const boxWidthScale = frameRect ? clamp(frameRect.width / pageWidth, 0.04, 0.9) : existing?.boxWidthScale;
		const baseBoxHeightScale = frameRect ? clamp(frameRect.height / pageHeight, 0.025, 0.9) : existing?.boxHeightScale;
		const preview: TextAnnotation = {
			id: existing?.id ?? "inline-text-preview",
			page: pageNumber,
			text: value,
			x: this.inlineTextPoint.x,
			y: this.inlineTextPoint.y,
			color: this.inlineTextEditorEl.dataset.textColor || existing?.color || this.currentTextColor,
			fontSize: this.currentTextFontSize,
			fontFamily: this.currentTextFontFamily,
			fontScale: this.getStableTextFontScale(this.currentTextFontSize),
			boxWidthScale,
			boxHeightScale: baseBoxHeightScale,
			zIndex: existing?.zIndex ?? this.getNextPageZIndex(pageNumber),
			createdAt: existing?.createdAt ?? new Date().toISOString()
		};
		const measuredHeightScale = surface ? this.measureTextBoxHeightScale(surface, preview) : null;
		if (measuredHeightScale) {
			preview.boxHeightScale = Math.max(baseBoxHeightScale ?? 0, measuredHeightScale);
		}
		return preview;
	}

	private measureTextBoxHeightScale(surface: PageSurface, textItem: TextAnnotation): number | null {
		const context = surface.overlayEl.getContext("2d");
		if (!context) {
			return null;
		}
		const fontSize = textItem.fontScale ? Math.max(10, textItem.fontScale * surface.lastWidth) : textItem.fontSize;
		const fontFamily = textItem.fontFamily ?? TEXT_FONT_FAMILIES[0];
		const boxWidth = textItem.boxWidthScale && textItem.boxWidthScale > 0
			? textItem.boxWidthScale * surface.lastWidth
			: surface.lastWidth * 0.48;
		context.save();
		context.font = `${fontSize}px "${fontFamily}", sans-serif`;
		const lineCount = Math.max(1, getWrappedCanvasTextLines(context, textItem.text || " ", Math.max(24, boxWidth - (INLINE_TEXT_BOX_PADDING_X * 2))).length);
		context.restore();
		const measuredHeight = (INLINE_TEXT_BOX_PADDING_Y * 2) + (lineCount * fontSize * INLINE_TEXT_LINE_HEIGHT) + 2;
		return clamp(measuredHeight / Math.max(surface.lastHeight, 1), 0.025, 0.9);
	}

	private updateInlineTextEditorBoxFromContent(pageNumber: number): void {
		const preview = this.getInlineTextPreviewItem(pageNumber);
		const surface = this.pageSurfaces.get(pageNumber);
		if (!preview?.boxHeightScale || !surface || !this.inlineTextEditorFrameEl || !this.inlineTextEditorEl) {
			return;
		}
		this.inlineTextEditorFrameEl.setCssStyles({ height: `${preview.boxHeightScale * surface.lastHeight}px` });
		this.inlineTextEditorEl.setCssStyles({ height: "100%" });
	}

	private drawShape(context: CanvasRenderingContext2D, surface: PageSurface, shape: ShapeAnnotation): void {
		const startX = shape.start.x * surface.lastWidth;
		const startY = shape.start.y * surface.lastHeight;
		const endX = shape.end.x * surface.lastWidth;
		const endY = shape.end.y * surface.lastHeight;
		const width = endX - startX;
		const height = endY - startY;

		context.save();
		context.strokeStyle = shape.color;
		context.lineWidth = Math.max(1, this.resolveStoredScale(shape.width, shape.widthScale, MAX_STROKE_WIDTH_SCALE) * surface.lastWidth);
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
			context.strokeRect(startX, startY, width, height);
			context.restore();
			return;
		}

		const centerX = startX + width / 2;
		const centerY = startY + height / 2;
		context.beginPath();
		context.ellipse(centerX, centerY, Math.abs(width) / 2, Math.abs(height) / 2, 0, 0, Math.PI * 2);
		context.stroke();
		context.restore();
	}

	private drawSelection(context: CanvasRenderingContext2D, surface: PageSurface, targets: SelectedTarget[]): void {
		const visibleTargets = targets.filter((target) => !(target.kind === "text" && target.id === this.inlineTextTargetId && target.page === this.inlineTextPageNumber));
		if (visibleTargets.length === 0) {
			return;
		}
		context.save();
		for (const target of visibleTargets) {
			const bounds = this.getTargetBounds(target);
			if (!bounds) {
				continue;
			}
			context.strokeStyle = "#4da3ff";
			context.lineWidth = 1.5;
			context.setLineDash([6, 4]);
			context.strokeRect(
				bounds.left * surface.lastWidth,
				bounds.top * surface.lastHeight,
				(bounds.right - bounds.left) * surface.lastWidth,
				(bounds.bottom - bounds.top) * surface.lastHeight
			);
		}
		if (visibleTargets.length === 1) {
			const bounds = this.getTargetBounds(visibleTargets[0]);
			if (bounds) {
				for (const handle of this.getHandlePoints(bounds)) {
					context.beginPath();
					context.fillStyle = "#ffffff";
					context.strokeStyle = "#4da3ff";
					context.setLineDash([]);
					const radius = this.getResizeHandleVisualRadius(surface);
					context.arc(handle.x * surface.lastWidth, handle.y * surface.lastHeight, radius, 0, Math.PI * 2);
					context.fill();
					context.stroke();
				}
			}
		}
		if (visibleTargets.length > 1) {
			const bounds = this.getCombinedBounds(visibleTargets);
			if (bounds) {
				context.strokeStyle = "#4da3ff";
				context.lineWidth = 1;
				context.setLineDash([3, 5]);
				context.strokeRect(
					bounds.left * surface.lastWidth,
					bounds.top * surface.lastHeight,
					(bounds.right - bounds.left) * surface.lastWidth,
					(bounds.bottom - bounds.top) * surface.lastHeight
				);
				for (const handle of this.getHandlePoints(bounds)) {
					context.beginPath();
					context.fillStyle = "#ffffff";
					context.strokeStyle = "#4da3ff";
					context.setLineDash([]);
					const radius = this.getResizeHandleVisualRadius(surface);
					context.arc(handle.x * surface.lastWidth, handle.y * surface.lastHeight, radius, 0, Math.PI * 2);
					context.fill();
					context.stroke();
				}
			}
		}
		context.restore();
	}

	private drawLasso(context: CanvasRenderingContext2D, surface: PageSurface, lasso: LassoSelection): void {
		if (lasso.points.length < 2) {
			return;
		}
		context.save();
		context.fillStyle = "rgba(77, 163, 255, 0.08)";
		context.strokeStyle = "rgba(77, 163, 255, 0.92)";
		context.lineWidth = 1.5;
		context.setLineDash([7, 5]);
		context.beginPath();
		context.moveTo(lasso.points[0].x * surface.lastWidth, lasso.points[0].y * surface.lastHeight);
		for (let index = 1; index < lasso.points.length; index += 1) {
			const point = lasso.points[index];
			context.lineTo(point.x * surface.lastWidth, point.y * surface.lastHeight);
		}
		if (lasso.points.length >= 3) {
			context.closePath();
			context.fill();
		}
		context.stroke();
		context.restore();
	}

	private drawFocusedRegion(
		context: CanvasRenderingContext2D,
		surface: PageSurface,
		bounds: { left: number; top: number; right: number; bottom: number }
	): void {
		context.save();
		context.fillStyle = "rgba(77, 163, 255, 0.12)";
		context.strokeStyle = "rgba(77, 163, 255, 0.95)";
		context.lineWidth = 2;
		context.setLineDash([8, 5]);
		context.fillRect(
			bounds.left * surface.lastWidth,
			bounds.top * surface.lastHeight,
			(bounds.right - bounds.left) * surface.lastWidth,
			(bounds.bottom - bounds.top) * surface.lastHeight
		);
		context.strokeRect(
			bounds.left * surface.lastWidth,
			bounds.top * surface.lastHeight,
			(bounds.right - bounds.left) * surface.lastWidth,
			(bounds.bottom - bounds.top) * surface.lastHeight
		);
		context.restore();
	}

	private findSelectableTarget(pageNumber: number, point: AnnotationPoint, threshold = 0.03): SelectedTarget | null {
		if (!this.annotationDocument) {
			return null;
		}
		const candidates: HitCandidate[] = [];

		for (let index = (this.annotationDocument.imageItems ?? []).length - 1; index >= 0; index -= 1) {
			const image = this.annotationDocument.imageItems?.[index];
			if (!image || image.page !== pageNumber) {
				continue;
			}
			const bounds = this.getImageBounds(image);
			if (pointInBounds(point, bounds, threshold)) {
				const score = pointInBounds(point, bounds)
					? -0.04
					: distanceToBounds(point, bounds);
				candidates.push({ kind: "image", id: image.id, page: pageNumber, score });
			}
		}

		for (let index = this.annotationDocument.textItems.length - 1; index >= 0; index -= 1) {
			const item = this.annotationDocument.textItems[index];
			if (item.page !== pageNumber) {
				continue;
			}
			const textBounds = getTextBounds(item);
			if (pointInBounds(point, textBounds, threshold)) {
				const score = pointInBounds(point, textBounds)
					? -0.03
					: distanceToBounds(point, textBounds);
				candidates.push({ kind: "text", id: item.id, page: pageNumber, score });
			}
		}

		for (let index = this.annotationDocument.shapes.length - 1; index >= 0; index -= 1) {
			const shape = this.annotationDocument.shapes[index];
			if (shape.page !== pageNumber) {
				continue;
			}
			const bounds = getShapeBounds(shape);
			if (shape.tool !== "line" && pointInBounds(point, bounds)) {
				candidates.push({ kind: "shape", id: shape.id, page: pageNumber, score: -0.02 });
				continue;
			}
			if (pointInBounds(point, bounds, threshold)) {
				const score = distanceToShape(point, shape);
				if (score <= threshold * 1.5 || pointInBounds(point, bounds)) {
					candidates.push({ kind: "shape", id: shape.id, page: pageNumber, score });
				}
			}
		}

		for (let index = this.annotationDocument.strokes.length - 1; index >= 0; index -= 1) {
			const stroke = this.annotationDocument.strokes[index];
			if (stroke.page !== pageNumber) {
				continue;
			}
			const score = distanceToStroke(point, stroke);
			if (score <= threshold) {
				candidates.push({ kind: "stroke", id: stroke.id, page: pageNumber, score });
			}
		}

		if (candidates.length === 0) {
			return null;
		}
		candidates.sort((left, right) => left.score - right.score);
		const best = candidates[0];
		return { kind: best.kind, id: best.id, page: best.page };
	}

	private moveSelectedTarget(target: SelectedTarget, deltaX: number, deltaY: number): void {
		if (!this.annotationDocument) {
			return;
		}
		if (target.kind === "text") {
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			if (!item) {
				return;
			}
			item.x = clamp(item.x + deltaX, 0, 1);
			item.y = clamp(item.y + deltaY, 0, 1);
			return;
		}
		if (target.kind === "shape") {
			const shape = this.annotationDocument.shapes.find((entry) => entry.id === target.id);
			if (!shape) {
				return;
			}
			shape.start = {
				...shape.start,
				x: clamp(shape.start.x + deltaX, 0, 1),
				y: clamp(shape.start.y + deltaY, 0, 1)
			};
			shape.end = {
				...shape.end,
				x: clamp(shape.end.x + deltaX, 0, 1),
				y: clamp(shape.end.y + deltaY, 0, 1)
			};
			return;
		}
		if (target.kind === "image") {
			const image = (this.annotationDocument.imageItems ?? []).find((entry) => entry.id === target.id);
			if (!image) {
				return;
			}
			image.x = clamp(image.x + deltaX, 0, Math.max(0, 1 - image.widthScale));
			image.y = clamp(image.y + deltaY, 0, Math.max(0, 1 - image.heightScale));
			return;
		}
		const stroke = this.annotationDocument.strokes.find((entry) => entry.id === target.id);
		if (!stroke) {
			return;
		}
		stroke.points = stroke.points.map((strokePoint) => ({
			...strokePoint,
			x: clamp(strokePoint.x + deltaX, 0, 1),
			y: clamp(strokePoint.y + deltaY, 0, 1)
		}));
	}

	private resizeSelectedTarget(target: SelectedTarget, handle: ResizeHandle, deltaX: number, deltaY: number): void {
		if (!this.annotationDocument) {
			return;
		}
		this.resizeSelectedTargets([target], handle, deltaX, deltaY);
	}

	private resizeSelectedTargets(targets: SelectedTarget[], handle: ResizeHandle, deltaX: number, deltaY: number): void {
		if (!this.annotationDocument || targets.length === 0) {
			return;
		}
		const bounds = this.getCombinedBounds(targets);
		if (!bounds) {
			return;
		}

		const nextBounds = {
			left: bounds.left,
			right: bounds.right,
			top: bounds.top,
			bottom: bounds.bottom
		};

		switch (handle) {
			case "nw":
				nextBounds.left = clamp(bounds.left + deltaX, 0, bounds.right - 0.01);
				nextBounds.top = clamp(bounds.top + deltaY, 0, bounds.bottom - 0.01);
				break;
			case "n":
				nextBounds.top = clamp(bounds.top + deltaY, 0, bounds.bottom - 0.01);
				break;
			case "ne":
				nextBounds.right = clamp(bounds.right + deltaX, bounds.left + 0.01, 1);
				nextBounds.top = clamp(bounds.top + deltaY, 0, bounds.bottom - 0.01);
				break;
			case "e":
				nextBounds.right = clamp(bounds.right + deltaX, bounds.left + 0.01, 1);
				break;
			case "sw":
				nextBounds.left = clamp(bounds.left + deltaX, 0, bounds.right - 0.01);
				nextBounds.bottom = clamp(bounds.bottom + deltaY, bounds.top + 0.01, 1);
				break;
			case "w":
				nextBounds.left = clamp(bounds.left + deltaX, 0, bounds.right - 0.01);
				break;
			case "s":
				nextBounds.bottom = clamp(bounds.bottom + deltaY, bounds.top + 0.01, 1);
				break;
			case "se":
				nextBounds.right = clamp(bounds.right + deltaX, bounds.left + 0.01, 1);
				nextBounds.bottom = clamp(bounds.bottom + deltaY, bounds.top + 0.01, 1);
				break;
		}

		const resizingOnlyText = targets.every((target) => target.kind === "text");
		if (this.isCornerResizeHandle(handle) && !resizingOnlyText) {
			const proposedWidthScale = (nextBounds.right - nextBounds.left) / Math.max(bounds.right - bounds.left, 0.0001);
			const proposedHeightScale = (nextBounds.bottom - nextBounds.top) / Math.max(bounds.bottom - bounds.top, 0.0001);
			const uniformScale =
				Math.abs(proposedWidthScale - 1) >= Math.abs(proposedHeightScale - 1) ? proposedWidthScale : proposedHeightScale;

			switch (handle) {
				case "nw":
					nextBounds.left = clamp(bounds.right - (bounds.right - bounds.left) * uniformScale, 0, bounds.right - 0.01);
					nextBounds.top = clamp(bounds.bottom - (bounds.bottom - bounds.top) * uniformScale, 0, bounds.bottom - 0.01);
					break;
				case "ne":
					nextBounds.right = clamp(bounds.left + (bounds.right - bounds.left) * uniformScale, bounds.left + 0.01, 1);
					nextBounds.top = clamp(bounds.bottom - (bounds.bottom - bounds.top) * uniformScale, 0, bounds.bottom - 0.01);
					break;
				case "sw":
					nextBounds.left = clamp(bounds.right - (bounds.right - bounds.left) * uniformScale, 0, bounds.right - 0.01);
					nextBounds.bottom = clamp(bounds.top + (bounds.bottom - bounds.top) * uniformScale, bounds.top + 0.01, 1);
					break;
				case "se":
					nextBounds.right = clamp(bounds.left + (bounds.right - bounds.left) * uniformScale, bounds.left + 0.01, 1);
					nextBounds.bottom = clamp(bounds.top + (bounds.bottom - bounds.top) * uniformScale, bounds.top + 0.01, 1);
					break;
			}
		}

		const widthScale = (nextBounds.right - nextBounds.left) / Math.max(bounds.right - bounds.left, 0.0001);
		const heightScale = (nextBounds.bottom - nextBounds.top) / Math.max(bounds.bottom - bounds.top, 0.0001);

		for (const target of targets) {
			this.scaleTargetWithinBounds(target, bounds, nextBounds, widthScale, heightScale, handle);
		}
	}

	private scaleTargetWithinBounds(
		target: SelectedTarget,
		previousBounds: { left: number; right: number; top: number; bottom: number },
		nextBounds: { left: number; right: number; top: number; bottom: number },
		widthScale: number,
		heightScale: number,
		handle: ResizeHandle
	): void {
		if (!this.annotationDocument) {
			return;
		}

		const transformPoint = (point: AnnotationPoint): AnnotationPoint => ({
			...point,
			x: clamp(nextBounds.left + (point.x - previousBounds.left) * widthScale, 0, 1),
			y: clamp(nextBounds.top + (point.y - previousBounds.top) * heightScale, 0, 1)
		});

		if (target.kind === "stroke") {
			const stroke = this.annotationDocument.strokes.find((entry) => entry.id === target.id);
			if (!stroke) {
				return;
			}
			stroke.points = stroke.points.map((point) => transformPoint(point));
			return;
		}

		if (target.kind === "text") {
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			if (!item) {
				return;
			}
			const currentBounds = getTextBounds(item);
			const currentWidth = Math.max(item.boxWidthScale ?? (currentBounds.right - currentBounds.left), 0.04);
			const currentHeight = Math.max(item.boxHeightScale ?? (currentBounds.bottom - currentBounds.top), 0.026);
			const anchor = transformPoint({ x: item.x, y: item.y, pressure: 0.5 });
			item.x = anchor.x;
			item.y = anchor.y;
			item.boxWidthScale = clamp(currentWidth * widthScale, 0.04, 0.9);
			item.boxHeightScale = clamp(currentHeight * heightScale, 0.026, 0.9);
			return;
		}

		if (target.kind === "image") {
			const image = (this.annotationDocument.imageItems ?? []).find((entry) => entry.id === target.id);
			if (!image) {
				return;
			}
			const currentBounds = this.getImageBounds(image);
			image.x = clamp(nextBounds.left + (currentBounds.left - previousBounds.left) * widthScale, 0, 0.98);
			image.y = clamp(nextBounds.top + (currentBounds.top - previousBounds.top) * heightScale, 0, 0.98);
			image.widthScale = clamp(image.widthScale * widthScale, 0.02, 0.98);
			image.heightScale = clamp(image.heightScale * heightScale, 0.02, 0.98);
			image.x = clamp(image.x, 0, Math.max(0, 1 - image.widthScale));
			image.y = clamp(image.y, 0, Math.max(0, 1 - image.heightScale));
			return;
		}

		const shape = this.annotationDocument.shapes.find((entry) => entry.id === target.id);
		if (!shape) {
			return;
		}
		shape.start = transformPoint(shape.start);
		shape.end = transformPoint(shape.end);
	}

	private isCornerResizeHandle(handle: ResizeHandle): boolean {
		return handle === "nw" || handle === "ne" || handle === "sw" || handle === "se";
	}

	private getResizeHandleHitThreshold(pageNumber: number): number {
		const surface = this.pageSurfaces.get(pageNumber);
		const minDimension = Math.min(surface?.lastWidth ?? 0, surface?.lastHeight ?? 0);
		if (!minDimension) {
			return 0.022;
		}
		return clamp(14 / minDimension, 0.012, 0.045);
	}

	private getResizeHandleVisualRadius(surface: PageSurface): number {
		const minDimension = Math.min(surface.lastWidth, surface.lastHeight);
		return minDimension < 520 ? 4.5 : 3.5;
	}

	private getTargetBounds(target: SelectedTarget): { left: number; right: number; top: number; bottom: number } | null {
		if (!this.annotationDocument) {
			return null;
		}
		if (target.kind === "text") {
			if (target.id === this.inlineTextTargetId && target.page === this.inlineTextPageNumber) {
				const preview = this.getInlineTextPreviewItem(target.page);
				if (preview) {
					return getTextBounds(preview);
				}
			}
			const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
			return item ? getTextBounds(item) : null;
		}
		if (target.kind === "shape") {
			const shape = this.annotationDocument.shapes.find((entry) => entry.id === target.id);
			return shape ? getShapeBounds(shape) : null;
		}
		if (target.kind === "image") {
			const image = (this.annotationDocument.imageItems ?? []).find((entry) => entry.id === target.id);
			return image ? this.getImageBounds(image) : null;
		}
		const stroke = this.annotationDocument.strokes.find((entry) => entry.id === target.id);
		return stroke ? getStrokeBounds(stroke) : null;
	}

	private getImageBounds(image: ImageAnnotation): { left: number; right: number; top: number; bottom: number } {
		return {
			left: clamp(image.x, 0, 1),
			right: clamp(image.x + image.widthScale, 0, 1),
			top: clamp(image.y, 0, 1),
			bottom: clamp(image.y + image.heightScale, 0, 1)
		};
	}

	private getCombinedBounds(targets: SelectedTarget[]): { left: number; right: number; top: number; bottom: number } | null {
		const boundsList = targets
			.map((target) => this.getTargetBounds(target))
			.filter((bounds): bounds is { left: number; right: number; top: number; bottom: number } => !!bounds);
		if (boundsList.length === 0) {
			return null;
		}
		return {
			left: Math.min(...boundsList.map((bounds) => bounds.left)),
			right: Math.max(...boundsList.map((bounds) => bounds.right)),
			top: Math.min(...boundsList.map((bounds) => bounds.top)),
			bottom: Math.max(...boundsList.map((bounds) => bounds.bottom))
		};
	}

	private getSelectionPage(): number | null {
		if (this.selectedTargets.length === 0) {
			return null;
		}
		const pages = new Set(this.selectedTargets.map((target) => target.page));
		return pages.size === 1 ? this.selectedTargets[0].page : null;
	}

	private findTargetsInLasso(lasso: LassoSelection): SelectedTarget[] {
		if (!this.annotationDocument || lasso.points.length < 3) {
			return [];
		}
		const hits: SelectedTarget[] = [];
		const polygonBounds = getPolygonBounds(lasso.points);
		if (polygonBounds.right - polygonBounds.left < 0.002 || polygonBounds.bottom - polygonBounds.top < 0.002) {
			return [];
		}
		const testPoints = (bounds: { left: number; right: number; top: number; bottom: number }) => [
			{ x: bounds.left, y: bounds.top, pressure: 0.5 },
			{ x: bounds.right, y: bounds.top, pressure: 0.5 },
			{ x: bounds.left, y: bounds.bottom, pressure: 0.5 },
			{ x: bounds.right, y: bounds.bottom, pressure: 0.5 },
			{ x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2, pressure: 0.5 }
		];

		const maybeAdd = (
			target: SelectedTarget,
			bounds: { left: number; right: number; top: number; bottom: number } | null,
			extraHit?: () => boolean
		) => {
			if (!bounds) {
				return;
			}
			if (!boundsOverlap(bounds, polygonBounds)) {
				return;
			}
			if (
				testPoints(bounds).some((point) => this.isPointInsidePolygon(point, lasso.points)) ||
				lasso.points.some((point) => point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom) ||
				this.doesPolygonIntersectBounds(lasso.points, bounds) ||
				(extraHit ? extraHit() : false)
			) {
				hits.push(target);
			}
		};

		for (const item of this.annotationDocument.textItems) {
			if (item.page === lasso.page) {
				maybeAdd({ kind: "text", id: item.id, page: item.page }, getTextBounds(item));
			}
		}
		for (const image of this.annotationDocument.imageItems ?? []) {
			if (image.page === lasso.page) {
				maybeAdd({ kind: "image", id: image.id, page: image.page }, this.getImageBounds(image));
			}
		}
		for (const shape of this.annotationDocument.shapes) {
			if (shape.page === lasso.page) {
				maybeAdd(
					{ kind: "shape", id: shape.id, page: shape.page },
					getShapeBounds(shape),
					() => this.doesPolygonIntersectShape(lasso.points, shape)
				);
			}
		}
		for (const stroke of this.annotationDocument.strokes) {
			if (stroke.page === lasso.page) {
				maybeAdd(
					{ kind: "stroke", id: stroke.id, page: stroke.page },
					getStrokeBounds(stroke),
					() => this.doesPolygonIntersectStroke(lasso.points, stroke)
				);
			}
		}

		return hits;
	}

	private doesPolygonIntersectBounds(
		polygon: AnnotationPoint[],
		bounds: { left: number; right: number; top: number; bottom: number }
	): boolean {
		const rectPoints: AnnotationPoint[] = [
			{ x: bounds.left, y: bounds.top, pressure: 0.5 },
			{ x: bounds.right, y: bounds.top, pressure: 0.5 },
			{ x: bounds.right, y: bounds.bottom, pressure: 0.5 },
			{ x: bounds.left, y: bounds.bottom, pressure: 0.5 }
		];
		return this.doPolylinesIntersectClosed(polygon, rectPoints);
	}

	private doesPolygonIntersectShape(polygon: AnnotationPoint[], shape: ShapeAnnotation): boolean {
		if (shape.tool === "line") {
			return this.doesPolygonIntersectPolyline(polygon, [shape.start, shape.end]);
		}
		return this.doesPolygonIntersectBounds(polygon, getShapeBounds(shape));
	}

	private doesPolygonIntersectStroke(polygon: AnnotationPoint[], stroke: StrokeAnnotation): boolean {
		if (stroke.points.length < 2) {
			return stroke.points.some((point) => this.isPointInsidePolygon(point, polygon));
		}
		return this.doesPolygonIntersectPolyline(polygon, stroke.points);
	}

	private doesPolygonIntersectPolyline(polygon: AnnotationPoint[], polyline: AnnotationPoint[]): boolean {
		for (let polygonIndex = 1; polygonIndex < polygon.length; polygonIndex += 1) {
			const polygonStart = polygon[polygonIndex - 1];
			const polygonEnd = polygon[polygonIndex];
			for (let lineIndex = 1; lineIndex < polyline.length; lineIndex += 1) {
				const lineStart = polyline[lineIndex - 1];
				const lineEnd = polyline[lineIndex];
				if (segmentsIntersect(polygonStart, polygonEnd, lineStart, lineEnd)) {
					return true;
				}
			}
		}
		const lastPolygonPoint = polygon[polygon.length - 1];
		const firstPolygonPoint = polygon[0];
		for (let lineIndex = 1; lineIndex < polyline.length; lineIndex += 1) {
			if (segmentsIntersect(lastPolygonPoint, firstPolygonPoint, polyline[lineIndex - 1], polyline[lineIndex])) {
				return true;
			}
		}
		return false;
	}

	private doPolylinesIntersectClosed(firstPolygon: AnnotationPoint[], secondPolygon: AnnotationPoint[]): boolean {
		return this.doesPolygonIntersectPolyline(firstPolygon, [...secondPolygon, secondPolygon[0]]);
	}

	private isPointInsidePolygon(point: AnnotationPoint, polygon: AnnotationPoint[]): boolean {
		let inside = false;
		for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
			const currentPoint = polygon[current];
			const previousPoint = polygon[previous];
			const intersects =
				((currentPoint.y > point.y) !== (previousPoint.y > point.y)) &&
				(point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / ((previousPoint.y - currentPoint.y) || 0.000001) + currentPoint.x);
			if (intersects) {
				inside = !inside;
			}
		}
		return inside;
	}

	private getHandlePoints(bounds: { left: number; right: number; top: number; bottom: number }): Array<{ handle: ResizeHandle; x: number; y: number }> {
		const midX = (bounds.left + bounds.right) / 2;
		const midY = (bounds.top + bounds.bottom) / 2;
		return [
			{ handle: "nw", x: bounds.left, y: bounds.top },
			{ handle: "n", x: midX, y: bounds.top },
			{ handle: "ne", x: bounds.right, y: bounds.top },
			{ handle: "e", x: bounds.right, y: midY },
			{ handle: "se", x: bounds.right, y: bounds.bottom },
			{ handle: "s", x: midX, y: bounds.bottom },
			{ handle: "sw", x: bounds.left, y: bounds.bottom },
			{ handle: "w", x: bounds.left, y: midY }
		];
	}

	private getHandleHit(target: SelectedTarget, point: AnnotationPoint): ResizeHandle | null {
		const bounds = this.getTargetBounds(target);
		if (!bounds) {
			return null;
		}
		const threshold = this.getResizeHandleHitThreshold(target.page);
		for (const handlePoint of this.getHandlePoints(bounds)) {
			if (distanceBetween(point, { x: handlePoint.x, y: handlePoint.y }) <= threshold) {
				return handlePoint.handle;
			}
		}
		return null;
	}

	private getSelectionHandleHit(pageNumber: number, point: AnnotationPoint): ResizeHandle | null {
		if (this.selectedTargets.length === 0) {
			return null;
		}
		if (this.selectedTargets.length === 1) {
			const target = this.selectedTarget;
			if (!target || target.page !== pageNumber) {
				return null;
			}
			return this.getHandleHit(target, point);
		}
		const pageTargets = this.selectedTargets.filter((target) => target.page === pageNumber);
		if (pageTargets.length < 2) {
			return null;
		}
		const bounds = this.getCombinedBounds(pageTargets);
		if (!bounds) {
			return null;
		}
		const threshold = this.getResizeHandleHitThreshold(pageNumber);
		for (const handlePoint of this.getHandlePoints(bounds)) {
			if (distanceBetween(point, { x: handlePoint.x, y: handlePoint.y }) <= threshold) {
				return handlePoint.handle;
			}
		}
		return null;
	}

	private isPointInsideSelection(pageNumber: number, point: AnnotationPoint): boolean {
		const pageTargets = this.selectedTargets.filter((target) => target.page === pageNumber);
		if (pageTargets.length === 0) {
			return false;
		}
		const bounds = this.getCombinedBounds(pageTargets);
		if (!bounds) {
			return false;
		}
		return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
	}

	private getSelectedTargetHit(pageNumber: number, point: AnnotationPoint): SelectedTarget | null {
		if (!this.annotationDocument) {
			return null;
		}
		const pageTargets = this.selectedTargets.filter((target) => target.page === pageNumber);
		if (pageTargets.length === 0) {
			return null;
		}
		const threshold = 0.03;
		const candidates: HitCandidate[] = [];
		for (const target of pageTargets) {
			if (target.kind === "text") {
				const item = this.annotationDocument.textItems.find((entry) => entry.id === target.id);
				if (!item) {
					continue;
				}
				const bounds = getTextBounds(item);
				if (pointInBounds(point, bounds, threshold)) {
					candidates.push({ ...target, score: pointInBounds(point, bounds) ? -0.03 : distanceToBounds(point, bounds) });
				}
				continue;
			}
			if (target.kind === "shape") {
				const shape = this.annotationDocument.shapes.find((entry) => entry.id === target.id);
				if (!shape) {
					continue;
				}
				const bounds = getShapeBounds(shape);
				if (shape.tool !== "line" && pointInBounds(point, bounds)) {
					candidates.push({ ...target, score: -0.02 });
					continue;
				}
				if (pointInBounds(point, bounds, threshold)) {
					const score = distanceToShape(point, shape);
					if (score <= threshold * 1.5 || pointInBounds(point, bounds)) {
						candidates.push({ ...target, score });
					}
				}
				continue;
			}
			const stroke = this.annotationDocument.strokes.find((entry) => entry.id === target.id);
			if (!stroke) {
				continue;
			}
			const score = distanceToStroke(point, stroke);
			if (score <= threshold) {
				candidates.push({ ...target, score });
			}
		}
		if (candidates.length === 0) {
			return null;
		}
		candidates.sort((left, right) => left.score - right.score);
		const best = candidates[0];
		return { kind: best.kind, id: best.id, page: best.page };
	}

	private isPointOnTextBoxBorder(item: TextAnnotation, point: AnnotationPoint, pageNumber: number): boolean {
		const bounds = getTextBounds(item);
		const threshold = this.getResizeHandleHitThreshold(pageNumber);
		if (!pointInBounds(point, bounds, threshold)) {
			return false;
		}
		const inner = {
			left: bounds.left + threshold,
			right: bounds.right - threshold,
			top: bounds.top + threshold,
			bottom: bounds.bottom - threshold
		};
		return inner.left >= inner.right || inner.top >= inner.bottom || !pointInBounds(point, inner);
	}

	private getCursorForHandle(handle: ResizeHandle): string {
		switch (handle) {
			case "nw":
			case "se":
				return "nwse-resize";
			case "n":
			case "s":
				return "ns-resize";
			case "ne":
			case "sw":
				return "nesw-resize";
			case "e":
			case "w":
				return "ew-resize";
		}
	}

	private pushHistory(): void {
		if (!this.annotationDocument) {
			return;
		}
		this.undoStack.push(cloneDocument(this.annotationDocument));
		if (this.undoStack.length > MAX_HISTORY) {
			this.undoStack.shift();
		}
		this.redoStack = [];
	}

	private markDirtyAndRedraw(message: string): void {
		this.invalidateAnnotationPageCache();
		this.isDirty = true;
		this.scheduleSave();
		this.drawAllAnnotations();
		this.refreshStatus(message);
	}

	private scheduleSave(): void {
		if (this.autosaveHandle !== null) {
			window.clearTimeout(this.autosaveHandle);
		}
		this.autosaveHandle = window.setTimeout(() => {
			void this.flushSave();
		}, this.plugin.getAutosaveDelayMs());
	}

	private destroyPageSurfaces(): void {
		this.unbindPdfPointerDocumentTracking();
		for (const surface of this.pageSurfaces.values()) {
			this.pageResizeObservers.get(surface.pageNumber)?.disconnect();
			surface.overlayEl.removeEventListener("pointerenter", this.handlePointerEnter);
			surface.overlayEl.removeEventListener("pointerdown", this.handlePointerDown);
			surface.overlayEl.removeEventListener("pointermove", this.handlePointerMove);
			surface.overlayEl.removeEventListener("pointerup", this.handlePointerUp);
			surface.overlayEl.removeEventListener("pointercancel", this.handlePointerCancel);
			surface.overlayEl.removeEventListener("pointerleave", this.handlePointerLeave);
			surface.overlayEl.remove();
			surface.transientEl.remove();
		}
		this.pageResizeObservers.clear();
		this.zoomingPages.clear();
		this.pageSurfaces.clear();
		this.handleToolbarDragEnd();
		const viewContentEl = this.getViewContentEl();
		viewContentEl?.removeEventListener("pointerdown", this.handleViewPointerDown, { capture: true });
		viewContentEl?.removeEventListener("pointermove", this.handleViewPointerMove);
		viewContentEl?.removeEventListener("pointerleave", this.handleViewPointerLeave);
		document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
	}

	async diagnoseOverlayState(): Promise<void> {
		this.syncPages();
		this.forceRedrawAllAnnotations();
		const pageNumber = this.currentPage;
		const surface = this.pageSurfaces.get(pageNumber) ?? Array.from(this.pageSurfaces.values())[0] ?? null;
		if (!surface) {
			const report = {
				pageNumber,
				surfaces: this.pageSurfaces.size,
				error: "No page surface is registered"
			};
			await writeClipboardText(JSON.stringify(report, null, 2));
			this.refreshStatus("Overlay diagnostic copied: no page surface", 8000);
			new Notice("Freedraw PDF diagnostic copied to clipboard.");
			return;
		}

		const pageRect = surface.pageEl.getBoundingClientRect();
		const hostRect = surface.hostEl.getBoundingClientRect();
		const overlayRect = surface.overlayEl.getBoundingClientRect();
		const centerX = overlayRect.left + overlayRect.width / 2;
		const centerY = overlayRect.top + overlayRect.height / 2;
		const stack = document.elementsFromPoint(centerX, centerY).slice(0, 8).map((element) => ({
			tag: element.tagName.toLowerCase(),
			className: isHtmlElement(element) ? element.className : "",
			id: element.id || ""
		}));
		const bucket = this.getPageAnnotationBucket(surface.pageNumber);
		const context = surface.overlayEl.getContext("2d");
		const overlayStyle = window.getComputedStyle(surface.overlayEl);
		let alphaPixels = 0;
		if (context && surface.overlayEl.width > 0 && surface.overlayEl.height > 0) {
			const sampleWidth = Math.min(surface.overlayEl.width, 240);
			const sampleHeight = Math.min(surface.overlayEl.height, 240);
			const data = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
			for (let index = 3; index < data.length; index += 4) {
				if (data[index] > 0) {
					alphaPixels += 1;
				}
			}
		}
		const report = {
			pageNumber: surface.pageNumber,
			currentPage: this.currentPage,
			annotationMode: this.annotationMode,
			surfaces: this.pageSurfaces.size,
			annotations: {
				strokes: bucket.strokes.length,
				textItems: bucket.textItems.length,
				shapes: bucket.shapes.length,
				imageItems: bucket.imageItems.length
			},
			pageRect: this.roundRectForDiagnostic(pageRect),
			hostRect: this.roundRectForDiagnostic(hostRect),
			overlayRect: this.roundRectForDiagnostic(overlayRect),
			canvas: {
				width: surface.overlayEl.width,
				height: surface.overlayEl.height,
				styleWidth: overlayStyle.width,
				styleHeight: overlayStyle.height,
				visibility: overlayStyle.visibility,
				display: overlayStyle.display,
				opacity: overlayStyle.opacity,
				pointerEvents: overlayStyle.pointerEvents,
				alphaPixels
			},
			connection: {
				pageConnected: surface.pageEl.isConnected,
				hostConnected: surface.hostEl.isConnected,
				overlayConnected: surface.overlayEl.isConnected,
				overlayParentClass: isHtmlElement(surface.overlayEl.parentElement) ? surface.overlayEl.parentElement.className : null
			},
			topStack: stack
		};
		await writeClipboardText(JSON.stringify(report, null, 2));
		this.refreshStatus(`Overlay diagnostic copied: p${surface.pageNumber}, alpha ${alphaPixels}`, 10000);
		new Notice("Freedraw PDF diagnostic copied to clipboard.");
	}

	private roundRectForDiagnostic(rect: DOMRect): { left: number; top: number; width: number; height: number; right: number; bottom: number } {
		const round = (value: number): number => Math.round(value * 10) / 10;
		return {
			left: round(rect.left),
			top: round(rect.top),
			width: round(rect.width),
			height: round(rect.height),
			right: round(rect.right),
			bottom: round(rect.bottom)
		};
	}

	private refreshStatus(message: string, durationMs = 2500): void {
		if (this.statusEl) {
			this.statusEl.textContent = message;
		}
		if (this.statusResetHandle !== null) {
			window.clearTimeout(this.statusResetHandle);
			this.statusResetHandle = null;
		}
		if (durationMs > 0) {
			this.statusResetHandle = window.setTimeout(() => {
				this.statusResetHandle = null;
				if (this.statusEl?.textContent === message) {
					this.statusEl.textContent = "";
				}
			}, durationMs);
		}
	}

	private showStartupError(message: string): void {
		this.refreshStatus(message, 6000);
		if (!this.startupErrorShown) {
			this.startupErrorShown = true;
			new Notice(message);
		}
	}
}

export default class PDFAnnotatorPlugin extends Plugin {
	private store!: AnnotationStore;
	private notebookStore!: NotebookStore;
	private annotatedEmbeds!: AnnotatedEmbedController;
	private settingsController!: PDFAnnotatorSettingsController;
	private sessions = new Map<WorkspaceLeaf, NativePdfAnnotatorSession>();
	private clipboard: AnnotationClipboardPayload | null = null;

	async onload(): Promise<void> {
		this.settingsController = new PDFAnnotatorSettingsController(
			() => this.loadData(),
			(data) => this.saveData(data),
			() => {
				setInkRenderSettings(this.settingsController.getInkRenderSettings());
				for (const session of this.sessions.values()) {
					session.refreshSettings();
				}
			}
		);
		await this.settingsController.load();
		setInkRenderSettings(this.settingsController.getInkRenderSettings());
		this.store = new AnnotationStore(this.app);
		this.notebookStore = new NotebookStore(this.app);
		this.annotatedEmbeds = new AnnotatedEmbedController(this.app, this.store, {
			shouldShowAnnotatedEmbedHeader: () => this.shouldShowAnnotatedEmbedHeader(),
			openPdfPage: (file, pageNumber, rect) => this.openPdfPage(file, pageNumber, rect),
			writeClipboardText: (text) => this.writeClipboardText(text)
		});
		this.addSettingTab(new PDFAnnotatorSettingTab(this.app, this));
		this.registerView(NOTEBOOK_VIEW_TYPE, (leaf) => new AnnotatorNotebookView(leaf, this.notebookStore, this));
		this.registerExtensions([NOTEBOOK_EXTENSION], NOTEBOOK_VIEW_TYPE);
		this.registerMarkdownCodeBlockProcessor("freedraw-pdf", (source, el, context) => {
			void this.annotatedEmbeds.renderMarkdownBlock(source, el, context.sourcePath);
		});
		this.addRibbonIcon("pen-tool", "Toggle annotation mode on active PDF", async () => {
			const session = await this.ensureActivePdfSession();
			if (!session) {
				new Notice("Open a PDF in Obsidian's built-in viewer first.");
				return;
			}
			session.toggleAnnotationMode();
		});
		this.addRibbonIcon("file-plus-2", "Create blank annotatable PDF", () => {
			this.openBlankAnnotatablePdfModal();
		});
		this.addCommand({
			id: "toggle-active-pdf-annotation-mode",
			name: "Toggle annotation mode on active PDF",
			checkCallback: (checking: boolean) => {
				const canRun = !!this.getActivePdfLeaf();
				if (canRun && !checking) {
					void this.toggleActiveSessionMode();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "create-blank-annotatable-pdf",
			name: "Create blank annotatable PDF",
			callback: () => {
				this.openBlankAnnotatablePdfModal();
			}
		});

		this.addCommand({
			id: "copy-current-page-pdf-link",
			name: "Copy current PDF page link",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.copyCurrentPageLink();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "open-active-pdf-annotation-json",
			name: "Open active PDF annotation data JSON",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.openAnnotationDataJson();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "export-current-page-snapshot",
			name: "Export current annotated page as PNG",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.exportCurrentPageSnapshot();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "export-annotated-mixed-pdf",
			name: "Export annotated mixed PDF",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.exportAnnotatedMixedDocumentPdf();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "create-native-mixed-working-pdf",
			name: "Advanced: create native mixed working PDF",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.materializeNativeMixedWorkingPdf();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "insert-native-notebook-page-after-current",
			name: "Add temporary notebook page after current PDF page",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.openTemplatePageInsertModal("after");
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "insert-native-notebook-page-before-current",
			name: "Add temporary notebook page before current PDF page",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.openTemplatePageInsertModal("before");
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "copy-current-page-annotated-embed",
			name: "Copy annotated PDF page embed",
			checkCallback: (checking: boolean) => {
				const source = this.getPreferredPdfInsertionSource();
				const canRun = !!source;
				if (canRun && !checking) {
					void this.copyAnnotatedPdfEmbedBlock(source.file, source.page);
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "insert-current-page-annotated-embed",
			name: "Insert annotated PDF page embed",
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const source = this.getPreferredPdfInsertionSource();
				const canRun = !!markdownView && !!source;
				if (canRun && !checking) {
					this.annotatedEmbeds.insertBlock(markdownView, source.file, source.page);
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "insert-selected-region-annotated-embed",
			name: "Insert annotated PDF selected region embed",
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const source = this.getPreferredPdfRegionInsertionSource();
				const canRun = !!markdownView && !!source;
				if (canRun && !checking) {
					this.annotatedEmbeds.insertBlock(markdownView, source.file, source.page, source.rect);
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-previous-mixed-page",
			name: "PDF: Go to previous page",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session && session.canNavigatePage(-1);
				if (canRun && !checking) {
					session.goToPreviousPage();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-next-mixed-page",
			name: "PDF: Go to next page",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session && session.canNavigatePage(1);
				if (canRun && !checking) {
					session.goToNextPage();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-open-mixed-page-list",
			name: "PDF: Open mixed page list",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.openMixedPageList();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-open-go-to-page",
			name: "PDF: Go to page...",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.openGoToPage();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-add-template-page-end",
			name: "PDF: Quick add notebook page to end",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.addTemplatePageToEnd();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-add-template-page-before",
			name: "PDF: Quick add notebook page before current page",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.addTemplatePageBeforeCurrent();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-add-template-page-after",
			name: "PDF: Quick add notebook page after current page",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.addTemplatePageAfterCurrent();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-duplicate-current-added-page",
			name: "PDF: Duplicate current added page",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session && session.hasCurrentAddedPage();
				if (canRun && !checking) {
					session.duplicateCurrentAddedPage();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-duplicate-current-added-page-structure",
			name: "PDF: Duplicate current added page structure only",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session && session.hasCurrentAddedPage();
				if (canRun && !checking) {
					session.duplicateCurrentAddedPage(false);
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-clear-current-added-page",
			name: "PDF: Clear current added page contents",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session && session.hasCurrentAddedPage();
				if (canRun && !checking) {
					session.clearCurrentAddedPageContents();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "pdf-delete-current-added-page",
			name: "PDF: Delete current page from session",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.deleteCurrentPage();
				}
				return canRun;
			}
		});

		registerNotebookCommands(this, this);

		this.addCommand({
			id: "select-all-page-annotations",
			name: "Select all annotations on current PDF page",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.selectAllCurrentPageAnnotations();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "duplicate-selected-annotations",
			name: "Duplicate selected annotations",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.duplicateSelectedTargets();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "delete-selected-annotations",
			name: "Delete selected annotations",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.deleteSelectedTargets();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "copy-selected-annotations",
			name: "Copy selected annotations",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.copySelectedTargets();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "cut-selected-annotations",
			name: "Cut selected annotations",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.cutSelectedTargets();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "bring-selected-annotations-to-front",
			name: "Bring selected annotations to front",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.reorderSelectedTargets("front");
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "send-selected-annotations-to-back",
			name: "Send selected annotations to back",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					session.reorderSelectedTargets("back");
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "paste-selected-annotations",
			name: "Paste copied annotations",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session && this.hasClipboard();
				if (canRun && !checking) {
					session.pasteClipboard();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "paste-selected-annotations-in-place",
			name: "Paste copied annotations in place",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session && this.hasClipboard();
				if (canRun && !checking) {
					session.pasteClipboard(true);
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "export-selection-snapshot",
			name: "Export selection snapshot",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.exportSelectionSnapshot();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "copy-selection-region-reference",
			name: "Copy selection region reference",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.copySelectionRegionReference();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "copy-selection-annotated-embed",
			name: "Copy selected region annotated embed",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.copySelectionAnnotatedEmbedBlock();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "diagnose-pdf-annotation-overlay",
			name: "Diagnose PDF annotation overlay",
			checkCallback: (checking: boolean) => {
				const session = this.getSessionForLeaf(this.getActivePdfLeaf());
				const canRun = !!session;
				if (canRun && !checking) {
					void session.diagnoseOverlayState();
				}
				return canRun;
			}
		});

		this.addCommand({
			id: "open-selection-region-reference-from-clipboard",
			name: "Open selection region reference from clipboard",
			callback: () => {
				void this.openRegionReferenceFromClipboard();
			}
		});

		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			void this.syncSessions();
		}));
		this.registerEvent(this.app.workspace.on("file-open", () => {
			void this.syncSessions();
		}));
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			void Promise.all(Array.from(this.sessions.values()).map((session) => session.refreshLayoutAndFlush()));
		}));
		this.registerEvent(this.app.vault.on("rename", (abstractFile: TAbstractFile, oldPath: string) => {
			if (!(abstractFile instanceof TFile) || abstractFile.extension.toLowerCase() !== "pdf") {
				return;
			}
			void this.store.migrateForRename(abstractFile, oldPath);
		}));
		this.registerEvent(this.app.vault.on("delete", (abstractFile: TAbstractFile) => {
			if (!(abstractFile instanceof TFile) || abstractFile.extension.toLowerCase() !== "pdf") {
				return;
			}
			void this.deleteAnnotationSidecarForDeletedPdf(abstractFile);
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile) {
				this.annotatedEmbeds.refreshForPath(file.path);
			}
		}));

		void this.syncSessions();
	}

	onunload(): void {
		this.settingsController.dispose();
		for (const session of this.sessions.values()) {
			session.detach();
		}
		this.sessions.clear();
	}

	private async deleteAnnotationSidecarForDeletedPdf(file: TFile): Promise<void> {
		try {
			const deleted = await this.store.deleteForPdfPath(file.path);
			if (deleted) {
				this.annotatedEmbeds.refreshForPath(`${file.path}.annot.json`);
				new Notice(`Deleted annotation data for ${file.name}.`);
			}
		} catch (error) {
			console.error(`freedraw-pdf: failed to delete annotation data for ${file.path}`, error);
			new Notice(`Could not delete annotation data for ${file.name}.`);
		}
	}

	async createNotebook(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		const folderPrefix = activeFile?.parent?.path ? `${activeFile.parent.path}/` : "";
		let baseName = "New notebook";
		let path = `${folderPrefix}${baseName}.${NOTEBOOK_EXTENSION}`;
		let counter = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = `${folderPrefix}${baseName} ${counter}.${NOTEBOOK_EXTENSION}`;
			counter += 1;
		}
		const title = path.split("/").pop()?.replace(`.${NOTEBOOK_EXTENSION}`, "") ?? baseName;
		const notebookFile = await this.app.vault.create(path, JSON.stringify(createEmptyNotebookDocument(title), null, 2));
		await this.openNotebookFile(notebookFile);
	}

	openBlankAnnotatablePdfModal(): void {
		new BlankAnnotatablePdfModal(this.app, (options) => {
			void this.createBlankAnnotatablePdf(options);
		}).open();
	}

	async createBlankAnnotatablePdf(options: BlankAnnotatablePdfOptions): Promise<void> {
		try {
			const activeFile = this.app.workspace.getActiveFile();
			const folderPrefix = activeFile?.parent?.path ? `${activeFile.parent.path}/` : "";
			const baseName = (options.title.trim() || "New annotatable PDF").replace(/[\\/:*?"<>|]/g, "-");
			const pageCount = clamp(Math.round(options.pageCount), 1, 200);
			let path = `${folderPrefix}${baseName}.pdf`;
			let counter = 2;
			while (this.app.vault.getAbstractFileByPath(path)) {
				path = `${folderPrefix}${baseName} ${counter}.pdf`;
				counter += 1;
			}

			const templatePage = createTemplateNotebookPage("Page 1", options.template, options.pageSize, options.paperColor);
			const renderDimensions = getNotebookPageRenderDimensions(templatePage.pageSize, BLANK_PDF_EXPORT_WIDTH_PX);
			const pages = [];
			for (let index = 0; index < pageCount; index += 1) {
				const canvas = document.createElement("canvas");
				canvas.width = renderDimensions.width;
				canvas.height = renderDimensions.height;
				const context = canvas.getContext("2d");
				if (!context) {
					new Notice("Could not create blank PDF canvas.");
					return;
				}
				context.fillStyle = options.paperColor || "#fffdf7";
				context.fillRect(0, 0, canvas.width, canvas.height);
				pages.push({
					widthPx: canvas.width,
					heightPx: canvas.height,
					jpegBytes: new Uint8Array(dataUrlToArrayBuffer(canvas.toDataURL("image/jpeg", 0.92)))
				});
			}
			const pdfBytes = buildPdfFromJpegPages(pages);
			const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
			new Uint8Array(pdfBuffer).set(pdfBytes);
			const pdfFile = await this.app.vault.createBinary(path, pdfBuffer);
			const annotationDocument = createEmptyDocument(pdfFile);
			annotationDocument.pdfPageTemplates = Array.from({ length: pageCount }, (_, index) => ({
				page: index + 1,
				template: options.template,
				paperColor: options.paperColor,
				pageSize: options.pageSize
			}));
			await this.store.save(pdfFile, annotationDocument);
			new Notice(`Created ${pdfFile.name} (${pageCount} page${pageCount === 1 ? "" : "s"})`);
			await this.openPdfPage(pdfFile, 1);
		} catch (error) {
			console.error("freedraw-pdf: failed to create blank annotatable PDF", error);
			new Notice("Could not create blank annotatable PDF. Check the developer console for details.");
		}
	}

	async openNotebookFile(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({
			type: NOTEBOOK_VIEW_TYPE,
			state: {
				file: file.path
			},
			active: true
		});
	}

	getToolDefaults(): ToolStateSnapshot {
		return this.settingsController.getToolDefaults();
	}

	shouldPreferInlineToolbar(): boolean {
		return this.settingsController.getInlineToolbarPreference() && !this.isPdfPlusEnabled();
	}

	getInlineToolbarPreference(): boolean {
		return this.settingsController.getInlineToolbarPreference();
	}

	getAutosaveDelayMs(): number {
		return this.settingsController.getAutosaveDelayMs();
	}

	shouldShowRegionToolbarButton(): boolean {
		return this.settingsController.shouldShowRegionToolbarButton();
	}

	shouldShowCopyEmbedToolbarButton(): boolean {
		return this.settingsController.shouldShowCopyEmbedToolbarButton();
	}

	shouldShowAnnotatedEmbedHeader(): boolean {
		return this.settingsController.shouldShowAnnotatedEmbedHeader();
	}

	getInkInputPolicy(): InkInputPolicy {
		return this.settingsController.getInkInputPolicy();
	}

	getInkRenderSettings(): InkRenderSettings {
		return this.settingsController.getInkRenderSettings();
	}

	getStoredPresets(): ToolPreset[] {
		return this.settingsController.getStoredPresets();
	}

	getPreferredPdfInsertionSource(): { file: TFile; page: number } | null {
		const activeSession = this.getSessionForLeaf(this.getActivePdfLeaf());
		if (activeSession?.currentFile) {
			return {
				file: activeSession.currentFile,
				page: activeSession.activePage
			};
		}
		for (const session of this.sessions.values()) {
			if (session.currentFile) {
				return {
					file: session.currentFile,
					page: session.activePage
				};
			}
		}
		return null;
	}

	getPreferredPdfRegionInsertionSource(): { file: TFile; page: number; rect: NormalizedRect } | null {
		const activeRegion = this.getSessionForLeaf(this.getActivePdfLeaf())?.getActiveRegionEmbedSource();
		if (activeRegion) {
			return activeRegion;
		}
		for (const session of this.sessions.values()) {
			const region = session.getActiveRegionEmbedSource();
			if (region) {
				return region;
			}
		}
		return null;
	}

	getClipboard(): AnnotationClipboardPayload | null {
		if (!this.clipboard) {
			return null;
		}
		return {
			strokes: this.clipboard.strokes.map((stroke) => JSON.parse(JSON.stringify(stroke)) as StrokeAnnotation),
			textItems: this.clipboard.textItems.map((item) => JSON.parse(JSON.stringify(item)) as TextAnnotation),
			shapes: this.clipboard.shapes.map((shape) => JSON.parse(JSON.stringify(shape)) as ShapeAnnotation),
			imageItems: (this.clipboard.imageItems ?? []).map((image) => JSON.parse(JSON.stringify(image)) as ImageAnnotation)
		};
	}

	setClipboard(payload: AnnotationClipboardPayload): void {
		this.clipboard = {
			strokes: payload.strokes.map((stroke) => JSON.parse(JSON.stringify(stroke)) as StrokeAnnotation),
			textItems: payload.textItems.map((item) => JSON.parse(JSON.stringify(item)) as TextAnnotation),
			shapes: payload.shapes.map((shape) => JSON.parse(JSON.stringify(shape)) as ShapeAnnotation),
			imageItems: (payload.imageItems ?? []).map((image) => JSON.parse(JSON.stringify(image)) as ImageAnnotation)
		};
		for (const session of this.sessions.values()) {
			if (session.isActive()) {
				session.refreshUiState();
			}
		}
	}

	hasClipboard(): boolean {
		return !!this.clipboard &&
			(this.clipboard.strokes.length > 0 || this.clipboard.textItems.length > 0 || this.clipboard.shapes.length > 0 || (this.clipboard.imageItems?.length ?? 0) > 0);
	}

	async openRegionReference(raw: string): Promise<boolean> {
		const reference = parseRegionReference(raw);
		if (!reference) {
			return false;
		}
		const file = this.app.vault.getAbstractFileByPath(reference.filePath);
		if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") {
			return false;
		}

		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		await this.syncSessions();
		const session = this.getSessionForLeaf(leaf);
		if (!session) {
			return false;
		}
		session.focusRegion(reference.page, reference.rect);
		return true;
	}

	async syncSessionsForNotebook(): Promise<void> {
		await this.syncSessions();
	}

	getSessionForLeafForNotebook(leaf: WorkspaceLeaf | null): NativePdfAnnotatorSession | null {
		return this.getSessionForLeaf(leaf);
	}

	async openRegionReferenceFromClipboard(): Promise<void> {
		try {
			const raw = await readClipboardText();
			const opened = await this.openRegionReference(raw);
			if (!opened) {
				new Notice("Clipboard does not contain a valid selection region reference.");
				return;
			}
			new Notice("Opened selection region reference.");
		} catch (error) {
			console.error("freedraw-pdf: failed to open region reference from clipboard", error);
			new Notice("Could not read clipboard for region reference.");
		}
	}

	updateToolPreferences(snapshot: ToolStateSnapshot, presets: ToolPreset[]): void {
		this.settingsController.updateToolPreferences(snapshot, presets);
	}

	async updateBehaviorSettings(nextSettings: Partial<Pick<PDFAnnotatorSettings, "preferInlineToolbar" | "showRegionToolbarButton" | "showCopyEmbedToolbarButton" | "showAnnotatedEmbedHeader" | "inkInputPolicy" | "inkRenderSettings" | "autosaveDelayMs">>): Promise<void> {
		await this.settingsController.updateBehaviorSettings(nextSettings);
	}

	async writeClipboardText(text: string): Promise<void> {
		await writeClipboardText(text);
	}

	buildAnnotatedPdfEmbedBlock(file: TFile, page: number, rect?: NormalizedRect | null, width = 720): string {
		return this.annotatedEmbeds.buildBlock(file, page, rect, width);
	}

	async copyAnnotatedPdfEmbedBlock(file: TFile, page: number, rect?: NormalizedRect | null): Promise<void> {
		await this.annotatedEmbeds.copyBlock(file, page, rect);
	}

	refreshAnnotatedEmbedsForPath(path: string): void {
		this.annotatedEmbeds.refreshForPath(path);
	}

	async openPdfFileAtPage(file: TFile, pageNumber: number): Promise<void> {
		await this.openPdfPage(file, pageNumber);
	}

	private async openPdfPage(file: TFile, pageNumber: number, rect?: NormalizedRect | null): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		await this.syncSessions();
		const session = this.getSessionForLeaf(leaf);
		if (!session) {
			new Notice(`Opened ${file.name}. Page ${pageNumber} will be available after the PDF view finishes loading.`);
			return;
		}
		if (rect) {
			session.focusRegion(pageNumber, rect);
			return;
		}
		session.focusPage(pageNumber);
	}

	private async toggleActiveSessionMode(): Promise<void> {
		const session = await this.ensureActivePdfSession();
		if (!session) {
			new Notice("Open a PDF in Obsidian's built-in viewer first.");
			return;
		}
		session.toggleAnnotationMode();
	}

	private async ensureActivePdfSession(): Promise<NativePdfAnnotatorSession | null> {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) {
			return null;
		}
		let session = this.sessions.get(leaf) ?? this.createSession(leaf);
		await session.attach();
		return session.isActive() ? session : null;
	}

	private async syncSessions(): Promise<void> {
		const keep = new Set<WorkspaceLeaf>();

		for (const leaf of this.getOpenPdfLeaves()) {
			let session = this.sessions.get(leaf);
			if (!session) {
				session = this.createSession(leaf);
			}
			await session.attach();
			keep.add(leaf);
		}

		for (const [leaf, session] of this.sessions.entries()) {
			if (!keep.has(leaf)) {
				session.detach();
				this.sessions.delete(leaf);
			}
		}
	}

	private getSessionForLeaf(leaf: WorkspaceLeaf | null): NativePdfAnnotatorSession | null {
		return leaf ? this.sessions.get(leaf) ?? null : null;
	}

	getActiveNotebookView(): AnnotatorNotebookView | null {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) {
			return null;
		}
		return leaf.view instanceof AnnotatorNotebookView ? leaf.view : null;
	}

	private createSession(leaf: WorkspaceLeaf): NativePdfAnnotatorSession {
		const session = new NativePdfAnnotatorSession(this, leaf, this.store);
		this.sessions.set(leaf, session);
		return session;
	}

	isPdfPlusEnabled(): boolean {
		const plugins = (this.app as App & { plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> } }).plugins;
		if (!plugins) {
			return false;
		}
		if (plugins.enabledPlugins) {
			return plugins.enabledPlugins.has("pdf-plus");
		}
		return Boolean(plugins.plugins?.["pdf-plus"]);
	}

	private getActivePdfLeaf(): WorkspaceLeaf | null {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) {
			return null;
		}
		return this.isPdfLeaf(leaf) ? leaf : null;
	}

	private getOpenPdfLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType("pdf").filter((leaf) => this.isPdfLeaf(leaf));
	}

	private isPdfLeaf(leaf: WorkspaceLeaf): boolean {
		const view = leaf.view as PdfLikeView;
		const file = view.file;
		return !!(file && file.extension.toLowerCase() === "pdf");
	}
}
