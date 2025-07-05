import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { isMainThread, parentPort, workerData } from 'worker_threads'
import { computeSimilarity, findFileUrl, formatDuration, readJsonFiles, sliceAndSortResults } from './helpers'
import { DEFAULT_RESULTS_LIMIT, DEFAULT_WORKER_CORES_LIMIT, DEFAULT_SEARCH_DIRECTORY, DEFAULT_SORT } from './constants'
import { ExpectedJsonItem, WorkerInformation } from './types'
import { distributeTasksToWorkers } from './main'
import dayjs from 'dayjs'
import { handleSend } from './file-server'
import NodeCache from 'node-cache'
import { config } from 'dotenv'

// Configure the environment for non-standard-system users
config({ quiet: true })

// Create and configure your cache instance with a default TTL (in seconds)
const cache = new NodeCache({ stdTTL: 30 })

/**
 * Cache middleware for GET requests.
 *
 * This middleware caches responses based on the original URL. If the query parameter `escape` is present,
 * it will delete the cached value for this request so that a fresh response is generated.
 *
 * @param ttl - Time to live for cache in seconds.
 * @returns Express middleware function.
 */
function cacheMiddleware(ttl: number) {
	return (request: Request, response: Response, next: NextFunction): void => {
		// Only cache GET requests. Ignore requests with ranges too to avoid messing with video.
		if (request.method !== 'GET' || request.headers['range']) {
			return next()
		}

		// Generate a unique key using the request's original URL
		const key = `__express__${request.originalUrl || request.url}`

		// Check if the "escape" query parameter is present.
		// If yes, invalidate the cached result.
		if (request.query.escape !== undefined) {
			cache.del(key)
		} else {
			const cachedResponse = cache.get(key)
			if (cachedResponse) {
				response.send(cachedResponse)
				return
			}
		}

		// Wrap res.send so we can capture its response and cache it.
		const originalSend = response.send.bind(response)
		response.send = (body: any): Response => {
			// Save the fresh response in cache using the provided TTL.
			cache.set(key, body, ttl)
			return originalSend(body)
		}

		next()
	}
}

/**
 * The number of requests handled by the server in its lifetime
 */
let requestCount = 0

type RequestParameters = { query: string; results: number; cores: number; directory: string; sort: string }
const getParametersFromRequest = (requestQuery: Record<string, string>): RequestParameters => {
	const query = requestQuery.q
	if (!query) throw new Error('Missing query parameter')

	const results = Number(requestQuery.r) || DEFAULT_RESULTS_LIMIT
	const cores = Number(requestQuery.c) || DEFAULT_WORKER_CORES_LIMIT

	if (isNaN(results)) throw Error('Result count provided, but is not a number. Ensure you are providing a valid number.')
	if (isNaN(cores)) throw Error('Cores count provided, but is not a number. Ensure you are providing a valid number.')

	const directory = requestQuery.d || DEFAULT_SEARCH_DIRECTORY
	const sort = requestQuery.s || DEFAULT_SORT
	return { query, results, cores, directory, sort }
}

const handleSearch = (request: any, response: any) => {
	const requestNumber = ++requestCount
	console.log(`Request #${requestNumber} received ...`)
	const startTime = Date.now()

	let params
	try {
		params = getParametersFromRequest(request.query)
	} catch (error) {
		if (error instanceof Error) return response.status(400).send(error.message)
	}
	if (!params) return response.status(400).send('Something went wrong ... Undefined parameters.')

	const { results: resultsLimit, cores: workerCount, directory: jsonDirectory, sort: sortAlgorithm, query } = params

	let workerPromises
	try {
		workerPromises = distributeTasksToWorkers({ jsonDirectory, workerCount, query, source: __filename })
	} catch (err) {
		console.error(err)
		return response.status(500).send('Internal Server Error')
	}

	Promise.all(workerPromises)
		.then((results) => {
			const mergedWorkerResults = results.flat(1)
			const combinedResults = sliceAndSortResults(mergedWorkerResults, resultsLimit, sortAlgorithm)

			const responseData = combinedResults.map((result, index) => {
				let creationDate = result.upload_date || result.created_at || result.created_time
				if (typeof creationDate === 'string') creationDate = dayjs(creationDate, 'YYYYMMDD').unix()

				const fileUrl = findFileUrl(jsonDirectory, result.id)
				return {
					index: index + 1,
					title: result.title,
					id: result.id,
					uploader: result.uploader,
					duration: formatDuration(result.duration),
					similarity: (result.similarity * 100).toFixed(2) + '%',
					fuzzyScore: (result.fuzzyScore * 100).toFixed(2) + '%',
					languageSimilarity: (result.languageSimilarity * 100).toFixed(2) + '%',
					directMatchScore: (result.directMatchScore * 100).toFixed(2) + '%',
					createdAt: creationDate,
					fileUrl: fileUrl || 'Not found',
				}
			})

			console.log(`Request #${requestNumber} completed in ${Date.now() - startTime}ms.`)

			return response.json(responseData)
		})
		.catch((err) => {
			console.error(err)
			return response.status(500).send('Internal Server Error')
		})
}

// Main thread logic
if (isMainThread) {
	const app = express()
	app.use(cors())
	app.use(cacheMiddleware(300))

	const PORT = process.env.PORT || 3000
	app.listen(PORT, () => {
		console.log(`Server is running on port ${PORT}`)
	})

	app.get('/search', handleSearch)
	app.get('/file', handleSend)
} else {
	const { query, workerFiles, jsonDirectory } = workerData as WorkerInformation
	const jsonData: ExpectedJsonItem[] = readJsonFiles(jsonDirectory, workerFiles)
	const matches = computeSimilarity(query, jsonData)
	parentPort?.postMessage(matches)
}
