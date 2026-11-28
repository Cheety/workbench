export type JsonText =
	| { readonly parsed: true; readonly value: unknown }
	| { readonly parsed: false };

export function parseJsonText(text: string): JsonText {
	try {
		const value: unknown = JSON.parse(text);
		return { parsed: true, value };
	} catch (error) {
		if (error instanceof SyntaxError) return { parsed: false };
		throw error;
	}
}
