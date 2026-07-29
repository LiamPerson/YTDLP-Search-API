"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.distributeTasksToWorkers = void 0;
const fs_1 = __importDefault(require("fs"));
const worker_threads_1 = require("worker_threads");
/**
 * Parallelizes the processing of JSON files using multiple worker threads.
 *
 * This function reads all `.json` files from a specified directory, divides them into chunks,
 * and processes each chunk in parallel using separate worker threads. Each worker thread handles
 * its own subset of files, allowing for efficient multi-threaded processing.
 *
 */
const distributeTasksToWorkers = ({ jsonDirectory, workerCount, query, source }) => {
    const files = fs_1.default.readdirSync(jsonDirectory).filter((file) => file.endsWith('.json'));
    const chunkSize = Math.ceil(files.length / workerCount);
    const promises = [];
    for (let i = 0; i < workerCount; i++) {
        const workerFiles = files.slice(i * chunkSize, (i + 1) * chunkSize);
        promises.push(new Promise((resolve, reject) => {
            const worker = new worker_threads_1.Worker(source, {
                execArgv: /\.ts$/.test(source) ? ['--require', 'ts-node/register'] : undefined, // Required to run the typescript code in worker thread
                workerData: { query, workerFiles, jsonDirectory },
            });
            worker.on('message', resolve);
            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0)
                    reject(new Error(`Worker stopped with exit code ${code}`));
            });
        }));
    }
    return promises;
};
exports.distributeTasksToWorkers = distributeTasksToWorkers;
//# sourceMappingURL=main.js.map