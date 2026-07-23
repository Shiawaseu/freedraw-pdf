const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { performance } = require("perf_hooks");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function createStrokeSamples() {
	const points = [];
	const count = 96;
	for (let index = 0; index < count; index += 1) {
		const t = index / (count - 1);
		const loop = Math.sin(t * Math.PI * 5.2);
		const wobble = Math.sin(t * Math.PI * 17) * 0.004;
		points.push({
			x: 0.08 + (t * 0.84),
			y: 0.48 + (loop * 0.08) + wobble,
			pressure: 0.34 + (Math.sin(t * Math.PI * 2.4) * 0.16) + (index % 9 === 0 ? 0.08 : 0),
			t: index * 8
		});
	}
	return points;
}

function getCommandCount(pathData) {
	return (pathData.match(/[MQTLCZ]/g) ?? []).length;
}

function getCoordinatePairCount(pathData) {
	return (pathData.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) ?? []).length;
}

try {
	const source = fs.readFileSync(path.join(projectRoot, "src", "ink", "inkEngine.ts"), "utf8");
	const transpiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2018,
			esModuleInterop: true,
			skipLibCheck: true
		}
	});
	const moduleShim = { exports: {} };
	vm.runInNewContext(transpiled.outputText, {
		require,
		module: moduleShim,
		exports: moduleShim.exports,
		console
	}, { filename: "inkEngine.check.cjs" });
	const ink = moduleShim.exports;
	const stroke = { widthScale: 8 / 1600, points: [] };
	for (const point of createStrokeSamples()) {
		ink.appendStrokePoints(stroke, [point]);
	}

	assert(stroke.points.length >= 72, `appendStrokePoints over-compressed handwriting samples (${stroke.points.length})`);
	assert(stroke.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.pressure)), "stroke contains non-finite point data");
	assert(stroke.points.every((point) => point.pressure >= 0.06 && point.pressure <= 1), "stroke pressure escaped expected range");

	const committedPath = ink.getSmoothInkStrokePath(stroke.points, 1600, 2200, 8, true, false, { renderMode: "committed" });
	const livePath = ink.getSmoothInkStrokePath(stroke.points, 1600, 2200, 8, true, true, { renderMode: "live" });
	const releasePreviewPath = ink.getSmoothInkStrokePath(stroke.points, 1600, 2200, 8, true, false, { renderMode: "live" });
	const tinyDotPath = ink.getSmoothInkStrokePath([
		{ x: 0.5, y: 0.5, pressure: 0.5, t: 0 },
		{ x: 0.5001, y: 0.5001, pressure: 0.5, t: 8 }
	], 1600, 2200, 8, true, false, { renderMode: "committed" });

	assert(committedPath, "committed handwriting path was not generated");
	assert(livePath, "live handwriting path was not generated");
	assert(releasePreviewPath, "release-preview handwriting path was not generated");
	assert(tinyDotPath === null, "tiny accidental dot should be suppressed");
	assert(!/NaN|Infinity/.test(committedPath), "committed path contains invalid numeric output");
	assert(!/NaN|Infinity/.test(livePath), "live path contains invalid numeric output");
	assert(!/NaN|Infinity/.test(releasePreviewPath), "release-preview path contains invalid numeric output");
	assert(getCoordinatePairCount(committedPath) >= 40, "committed path is too sparse and likely angular");
	assert(getCoordinatePairCount(livePath) >= 32, "live path is too sparse and likely angular");
	assert(releasePreviewPath === committedPath, "live release-preview and committed paths diverged, causing release-time stroke snap");
	assert(getCoordinatePairCount(livePath) >= getCoordinatePairCount(committedPath) * 0.8, "live path is much sparser than committed path and will visibly change on release");

	const start = performance.now();
	for (let index = 0; index < 30; index += 1) {
		const pathData = ink.getSmoothInkStrokePath(stroke.points, 1600, 2200, 8, true, index % 2 === 0, { renderMode: index % 2 === 0 ? "live" : "committed" });
		assert(pathData, "timed path generation returned no path");
	}
	const elapsedMs = performance.now() - start;
	assert(elapsedMs < 900, `ink path generation is too slow (${elapsedMs.toFixed(1)} ms for 30 paths)`);

	console.log(`Ink engine verifier passed. points=${stroke.points.length}; committedPairs=${getCoordinatePairCount(committedPath)}; livePairs=${getCoordinatePairCount(livePath)}; committedCommands=${getCommandCount(committedPath)}; liveCommands=${getCommandCount(livePath)}; time=${elapsedMs.toFixed(1)}ms`);
} finally {
	// No filesystem cleanup required; the transpiled module is evaluated in memory.
}
