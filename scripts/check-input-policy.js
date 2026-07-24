const fs = require("fs");
const path = require("path");

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
assertContains("src/config.ts", configTs, "inkInputPolicy: \"pen-mouse-stylus-touch\"", "default policy must be palm-safe but stylus-compatible");

assertContains("src/pointer/pointerInput.ts", pointerInputTs, "policy: InkInputPolicy = \"pen-mouse-stylus-touch\"", "pointer filter must accept an explicit policy");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "policy === \"allow-touch\"", "touch fallback policy must be implemented");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "policy === \"pen-mouse-only\"", "strict pen/mouse policy must be implemented");
assertContains("src/pointer/pointerInput.ts", pointerInputTs, "event.isPrimary === false", "touch fallback must ignore secondary touches");

assertContains("src/settings/settingsController.ts", settingsControllerTs, "normalizeInkInputPolicy", "settings loader must normalize policy values");
assertContains("src/settings/settingsController.ts", settingsControllerTs, "getInkInputPolicy()", "settings controller must expose the selected policy");
assertContains("src/settings/settingTab.ts", settingTabTs, "Ink input mode", "settings UI must expose the policy");
assertContains("src/settings/settingTab.ts", settingTabTs, "Allow touch drawing", "settings UI must expose the touch fallback");

assertContains("main.ts", mainTs, "getInkInputPolicy(): InkInputPolicy", "plugin/session must expose policy accessors");
assertContains("main.ts", mainTs, "this.getInkInputPolicy() === \"allow-touch\" ? \"none\" : \"pan-x pan-y\"", "overlay must preserve touch scrolling outside touch fallback mode");
assertContains("main.ts", mainTs, "shouldIgnoreInkPointerEvent(event, this.currentTool, this.getInkInputPolicy())", "native PDF pointer handling must pass the policy");
assertContains("main.ts", mainTs, "canvas.setCssStyles({ touchAction: \"none\" })", "accepted ink pointers must disable browser gesture handling while drawing");

assertContains("package.json", JSON.stringify(packageJson.scripts), "check:input", "package scripts must expose this verifier");

if (builtMain) {
	assertContains("main.js", builtMain, "Ink input mode", "built bundle must include the settings UI");
	assertContains("main.js", builtMain, "Allow touch drawing", "built bundle must include the touch fallback option");
	assertContains("main.js", builtMain, "pen-mouse-only", "built bundle must include strict policy handling");
}

console.log("Input-policy verifier passed.");
