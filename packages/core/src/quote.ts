/** Renders a name for a message so that it cannot be mistaken for prose. */
export function quote(name: string): string {
	return JSON.stringify(name);
}
