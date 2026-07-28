import { calculateVelocity, estimatePressureFromVelocity, getInputMethod, isTabletStylusEvent, isTabletWebKitTouchDevice } from "../utils/deviceUtils";
import { clamp } from "../utils/general";
import { isShapeTool } from "../tools/toolState";
import type { AnnotationTool, InkInputPolicy } from "../types";

export function isInkDrawingTool(tool: AnnotationTool): boolean {
	return tool === "pen" || tool === "highlighter" || tool === "eraser" || isShapeTool(tool);
}

export function shouldIgnoreInkPointerEvent(
	event: PointerEvent,
	tool: AnnotationTool,
	policy: InkInputPolicy = "pen-mouse-stylus-touch"
): boolean {
	if (!isInkDrawingTool(tool)) {
		return false;
	}
	const inputMethod = getInputMethod(event);
	if (inputMethod === "pen") {
		return false;
	}
	if (inputMethod === "mouse") {
		return event.button !== 0;
	}
	if (inputMethod === "touch") {
		return policy === "pen-mouse-only" || event.isPrimary === false;
	}
	if (policy === "allow-touch" && inputMethod === "unknown") {
		return event.isPrimary === false;
	}
	if (policy === "pen-mouse-only" || inputMethod === "unknown" && !hasStylusLikePressure(event)) {
		return true;
	}
	if (hasStylusLikePressure(event)) {
		return false;
	}
	return true;
}

function hasStylusLikePressure(event: PointerEvent): boolean {
	const webkitForce = (event as PointerEvent & { webkitForce?: number }).webkitForce;
	if (typeof webkitForce === "number" && webkitForce > 0.01) {
		return true;
	}
	const tiltX = (event as PointerEvent & { tiltX?: number }).tiltX;
	const tiltY = (event as PointerEvent & { tiltY?: number }).tiltY;
	if ((typeof tiltX === "number" && tiltX !== 0) || (typeof tiltY === "number" && tiltY !== 0)) {
		return true;
	}
	return typeof event.pressure === "number" && event.pressure > 0.01 && event.pressure !== 0.5;
}

export function getCoalescedPointerEvents(event: PointerEvent): PointerEvent[] {
	if (event.pointerType === "touch" && typeof event.getCoalescedEvents === "function") {
		const samples = event.getCoalescedEvents();
		if (samples.length > 0) {
			const last = samples[samples.length - 1];
			if (last.clientX !== event.clientX || last.clientY !== event.clientY || last.timeStamp !== event.timeStamp) {
				return [...samples, event];
			}
			return samples;
		}
	}
	return [event];
}

export function resolvePointerPressure(
	event: PointerEvent,
	lastPoint: { clientX: number; clientY: number } | null,
	lastPointTime: number
): number {
	if (isTabletStylusEvent(event)) {
		if (event.pressure > 0) {
			return clamp(event.pressure, 0.06, 1);
		}
		const webkitForce = (event as PointerEvent & { webkitForce?: number }).webkitForce;
		if (typeof webkitForce === "number" && webkitForce > 0) {
			return clamp(webkitForce, 0.06, 1);
		}
	}

	const inputMethod = getInputMethod(event);
	if (event.pressure > 0) {
		return clamp(event.pressure, inputMethod === "pen" ? 0.06 : 0.2, 1);
	}

	if (inputMethod === "touch") {
		const webkitForce = (event as PointerEvent & { webkitForce?: number }).webkitForce;
		if (typeof webkitForce === "number" && webkitForce > 0) {
			return clamp(webkitForce, 0.18, 1);
		}
		return isTabletWebKitTouchDevice() ? 0.42 : 0.5;
	}

	if (lastPoint && event.timeStamp) {
		const deltaTimeMs = Math.max(1, event.timeStamp - lastPointTime);
		const velocity = calculateVelocity(
			lastPoint.clientX,
			lastPoint.clientY,
			event.clientX,
			event.clientY,
			deltaTimeMs
		);
		return clamp(estimatePressureFromVelocity(velocity, 0), 0.2, 1);
	}

	return 0.5;
}
