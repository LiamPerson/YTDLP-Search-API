import fs from 'fs'
import { Item } from './types'
import { Worker } from 'worker_threads'

type Params = {
	jsonDirectory: string
	workerCount: number
	query: string
	/**
	 * Just have this as `__filename`. The file to run workers on.
	 */
	source: string
}

/**
 * Parallelizes the processing of JSON files using multiple worker threads.
 *
 * This function reads all `.json` files from a specified directory, divides them into chunks,
 * and processes each chunk in parallel using separate worker threads. Each worker thread handles
 * its own subset of files, allowing for efficient multi-threaded processing.
 *
 */
export const distributeTasksToWorkers = ({ jsonDirectory, workerCount, query, source }: Params) => {
	const files = fs.readdirSync(jsonDirectory).filter((file: string) => file.endsWith('.json'))
	const chunkSize = Math.ceil(files.length / workerCount)

	const promises: Promise<Item>[] = []

	for (let i = 0; i < workerCount; i++) {
		const workerFiles = files.slice(i * chunkSize, (i + 1) * chunkSize)

		promises.push(
			new Promise((resolve, reject) => {
				const worker = new Worker(source, {
					execArgv: /\.ts$/.test(source) ? ['--require', 'ts-node/register'] : undefined, // Required to run the typescript code in worker thread
					workerData: { query, workerFiles, jsonDirectory },
				})

				worker.on('message', resolve)
				worker.on('error', reject)
				worker.on('exit', (code) => {
					if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`))
				})
			})
		)
	}
	return promises
}
