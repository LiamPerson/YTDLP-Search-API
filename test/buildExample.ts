// buildExample.ts
import fs from 'fs'
import path from 'path'

/**
 * Change this to list the exact keys you want preserved in each object.
 */
const RELEVANT_KEYS = ['id', 'title', 'description', 'tags', 'uploader', 'duration'] as const
type RelevantKey = (typeof RELEVANT_KEYS)[number]
const NUMBER_OF_ITEMS = 700

/**
 * Given an object, return a new object containing only the relevant keys.
 */
function pickRelevant<T extends Record<string, any>>(obj: T, keys: readonly (keyof T)[]): Partial<T> {
	const out: Partial<T> = {}
	for (const k of keys) {
		if (k in obj) {
			out[k] = obj[k]
		}
	}
	return out
}

async function buildExampleJson() {
	// 1) Configure your input directory and output file
	const jsonDirectory = '/run/media/user/HardDisk3TB/YTDLP/'
	const outputFile = '/run/media/user/HardDisk3TB/YTDLP-Search-API/test/example.json'

	// 2) Read all .json except the output file
	const files = fs
		.readdirSync(jsonDirectory)
		.filter((f) => f.endsWith('.json'))
		.filter((_, i) => i < NUMBER_OF_ITEMS)

	console.log(`Found ${files.length} source files.`)

	// 3) Accumulate only relevant props
	const allItems: any[] = []

	for (const file of files) {
		const fullPath = path.join(jsonDirectory, file)
		let parsed: unknown

		try {
			const raw = fs.readFileSync(fullPath, 'utf-8')
			parsed = JSON.parse(raw)
		} catch (err) {
			console.error(`⚠️ Failed to parse ${file}:`, (err as Error).message)
			continue
		}

		// If the file holds an array, process each element; otherwise process the single object
		const entries = Array.isArray(parsed) ? parsed : [parsed]

		for (const entry of entries) {
			if (entry && typeof entry === 'object') {
				// Pick only the relevant keys
				const slim = pickRelevant(entry as Record<string, any>, RELEVANT_KEYS)
				allItems.push(slim)
			}
		}
	}

	console.log(`Collected ${allItems.length} merged entries.`)

	// 4) Write out the merged array
	fs.writeFileSync(outputFile, JSON.stringify(allItems, null, 2), 'utf-8')
	console.log(`✅ example.json written to ${outputFile}`)
}

buildExampleJson().catch((err) => {
	console.error('Fatal error:', err)
	process.exit(1)
})
