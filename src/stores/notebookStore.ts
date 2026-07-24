import { App, TFile } from "obsidian";
import { normalizeAnnotationZIndexes } from "./annotationStore";
import { generateId } from "../utils/general";
import type { NotebookDocument } from "../types";

export function createEmptyNotebookDocument(title: string): NotebookDocument {
	return {
		version: 1,
		title,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		pages: [
			{
				id: generateId("page"),
				title: "Page 1",
				kind: "template",
				sourceLabel: "Template page",
				template: "ruled",
				paperColor: "#fffdf7",
				pageSize: "a4",
				strokes: [],
				textItems: [],
				shapes: []
			}
		]
	};
}

export function cloneNotebookDocument(document: NotebookDocument): NotebookDocument {
	return JSON.parse(JSON.stringify(document)) as NotebookDocument;
}

export function normalizeNotebookZIndexes(document: NotebookDocument): boolean {
	let changed = false;
	for (const page of document.pages) {
		changed = normalizeAnnotationZIndexes(page.strokes, page.textItems, page.shapes) || changed;
	}
	return changed;
}

export class NotebookStore {
	constructor(private readonly app: App) {}

	async load(file: TFile): Promise<NotebookDocument> {
		const raw = await this.app.vault.cachedRead(file);
		const parsed = JSON.parse(raw) as Partial<NotebookDocument>;
		return {
			version: 1,
			title: parsed.title ?? file.basename,
			createdAt: parsed.createdAt ?? new Date().toISOString(),
			updatedAt: parsed.updatedAt ?? new Date().toISOString(),
			pages: Array.isArray(parsed.pages) && parsed.pages.length > 0
				? parsed.pages.map((page, index) => ({
					id: page.id ?? generateId("page"),
					title: page.title ?? `Page ${index + 1}`,
					kind: page.kind === "pdf" ? "pdf" : "template",
					sourceLabel: page.sourceLabel ?? (page.kind === "pdf" ? `PDF page ${page.pdfSource?.page ?? index + 1}` : "Template page"),
					pdfSource: page.kind === "pdf" && page.pdfSource
						? {
							filePath: page.pdfSource.filePath,
							page: page.pdfSource.page
						}
						: undefined,
					template: page.template ?? "ruled",
					paperColor: page.paperColor ?? "#fffdf7",
					pageSize: page.pageSize ?? "a4",
					strokes: Array.isArray(page.strokes)
						? page.strokes.map((stroke) => ({
							...stroke,
							page: 1
						}))
						: [],
					textItems: Array.isArray(page.textItems)
						? page.textItems.map((item) => ({
							...item,
							page: 1
						}))
						: [],
					shapes: Array.isArray(page.shapes)
						? page.shapes.map((shape) => ({
							...shape,
							page: 1
						}))
						: []
				}))
				: createEmptyNotebookDocument(file.basename).pages
		};
	}

	async save(file: TFile, document: NotebookDocument): Promise<void> {
		document.updatedAt = new Date().toISOString();
		await this.app.vault.modify(file, JSON.stringify(document, null, 2));
	}
}
