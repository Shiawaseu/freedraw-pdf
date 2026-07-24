export async function writeClipboardText(text: string): Promise<void> {
	const electronClipboard = (window as unknown as { require?: (moduleName: string) => { clipboard?: { writeText?: (value: string) => void } } }).require?.("electron")?.clipboard;
	if (electronClipboard?.writeText) {
		electronClipboard.writeText(text);
		return;
	}
	try {
		await navigator.clipboard.writeText(text);
		return;
	} catch (error) {
		console.warn("freedraw-pdf: navigator clipboard write failed, trying textarea fallback", error);
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setCssStyles({
		position: "fixed",
		left: "-10000px",
		top: "0"
	});
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	try {
		if (!document.execCommand("copy")) {
			throw new Error("document.execCommand('copy') returned false");
		}
	} finally {
		textarea.remove();
	}
}

export async function readClipboardText(): Promise<string> {
	const electronClipboard = (window as unknown as { require?: (moduleName: string) => { clipboard?: { readText?: () => string } } }).require?.("electron")?.clipboard;
	if (electronClipboard?.readText) {
		return electronClipboard.readText();
	}
	return navigator.clipboard.readText();
}
