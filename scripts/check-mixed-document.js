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

const mainTs = read("main.ts");
const mixedExportTs = read("src/export/mixedDocumentExport.ts");
const packageJson = JSON.parse(read("package.json"));
const builtMainPath = path.join(projectRoot, "main.js");
const builtMain = fs.existsSync(builtMainPath) ? fs.readFileSync(builtMainPath, "utf8") : "";

assertContains("main.ts", mainTs, "id: \"create-blank-annotatable-pdf\"", "scratch native PDF command must be registered");
assertContains("main.ts", mainTs, "Create blank annotatable PDF", "scratch native PDF workflow must be visible");
assertContains("main.ts", mainTs, "this.addRibbonIcon(\"file-plus-2\", \"Create blank annotatable PDF\"", "scratch native PDF workflow must have a visible ribbon entry");
assertContains("main.ts", mainTs, "buildPdfFromJpegPages(pages)", "scratch native PDF workflow must create a real PDF");
assertContains("main.ts", mainTs, "createEmptyDocument(pdfFile)", "scratch native PDF must create an annotation sidecar document");
assertContains("main.ts", mainTs, "annotationDocument.pdfPageTemplates", "scratch native PDF must store template metadata in the sidecar");
assertContains("main.ts", mainTs, "await this.store.save(pdfFile, annotationDocument)", "scratch native PDF must save the annotation sidecar");

assertContains("main.ts", mainTs, "id: \"export-annotated-mixed-pdf\"", "mixed annotated PDF export command must be registered");
assertContains("main.ts", mainTs, "Export annotated mixed PDF", "mixed annotated PDF export must be visible");
assertContains("main.ts", mainTs, "await this.plugin.openPdfFileAtPage(outputFile, 1)", "mixed annotated PDF export should open the generated PDF");
assertContains("src/export/mixedDocumentExport.ts", mixedExportTs, "export async function exportAnnotatedMixedDocumentPdf", "mixed annotated PDF export implementation must exist");
assertContains("src/export/mixedDocumentExport.ts", mixedExportTs, "renderMixedPagesToPdfBytes(app, host, sourceFile, annotationDocument, mixedEntries, realPdfPageCount, true)", "mixed export must include annotations");
assertContains("src/export/mixedDocumentExport.ts", mixedExportTs, "\"annotated mixed\"", "mixed export must write a separate annotated PDF");

assertContains("main.ts", mainTs, "id: \"insert-native-notebook-page-after-current\"", "temporary insertion-after command must remain registered");
assertContains("main.ts", mainTs, "id: \"insert-native-notebook-page-before-current\"", "temporary insertion-before command must remain registered");
assertContains("main.ts", mainTs, "openTemplatePageInsertModal", "default insertion must use the configurable temporary-page modal path");
assertContains("main.ts", mainTs, "Add template page after current", "temporary insertion must be visible in menus");
assertContains("main.ts", mainTs, "Export finished annotated PDF", "finished-PDF export must be visible in the page workflow");
assertContains("main.ts", mainTs, "deleteCurrentPdfPageFromSession", "current original PDF pages must be deletable non-destructively from the session");
assertContains("main.ts", mainTs, "deletedPdfPages", "deleted original PDF pages must be tracked in the sidecar");
assertContains("main.ts", mainTs, "isPdfPageDeleted(pageNumber, document)", "deleted original PDF pages must be omitted from mixed page entries");
assertContains("main.ts", mainTs, "createNativeMixedWorkingPdf", "advanced native materialization must remain available");
assertContains("src/export/mixedDocumentExport.ts", mixedExportTs, "export async function createNativeMixedWorkingPdf", "native mixed working PDF implementation must exist");
assertContains("src/export/mixedDocumentExport.ts", mixedExportTs, "renderMixedPagesToPdfBytes(app, host, sourceFile, annotationDocument, mixedEntries, realPdfPageCount, false)", "native working PDF should keep annotations editable in sidecar");
assertContains("main.ts", mainTs, "nextDocument.appendedPages = []", "native working PDF sidecar must clear converted synthetic pages");

assertNotContains("main.ts", mainTs, "registerNotebookCommands", "standalone notebook commands must not be registered");
assertNotContains("main.ts", mainTs, "AnnotatorNotebookView", "standalone notebook view must not be registered");
assertNotContains("main.ts", mainTs, "NOTEBOOK_VIEW_TYPE", "standalone notebook view type must not be registered");

assertContains("package.json", JSON.stringify(packageJson.scripts), "check:mixed", "package scripts must expose this verifier");

if (builtMain) {
	assertContains("main.js", builtMain, "Create blank annotatable PDF", "built bundle must include scratch native PDF workflow");
	assertContains("main.js", builtMain, "Export annotated mixed PDF", "built bundle must include mixed annotated PDF export");
	assertContains("main.js", builtMain, "Add template page after current", "built bundle must include temporary page insertion");
	assertContains("main.js", builtMain, "Delete current PDF page from session", "built bundle must include session-level PDF page deletion");
	assertNotContains("main.js", builtMain, "Legacy: Create .annotbook notebook", "built bundle must not include standalone notebook commands");
	assertNotContains("main.js", builtMain, "Create annotator notebook", "built bundle must not expose the old primary annotbook command label");
}

console.log("Mixed-document verifier passed.");
