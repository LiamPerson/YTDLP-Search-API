// scripts/embed-with-sidecar.js
import fs from 'fs'
import path from 'path'
import { Ollama } from 'ollama'
import { config } from 'dotenv'
config()

const ollama_host = process.env.OLLAMA_HOST
if (!ollama_host) {
	throw new Error(
		'Error when creating embedding: No Ollama host provided (OLLAMA_HOST environment variable). This tool requires you to have access to an Ollama API server that serves embedding models. Ensure you have a host set in your env such as http://127.0.0.1'
	)
}

const ollama_embedding_model = process.env.OLLAMA_EMBEDDING_MODEL
if (!ollama_embedding_model) {
	throw new Error(
		'Error when creating embedding: No Ollama embedding model name provided (OLLAMA_EMBEDDING_MODEL environment variable). This tool requires you to have access to an Ollama API server that serves the embedding model you wish to use. Ensure you have a model name set that is available on your chosen ollama instance.'
	)
}

const ollama = new Ollama({ host: ollama_host })

/**
 * Generate an embedding for the provided text using Ollama.
 * @param {string} text
 * @returns {Promise<number[]>} embedding vector
 */
const generateEmbedding = async (text: string) => {
	console.log({ text })
	const { embedding } = await ollama.embeddings({
		model: ollama_embedding_model,
		prompt: text,
	})
	return embedding
}

/**
 * Save embedding as a sidecar JSON file next to the original file.
 * @param {string} filename - path to the original file
 * @param {number[]} embedding
 */
const saveEmbeddingSidecar = (filename: string, embedding: number[]) => {
	const sidecarFile = `${filename}.embedding.json`
	fs.writeFileSync(sidecarFile, JSON.stringify({ embedding }, null, 2), 'utf-8')
}

/**
 * Load embedding from a sidecar JSON file.
 * @param {string} filename - path to the original file
 * @returns {number[]} embedding vector
 */
const loadEmbeddingSidecar = (filename: string): number[] => {
	const sidecarFile = `${filename}.embedding.json`
	const raw = fs.readFileSync(sidecarFile, 'utf-8')
	const data = JSON.parse(raw)
	return data.embedding
}

/**
 * Checks if a filename or path is a valid info file (ends with ".info.json")
 * @param file
 * @returns
 */
const isInfoFile = (file: string): boolean => {
	return file.slice(-10) === '.info.json'
}

/**
 * Example: create embeddings for all .info.json files in a directory (idempotent).
 */
const embedDirectory = async (directoryPath: string) => {
	const files = fs.readdirSync(directoryPath)
	for (const file of files) {
		const fullPath = path.join(directoryPath, file)
		const stat = fs.statSync(fullPath)
		if (stat.isFile() && isInfoFile(fullPath)) {
			const sidecar = `${fullPath}.embedding.json`
			// if (fs.existsSync(sidecar)) {
			//   console.log(`Skipping (sidecar exists): ${f}`);
			//   continue;
			// }
			const text = fs.readFileSync(fullPath, 'utf-8')
			console.log(`Generating embedding for: ${file}`)
			const embedding = await generateEmbedding(text)
			saveEmbeddingSidecar(fullPath, embedding)
			console.log(`Saved sidecar: ${path.basename(sidecar)}`)
		}
	}
}

/**
 * Example: compute cosine similarity between two embeddings.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} cosine similarity in range [-1, 1]
 */
const cosineSimilarity = (a: number[], b: number[]) => {
	const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
	const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0))
	const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0))
	console.log({ dot, magA, magB })
	if (magA === 0 || magB === 0) return 0
	return dot / (magA * magB)
}

/**
 * Example: find the top N most similar documents to a query in a directory.
 */
const findMostSimilar = async (dirPath: string, queryText: string, topN = 5) => {
	const queryEmbedding = await generateEmbedding(queryText)
	console.log({ queryEmbedding })
	const results = []
	const files = fs.readdirSync(dirPath)
	for (const f of files) {
		const fullPath = path.join(dirPath, f)
		if (fs.statSync(fullPath).isFile() && path.extname(f).toLowerCase() === '.txt') {
			const sidecar = `${fullPath}.embedding.json`
			if (!fs.existsSync(sidecar)) continue
			const docEmbedding = loadEmbeddingSidecar(fullPath)
			const score = cosineSimilarity(queryEmbedding, docEmbedding)
			results.push({ file: f, score })
		}
	}
	return results.sort((a, b) => b.score - a.score).slice(0, topN)
}

/**
 * CLI usage example:
 *   node ./scripts/embed-with-sidecar.js embed ./docs
 *   node ./scripts/embed-with-sidecar.js find ./docs "your query here" 3
 */
const main = async () => {
	const [, , cmd, target, ...rest] = process.argv
	console.log({ cmd, target, rest })
	try {
		if (cmd === 'embed' && target) {
			await embedDirectory(target)
		} else if (cmd === 'find' && target && rest.length >= 1) {
			const query = rest.join(' ')
			console.log({ query })
			const topN = rest.length > 1 ? parseInt(rest[rest.length - 1], 10) || 5 : 5
			const results = await findMostSimilar(target, query, topN)
			console.table(results)
		} else {
			console.log('Usage:')
			console.log('  node embed-with-sidecar.js embed <directory>')
			console.log('  node embed-with-sidecar.js find <directory> "<query text>" [topN]')
		}
	} catch (err) {
		console.error('Error:', err)
		process.exit(1)
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main()
}
