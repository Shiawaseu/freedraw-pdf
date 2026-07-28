import { getShapeBounds, getTextBounds } from "./bounds";
import { distanceToSegment } from "./geometry";
import { distanceBetweenSegments, distanceToShape, segmentIntersectsExpandedBounds } from "./interaction";
import type { AnnotationDocument, AnnotationPoint, ImageAnnotation, ShapeAnnotation, StrokeAnnotation, TextAnnotation } from "../types";

interface Segment {
	start: AnnotationPoint;
	end: AnnotationPoint;
}

function getSegments(points: AnnotationPoint[]): Segment[] {
	if (points.length === 0) {
		return [];
	}
	if (points.length === 1) {
		return [{ start: points[0], end: points[0] }];
	}
	return points.slice(1).map((point, index) => ({ start: points[index], end: point }));
}

function pathTouchesStroke(stroke: StrokeAnnotation, segments: Segment[], threshold: number): boolean {
	if (stroke.points.length === 0) {
		return false;
	}
	if (segments.some((segment) => stroke.points.some((point) => distanceToSegment(point, segment.start, segment.end) <= threshold))) {
		return true;
	}
	for (let index = 1; index < stroke.points.length; index += 1) {
		if (segments.some((segment) =>
			distanceBetweenSegments(stroke.points[index - 1], stroke.points[index], segment.start, segment.end) <= threshold
		)) {
			return true;
		}
	}
	return false;
}

function pathTouchesText(item: TextAnnotation, segments: Segment[], threshold: number): boolean {
	const bounds = getTextBounds(item);
	return segments.some((segment) => segmentIntersectsExpandedBounds(segment.start, segment.end, bounds, threshold));
}

function pathTouchesImage(image: ImageAnnotation, segments: Segment[], threshold: number): boolean {
	const bounds = {
		left: image.x,
		top: image.y,
		right: image.x + image.widthScale,
		bottom: image.y + image.heightScale
	};
	return segments.some((segment) => segmentIntersectsExpandedBounds(segment.start, segment.end, bounds, threshold));
}

function pathTouchesShape(shape: ShapeAnnotation, segments: Segment[], threshold: number): boolean {
	if (shape.tool === "line") {
		return segments.some((segment) => distanceBetweenSegments(segment.start, segment.end, shape.start, shape.end) <= threshold);
	}
	const bounds = getShapeBounds(shape);
	return segments.some((segment) =>
		segmentIntersectsExpandedBounds(segment.start, segment.end, bounds, threshold) ||
		distanceToShape(segment.start, shape) <= threshold ||
		distanceToShape(segment.end, shape) <= threshold
	);
}

function getOrder(zIndex: number | undefined, fallback: number): number {
	return zIndex ?? fallback;
}

export function migrateLegacyEraserPaths(document: AnnotationDocument): boolean {
	const eraserPaths = [...(document.eraserPaths ?? [])]
		.map((annotation, index) => ({ annotation, fallbackOrder: 300000 + index }))
		.sort((left, right) => getOrder(left.annotation.zIndex, left.fallbackOrder) - getOrder(right.annotation.zIndex, right.fallbackOrder));
	if (eraserPaths.length === 0) {
		return false;
	}

	for (const { annotation: eraserPath, fallbackOrder } of eraserPaths) {
		const segments = getSegments(eraserPath.points);
		if (segments.length === 0) {
			continue;
		}
		const eraseOrder = getOrder(eraserPath.zIndex, fallbackOrder);
		document.strokes = document.strokes.filter((stroke, index) =>
			stroke.page !== eraserPath.page ||
			getOrder(stroke.zIndex, index) >= eraseOrder ||
			!pathTouchesStroke(
				stroke,
				segments,
				Math.max(0.0005, eraserPath.radiusScale) + Math.max(0, stroke.widthScale ?? 0) * 0.5
			)
		);
		document.textItems = document.textItems.filter((item, index) =>
			item.page !== eraserPath.page ||
			getOrder(item.zIndex, 100000 + index) >= eraseOrder ||
			!pathTouchesText(item, segments, eraserPath.radiusScale)
		);
		document.shapes = document.shapes.filter((shape, index) =>
			shape.page !== eraserPath.page ||
			getOrder(shape.zIndex, 200000 + index) >= eraseOrder ||
			!pathTouchesShape(shape, segments, eraserPath.radiusScale)
		);
		document.imageItems = (document.imageItems ?? []).filter((image, index) =>
			image.page !== eraserPath.page ||
			getOrder(image.zIndex, index) >= eraseOrder ||
			!pathTouchesImage(image, segments, eraserPath.radiusScale)
		);
	}
	document.eraserPaths = [];
	return true;
}
