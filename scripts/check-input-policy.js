const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");

function read(relativePath) {
	return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function assertContains(fileName, content, needle, message) {
	if (!content.includes(needle)) {
		throw new Error(`${fileName}: ${message}\nMissing: ${needle}`);
	}
}

const mainTs = read("main.ts");
const typesTs = read("src/types.ts");
const configTs = read("src/config.ts");
const pointerInputTs = read("src/pointer/pointerInput.ts");
const settingsControllerTs = read("src/settings/settingsController.ts");
const settingTabTs = read("src/settings/settingTab.ts");
const packageJson = JSON.parse(read("package.json"));
const builtMainPath = path.join(projectRoot, "main.js");
const builtMain = fs.existsSync(builtMainPath) ? fs.readFileSync(builtMainPath, "utf8") : "";

assertContains("src/types.ts", typesTs, "export type InkInputPolicy", "ink input policy type must exist");
assertContains("src/types.ts", typesTs, "inkInputPolicy: InkInputPolicy", "settings must persist the ink input policy");
assertContains("src/config.ts", configTs, "inkInputPolicy: \"allow-touch\"", "default policy must accept primary touch on iPad");

assertContains("src/pointer/pointerInput.ts", pointerInputTs, "policy: InkInputPolicy = \"pen-mouse-stylus-touch\"", "pointer filter must accept an explicit policy");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "policy === \"allow-touch\"", "touch fallback policy must be implemented");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "policy === \"pen-mouse-only\"", "strict pen/mouse policy must be implemented");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "event.isPrimary === false", "touch fallback must ignore secondary touches");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "if (inputMethod === \"touch\")", "touch pointers must use a dedicated admission path");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "policy === \"pen-mouse-only\" || event.isPrimary === false", "all primary touch must be admitted unless touch drawing is explicitly disabled");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "event.getCoalescedEvents()", "touch input must recover coalesced iPad samples");

assertContains("src/settings/settingsController.ts", settingsControllerTs, "normalizeInkInputPolicy", "settings loader must normalize policy values");
assertContains("src/settings/settingsController.ts", settingsControllerTs, "getInkInputPolicy()", "settings controller must expose the selected policy");
assertContains("src/settings/settingTab.ts", settingTabTs, "Ink input mode", "settings UI must expose the policy");
assertContains("src/settings/settingTab.ts", settingTabTs, "Allow touch drawing", "settings UI must expose the touch fallback");

assertContains("main.ts", mainTs, "getInkInputPolicy(): InkInputPolicy", "plugin/session must expose policy accessors");
assertContains("main.ts", mainTs, "this.getInkInputPolicy() === \"pen-mouse-only\" ? \"pan-x pan-y\" : \"none\"", "overlay must reserve touch before pointerdown whenever touch drawing can be accepted");
assertContains("main.ts", mainTs, "shouldIgnoreInkPointerEvent(event, this.currentTool, this.getInkInputPolicy())", "native PDF pointer handling must pass the policy");
assertContains("main.ts", mainTs, "canvas.setCssStyles({ touchAction: \"none\" })", "accepted ink pointers must disable browser gesture handling while drawing");
assertContains("main.ts", mainTs, "this.currentStroke && canvas && event.pointerType === \"touch\"", "touch pointer-up must preserve very short strokes");
assertContains("main.ts", mainTs, "if (this.activePdfPointerId !== null && this.activePdfPointerId !== event.pointerId)", "secondary pointers must not interrupt an active PDF interaction");
assertContains("main.ts", mainTs, "private moveSelectedTargetsWithinPage", "selection movement must use bounded whole-object translation");
assertContains("main.ts", mainTs, "const boundedDeltaX = clamp(deltaX, -bounds.left, 1 - bounds.right);", "selection movement must stop at the horizontal page edge without collapsing points");
assertContains("main.ts", mainTs, "const boundedDeltaY = clamp(deltaY, -bounds.top, 1 - bounds.bottom);", "selection movement must stop at the vertical page edge without collapsing points");
assertContains("main.ts", mainTs, `.${"${SESSION_ROOT_CLASS}"}, ${"${TOOLBAR_SELECTORS}"}`, "native PDF toolbar clicks must never enter fallback handwriting");

assertContains("package.json", JSON.stringify(packageJson.scripts), "check:input", "package scripts must expose this verifier");

if (builtMain) {
	assertContains("main.js", builtMain, "Ink input mode", "built bundle must include the settings UI");
	assertContains("main.js", builtMain, "Allow touch drawing", "built bundle must include the touch fallback option");
	assertContains("main.js", builtMain, "pen-mouse-only", "built bundle must include strict policy handling");
}

const transpiledPointerInput = ts.transpileModule(pointerInputTs, {
	compilerOptions: {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2018,
		skipLibCheck: true
	}
});
const pointerModule = { exports: {} };
const pointerRequire = (request) => {
	if (request === "../utils/deviceUtils") {
		return {
			calculateVelocity: () => 0,
			estimatePressureFromVelocity: () => 0.5,
			getInputMethod: (event) => event.pointerType || "unknown",
			isTabletStylusEvent: (event) => event.pointerType === "pen",
			isTabletWebKitTouchDevice: () => true
		};
	}
	if (request === "../utils/general") {
		return { clamp: (value, min, max) => Math.max(min, Math.min(max, value)) };
	}
	if (request === "../tools/toolState") {
		return { isShapeTool: () => false };
	}
	throw new Error(`Unexpected pointer-input dependency: ${request}`);
};
vm.runInNewContext(transpiledPointerInput.outputText, {
	require: pointerRequire,
	module: pointerModule,
	exports: pointerModule.exports,
	console
}, { filename: "pointerInput.check.cjs" });
const pointerInput = pointerModule.exports;
const primaryTouch = { pointerType: "touch", isPrimary: true, pressure: 0.5, button: 0 };
const secondaryTouch = { ...primaryTouch, isPrimary: false };
if (pointerInput.shouldIgnoreInkPointerEvent(primaryTouch, "pen", "allow-touch")) {
	throw new Error("primary iPad touch was rejected in touch drawing mode");
}
if (pointerInput.shouldIgnoreInkPointerEvent(primaryTouch, "pen", "pen-mouse-stylus-touch")) {
	throw new Error("legacy default mode rejected primary iPad touch");
}
if (!pointerInput.shouldIgnoreInkPointerEvent(secondaryTouch, "pen", "allow-touch")) {
	throw new Error("secondary touch was admitted as handwriting");
}
if (!pointerInput.shouldIgnoreInkPointerEvent(primaryTouch, "pen", "pen-mouse-only")) {
	throw new Error("strict pen/mouse mode admitted touch");
}
const coalescedTouch = {
	...primaryTouch,
	clientX: 3,
	clientY: 3,
	timeStamp: 3,
	getCoalescedEvents: () => [
		{ ...primaryTouch, clientX: 1, clientY: 1, timeStamp: 1 },
		{ ...primaryTouch, clientX: 2, clientY: 2, timeStamp: 2 }
	]
};
const recoveredSamples = pointerInput.getCoalescedPointerEvents(coalescedTouch);
if (recoveredSamples.length !== 3 || recoveredSamples[2] !== coalescedTouch) {
	throw new Error(`touch coalescing lost the dispatched sample (${recoveredSamples.length} samples)`);
}

console.log(`Input-policy verifier passed. recoveredTouchSamples=${recoveredSamples.length}`);
