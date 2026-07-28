export interface CooperativeRenderStep {
	run: () => void;
	expensive: boolean;
}

export interface CooperativeRenderSliceOptions {
	budgetMs: number;
	now: () => number;
	isInputPending: () => boolean;
}

export interface CooperativeRenderSliceResult {
	nextStep: number;
	inputPending: boolean;
}

export function runCooperativeRenderSlice(
	steps: CooperativeRenderStep[],
	startStep: number,
	options: CooperativeRenderSliceOptions
): CooperativeRenderSliceResult {
	const deadline = options.now() + Math.max(1, options.budgetMs);
	let nextStep = startStep;
	let processedExpensiveStep = false;

	while (nextStep < steps.length) {
		if (options.isInputPending()) {
			return { nextStep, inputPending: true };
		}

		const step = steps[nextStep];
		if (step.expensive && processedExpensiveStep) {
			break;
		}

		step.run();
		nextStep += 1;
		processedExpensiveStep = processedExpensiveStep || step.expensive;

		if (options.now() >= deadline) {
			break;
		}
	}

	return { nextStep, inputPending: false };
}
