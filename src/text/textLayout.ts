import { getTextLines } from "../annotation/bounds";
import { clamp } from "../utils/general";
import type { AnnotationPoint, TextAnnotation } from "../types";

export const INLINE_TEXT_BOX_PADDING_X = 10;
export const INLINE_TEXT_BOX_PADDING_Y = 6;
export const INLINE_TEXT_LINE_HEIGHT = 1.35;

export function getInlineTextEditorLayout(
	point: AnnotationPoint,
	width: number,
	height: number,
	existingItem?: TextAnnotation
): { left: number; top: number; width: number; height: number; point: AnnotationPoint } {
	const safeWidth = Math.max(width, 1);
	const safeHeight = Math.max(height, 1);
	const left = clamp(point.x * safeWidth, 8, Math.max(8, safeWidth - 210));
	const top = clamp(point.y * safeHeight, 8, Math.max(8, safeHeight - 64));
	const savedWidth = existingItem?.boxWidthScale && existingItem.boxWidthScale > 0
		? existingItem.boxWidthScale * safeWidth
		: 0;
	const preferredWidth = savedWidth > 0
		? savedWidth
		: Math.min(520, Math.max(240, safeWidth * 0.44));
	const availableWidth = Math.max(180, safeWidth - left - 12);
	const maxWidth = Math.max(180, Math.min(availableWidth, safeWidth * 0.78, 560));
	const editorWidth = clamp(preferredWidth, 180, maxWidth);
	const savedHeight = existingItem?.boxHeightScale && existingItem.boxHeightScale > 0
		? existingItem.boxHeightScale * safeHeight
		: 0;
	const preferredHeight = savedHeight > 0 ? savedHeight : 44;
	const editorHeight = clamp(preferredHeight, 36, Math.max(60, safeHeight - top - 12));
	return {
		left,
		top,
		width: editorWidth,
		height: editorHeight,
		point: {
			...point,
			x: clamp(left / safeWidth, 0.01, 0.96),
			y: clamp(top / safeHeight, 0.01, 0.96)
		}
	};
}

export function resizeInlineTextEditor(editor: HTMLTextAreaElement, maxHeight: number): void {
	editor.style.height = "auto";
	editor.style.height = `${Math.min(Math.max(40, editor.scrollHeight + 2), Math.max(80, maxHeight))}px`;
}

export function getWrappedCanvasTextLines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	const safeMaxWidth = Math.max(20, maxWidth);
	for (const sourceLine of getTextLines(text)) {
		if (sourceLine.trim() === "") {
			lines.push("");
			continue;
		}
		let currentLine = "";
		for (const word of sourceLine.split(/(\s+)/)) {
			if (word === "") {
				continue;
			}
			const candidate = `${currentLine}${word}`;
			if (currentLine && context.measureText(candidate).width > safeMaxWidth) {
				lines.push(currentLine.trimEnd());
				currentLine = word.trimStart();
				continue;
			}
			currentLine = candidate;
		}
		if (currentLine) {
			lines.push(currentLine.trimEnd());
		}
	}
	return lines.length > 0 ? lines : [""];
}
