import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { InkEasingMode, InkInputPolicy, InkPressureMode, InkRenderSettings, PDFAnnotatorSettings, ToolPreset, ToolStateSnapshot } from "../types";

export interface PDFAnnotatorSettingsHost {
	getInlineToolbarPreference(): boolean;
	shouldShowRegionToolbarButton(): boolean;
	shouldShowCopyEmbedToolbarButton(): boolean;
	shouldShowAnnotatedEmbedHeader(): boolean;
	getInkInputPolicy(): InkInputPolicy;
	getInkRenderSettings(): InkRenderSettings;
	getAutosaveDelayMs(): number;
	getToolDefaults(): ToolStateSnapshot;
	getStoredPresets(): ToolPreset[];
	updateBehaviorSettings(
		nextSettings: Partial<Pick<PDFAnnotatorSettings, "preferInlineToolbar" | "showRegionToolbarButton" | "showCopyEmbedToolbarButton" | "showAnnotatedEmbedHeader" | "inkInputPolicy" | "inkRenderSettings" | "autosaveDelayMs">>
	): Promise<void>;
	updateToolPreferences(snapshot: ToolStateSnapshot, presets: ToolPreset[]): void;
}

export class PDFAnnotatorSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: Plugin & PDFAnnotatorSettingsHost) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "freedraw-pdf" });

		new Setting(containerEl)
			.setName("Prefer native PDF toolbar")
			.setDesc("Mount controls into Obsidian's native PDF toolbar when available. If another PDF toolbar extension is active, freedraw-pdf can fall back to the floating toolbar to avoid control conflicts.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.getInlineToolbarPreference())
					.onChange(async (value) => {
						await this.plugin.updateBehaviorSettings({ preferInlineToolbar: value });
					});
			});

		new Setting(containerEl)
			.setName("Show Region embed toolbar button")
			.setDesc("Show the crop/screenshot-style region capture tool directly in the PDF toolbar. When off, use the freedraw-pdf overflow menu instead.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.shouldShowRegionToolbarButton())
					.onChange(async (value) => {
						await this.plugin.updateBehaviorSettings({ showRegionToolbarButton: value });
					});
			});

		new Setting(containerEl)
			.setName("Show Copy embed toolbar button")
			.setDesc("Show a direct Copy embed button after a region has been captured. When off, the same action remains available from the Region menu.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.shouldShowCopyEmbedToolbarButton())
					.onChange(async (value) => {
						await this.plugin.updateBehaviorSettings({ showCopyEmbedToolbarButton: value });
					});
			});

		new Setting(containerEl)
			.setName("Show annotated embed header")
			.setDesc("Show title and Open/Refresh/Copy block controls above annotated PDF embeds in markdown. Off by default for a clean screenshot-like display.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.shouldShowAnnotatedEmbedHeader())
					.onChange(async (value) => {
						await this.plugin.updateBehaviorSettings({ showAnnotatedEmbedHeader: value });
					});
			});

		new Setting(containerEl)
			.setName("Ink input mode")
			.setDesc("Controls which pointer inputs can draw. Use touch fallback only if your stylus is reported as touch; otherwise fingers stay available for scrolling.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("pen-mouse-stylus-touch", "Pen + mouse + stylus-like touch")
					.addOption("pen-mouse-only", "Pen + mouse only")
					.addOption("allow-touch", "Allow touch drawing")
					.setValue(this.plugin.getInkInputPolicy())
					.onChange(async (value) => {
						await this.plugin.updateBehaviorSettings({ inkInputPolicy: value as InkInputPolicy });
					});
			});

		containerEl.createEl("h3", { text: "Ink rendering" });
		containerEl.createEl("p", {
			text: "These values are passed to perfect-freehand. Higher streamline/smoothing values make strokes cleaner but can add visual lag or soften corners.",
			cls: "setting-item-description"
		});

		const updateInkRenderSettings = async (patch: Partial<InkRenderSettings>): Promise<void> => {
			await this.plugin.updateBehaviorSettings({
				inkRenderSettings: {
					...this.plugin.getInkRenderSettings(),
					...patch
				}
			});
		};

		const inkRenderSettings = this.plugin.getInkRenderSettings();

		new Setting(containerEl)
			.setName("Pressure mode")
			.setDesc("Simulated pressure uses stroke speed. Stylus pressure uses real pointer pressure when available.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("simulate", "Simulate pressure from mouse/stroke speed")
					.addOption("stylus", "Use stylus pressure")
					.setValue(inkRenderSettings.pressureMode)
					.onChange(async (value) => {
						await updateInkRenderSettings({ pressureMode: value as InkPressureMode });
					});
			});

		new Setting(containerEl)
			.setName("Thinning")
			.setDesc("How much pressure changes stroke width. Demo-like value: 0.5.")
			.addSlider((slider) => {
				slider
					.setLimits(-1, 1, 0.05)
					.setValue(inkRenderSettings.thinning)
					.setDynamicTooltip()
					.onChange(async (value) => {
						await updateInkRenderSettings({ thinning: value });
					});
			});

		new Setting(containerEl)
			.setName("Streamline")
			.setDesc("How strongly the line follows a stabilized path. Higher values are smoother but less immediate.")
			.addSlider((slider) => {
				slider
					.setLimits(0, 1, 0.05)
					.setValue(inkRenderSettings.streamline)
					.setDynamicTooltip()
					.onChange(async (value) => {
						await updateInkRenderSettings({ streamline: value });
					});
			});

		new Setting(containerEl)
			.setName("Smoothing")
			.setDesc("How rounded the freehand outline becomes.")
			.addSlider((slider) => {
				slider
					.setLimits(0, 1, 0.05)
					.setValue(inkRenderSettings.smoothing)
					.setDynamicTooltip()
					.onChange(async (value) => {
						await updateInkRenderSettings({ smoothing: value });
					});
			});

		new Setting(containerEl)
			.setName("Easing")
			.setDesc("Pressure response curve used by the stroke outline.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("linear", "Linear")
					.addOption("ease-in", "Ease in")
					.addOption("ease-out", "Ease out")
					.addOption("ease-in-out", "Ease in-out")
					.setValue(inkRenderSettings.easing)
					.onChange(async (value) => {
						await updateInkRenderSettings({ easing: value as InkEasingMode });
					});
			});

		new Setting(containerEl)
			.setName("Taper start")
			.setDesc("Start taper length in pixels. 0 keeps the start capped.")
			.addSlider((slider) => {
				slider
					.setLimits(0, 120, 1)
					.setValue(inkRenderSettings.taperStart)
					.setDynamicTooltip()
					.onChange(async (value) => {
						await updateInkRenderSettings({ taperStart: value });
					});
			});

		new Setting(containerEl)
			.setName("Taper end")
			.setDesc("End taper length in pixels. 0 keeps the end capped.")
			.addSlider((slider) => {
				slider
					.setLimits(0, 120, 1)
					.setValue(inkRenderSettings.taperEnd)
					.setDynamicTooltip()
					.onChange(async (value) => {
						await updateInkRenderSettings({ taperEnd: value });
					});
			});

		new Setting(containerEl)
			.setName("Autosave delay")
			.setDesc("Delay before annotation edits are written to the sidecar file.")
			.addSlider((slider) => {
				slider
					.setLimits(200, 2000, 100)
					.setValue(this.plugin.getAutosaveDelayMs())
					.setDynamicTooltip()
					.onChange(async (value) => {
						await this.plugin.updateBehaviorSettings({ autosaveDelayMs: value });
					});
			});

		const defaults = this.plugin.getToolDefaults();

		new Setting(containerEl)
			.setName("Default pen width")
			.setDesc("Starting width for new pen strokes.")
			.addSlider((slider) => {
				slider
					.setLimits(1, 18, 1)
					.setValue(defaults.widths.pen)
					.setDynamicTooltip()
					.onChange((value) => {
						const next = this.plugin.getToolDefaults();
						next.widths.pen = value;
						this.plugin.updateToolPreferences(next, this.plugin.getStoredPresets());
					});
			});

		new Setting(containerEl)
			.setName("Default highlighter width")
			.setDesc("Starting width for new highlighter strokes.")
			.addSlider((slider) => {
				slider
					.setLimits(4, 30, 1)
					.setValue(defaults.widths.highlighter)
					.setDynamicTooltip()
					.onChange((value) => {
						const next = this.plugin.getToolDefaults();
						next.widths.highlighter = value;
						this.plugin.updateToolPreferences(next, this.plugin.getStoredPresets());
					});
			});

		new Setting(containerEl)
			.setName("Default eraser width")
			.setDesc("Starting size for the eraser tool.")
			.addSlider((slider) => {
				slider
					.setLimits(4, 36, 1)
					.setValue(defaults.widths.eraser)
					.setDynamicTooltip()
					.onChange((value) => {
						const next = this.plugin.getToolDefaults();
						next.widths.eraser = value;
						this.plugin.updateToolPreferences(next, this.plugin.getStoredPresets());
					});
			});
	}
}
