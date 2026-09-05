export function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.replace(/&#x0*27;/gi, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(parseInt(n, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCharCode(parseInt(n, 16)));
}

export function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/[ \t\r\f\v]+/g, " ").trim();
}

export function sanitizeContentText(value: string, maxLength = 2000): string {
	return value.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, maxLength);
}

export function htmlToText(html: string): string {
	let text = html;
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
	text = text.replace(/<head[\s\S]*?<\/head>/gi, " ");
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
	text = text.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
	text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, "\n");
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
	text = text.replace(/<li[^>]*>/gi, "- ");
	text = decodeEntities(text.replace(/<[^>]+>/g, ""));
	text = text.replace(/[ \t\f\v]+/g, " ");
	text = text.replace(/ *\n */g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}
