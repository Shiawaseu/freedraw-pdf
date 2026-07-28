const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

const moduleCache = new Map();
function loadTypeScriptModule(filePath) {
	const resolvedPath = path.resolve(filePath);
	if (moduleCache.has(resolvedPath)) {
		return moduleCache.get(resolvedPath).exports;
	}
	const moduleShim = { exports: {} };
	moduleCache.set(resolvedPath, moduleShim);
	const source = fs.readFileSync(resolvedPath, "utf8");
	const transpiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2018,
			esModuleInterop: true,
			skipLibCheck: true
		}
	});
	const localRequire = (request) => {
		if (!request.startsWith(".")) {
			return require(request);
		}
		const target = path.resolve(path.dirname(resolvedPath), request);
		return loadTypeScriptModule(path.extname(target) ? target : `${target}.ts`);
	};
	const evaluate = vm.runInThisContext(
		`(function (require, module, exports) {\n${transpiled.outputText}\n})`,
		{ filename: resolvedPath }
	);
	evaluate(localRequire, moduleShim, moduleShim.exports);
	return moduleShim.exports;
}

const { migrateLegacyEraserPaths } = loadTypeScriptModule(path.join(projectRoot, "src", "annotation", "eraser.ts"));

const points = Array.from({ length: 9 }, (_, index) => ({
	x: 0.1 + index * 0.1,
	y: 0.5,
	pressure: 0.5,
	t: index * 8
}));
const document = {
	version: 7,
	sourceFile: "test.pdf",
	updatedAt: new Date().toISOString(),
	strokes: [
		{
			id: "old-stroke",
			page: 1,
			tool: "pen",
			color: "#000",
			width: 8,
			widthScale: 0.01,
			zIndex: 0,
			points,
			createdAt: new Date().toISOString()
		},
		{
			id: "newer-stroke",
			page: 1,
			tool: "pen",
			color: "#000",
			width: 8,
			widthScale: 0.01,
			zIndex: 2,
			points,
			createdAt: new Date().toISOString()
		}
	],
	eraserPaths: [{
		id: "legacy-eraser",
		page: 1,
		points: [
			{ x: 0.5, y: 0.4, pressure: 0.5 },
			{ x: 0.5, y: 0.6, pressure: 0.5 }
		],
		radiusScale: 0.055,
		zIndex: 1,
		createdAt: new Date().toISOString()
	}],
	textItems: [],
	shapes: [],
	imageItems: []
};

assert(migrateLegacyEraserPaths(document), "legacy eraser path was not migrated");
assert(document.eraserPaths.length === 0, "migrated eraser path remained renderable");
assert(!document.strokes.some((stroke) => stroke.id === "old-stroke"), "contacted stroke did not disappear atomically");
assert(document.strokes.some((stroke) => stroke.id === "newer-stroke" && stroke.points.length === points.length), "stroke drawn after the eraser was modified");
assert(!migrateLegacyEraserPaths(document), "migration was not idempotent");

console.log(`Eraser migration verifier passed. survivingStrokes=${document.strokes.length}; renderableErasers=${document.eraserPaths.length}`);
