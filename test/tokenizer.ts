// tokenizer.ts
/**
 * Very basic tokenizer: lowercase, split on non-letters.
 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
}
