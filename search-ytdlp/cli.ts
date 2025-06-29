import minimist from 'minimist'
import { DEFAULT_RESULTS_LIMIT, DEFAULT_SEARCH_DIRECTORY, DEFAULT_SORT, DEFAULT_WORKER_CORES_LIMIT } from './constants'
import { isMainThread, parentPort, workerData } from 'worker_threads'
import { ExpectedJsonItem, WorkerInformation } from './types'
import { computeSimilarity, findFileUrl, formatDuration, readJsonFiles, sliceAndSortResults } from './helpers'
import { distributeTasksToWorkers } from './main'

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

const argJsonDirectory = args.directory
const argWorkerCount = args.cores
const argResultsLimit = args.results
const argSortAlgorithm = args.sort
const argQuery = process.argv[2]

// Main thread logic
if (isMainThread) {
	const workerPromises = distributeTasksToWorkers({
		jsonDirectory: argJsonDirectory,
		workerCount: argWorkerCount,
		query: argQuery,
		source: __filename,
	})

	Promise.all(workerPromises)
		.then((results) => {
			const mergedWorkerResults = results.flat(1)
			const combinedResults = sliceAndSortResults(mergedWorkerResults, argResultsLimit, argSortAlgorithm)

			combinedResults.forEach((result, index) => {
				const fileUrl = findFileUrl(argJsonDirectory, result.id)

				console.log(`${index + 1}.`)
				console.log(`   Title                : ${result.title}`)
				console.log(`   ID                   : ${result.id}`)
				console.log(`   Author               : ${result.uploader}`)
				console.log(`   Duration             : ${formatDuration(result.duration)}`)
				console.log(`   Similarity           : ${(result.similarity * 100).toFixed(2)}%`)
				console.log(`   Fuzzy Score          : ${(result.fuzzyScore * 100).toFixed(2)}%`)
				console.log(`   Language Score       : ${(result.languageSimilarity * 100).toFixed(2)}%`)
				console.log(`   Direct Match Score   : ${(result.directMatchScore * 100).toFixed(2)}%`)
				console.log(`   Video                : ${fileUrl || 'Not found'}`)
				console.log('')
			})
		})
		.catch((err) => console.error(err))
} else {
	const { query, workerFiles } = workerData as WorkerInformation
	const jsonData: ExpectedJsonItem[] = readJsonFiles(argJsonDirectory, workerFiles)
	const matches = computeSimilarity(query, jsonData)
	parentPort?.postMessage(matches)
}
