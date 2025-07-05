// tfidfIndex.ts
import { promises as fs } from 'fs'
import { Item, Vector } from './types'
import { tokenize } from './tokenizer'

interface SerializedIndex {
	vocabulary: [string, number][]
	idf: number[] // will rehydrate into Float32Array
	docVectors: number[][] // 2d arrays per document
	docIds: string[]
	N: number
}

export class TfIdfIndex {
	private vocabulary: Map<string, number> = new Map()
	private idf: Float32Array = new Float32Array(0)
	private docVectors: Vector[] = []
	private docIds: string[] = []
	private N = 0

	/**
	 * Build the index from a list of items.
	 */
	public build(items: Item[]) {
		this.N = items.length

		// 1) Document frequencies (df)
		const dfMap = new Map<string, number>()
		for (const it of items) {
			const text = [it.title, it.description, ...(it.tags || [])].join(' ')
			const tokens = new Set(tokenize(text))
			for (const t of tokens) {
				dfMap.set(t, (dfMap.get(t) || 0) + 1)
			}
		}

		// 2) vocabulary + idf
		this.vocabulary.clear()
		this.idf = new Float32Array(dfMap.size)
		let idx = 0
		for (const [term, df] of dfMap.entries()) {
			this.vocabulary.set(term, idx)
			this.idf[idx] = Math.log(this.N / df)
			idx++
		}

		// 3) docVectors
		this.docVectors = new Array(this.N)
		this.docIds = new Array(this.N)

		for (let i = 0; i < items.length; i++) {
			const it = items[i]
			this.docIds[i] = it.id

			const tfMap = new Map<number, number>()
			const tokens = tokenize([it.title, it.description, ...(it.tags || [])].join(' '))
			for (const t of tokens) {
				const ti = this.vocabulary.get(t)
				if (ti !== undefined) {
					tfMap.set(ti, (tfMap.get(ti) || 0) + 1)
				}
			}

			const v = new Float32Array(this.vocabulary.size)
			const norm = tokens.length
			for (const [ti, count] of tfMap) {
				v[ti] = (count / norm) * this.idf[ti]
			}
			this.docVectors[i] = v
		}
	}

	/**
	 * Save the built index to a JSON file.
	 */
	public async saveToFile(path: string): Promise<void> {
		const serialized: SerializedIndex = {
			vocabulary: Array.from(this.vocabulary.entries()),
			idf: Array.from(this.idf),
			docVectors: this.docVectors.map((v) => Array.from(v)),
			docIds: this.docIds.slice(),
			N: this.N,
		}
		const json = JSON.stringify(serialized)
		await fs.writeFile(path, json, 'utf8')
	}

	/**
	 * Load an index from disk (must match the above format).
	 */
	public static async loadFromFile(path: string): Promise<TfIdfIndex> {
		const raw = await fs.readFile(path, 'utf8')
		const { vocabulary, idf, docVectors, docIds, N } = JSON.parse(raw) as SerializedIndex

		const idx = new TfIdfIndex()
		idx.N = N
		// rehydrate vocabulary
		idx.vocabulary = new Map(vocabulary)
		// rehydrate idf
		idx.idf = new Float32Array(idf)
		// rehydrate docVectors
		idx.docVectors = docVectors.map((arr) => new Float32Array(arr))
		idx.docIds = docIds.slice()
		return idx
	}
	/**
	 * Given a query string, return top K results sorted by cosine similarity.
	 */
	public search(query: string, topK = 10): { id: string; score: number }[] {
		// 1) Build TF for query
		const tokens = tokenize(query)
		const tfMap = new Map<number, number>()
		for (const t of tokens) {
			const ti = this.vocabulary.get(t)
			if (ti !== undefined) tfMap.set(ti, (tfMap.get(ti) || 0) + 1)
		}

		// 2) Build query vector
		const qv = new Float32Array(this.vocabulary.size)
		const norm = tokens.length || 1
		for (const [ti, count] of tfMap.entries()) {
			qv[ti] = (count / norm) * this.idf[ti]
		}

		// 3) Precompute query norm
		const qNorm = Math.hypot(...qv)

		// 4) Compute cosine similarity vs each doc
		const results: { id: string; score: number }[] = []
		for (let i = 0; i < this.docVectors.length; i++) {
			const dv = this.docVectors[i]
			// dot product
			let dot = 0
			for (let j = 0; j < dv.length; j++) {
				dot += dv[j] * qv[j]
			}
			const dNorm = Math.hypot(...dv)
			const score = dNorm && qNorm ? dot / (dNorm * qNorm) : 0
			if (score > 0) {
				results.push({ id: this.docIds[i], score })
			}
		}

		// 5) Sort & return topK
		return results.sort((a, b) => b.score - a.score).slice(0, topK)
	}
}
