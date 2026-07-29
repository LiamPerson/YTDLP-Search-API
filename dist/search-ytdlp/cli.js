"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = void 0;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const promises_1 = require("readline/promises");
const process_1 = require("process");
const config_1 = require("./config");
const constants_1 = require("./constants");
const errors_1 = require("./errors");
const helpers_1 = require("./helpers");
const search_index_1 = require("./search-index");
const parseArguments = (values) => {
    const parsed = { positionals: [], help: false, json: false, interactive: false };
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value === '--') {
            parsed.positionals.push(...values.slice(index + 1));
            break;
        }
        if (value === '-h' || value === '--help')
            parsed.help = true;
        else if (value === '--json')
            parsed.json = true;
        else if (value === '--interactive')
            parsed.interactive = true;
        else if (value === '-d' || value === '--directory')
            parsed.directory = values[++index];
        else if (value === '-r' || value === '--results')
            parsed.results = values[++index];
        else if (value === '-s' || value === '--sort')
            parsed.sort = values[++index];
        else if (value === '--offset')
            parsed.offset = values[++index];
        else if (value.startsWith('-'))
            throw new errors_1.ValidationError(`Unknown option '${value}'.`);
        else
            parsed.positionals.push(value);
    }
    return parsed;
};
const printHelp = () => {
    console.log(`
Usage:
  npm run cli -- "search words" [-r 20] [-s normal]
  npm run cli

Options:
  -d, --directory <path>  Override YTDLP_DIRECTORY for this CLI session
  -r, --results <number>  Results per search
  -s, --sort <mode>       normal, fuzzy, language, or random
      --offset <number>   Skip the first N results
      --json              Print machine-readable JSON for one-shot searches
      --interactive       Enter interactive mode after an optional first search

Interactive commands:
  :open N       Open result N with the operating system's default player
  :path N       Print the resolved media path
  :refresh      Rebuild the sidecar index after new downloads
  :stats        Show index and memory statistics
  :help         Show these commands
  :quit         Exit
`);
};
const parsePositiveInteger = (value, fallback, name, maximum) => {
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
        throw new errors_1.ValidationError(`${name} must be an integer between 0 and ${maximum}.`);
    }
    return parsed;
};
const openMedia = (mediaPath) => {
    let command;
    let args;
    if (process.platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', mediaPath];
    }
    else if (process.platform === 'darwin') {
        command = 'open';
        args = [mediaPath];
    }
    else {
        command = 'xdg-open';
        args = [mediaPath];
    }
    const child = (0, child_process_1.spawn)(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (error) => console.error(`Unable to open '${mediaPath}': ${error.message}`));
    child.unref();
};
const printResults = (results, offset = 0) => {
    if (results.length === 0) {
        console.log('No matching videos were found.');
        return;
    }
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        console.log(`${offset + index + 1}. ${result.title}`);
        console.log(`   Author     : ${result.uploader}`);
        console.log(`   ID         : ${result.id}`);
        console.log(`   Duration   : ${(0, helpers_1.formatDuration)(result.duration)}`);
        console.log(`   Relevance  : ${(result.similarity * 100).toFixed(2)}%`);
        console.log(`   Sidecar    : ${path_1.default.basename(result.sidecarPath)}`);
    }
};
const runCli = async () => {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }
    const environment = { ...process.env };
    if (args.directory)
        environment.YTDLP_DIRECTORY = args.directory;
    const config = (0, config_1.getAppConfig)(environment);
    const limit = parsePositiveInteger(args.results, config.defaultResults, 'results', config.maxResults);
    if (limit < 1)
        throw new errors_1.ValidationError('results must be at least 1.');
    const offset = parsePositiveInteger(args.offset, 0, 'offset', 1_000_000);
    const sort = String(args.sort || constants_1.SORT_OPTIONS.normal).toLowerCase();
    if (!Object.values(constants_1.SORT_OPTIONS).includes(sort))
        throw new errors_1.ValidationError(`Unknown sort mode '${sort}'.`);
    const initialQuery = args.positionals.join(' ').trim();
    const interactive = Boolean(args.interactive || !initialQuery);
    const index = new search_index_1.SidecarSearchIndex(config);
    await index.initialize();
    let lastResults = [];
    const performSearch = async (query) => {
        const effectiveQuery = query.trim() || (sort === constants_1.SORT_OPTIONS.random ? 'random' : '');
        if (!effectiveQuery)
            throw new errors_1.ValidationError('Enter a search query.');
        const execution = await index.search({ query: effectiveQuery, limit, offset, sort });
        lastResults = execution.results;
        if (args.json && !interactive) {
            const outputResults = await Promise.all(execution.results.map(async (result) => {
                const { preferredMediaPath: _preferredMediaPath, indexGeneration: _indexGeneration, ...publicResult } = result;
                return { ...publicResult, mediaPath: await index.resolveMediaPath(result) };
            }));
            console.log(JSON.stringify({ ...execution, results: outputResults }, null, 2));
            return;
        }
        printResults(execution.results, offset);
        console.log(`Search completed in ${execution.durationMs}ms across ${execution.indexedVideos.toLocaleString()} indexed videos ` +
            `(${execution.candidateCount.toLocaleString()} candidates).`);
    };
    if (initialQuery)
        await performSearch(initialQuery);
    if (!interactive)
        return;
    const terminal = (0, promises_1.createInterface)({ input: process_1.stdin, output: process_1.stdout });
    console.log('Interactive search is ready. Type :help for commands.');
    try {
        while (true) {
            const line = (await terminal.question('search> ')).trim();
            if (!line)
                continue;
            if (line === ':quit' || line === ':q' || line === ':exit')
                break;
            if (line === ':help') {
                printHelp();
                continue;
            }
            if (line === ':stats') {
                console.dir(index.getStatus(), { depth: 4 });
                continue;
            }
            if (line === ':refresh') {
                await index.refresh();
                continue;
            }
            const resultCommand = line.match(/^:(open|path)\s+(\d+)$/i);
            if (resultCommand) {
                const displayedNumber = Number(resultCommand[2]);
                const result = lastResults[displayedNumber - offset - 1] ?? lastResults[displayedNumber - 1];
                if (!result) {
                    console.log(`Result ${displayedNumber} is not in the current result set.`);
                    continue;
                }
                const mediaPath = await index.resolveMediaPath(result);
                if (!mediaPath) {
                    console.log('No matching media file was found next to that sidecar.');
                    continue;
                }
                if (resultCommand[1].toLowerCase() === 'path')
                    console.log(mediaPath);
                else
                    openMedia(mediaPath);
                continue;
            }
            try {
                await performSearch(line);
            }
            catch (error) {
                console.error((0, errors_1.toError)(error).message);
            }
        }
    }
    finally {
        terminal.close();
    }
};
exports.runCli = runCli;
if (require.main === module) {
    (0, exports.runCli)().catch((error) => {
        console.error((0, errors_1.toError)(error).message);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli.js.map