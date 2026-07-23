import type { Plugin, TFile } from "obsidian";
import type { AnnotatorNotebookView } from "../notebook/AnnotatorNotebookView";

export interface NotebookCommandHost {
	createNotebook(): Promise<void>;
	getActiveNotebookView(): AnnotatorNotebookView | null;
	getPreferredPdfInsertionSource(): { file: TFile; page: number } | null;
	hasClipboard(): boolean;
}

export function registerNotebookCommands(plugin: Plugin, host: NotebookCommandHost): void {
	plugin.addCommand({
		id: "create-annotator-notebook",
		name: "Legacy: Create .annotbook notebook",
		callback: () => {
			void host.createNotebook();
		}
	});

	addNotebookCommand(plugin, host, "notebook-previous-page", "Notebook: Previous page", (view) => !!view && view.canNavigate(-1), (view) => view.goToPreviousPage());
	addNotebookCommand(plugin, host, "notebook-next-page", "Notebook: Next page", (view) => !!view && view.canNavigate(1), (view) => view.goToNextPage());
	addNotebookCommand(plugin, host, "notebook-add-page-before", "Notebook: Insert page before current", Boolean, (view) => view.addPageBeforeCurrent());
	addNotebookCommand(plugin, host, "notebook-add-page-after", "Notebook: Insert page after current", Boolean, (view) => view.addPageAfterCurrent());
	addNotebookCommand(plugin, host, "notebook-add-page-end", "Notebook: Add page to end", Boolean, (view) => view.addPageToEnd());
	addNotebookCommand(plugin, host, "notebook-insert-current-pdf-page-before", "Notebook: Insert current PDF page before current", (view) => !!view && !!host.getPreferredPdfInsertionSource(), (view) => view.insertCurrentPdfPageBeforeCurrent());
	addNotebookCommand(plugin, host, "notebook-insert-current-pdf-page-after", "Notebook: Insert current PDF page after current", (view) => !!view && !!host.getPreferredPdfInsertionSource(), (view) => view.insertCurrentPdfPageAfterCurrent());
	addNotebookCommand(plugin, host, "notebook-add-current-pdf-page-end", "Notebook: Add current PDF page to end", (view) => !!view && !!host.getPreferredPdfInsertionSource(), (view) => view.insertCurrentPdfPageToEnd());
	addNotebookCommand(plugin, host, "notebook-duplicate-current-page", "Notebook: Duplicate current page", Boolean, (view) => view.duplicateCurrentPage());
	addNotebookCommand(plugin, host, "notebook-duplicate-current-page-structure", "Notebook: Duplicate current page structure only", Boolean, (view) => view.duplicateCurrentPageStructure());
	addNotebookCommand(plugin, host, "notebook-undo", "Notebook: Undo", Boolean, (view) => view.undoNotebook());
	addNotebookCommand(plugin, host, "notebook-redo", "Notebook: Redo", Boolean, (view) => view.redoNotebook());
	addNotebookCommand(plugin, host, "notebook-rename-current-page", "Notebook: Rename current page", Boolean, (view) => view.renameCurrentPage());
	addNotebookCommand(plugin, host, "notebook-focus-current-page-single", "Notebook: Focus current page in single-page mode", Boolean, (view) => view.focusCurrentPageSingle());
	addNotebookCommand(plugin, host, "notebook-open-current-source-pdf-page", "Notebook: Open source PDF for current page", (view) => !!view && view.hasActivePdfBackedPage(), (view) => view.openCurrentPdfSourcePage());
	addNotebookCommand(plugin, host, "notebook-copy-current-source-pdf-link", "Notebook: Copy source PDF link for current page", (view) => !!view && view.hasActivePdfBackedPage(), (view) => view.copyCurrentPdfSourceLink());
	addNotebookCommand(plugin, host, "notebook-move-current-page-to-top", "Notebook: Move current page to top", Boolean, (view) => view.moveCurrentPageToTop());
	addNotebookCommand(plugin, host, "notebook-move-current-page-to-bottom", "Notebook: Move current page to bottom", Boolean, (view) => view.moveCurrentPageToBottom());
	addNotebookCommand(plugin, host, "notebook-clear-current-page-contents", "Notebook: Clear current page contents", Boolean, (view) => view.clearCurrentPageContents());
	addNotebookCommand(plugin, host, "notebook-toggle-flow-mode", "Notebook: Toggle single-page / continuous mode", Boolean, (view) => view.toggleNotebookFlowMode());
	addNotebookCommand(plugin, host, "notebook-fit-width", "Notebook: Fit current page to width", Boolean, (view) => view.fitCurrentPageWidth());
	addNotebookCommand(plugin, host, "notebook-fit-page", "Notebook: Fit current page to page", Boolean, (view) => view.fitCurrentPageView());
	addNotebookCommand(plugin, host, "notebook-export-page-snapshot", "Notebook: Export current page snapshot", Boolean, (view) => void view.exportPageSnapshot());
	addNotebookCommand(plugin, host, "notebook-select-all-page-annotations", "Notebook: Select all annotations on current page", Boolean, (view) => view.selectAllCurrentPageAnnotations());
	addNotebookCommand(plugin, host, "notebook-copy-selection", "Notebook: Copy current selection", (view) => !!view && view.hasNotebookSelection(), (view) => view.copyCurrentSelection());
	addNotebookCommand(plugin, host, "notebook-cut-selection", "Notebook: Cut current selection", (view) => !!view && view.hasNotebookSelection(), (view) => view.cutCurrentSelection());
	addNotebookCommand(plugin, host, "notebook-bring-selection-to-front", "Notebook: Bring current selection to front", (view) => !!view && view.hasNotebookSelection(), (view) => view.bringCurrentSelectionToFront());
	addNotebookCommand(plugin, host, "notebook-send-selection-to-back", "Notebook: Send current selection to back", (view) => !!view && view.hasNotebookSelection(), (view) => view.sendCurrentSelectionToBack());
	addNotebookCommand(plugin, host, "notebook-paste-selection", "Notebook: Paste copied selection", (view) => !!view && host.hasClipboard(), (view) => view.pasteCurrentClipboard());
	addNotebookCommand(plugin, host, "notebook-paste-selection-in-place", "Notebook: Paste copied selection in place", (view) => !!view && host.hasClipboard(), (view) => view.pasteCurrentClipboard(true));
	addNotebookCommand(plugin, host, "notebook-export-selection-snapshot", "Notebook: Export selection snapshot", (view) => !!view && view.hasNotebookSelection(), (view) => void view.exportCurrentSelectionSnapshot());
}

function addNotebookCommand(
	plugin: Plugin,
	host: NotebookCommandHost,
	id: string,
	name: string,
	canRun: (view: AnnotatorNotebookView | null) => boolean,
	run: (view: AnnotatorNotebookView) => void
): void {
	plugin.addCommand({
		id,
		name,
		checkCallback: (checking: boolean) => {
			const view = host.getActiveNotebookView();
			const runnable = canRun(view);
			if (runnable && !checking && view) {
				run(view);
			}
			return runnable;
		}
	});
}
