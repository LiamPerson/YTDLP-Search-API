import minimist from 'minimist'
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads'
import fs from 'fs'
import { DEFAULT_RESULTS_LIMIT, DEFAULT_WORKER_CORES_LIMIT, DEFAULT_SEARCH_DIRECTORY, DEFAULT_SORT } from './search-ytdlp/constants'
import { getSortAlgorithm, findFileUrl, formatDuration, readJsonFiles, computeSimilarity } from './search-ytdlp/helpers'
import { Item, ExpectedJsonItem } from './search-ytdlp/types'

// Parse command-line arguments
const args = minimist(process.argv.slice(2), {
	alias: {
		r: 'results',
		c: 'cores',
		d: 'directory',
		s: 'sort',
	},
	default: {
		results: DEFAULT_RESULTS_LIMIT,
		cores: DEFAULT_WORKER_CORES_LIMIT,
		directory: DEFAULT_SEARCH_DIRECTORY,
		sort: DEFAULT_SORT,
	},
})

const jsonDir = args.directory
const numWorkers = args.cores
const resultsLimit = args.results
const sortAlgorithm = args.sort
const commandArguments = args._.join(' ')

// Main thread logic
if (isMainThread) {
	const files = fs.readdirSync(jsonDir).filter((file: string) => file.endsWith('.json'))
	const chunkSize = Math.ceil(files.length / numWorkers)

	const promises: Promise<Item>[] = []

	for (let i = 0; i < numWorkers; i++) {
		const workerFiles = files.slice(i * chunkSize, (i + 1) * chunkSize)

		promises.push(
			new Promise((resolve, reject) => {
				const worker = new Worker(__filename, {
					workerData: { query: commandArguments, workerFiles },
				})

				worker.on('message', resolve)
				worker.on('error', reject)
				worker.on('exit', (code) => {
					if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`))
				})
			})
		)
	}

	Promise.all(promises)
		.then((results) => {
			const combinedResults: Item[] = results.sort(getSortAlgorithm(sortAlgorithm)).slice(0, resultsLimit)

			combinedResults.forEach((result, index) => {
				const fileUrl = findFileUrl(jsonDir, result.id)

				console.log(`${index + 1}.`)
				console.log(`   Title            : ${result.title}`)
				console.log(`   ID               : ${result.id}`)
				console.log(`   Author           : ${result.uploader}`)
				console.log(`   Duration         : ${formatDuration(result.duration)}`)
				console.log(`   Similarity       : ${(result.similarity * 100).toFixed(2)}%`)
				console.log(`   Fuzzy Score      : ${(result.fuzzyScore * 100).toFixed(2)}%`)
				console.log(`   Language Score   : ${(result.languageSimilarity * 100).toFixed(2)}%`)
				console.log(`   Video            : ${fileUrl || 'Not found'}`)
				console.log('')
			})
		})
		.catch((err) => console.error(err))
} else {
	const { query, workerFiles } = workerData
	const jsonData: ExpectedJsonItem[] = readJsonFiles(jsonDir, workerFiles)
	const matches = computeSimilarity(query, jsonData)
	parentPort?.postMessage(matches)
}
