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

function assertNotContains(fileName, content, needle, message) {
	if (content.includes(needle)) {
		throw new Error(`${fileName}: ${message}\nUnexpected: ${needle}`);
	}
}

function assertOccurrenceAtLeast(fileName, content, needle, minCount, message) {
	const count = content.split(needle).length - 1;
	if (count < minCount) {
		throw new Error(`${fileName}: ${message}\nExpected at least ${minCount}, found ${count}: ${needle}`);
	}
}

const mainTs = read("main.ts");
const stylesCss = read("styles.css");
const packageJson = JSON.parse(read("package.json"));
const builtMainPath = path.join(projectRoot, "main.js");
const builtMain = fs.existsSync(builtMainPath) ? fs.readFileSync(builtMainPath, "utf8") : "";

assertContains("main.ts", mainTs, "if (!this.annotationMode) {", "toolbar must have an explicit read-mode branch");
assertContains("main.ts", mainTs, "pdf-native-annotator-read-mode-hint", "read mode must be visibly labeled");
assertContains("main.ts", mainTs, "readModeHint.textContent = \"Read mode\"", "read mode label must be clear");
assertContains("main.ts", mainTs, "this.toolbarEl.appendChild(leftGroup);\n\t\t\tthis.toolbarEl.appendChild(rightGroup);\n\t\t\tthis.repositionOpenPopovers();\n\t\t\treturn;", "read mode branch must return before rendering inactive drawing controls");
assertContains("main.ts", mainTs, "this.setActiveTool(\"pen\")", "annotation mode must still switch from select to pen when enabled");
assertOccurrenceAtLeast("main.ts", mainTs, "this.addTemplatePageFromToolbar();", 2, "+ Page must be direct in both read and annotation modes");
assertNotContains("main.ts", mainTs, "this.openAddPageMenu(addPageButton)", "+ Page must not open a hidden menu");
assertContains("main.ts", mainTs, "Add notebook page before current PDF page...", "overflow menu must expose PDF-page before insertion");
assertContains("main.ts", mainTs, "Add notebook page after current PDF page...", "overflow menu must expose PDF-page after insertion");
assertNotContains("main.ts", mainTs, "setTitle(\"Add notebook page after current\")", "overflow menu must not keep the old duplicate add-after action");
assertNotContains("main.ts", mainTs, "setTitle(\"Add notebook page before current\")", "overflow menu must not keep the old duplicate add-before action");

assertContains("styles.css", stylesCss, ".pdf-native-annotator-read-mode-hint", "read-mode hint must be styled");
assertContains("package.json", JSON.stringify(packageJson.scripts), "check:toolbar", "package scripts must expose this verifier");

if (builtMain) {
	assertContains("main.js", builtMain, "Read mode", "built bundle must include compact read-mode toolbar label");
	assertContains("main.js", builtMain, "pdf-native-annotator-read-mode-hint", "built bundle must include read-mode hint class");
	assertContains("main.js", builtMain, "addTemplatePageFromToolbar", "built bundle must wire direct + Page behavior");
}

console.log("Toolbar usability verifier passed.");
