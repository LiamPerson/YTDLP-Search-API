const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const minimist = require('minimist');

const DEFAULT_SEARCH_DIRECTORY = '/run/media/user/HardDisk3TB/YTDLP/';
const DEFAULT_WORKER_CORES_LIMIT = 8;
const DEFAULT_RESULTS_LIMIT = 5;

const args = minimist(process.argv.slice(2), {
    alias: {
        r: 'results',
        c: 'cores',
        d: 'directory'
    },
    default: {
        results: DEFAULT_RESULTS_LIMIT,
        cores: DEFAULT_WORKER_CORES_LIMIT,
        directory: DEFAULT_SEARCH_DIRECTORY
    }
});

const formatDuration = (duration) => {
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
};

const searchVideos = (directory, title, resultsLimit) => {
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
    const results = [];

    for (const file of files) {
        const filePath = path.join(directory, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        if (data.title.toLowerCase().includes(title.toLowerCase())) {
            results.push({
                title: data.title,
                id: data.id,
                uploader: data.uploader,
                duration: data.duration,
                similarity: 1, // Assuming full match for simplicity
                fileUrl: path.join(directory, data.id + '.mkv') // Adjust based on your naming convention
            });
        }
    }

    return results.slice(0, resultsLimit);
};

if (isMainThread) {
    const titleToSearch = process.argv[2]; // Get the title to search from command line arguments
    const numCores = args.cores;
    const directory = args.directory;
    const resultsLimit = args.results;

    const workers = [];
    const results = [];
    const startTime = Date.now(); // Record the start time

    for (let i = 0; i < numCores; i++) {
        workers.push(new Worker(__filename, {
            workerData: { directory, titleToSearch, resultsLimit }
        }));
    }

    for (const worker of workers) {
        worker.on('message', (result) => {
            results.push(...result);
            if (results.length >= resultsLimit) {
                workers.forEach(w => w.terminate());
                console.log('Search results:');
                results.slice(0, resultsLimit).forEach((result, index) => {
                    console.log(`${index + 1}.`);
                    console.log(`   Title      : ${result.title}`);
                    console.log(`   ID         : ${result.id}`);
                    console.log(`   Author     : ${result.uploader}`);
                    console.log(`   Duration   : ${formatDuration(result.duration)}`);
                    console.log(`   Similarity : ${(result.similarity * 100).toFixed(2)}%`);
                    console.log(`   Video      : ${result.fileUrl || 'Not found'}`);
                    console.log('');
                });

                // Calculate and log the completion time
                const endTime = Date.now();
                const duration = endTime - startTime;
                console.log(`Search completed in ${duration} ms.`);
            }
        });

        worker.on('error', (error) => {
            console.error('Worker error:', error);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Worker stopped with exit code ${code}`);
            }
        });
    }
} else {
    const { directory, titleToSearch, resultsLimit } = workerData;
    const results = searchVideos(directory, titleToSearch, resultsLimit);
    parentPort.postMessage(results);
}
