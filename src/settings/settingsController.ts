import { DEFAULT_SETTINGS, normalizeToolPresets } from "../config";
import type { InkEasingMode, InkInputPolicy, InkPressureMode, InkRenderSettings, LivePreviewMode, PDFAnnotatorSettings, ToolPreset, ToolStateSnapshot } from "../types";

type BehaviorSettingKeys = "preferInlineToolbar" | "showRegionToolbarButton" | "showCopyEmbedToolbarButton" | "showAnnotatedEmbedHeader" | "showDrawingNotices" | "showRenderTelemetry" | "inkInputPolicy" | "livePreviewMode" | "inkRenderSettings" | "autosaveDelayMs";

function normalizeInkInputPolicy(value: unknown): InkInputPolicy {
	return value === "pen-mouse-only" || value === "allow-touch" || value === "pen-mouse-stylus-touch"
		? value
		: DEFAULT_SETTINGS.inkInputPolicy;
}

function normalizeLivePreviewMode(value: unknown): LivePreviewMode {
	return value === "quality" || value === "fast" ? value : DEFAULT_SETTINGS.livePreviewMode;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(min, Math.min(max, value))
		: fallback;
}

function normalizeInkPressureMode(value: unknown): InkPressureMode {
	return value === "stylus" || value === "simulate" ? value : DEFAULT_SETTINGS.inkRenderSettings.pressureMode;
}

function normalizeInkEasingMode(value: unknown): InkEasingMode {
	return value === "ease-in" || value === "ease-out" || value === "ease-in-out" || value === "linear"
		? value
		: DEFAULT_SETTINGS.inkRenderSettings.easing;
}

function normalizeInkRenderSettings(value: unknown): InkRenderSettings {
	const raw = value && typeof value === "object" ? value as Partial<InkRenderSettings> : {};
	return {
		thinning: clampNumber(raw.thinning, DEFAULT_SETTINGS.inkRenderSettings.thinning, -1, 1),
		streamline: clampNumber(raw.streamline, DEFAULT_SETTINGS.inkRenderSettings.streamline, 0, 1),
		smoothing: clampNumber(raw.smoothing, DEFAULT_SETTINGS.inkRenderSettings.smoothing, 0, 1),
		easing: normalizeInkEasingMode(raw.easing),
		taperStart: clampNumber(raw.taperStart, DEFAULT_SETTINGS.inkRenderSettings.taperStart, 0, 120),
		taperEnd: clampNumber(raw.taperEnd, DEFAULT_SETTINGS.inkRenderSettings.taperEnd, 0, 120),
		pressureMode: normalizeInkPressureMode(raw.pressureMode)
	};
}

export class PDFAnnotatorSettingsController {
	private settings: PDFAnnotatorSettings = this.createDefaultSettings();
	private settingsSaveHandle: number | null = null;

	constructor(
		private readonly loadData: () => Promise<unknown>,
		private readonly saveData: (data: PDFAnnotatorSettings) => Promise<void>,
		private readonly onBehaviorChanged: () => void
	) {}

	async load(): Promise<void> {
		const loaded = await this.loadData() as Partial<PDFAnnotatorSettings> | null | undefined;
		const toolDefaults: Partial<ToolStateSnapshot> = loaded?.toolDefaults ?? {};
		const normalizedPresets = normalizeToolPresets(loaded?.presets);
		this.settings = {
			toolDefaults: {
				...DEFAULT_SETTINGS.toolDefaults,
				...toolDefaults,
				selectedPresetIds: {
					...(DEFAULT_SETTINGS.toolDefaults.selectedPresetIds ?? {}),
					...(toolDefaults.selectedPresetIds ?? {})
				},
				widths: {
					...DEFAULT_SETTINGS.toolDefaults.widths,
					...(toolDefaults.widths ?? {})
				}
			},
			presets: normalizedPresets,
			preferInlineToolbar: typeof loaded?.preferInlineToolbar === "boolean" ? loaded.preferInlineToolbar : DEFAULT_SETTINGS.preferInlineToolbar,
			showRegionToolbarButton: typeof loaded?.showRegionToolbarButton === "boolean" ? loaded.showRegionToolbarButton : DEFAULT_SETTINGS.showRegionToolbarButton,
			showCopyEmbedToolbarButton: typeof loaded?.showCopyEmbedToolbarButton === "boolean" ? loaded.showCopyEmbedToolbarButton : DEFAULT_SETTINGS.showCopyEmbedToolbarButton,
			showAnnotatedEmbedHeader: typeof loaded?.showAnnotatedEmbedHeader === "boolean" ? loaded.showAnnotatedEmbedHeader : DEFAULT_SETTINGS.showAnnotatedEmbedHeader,
			showDrawingNotices: typeof loaded?.showDrawingNotices === "boolean" ? loaded.showDrawingNotices : DEFAULT_SETTINGS.showDrawingNotices,
			showRenderTelemetry: typeof loaded?.showRenderTelemetry === "boolean" ? loaded.showRenderTelemetry : DEFAULT_SETTINGS.showRenderTelemetry,
			inkInputPolicy: normalizeInkInputPolicy(loaded?.inkInputPolicy),
			livePreviewMode: normalizeLivePreviewMode(loaded?.livePreviewMode),
			inkRenderSettings: normalizeInkRenderSettings(loaded?.inkRenderSettings),
			autosaveDelayMs: typeof loaded?.autosaveDelayMs === "number" ? loaded.autosaveDelayMs : DEFAULT_SETTINGS.autosaveDelayMs
		};
		if (JSON.stringify(loaded?.presets ?? []) !== JSON.stringify(normalizedPresets)) {
			this.scheduleSave();
		}
	}

	dispose(): void {
		if (this.settingsSaveHandle !== null) {
			window.clearTimeout(this.settingsSaveHandle);
			this.settingsSaveHandle = null;
		}
	}

	getToolDefaults(): ToolStateSnapshot {
		return {
			...this.settings.toolDefaults,
			selectedPresetIds: { ...(this.settings.toolDefaults.selectedPresetIds ?? {}) },
			widths: { ...this.settings.toolDefaults.widths }
		};
	}

	getInlineToolbarPreference(): boolean {
		return this.settings.preferInlineToolbar;
	}

	getAutosaveDelayMs(): number {
		return this.settings.autosaveDelayMs;
	}

	shouldShowRegionToolbarButton(): boolean {
		return this.settings.showRegionToolbarButton;
	}

	shouldShowCopyEmbedToolbarButton(): boolean {
		return this.settings.showCopyEmbedToolbarButton;
	}

	shouldShowAnnotatedEmbedHeader(): boolean {
		return this.settings.showAnnotatedEmbedHeader;
	}

	shouldShowDrawingNotices(): boolean {
		return this.settings.showDrawingNotices;
	}

	shouldShowRenderTelemetry(): boolean {
		return this.settings.showRenderTelemetry;
	}

	getInkInputPolicy(): InkInputPolicy {
		return this.settings.inkInputPolicy;
	}

	getLivePreviewMode(): LivePreviewMode {
		return this.settings.livePreviewMode;
	}

	getInkRenderSettings(): InkRenderSettings {
		return { ...this.settings.inkRenderSettings };
	}

	getStoredPresets(): ToolPreset[] {
		return this.settings.presets.map((preset) => ({ ...preset }));
	}

	updateToolPreferences(snapshot: ToolStateSnapshot, presets: ToolPreset[]): void {
		this.settings.toolDefaults = {
			...snapshot,
			selectedPresetIds: { ...(snapshot.selectedPresetIds ?? {}) },
			widths: { ...snapshot.widths }
		};
		this.settings.presets = presets.map((preset) => ({ ...preset }));
		this.scheduleSave();
	}

	async updateBehaviorSettings(nextSettings: Partial<Pick<PDFAnnotatorSettings, BehaviorSettingKeys>>): Promise<void> {
		this.settings = {
			...this.settings,
			...nextSettings
		};
		this.scheduleSave();
		this.onBehaviorChanged();
	}

	private createDefaultSettings(): PDFAnnotatorSettings {
		return {
			toolDefaults: {
				...DEFAULT_SETTINGS.toolDefaults,
				selectedPresetIds: { ...(DEFAULT_SETTINGS.toolDefaults.selectedPresetIds ?? {}) },
				widths: { ...DEFAULT_SETTINGS.toolDefaults.widths }
			},
			presets: DEFAULT_SETTINGS.presets.map((preset) => ({ ...preset })),
			preferInlineToolbar: DEFAULT_SETTINGS.preferInlineToolbar,
			showRegionToolbarButton: DEFAULT_SETTINGS.showRegionToolbarButton,
			showCopyEmbedToolbarButton: DEFAULT_SETTINGS.showCopyEmbedToolbarButton,
			showAnnotatedEmbedHeader: DEFAULT_SETTINGS.showAnnotatedEmbedHeader,
			showDrawingNotices: DEFAULT_SETTINGS.showDrawingNotices,
			showRenderTelemetry: DEFAULT_SETTINGS.showRenderTelemetry,
			inkInputPolicy: DEFAULT_SETTINGS.inkInputPolicy,
			livePreviewMode: DEFAULT_SETTINGS.livePreviewMode,
			inkRenderSettings: { ...DEFAULT_SETTINGS.inkRenderSettings },
			autosaveDelayMs: DEFAULT_SETTINGS.autosaveDelayMs
		};
	}

	private scheduleSave(): void {
		if (this.settingsSaveHandle !== null) {
			window.clearTimeout(this.settingsSaveHandle);
		}
		this.settingsSaveHandle = window.setTimeout(() => {
			this.settingsSaveHandle = null;
			void this.saveData(this.settings);
		}, 150);
	}
}
