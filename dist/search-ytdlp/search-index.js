"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidecarSearchIndex = void 0;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const constants_1 = require("./constants");
const errors_1 = require("./errors");
const helpers_1 = require("./helpers");
const FIELD_TITLE = 1;
const FIELD_UPLOADER = 2;
const FIELD_METADATA = 4;
const FIELD_DESCRIPTION = 8;
const FIELD_BITS = 4;
const FIELD_MASK = (1 << FIELD_BITS) - 1;
const MAX_ERROR_SAMPLES = 20;
const MAX_MEDIA_CACHE_ENTRIES = 10_000;
const MAX_FUZZY_TERMS_PER_QUERY_TOKEN = 12;
const MAX_FUZZY_TERM_COMPARISONS = 25_000;
const MAX_TITLE_TOKENS_PER_DOCUMENT = 96;
const MAX_UPLOADER_TOKENS_PER_DOCUMENT = 48;
const MAX_TITLE_COMPOUND_TOKENS_PER_DOCUMENT = 24;
const MAX_QUERY_COMPOUND_TERMS = 12;
const MAX_QUERY_COMPOUND_SPAN = 4;
const MIN_TITLE_EDGE_TOKEN_LENGTH = 7;
const MAX_TITLE_EDGE_TERMS_PER_BUCKET = 2_048;
const fieldWeight = (mask) => {
    let score = 0;
    if (mask & FIELD_TITLE)
        score += 6;
    if (mask & FIELD_UPLOADER)
        score += 1.5;
    if (mask & FIELD_METADATA)
        score += 2.5;
    if (mask & FIELD_DESCRIPTION)
        score += 1;
    return score;
};
const encodePosting = (documentIndex, mask) => documentIndex * (1 << FIELD_BITS) + mask;
const decodeDocumentIndex = (posting) => Math.floor(posting / (1 << FIELD_BITS));
const decodeFieldMask = (posting) => posting & FIELD_MASK;
const fullQueryMask = (tokenCount) => (tokenCount >= 31 ? 0x7fffffff : (1 << tokenCount) - 1);
const titleEdgeKey = (token) => {
    if (token.length < MIN_TITLE_EDGE_TOKEN_LENGTH)
        return undefined;
    return `${token.slice(0, 3)}:${token.slice(-3)}`;
};
const assertNotAborted = (signal) => {
    if (!signal?.aborted)
        return;
    const reason = signal.reason;
    if (reason instanceof Error)
        throw reason;
    throw new errors_1.CancelledError(typeof reason === 'string' ? reason : 'The operation was cancelled.');
};
const createQueryLookupTerms = (queryTokens) => {
    const output = queryTokens.map((token, index) => ({
        token,
        matchedMask: index < 31 ? 1 << index : 0,
        scoreMultiplier: 1,
        compound: false,
    }));
    const baseTokens = new Set(queryTokens);
    const compounds = new Map();
    const maximumSpan = Math.min(MAX_QUERY_COMPOUND_SPAN, queryTokens.length);
    for (let span = 2; span <= maximumSpan; span += 1) {
        for (let start = 0; start + span <= queryTokens.length; start += 1) {
            const token = queryTokens.slice(start, start + span).join('');
            if (token.length < 4 || token.length > 64 || baseTokens.has(token))
                continue;
            let matchedMask = 0;
            for (let index = start; index < start + span && index < 31; index += 1)
                matchedMask |= 1 << index;
            const existing = compounds.get(token);
            if (existing) {
                existing.matchedMask |= matchedMask;
                existing.scoreMultiplier = Math.max(existing.scoreMultiplier, Math.sqrt(span));
            }
            else {
                compounds.set(token, { token, matchedMask, scoreMultiplier: Math.sqrt(span), compound: true });
            }
            if (compounds.size >= MAX_QUERY_COMPOUND_TERMS)
                return [...output, ...compounds.values()];
        }
    }
    return [...output, ...compounds.values()];
};
class PostingBuilder {
    config;
    postings = new Map();
    ignoredTerms = new Set();
    postingCount = 0;
    droppedFrequentTerms = 0;
    descriptionTokenBudgetExhausted = false;
    descriptionDocumentsTruncated = 0;
    duplicateIds = 0;
    seenIds = new Set();
    documents = [];
    constructor(config) {
        this.config = config;
    }
    addDocument(info, sidecarPath) {
        const sidecarDirectory = path_1.default.dirname(sidecarPath);
        const fallbackId = this.removeSidecarSuffix(path_1.default.basename(sidecarPath));
        const id = (0, helpers_1.safeString)(info.id, 1_000) || (0, helpers_1.safeString)(info.display_id, 1_000) || fallbackId || `video-${this.documents.length + 1}`;
        const title = (0, helpers_1.safeString)(info.title, 2_000) || (0, helpers_1.safeString)(info.fulltitle, 2_000) || (0, helpers_1.safeString)(info.alt_title, 2_000) || id;
        const uploader = (0, helpers_1.safeString)(info.uploader, 1_000) ||
            (0, helpers_1.safeString)(info.channel, 1_000) ||
            (0, helpers_1.safeString)(info.creator, 1_000) ||
            (0, helpers_1.safeString)(info.artist, 1_000) ||
            (0, helpers_1.safeString)(info.uploader_id, 1_000) ||
            'Unknown';
        const duration = Math.max(0, (0, helpers_1.safeNumber)(info.duration));
        const description = (0, helpers_1.safeString)(info.description, this.config.descriptionIndexChars);
        const tags = (0, helpers_1.stringArray)(info.tags);
        const categories = (0, helpers_1.stringArray)(info.categories);
        const extraMetadata = [
            (0, helpers_1.safeString)(info.playlist, 2_000),
            (0, helpers_1.safeString)(info.playlist_title, 2_000),
            (0, helpers_1.safeString)(info.series, 2_000),
            (0, helpers_1.safeString)(info.season, 1_000),
            (0, helpers_1.safeString)(info.episode, 2_000),
            (0, helpers_1.safeString)(info.track, 2_000),
            (0, helpers_1.safeString)(info.album, 2_000),
            (0, helpers_1.safeString)(info.webpage_url_domain, 500),
            id,
        ].filter(Boolean);
        const titleSearch = (0, helpers_1.normalizeText)(title);
        const uploaderSearch = (0, helpers_1.normalizeText)(uploader);
        const metadataSearch = (0, helpers_1.normalizeText)([...tags, ...categories, ...extraMetadata].join(' ')).slice(0, this.config.metadataSearchChars);
        const descriptionExcerpt = (0, helpers_1.normalizeText)(description.slice(0, Math.max(this.config.descriptionExcerptChars * 3, this.config.descriptionExcerptChars))).slice(0, this.config.descriptionExcerptChars);
        const createdAt = (0, helpers_1.parseCreationTimestamp)(info.timestamp) ??
            (0, helpers_1.parseCreationTimestamp)(info.release_timestamp) ??
            (0, helpers_1.parseCreationTimestamp)(info.upload_date) ??
            (0, helpers_1.parseCreationTimestamp)(info.created_at) ??
            (0, helpers_1.parseCreationTimestamp)(info.created_time);
        const preferredMediaPath = this.extractPreferredMediaPath(info, sidecarDirectory);
        const index = this.documents.length;
        if (this.seenIds.has(id))
            this.duplicateIds += 1;
        else
            this.seenIds.add(id);
        this.documents.push({
            index,
            id,
            title,
            uploader,
            duration,
            createdAt,
            sidecarPath,
            preferredMediaPath,
            titleSearch,
            uploaderSearch,
            metadataSearch,
            descriptionExcerpt,
        });
        const tokenMasks = new Map();
        const titleTokens = (0, helpers_1.tokenize)(titleSearch, {
            maximumTokens: MAX_TITLE_TOKENS_PER_DOCUMENT,
            includeStopWords: true,
        });
        this.addTokensToMask(tokenMasks, titleTokens, FIELD_TITLE);
        this.addTokensToMask(tokenMasks, (0, helpers_1.createCompoundTokens)(titleTokens, {
            maximumTokens: MAX_TITLE_COMPOUND_TOKENS_PER_DOCUMENT,
            maximumSpan: 2,
            maximumLength: 64,
            minimumComponentLength: 2,
            alphabeticComponentsOnly: true,
        }), FIELD_TITLE);
        this.addTokensToMask(tokenMasks, (0, helpers_1.tokenize)(uploaderSearch, { maximumTokens: MAX_UPLOADER_TOKENS_PER_DOCUMENT, includeStopWords: true }), FIELD_UPLOADER);
        this.addTokensToMask(tokenMasks, (0, helpers_1.tokenize)(metadataSearch, {
            maximumTokens: this.config.metadataTokensPerDocument,
            includeStopWords: true,
        }), FIELD_METADATA);
        const descriptionTokens = this.config.descriptionTokensPerDocument > 0
            ? (0, helpers_1.tokenize)(description, {
                maximumTokens: this.config.descriptionTokensPerDocument,
                includeStopWords: false,
            })
            : [];
        if (this.config.descriptionTokensPerDocument > 0 &&
            descriptionTokens.length >= this.config.descriptionTokensPerDocument &&
            description.length > 0) {
            this.descriptionDocumentsTruncated += 1;
        }
        this.addTokensToMask(tokenMasks, descriptionTokens, FIELD_DESCRIPTION);
        for (const [token, mask] of tokenMasks) {
            const isDescriptionOnly = mask === FIELD_DESCRIPTION;
            if (isDescriptionOnly && this.postingCount >= this.config.maxIndexPostings) {
                this.descriptionTokenBudgetExhausted = true;
                continue;
            }
            this.addPosting(token, encodePosting(index, mask));
        }
    }
    finalize(generation, buildStats) {
        const postingValues = new Uint32Array(this.postingCount);
        const postingRanges = new Map();
        let offset = 0;
        for (const [token, values] of this.postings) {
            postingValues.set(values, offset);
            postingRanges.set(token, { offset, length: values.length });
            offset += values.length;
        }
        const fuzzyBuckets = new Map();
        const titleEdgeBuckets = new Map();
        const droppedTitleEdgeKeys = new Set();
        let titleEdgeTermCount = 0;
        for (const [token, range] of postingRanges) {
            const key = this.fuzzyBucketKey(token[0], token.length);
            const bucket = fuzzyBuckets.get(key);
            if (bucket)
                bucket.push(token);
            else
                fuzzyBuckets.set(key, [token]);
            const edgeKey = titleEdgeKey(token);
            if (!edgeKey || droppedTitleEdgeKeys.has(edgeKey))
                continue;
            let appearsInTitle = false;
            for (let offset = range.offset; offset < range.offset + range.length; offset += 1) {
                if (decodeFieldMask(postingValues[offset]) & FIELD_TITLE) {
                    appearsInTitle = true;
                    break;
                }
            }
            if (!appearsInTitle)
                continue;
            const edgeBucket = titleEdgeBuckets.get(edgeKey);
            if (!edgeBucket) {
                titleEdgeBuckets.set(edgeKey, [token]);
                titleEdgeTermCount += 1;
            }
            else if (edgeBucket.length >= MAX_TITLE_EDGE_TERMS_PER_BUCKET) {
                titleEdgeBuckets.delete(edgeKey);
                droppedTitleEdgeKeys.add(edgeKey);
                titleEdgeTermCount -= edgeBucket.length;
            }
            else {
                edgeBucket.push(token);
                titleEdgeTermCount += 1;
            }
        }
        const stats = {
            ...buildStats,
            indexedVideos: this.documents.length,
            duplicateIds: this.duplicateIds,
            postingCount: offset,
            termCount: postingRanges.size,
            droppedFrequentTerms: this.droppedFrequentTerms,
            titleEdgeTermCount,
            titleEdgeBucketCount: titleEdgeBuckets.size,
            droppedTitleEdgeBuckets: droppedTitleEdgeKeys.size,
            descriptionTokenBudgetExhausted: this.descriptionTokenBudgetExhausted,
            descriptionDocumentsTruncated: this.descriptionDocumentsTruncated,
        };
        return {
            documents: this.documents,
            postingValues,
            postingRanges,
            fuzzyBuckets,
            titleEdgeBuckets,
            ignoredTerms: this.ignoredTerms,
            generation,
            builtAt: Date.now(),
            stats,
        };
    }
    addTokensToMask(target, tokens, mask) {
        for (const token of tokens)
            target.set(token, (target.get(token) ?? 0) | mask);
    }
    addPosting(token, encodedPosting) {
        if (this.ignoredTerms.has(token))
            return;
        const existing = this.postings.get(token);
        if (!existing) {
            this.postings.set(token, [encodedPosting]);
            this.postingCount += 1;
            return;
        }
        if (existing.length >= this.config.maxPostingsPerTerm) {
            this.postings.delete(token);
            this.ignoredTerms.add(token);
            this.postingCount -= existing.length;
            this.droppedFrequentTerms += 1;
            return;
        }
        existing.push(encodedPosting);
        this.postingCount += 1;
    }
    extractPreferredMediaPath(info, sidecarDirectory) {
        const candidates = [];
        for (const value of [info._filename, info.filename]) {
            if (typeof value === 'string' && value.trim())
                candidates.push(value.trim());
        }
        if (Array.isArray(info.requested_downloads)) {
            for (const download of info.requested_downloads) {
                if (!download || typeof download !== 'object')
                    continue;
                const record = download;
                for (const value of [record.filepath, record.filename]) {
                    if (typeof value === 'string' && value.trim())
                        candidates.push(value.trim());
                }
            }
        }
        for (const candidate of candidates) {
            const resolved = path_1.default.isAbsolute(candidate) ? path_1.default.resolve(candidate) : path_1.default.resolve(sidecarDirectory, candidate);
            if ((0, helpers_1.isPathInside)(this.config.searchDirectory, resolved) && constants_1.MEDIA_EXTENSIONS.has(path_1.default.extname(resolved).toLowerCase())) {
                return resolved;
            }
        }
        return undefined;
    }
    removeSidecarSuffix(fileName) {
        const lowerName = fileName.toLowerCase();
        for (const suffix of this.config.sidecarSuffixes) {
            if (lowerName.endsWith(suffix))
                return fileName.slice(0, -suffix.length);
        }
        return path_1.default.parse(fileName).name;
    }
    fuzzyBucketKey(firstCharacter, length) {
        return `${firstCharacter}:${length}`;
    }
}
class SidecarSearchIndex {
    config;
    logger;
    snapshot;
    liveSegments = [];
    pathVersions = new Map();
    knownSidecars = new Set();
    sidecarFingerprints = new Map();
    baseIndexedPaths = new Set();
    retrySidecars = new Map();
    activeIndexedVideos = 0;
    liveDocumentCount = 0;
    lastSyncAt;
    lastSync;
    state = 'idle';
    generation = 0;
    activeSearches = 0;
    refreshPromise;
    mutationTail = Promise.resolve();
    readyPromise = Promise.resolve();
    resolveReady;
    rejectReady;
    idleWaiters = [];
    startedAt;
    readyAt;
    lastError;
    progress = {
        sidecarFilesFound: 0,
        processedFiles: 0,
        indexedVideos: 0,
        invalidSidecars: 0,
        oversizedSidecars: 0,
    };
    mediaPathCache = new Map();
    constructor(config, logger = console) {
        this.config = config;
        this.logger = logger;
    }
    getStatus() {
        const baseStats = this.snapshot?.stats;
        return {
            state: this.state,
            rootDirectory: this.config.searchDirectory,
            generation: this.generation,
            activeSearches: this.activeSearches,
            startedAt: this.startedAt,
            readyAt: this.readyAt,
            lastError: this.lastError,
            progress: { ...this.progress, indexedVideos: this.activeIndexedVideos || this.progress.indexedVideos },
            stats: baseStats ? { ...baseStats, indexedVideos: this.activeIndexedVideos } : undefined,
            live: {
                indexedVideos: this.activeIndexedVideos,
                segments: this.liveSegments.length,
                changedPaths: this.pathVersions.size,
                pendingRetries: this.retrySidecars.size,
                lastSyncAt: this.lastSyncAt,
                lastSyncDurationMs: this.lastSync?.durationMs,
                lastSync: this.lastSync,
            },
            memory: process.memoryUsage(),
        };
    }
    async initialize() {
        if (this.state === 'ready' && this.snapshot)
            return this.snapshot.stats;
        return this.refresh();
    }
    async refresh() {
        if (this.refreshPromise)
            return this.refreshPromise;
        this.refreshPromise = this.enqueueMutation(() => this.performRefresh()).finally(() => {
            this.refreshPromise = undefined;
        });
        return this.refreshPromise;
    }
    isSidecarPath(candidatePath) {
        const resolved = path_1.default.resolve(candidatePath);
        return (0, helpers_1.isPathInside)(this.config.searchDirectory, resolved) && this.isSidecarFile(path_1.default.basename(resolved));
    }
    async applySidecarChanges(sidecarPaths) {
        const paths = [...new Set([...sidecarPaths].map((candidate) => path_1.default.resolve(candidate)).filter((candidate) => this.isSidecarPath(candidate)))];
        return this.enqueueMutation(async () => {
            if (!this.snapshot || this.state !== 'ready')
                await this.performRefresh();
            return this.performIncrementalUpdate(paths);
        });
    }
    async synchronizeFromDisk() {
        return this.enqueueMutation(async () => {
            if (!this.snapshot || this.state !== 'ready')
                await this.performRefresh();
            return this.performDiskSynchronization();
        });
    }
    async search(parameters, signal) {
        const startedAt = Date.now();
        let view;
        // Acquiring every immutable part of the view and incrementing activeSearches
        // happens in one synchronous turn. Full compaction can then wait for this
        // search, while small live segments may be published atomically beside it.
        while (true) {
            assertNotAborted(signal);
            if (this.state === 'ready' && this.snapshot) {
                view = {
                    base: this.snapshot,
                    segments: this.liveSegments,
                    pathVersions: this.pathVersions,
                    generation: this.generation,
                    indexedVideos: this.activeIndexedVideos,
                };
                this.activeSearches += 1;
                break;
            }
            await this.waitUntilReady(signal);
        }
        try {
            if (parameters.sort === constants_1.SORT_OPTIONS.random) {
                return await this.searchRandomView(view, parameters, startedAt, signal);
            }
            return await this.searchRankedView(view, parameters, startedAt, signal);
        }
        finally {
            this.activeSearches -= 1;
            if (this.activeSearches === 0) {
                const waiters = this.idleWaiters.splice(0);
                for (const resolve of waiters)
                    resolve();
            }
        }
    }
    async resolveMediaPath(result, signal) {
        assertNotAborted(signal);
        const cacheKey = `${result.indexGeneration}\u0000${result.sidecarPath}`;
        const cached = this.mediaPathCache.get(cacheKey);
        if (cached !== undefined) {
            this.touchMediaCache(cacheKey, cached);
            return cached;
        }
        const candidates = [];
        if (result.preferredMediaPath)
            candidates.push(result.preferredMediaPath);
        const sidecarBase = this.removeSidecarSuffix(result.sidecarPath);
        for (const extension of constants_1.MEDIA_EXTENSIONS)
            candidates.push(`${sidecarBase}${extension}`);
        for (const extension of constants_1.MEDIA_EXTENSIONS)
            candidates.push(path_1.default.join(path_1.default.dirname(result.sidecarPath), `${result.id}${extension}`));
        for (const candidate of new Set(candidates)) {
            assertNotAborted(signal);
            if (!(0, helpers_1.isPathInside)(this.config.searchDirectory, candidate))
                continue;
            try {
                const stats = await fs_1.promises.stat(candidate);
                if (stats.isFile()) {
                    this.touchMediaCache(cacheKey, candidate);
                    return candidate;
                }
            }
            catch (error) {
                const code = error.code;
                if (code !== 'ENOENT' && code !== 'ENOTDIR')
                    this.logger.warn(`Unable to inspect media candidate '${candidate}':`, error);
            }
        }
        return null;
    }
    toFileUrl(mediaPath) {
        return mediaPath ? (0, url_1.pathToFileURL)(mediaPath).href : null;
    }
    toRelativeMediaPath(mediaPath) {
        if (!mediaPath || !(0, helpers_1.isPathInside)(this.config.searchDirectory, mediaPath))
            return null;
        return path_1.default.relative(this.config.searchDirectory, mediaPath);
    }
    async performRefresh() {
        // Enter loading before waiting so new searches queue behind the refresh
        // instead of acquiring the snapshot that is about to be discarded.
        this.state = 'loading';
        this.startedAt = Date.now();
        this.readyAt = undefined;
        this.lastError = undefined;
        this.progress = {
            sidecarFilesFound: 0,
            processedFiles: 0,
            indexedVideos: 0,
            invalidSidecars: 0,
            oversizedSidecars: 0,
        };
        this.createReadyPromise();
        await this.waitForIdleSearches();
        // Drop the old snapshot before rebuilding. This briefly pauses searches but
        // avoids doubling the index's peak memory during a refresh.
        this.snapshot = undefined;
        this.liveSegments = [];
        this.pathVersions = new Map();
        this.baseIndexedPaths = new Set();
        this.sidecarFingerprints = new Map();
        this.activeIndexedVideos = 0;
        this.liveDocumentCount = 0;
        this.mediaPathCache.clear();
        try {
            const builder = new PostingBuilder(this.config);
            const discoveredSidecars = new Set();
            const discoveredFingerprints = new Map();
            const invalidPaths = new Set();
            const errorSamples = [];
            let invalidSidecars = 0;
            let oversizedSidecars = 0;
            const workerCount = Math.max(1, this.config.indexReadConcurrency);
            const activeReads = new Set();
            const processSidecar = async (sidecarPath) => {
                try {
                    const stats = await fs_1.promises.stat(sidecarPath);
                    if (!stats.isFile())
                        return;
                    discoveredFingerprints.set(sidecarPath, this.sidecarFingerprint(stats.size, stats.mtimeMs));
                    if (stats.size > this.config.maxSidecarBytes) {
                        oversizedSidecars += 1;
                        this.recordErrorSample(errorSamples, sidecarPath, `Skipped because it is ${stats.size.toLocaleString()} bytes; MAX_SIDECAR_BYTES is ${this.config.maxSidecarBytes.toLocaleString()}.`);
                        return;
                    }
                    const content = await fs_1.promises.readFile(sidecarPath, 'utf8');
                    const parsed = JSON.parse(content);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        throw new errors_1.ValidationError('The sidecar root must be a JSON object.');
                    }
                    builder.addDocument(parsed, sidecarPath);
                }
                catch (error) {
                    const normalized = (0, errors_1.toError)(error);
                    if (normalized instanceof RangeError && /allocation|heap|array length/iu.test(normalized.message)) {
                        throw new errors_1.AppError('The index reached the available JavaScript heap before it could finish. Lower the index limits or start Node with a larger --max-old-space-size value.', { statusCode: 503, code: 'INDEX_MEMORY_LIMIT', expose: true });
                    }
                    invalidSidecars += 1;
                    invalidPaths.add(sidecarPath);
                    this.recordErrorSample(errorSamples, sidecarPath, normalized.message);
                }
                finally {
                    this.progress.processedFiles += 1;
                    this.progress.indexedVideos = builder.documents.length;
                    this.progress.invalidSidecars = invalidSidecars;
                    this.progress.oversizedSidecars = oversizedSidecars;
                    if (this.progress.processedFiles % this.config.indexProgressEvery === 0) {
                        this.logger.log(`Indexed ${builder.documents.length.toLocaleString()} videos from ` +
                            `${this.progress.sidecarFilesFound.toLocaleString()} discovered sidecars ` +
                            `(${invalidSidecars.toLocaleString()} invalid, ${oversizedSidecars.toLocaleString()} oversized).`);
                        await (0, helpers_1.yieldToEventLoop)();
                    }
                }
            };
            for await (const sidecarPath of this.iterateSidecarPaths()) {
                discoveredSidecars.add(sidecarPath);
                this.progress.sidecarFilesFound += 1;
                while (activeReads.size >= workerCount)
                    await Promise.race(activeReads);
                let task;
                task = processSidecar(sidecarPath).finally(() => activeReads.delete(task));
                activeReads.add(task);
            }
            await Promise.all(activeReads);
            this.logger.log(`Finished reading ${this.progress.sidecarFilesFound.toLocaleString()} sidecars; compacting the index ...`);
            this.generation += 1;
            const snapshot = builder.finalize(this.generation, {
                sidecarFilesFound: this.progress.sidecarFilesFound,
                processedFiles: this.progress.processedFiles,
                indexedVideos: builder.documents.length,
                invalidSidecars,
                oversizedSidecars,
                errorSamples,
                durationMs: 0,
            });
            const durationMs = Date.now() - (this.startedAt ?? Date.now());
            snapshot.stats.durationMs = durationMs;
            this.snapshot = snapshot;
            this.knownSidecars = discoveredSidecars;
            this.sidecarFingerprints = discoveredFingerprints;
            this.baseIndexedPaths = new Set(snapshot.documents.map((document) => document.sidecarPath));
            this.retrySidecars = new Map([...invalidPaths].map((sidecarPath) => [sidecarPath, { attempts: 0, nextAttemptAt: Date.now() }]));
            this.liveSegments = [];
            this.pathVersions = new Map();
            this.activeIndexedVideos = snapshot.documents.length;
            this.liveDocumentCount = 0;
            this.lastSyncAt = Date.now();
            this.lastSync = undefined;
            this.state = 'ready';
            this.readyAt = Date.now();
            this.resolveReady?.();
            this.logger.log(`Search index ready: ${snapshot.documents.length.toLocaleString()} videos, ` +
                `${snapshot.stats.termCount.toLocaleString()} terms, ${durationMs.toLocaleString()}ms.`);
            if (snapshot.stats.descriptionTokenBudgetExhausted) {
                this.logger.warn('The description posting budget was reached. Titles, uploaders, tags, categories and other compact metadata remain fully indexed; some later description-only terms were omitted to keep memory bounded.');
            }
            return snapshot.stats;
        }
        catch (error) {
            const caughtError = (0, errors_1.toError)(error);
            const normalizedError = caughtError instanceof RangeError && /allocation|heap|array length/iu.test(caughtError.message)
                ? new errors_1.AppError('The index reached the available JavaScript heap before it could finish. Lower DESCRIPTION_INDEX_CHARS, DESCRIPTION_TOKENS_PER_DOCUMENT, METADATA_SEARCH_CHARS or MAX_INDEX_POSTINGS, or start Node with a larger --max-old-space-size value.', { statusCode: 503, code: 'INDEX_MEMORY_LIMIT', expose: true })
                : caughtError;
            this.state = 'error';
            this.lastError = normalizedError.message;
            this.rejectReady?.(normalizedError);
            this.logger.error('Search index build failed:', normalizedError);
            throw normalizedError;
        }
    }
    async searchRankedView(view, parameters, startedAt, signal) {
        const requested = parameters.offset + parameters.limit;
        const segmentParameters = { ...parameters, offset: 0, limit: requested };
        const combined = [];
        let candidateCount = 0;
        const baseFilter = view.pathVersions.size === 0
            ? undefined
            : (document) => !view.pathVersions.has(document.sidecarPath);
        const baseExecution = await this.searchRanked(view.base, segmentParameters, Date.now(), signal, baseFilter);
        combined.push(...baseExecution.results);
        candidateCount += baseExecution.candidateCount;
        for (const segment of view.segments) {
            assertNotAborted(signal);
            const segmentExecution = await this.searchRanked(segment, segmentParameters, Date.now(), signal, (document) => view.pathVersions.get(document.sidecarPath) === segment.generation);
            combined.push(...segmentExecution.results);
            candidateCount += segmentExecution.candidateCount;
        }
        combined.sort((0, helpers_1.getSortAlgorithm)(parameters.sort));
        return {
            query: parameters.query,
            results: combined.slice(parameters.offset, parameters.offset + parameters.limit),
            candidateCount,
            indexedVideos: view.indexedVideos,
            durationMs: Date.now() - startedAt,
            indexGeneration: view.generation,
        };
    }
    async searchRandomView(view, parameters, startedAt, signal) {
        if (parameters.offset !== 0) {
            throw new errors_1.ValidationError('Random search does not support offsets. Run another random search instead.');
        }
        const sources = [view.base, ...view.segments];
        const sourceOffsets = [];
        let slotCount = 0;
        for (const source of sources) {
            sourceOffsets.push(slotCount);
            slotCount += source.documents.length;
        }
        const sampleSize = Math.min(view.indexedVideos, parameters.limit);
        const selectedPaths = new Set();
        const selected = [];
        const maximumAttempts = Math.max(1_000, sampleSize * 50);
        let attempts = 0;
        const isActive = (source, document) => {
            if (source === view.base)
                return !view.pathVersions.has(document.sidecarPath);
            return view.pathVersions.get(document.sidecarPath) === source.generation;
        };
        const getRandomDocument = () => {
            if (slotCount === 0)
                return undefined;
            const slot = Math.floor(Math.random() * slotCount);
            let sourceIndex = sources.length - 1;
            for (let index = 1; index < sourceOffsets.length; index += 1) {
                if (slot < sourceOffsets[index]) {
                    sourceIndex = index - 1;
                    break;
                }
            }
            const source = sources[sourceIndex];
            const document = source.documents[slot - sourceOffsets[sourceIndex]];
            return document ? { source, document } : undefined;
        };
        while (selected.length < sampleSize && attempts < maximumAttempts) {
            assertNotAborted(signal);
            attempts += 1;
            const candidate = getRandomDocument();
            if (!candidate || !isActive(candidate.source, candidate.document))
                continue;
            if (selectedPaths.has(candidate.document.sidecarPath))
                continue;
            selectedPaths.add(candidate.document.sidecarPath);
            selected.push({ document: candidate.document, generation: candidate.source.generation });
        }
        // The live overlay is deliberately compacted before it contains many stale
        // slots. This fallback still guarantees a complete sample after heavy churn.
        if (selected.length < sampleSize) {
            for (const source of sources) {
                for (const document of source.documents) {
                    assertNotAborted(signal);
                    if (!isActive(source, document) || selectedPaths.has(document.sidecarPath))
                        continue;
                    selectedPaths.add(document.sidecarPath);
                    selected.push({ document, generation: source.generation });
                    if (selected.length >= sampleSize)
                        break;
                }
                if (selected.length >= sampleSize)
                    break;
            }
        }
        for (let index = selected.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            const temporary = selected[index];
            selected[index] = selected[swapIndex];
            selected[swapIndex] = temporary;
        }
        const results = selected.map(({ document, generation }) => ({
            id: document.id,
            title: document.title,
            uploader: document.uploader,
            duration: document.duration,
            createdAt: document.createdAt,
            sidecarPath: document.sidecarPath,
            preferredMediaPath: document.preferredMediaPath,
            indexGeneration: generation,
            similarity: 0,
            fuzzyScore: 0,
            languageSimilarity: 0,
            directMatchScore: 0,
        }));
        return {
            query: parameters.query,
            results,
            candidateCount: view.indexedVideos,
            indexedVideos: view.indexedVideos,
            durationMs: Date.now() - startedAt,
            indexGeneration: view.generation,
        };
    }
    async searchRanked(snapshot, parameters, startedAt, signal, isDocumentActive) {
        const normalizedQuery = (0, helpers_1.normalizeText)(parameters.query);
        const queryTokens = (0, helpers_1.tokenize)(normalizedQuery, {
            maximumTokens: this.config.maxQueryTokens,
            includeStopWords: true,
        });
        if (!normalizedQuery || queryTokens.length === 0)
            throw new errors_1.ValidationError('Search query must contain letters or numbers.');
        const lookupTerms = createQueryLookupTerms(queryTokens);
        const candidates = new Map();
        for (const lookupTerm of lookupTerms) {
            assertNotAborted(signal);
            const token = lookupTerm.token;
            const tokenCandidates = new Map();
            const exactRange = snapshot.postingRanges.get(token);
            this.collectPostings(snapshot, tokenCandidates, token, 1, isDocumentActive);
            const fuzzyExpansionThreshold = Math.min(500, Math.max(20, (parameters.limit + parameters.offset) * 2));
            if (!exactRange || exactRange.length < fuzzyExpansionThreshold) {
                for (const fuzzyTerm of this.findFuzzyTerms(snapshot, token, lookupTerm.compound)) {
                    this.collectPostings(snapshot, tokenCandidates, fuzzyTerm.term, fuzzyTerm.similarity, isDocumentActive);
                }
            }
            for (const [documentIndex, tokenScore] of tokenCandidates) {
                const existing = candidates.get(documentIndex);
                const weightedScore = tokenScore.weightedScore * lookupTerm.scoreMultiplier;
                if (existing) {
                    existing.weightedScore += weightedScore;
                    existing.matchedMask |= lookupTerm.matchedMask;
                    existing.fuzzyScore = Math.max(existing.fuzzyScore, tokenScore.fuzzyScore);
                }
                else {
                    candidates.set(documentIndex, {
                        weightedScore,
                        matchedMask: lookupTerm.matchedMask,
                        fuzzyScore: tokenScore.fuzzyScore,
                    });
                }
            }
            if (candidates.size > this.config.maxCandidates * 2)
                this.pruneCandidates(candidates, this.config.maxCandidates);
            await (0, helpers_1.yieldToEventLoop)();
        }
        // Most queries are fully served by postings. Only scan compact in-memory
        // fields when every exact/fuzzy posting lookup missed (for example, a very
        // frequent term deliberately omitted by MAX_POSTINGS_PER_TERM).
        const mayNeedFallbackScan = lookupTerms.some(({ token }) => snapshot.ignoredTerms.has(token)) ||
            snapshot.stats.descriptionTokenBudgetExhausted ||
            (queryTokens.length === 1 && normalizedQuery.length <= 5);
        if (candidates.size === 0 && mayNeedFallbackScan) {
            await this.addDirectPhraseCandidates(snapshot, candidates, normalizedQuery, queryTokens.length, signal, isDocumentActive);
        }
        if (candidates.size > this.config.maxCandidates)
            this.pruneCandidates(candidates, this.config.maxCandidates);
        const ranked = [];
        let processed = 0;
        let activeCandidateCount = 0;
        for (const [documentIndex, candidate] of candidates) {
            assertNotAborted(signal);
            const document = snapshot.documents[documentIndex];
            if (!document || (isDocumentActive && !isDocumentActive(document)))
                continue;
            activeCandidateCount += 1;
            const tokenCoverage = (0, helpers_1.popCount32)(candidate.matchedMask) / queryTokens.length;
            const fieldRelevance = (0, helpers_1.clamp)(candidate.weightedScore / (queryTokens.length * 11));
            const languageSimilarity = (0, helpers_1.clamp)(tokenCoverage * 0.25 + fieldRelevance * 0.75);
            const directMatchScore = (0, helpers_1.calculateDirectMatchScore)(normalizedQuery, {
                title: document.titleSearch,
                uploader: document.uploaderSearch,
                metadata: document.metadataSearch,
                description: document.descriptionExcerpt,
            });
            const fuzzyScore = (0, helpers_1.clamp)(candidate.fuzzyScore);
            const similarity = (0, helpers_1.clamp)(directMatchScore * 0.45 + languageSimilarity * 0.5 + fuzzyScore * 0.05);
            ranked.push({
                id: document.id,
                title: document.title,
                uploader: document.uploader,
                duration: document.duration,
                createdAt: document.createdAt,
                sidecarPath: document.sidecarPath,
                preferredMediaPath: document.preferredMediaPath,
                indexGeneration: snapshot.generation,
                similarity,
                fuzzyScore,
                languageSimilarity,
                directMatchScore,
            });
            processed += 1;
            if (processed % 500 === 0)
                await (0, helpers_1.yieldToEventLoop)();
        }
        ranked.sort((0, helpers_1.getSortAlgorithm)(parameters.sort));
        return {
            query: parameters.query,
            results: ranked.slice(parameters.offset, parameters.offset + parameters.limit),
            candidateCount: activeCandidateCount,
            indexedVideos: snapshot.documents.length,
            durationMs: Date.now() - startedAt,
            indexGeneration: snapshot.generation,
        };
    }
    async searchRandom(snapshot, parameters, startedAt, signal) {
        if (parameters.offset !== 0) {
            throw new errors_1.ValidationError('Random search does not support offsets. Run another random search instead.');
        }
        const sampleSize = Math.min(snapshot.documents.length, parameters.limit);
        const selectedIndices = new Set();
        const firstCandidate = snapshot.documents.length - sampleSize;
        for (let candidate = firstCandidate; candidate < snapshot.documents.length; candidate += 1) {
            assertNotAborted(signal);
            const randomIndex = Math.floor(Math.random() * (candidate + 1));
            selectedIndices.add(selectedIndices.has(randomIndex) ? candidate : randomIndex);
        }
        const sample = [...selectedIndices].map((index) => snapshot.documents[index]);
        for (let index = sample.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            const temporary = sample[index];
            sample[index] = sample[swapIndex];
            sample[swapIndex] = temporary;
        }
        const results = sample.map((document) => ({
            id: document.id,
            title: document.title,
            uploader: document.uploader,
            duration: document.duration,
            createdAt: document.createdAt,
            sidecarPath: document.sidecarPath,
            preferredMediaPath: document.preferredMediaPath,
            indexGeneration: snapshot.generation,
            similarity: 0,
            fuzzyScore: 0,
            languageSimilarity: 0,
            directMatchScore: 0,
        }));
        return {
            query: parameters.query,
            results,
            candidateCount: snapshot.documents.length,
            indexedVideos: snapshot.documents.length,
            durationMs: Date.now() - startedAt,
            indexGeneration: snapshot.generation,
        };
    }
    collectPostings(snapshot, target, term, termSimilarity, isDocumentActive) {
        const range = snapshot.postingRanges.get(term);
        if (!range)
            return;
        const end = range.offset + range.length;
        for (let offset = range.offset; offset < end; offset += 1) {
            const posting = snapshot.postingValues[offset];
            const documentIndex = decodeDocumentIndex(posting);
            const document = snapshot.documents[documentIndex];
            if (!document || (isDocumentActive && !isDocumentActive(document)))
                continue;
            const weightedScore = fieldWeight(decodeFieldMask(posting)) * termSimilarity;
            const existing = target.get(documentIndex);
            if (!existing || weightedScore > existing.weightedScore) {
                target.set(documentIndex, { weightedScore, fuzzyScore: termSimilarity });
            }
            else if (termSimilarity > existing.fuzzyScore) {
                existing.fuzzyScore = termSimilarity;
            }
        }
    }
    findFuzzyTerms(snapshot, token, titleEdgeOnly = false) {
        if (token.length < 3)
            return [];
        if (/^\d+$/u.test(token))
            return [];
        const maximumDistance = token.length >= 9 ? 3 : token.length >= 5 ? 2 : 1;
        const matches = [];
        const firstCharacter = token[0];
        let prioritisedTerms;
        let comparisons = 0;
        const consider = (term, prioritised = false) => {
            if (comparisons >= MAX_FUZZY_TERM_COMPARISONS || term === token)
                return;
            if (!prioritised && prioritisedTerms?.has(term))
                return;
            if (prioritised) {
                prioritisedTerms ??= new Set();
                if (prioritisedTerms.has(term))
                    return;
                prioritisedTerms.add(term);
            }
            comparisons += 1;
            let similarity = (0, helpers_1.fuzzyTokenSimilarity)(token, term);
            if (similarity <= 0 && prioritised)
                similarity = (0, helpers_1.broadCharacterTokenSimilarity)(token, term);
            if (similarity > 0)
                matches.push({ term, similarity });
        };
        // Prioritise long title terms with the same three-character prefix and
        // suffix.  This keeps broad human misspellings reliable even when a huge
        // description vocabulary would otherwise exhaust the comparison cap.
        const edgeKey = titleEdgeKey(token);
        if (edgeKey) {
            const edgeBucket = snapshot.titleEdgeBuckets.get(edgeKey);
            if (edgeBucket)
                for (const term of edgeBucket)
                    consider(term, true);
        }
        if (titleEdgeOnly) {
            matches.sort((left, right) => right.similarity - left.similarity);
            return matches.slice(0, MAX_FUZZY_TERMS_PER_QUERY_TOKEN);
        }
        for (let length = Math.max(2, token.length - maximumDistance); length <= token.length + maximumDistance; length += 1) {
            const bucket = snapshot.fuzzyBuckets.get(`${firstCharacter}:${length}`);
            if (!bucket)
                continue;
            for (const term of bucket) {
                if (comparisons >= MAX_FUZZY_TERM_COMPARISONS)
                    break;
                consider(term);
            }
            if (comparisons >= MAX_FUZZY_TERM_COMPARISONS)
                break;
        }
        matches.sort((left, right) => right.similarity - left.similarity);
        return matches.slice(0, MAX_FUZZY_TERMS_PER_QUERY_TOKEN);
    }
    async addDirectPhraseCandidates(snapshot, candidates, normalizedQuery, queryTokenCount, signal, isDocumentActive) {
        const mask = fullQueryMask(queryTokenCount);
        const compactQuery = normalizedQuery.replace(/\s+/gu, '');
        for (let index = 0; index < snapshot.documents.length; index += 1) {
            assertNotAborted(signal);
            const document = snapshot.documents[index];
            if (isDocumentActive && !isDocumentActive(document))
                continue;
            let weightedScore = 0;
            if (document.titleSearch.includes(normalizedQuery))
                weightedScore = 6;
            else if (compactQuery.length >= 4 && document.titleSearch.replace(/\s+/gu, '').includes(compactQuery))
                weightedScore = 6;
            else if (document.metadataSearch.includes(normalizedQuery))
                weightedScore = 2.5;
            else if (document.uploaderSearch.includes(normalizedQuery))
                weightedScore = 1.5;
            else if (document.descriptionExcerpt.includes(normalizedQuery))
                weightedScore = 1;
            if (weightedScore > 0) {
                const existing = candidates.get(index);
                if (existing) {
                    existing.weightedScore = Math.max(existing.weightedScore, weightedScore * queryTokenCount);
                    existing.matchedMask |= mask;
                    existing.fuzzyScore = Math.max(existing.fuzzyScore, 1);
                }
                else {
                    candidates.set(index, {
                        weightedScore: weightedScore * queryTokenCount,
                        matchedMask: mask,
                        fuzzyScore: 1,
                    });
                }
            }
            if (candidates.size > this.config.maxCandidates * 2)
                this.pruneCandidates(candidates, this.config.maxCandidates);
            if (index > 0 && index % 5_000 === 0)
                await (0, helpers_1.yieldToEventLoop)();
        }
    }
    pruneCandidates(candidates, limit) {
        const best = [...candidates.entries()]
            .sort((left, right) => right[1].weightedScore - left[1].weightedScore)
            .slice(0, limit);
        candidates.clear();
        for (const [documentIndex, score] of best)
            candidates.set(documentIndex, score);
    }
    enqueueMutation(operation) {
        const run = this.mutationTail.then(operation, operation);
        this.mutationTail = run.then(() => undefined, () => undefined);
        return run;
    }
    async performDiskSynchronization() {
        const startedAt = Date.now();
        const currentPaths = new Set();
        const candidates = new Set();
        const now = Date.now();
        let scanErrors = 0;
        for await (const sidecarPath of this.iterateSidecarPaths(() => {
            scanErrors += 1;
        })) {
            currentPaths.add(sidecarPath);
            const retry = this.retrySidecars.get(sidecarPath);
            if (!this.knownSidecars.has(sidecarPath) ||
                (retry !== undefined && retry.attempts < 5 && retry.nextAttemptAt <= now)) {
                candidates.add(sidecarPath);
            }
        }
        // Only infer deletions after a clean traversal. A temporarily unreadable
        // directory must never make a whole subtree disappear from search.
        if (scanErrors === 0) {
            for (const knownPath of this.knownSidecars) {
                if (!currentPaths.has(knownPath))
                    candidates.add(knownPath);
            }
        }
        const maximumBatch = this.config.autoIndexMaxBatch ?? 2_000;
        if (candidates.size > maximumBatch) {
            this.logger.log(`Automatic discovery found ${candidates.size.toLocaleString()} changes; running one memory-safe full compaction instead of creating an oversized live segment.`);
            await this.performRefresh();
            const result = {
                requestedPaths: candidates.size,
                addedVideos: 0,
                updatedVideos: 0,
                removedVideos: 0,
                unchangedFiles: 0,
                invalidSidecars: 0,
                oversizedSidecars: 0,
                deferredSidecars: 0,
                changed: true,
                fullRefresh: true,
                compactionRecommended: false,
                errorSamples: [],
                durationMs: Date.now() - startedAt,
            };
            this.lastSyncAt = Date.now();
            this.lastSync = result;
            return result;
        }
        const result = await this.performIncrementalUpdate(candidates, false);
        result.durationMs = Date.now() - startedAt;
        this.lastSyncAt = Date.now();
        this.lastSync = result;
        return result;
    }
    async performIncrementalUpdate(sidecarPaths, forceRetry = true) {
        const startedAt = Date.now();
        const paths = [...new Set(sidecarPaths)];
        const builder = new PostingBuilder(this.config);
        const successfulPaths = [];
        const removedPaths = [];
        const errorSamples = [];
        let unchangedFiles = 0;
        let invalidSidecars = 0;
        let oversizedSidecars = 0;
        let deferredSidecars = 0;
        for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
            const sidecarPath = paths[pathIndex];
            if (!this.isSidecarPath(sidecarPath))
                continue;
            let firstStats;
            try {
                firstStats = await fs_1.promises.stat(sidecarPath);
            }
            catch (error) {
                const code = error.code;
                if (code === 'ENOENT' || code === 'ENOTDIR') {
                    const wasActive = this.isPathActive(sidecarPath);
                    this.knownSidecars.delete(sidecarPath);
                    this.sidecarFingerprints.delete(sidecarPath);
                    this.retrySidecars.delete(sidecarPath);
                    removedPaths.push({ path: sidecarPath, wasActive });
                    continue;
                }
                invalidSidecars += 1;
                this.scheduleRetry(sidecarPath, (0, errors_1.toError)(error).message, errorSamples, true);
                continue;
            }
            if (!firstStats.isFile()) {
                unchangedFiles += 1;
                continue;
            }
            this.knownSidecars.add(sidecarPath);
            const fingerprint = this.sidecarFingerprint(firstStats.size, firstStats.mtimeMs);
            const retry = this.retrySidecars.get(sidecarPath);
            if (this.sidecarFingerprints.get(sidecarPath) === fingerprint && retry === undefined) {
                unchangedFiles += 1;
                continue;
            }
            if (!forceRetry && retry && (retry.attempts >= 5 || retry.nextAttemptAt > Date.now())) {
                unchangedFiles += 1;
                continue;
            }
            if (firstStats.size > this.config.maxSidecarBytes) {
                oversizedSidecars += 1;
                this.sidecarFingerprints.set(sidecarPath, fingerprint);
                this.retrySidecars.delete(sidecarPath);
                this.recordErrorSample(errorSamples, sidecarPath, `Skipped because it is ${firstStats.size.toLocaleString()} bytes; MAX_SIDECAR_BYTES is ${this.config.maxSidecarBytes.toLocaleString()}.`);
                continue;
            }
            const settleMs = this.config.autoIndexSettleMs ?? 0;
            const ageMs = Date.now() - firstStats.mtimeMs;
            if (settleMs > 0 && ageMs < settleMs) {
                deferredSidecars += 1;
                this.retrySidecars.set(sidecarPath, {
                    attempts: retry?.attempts ?? 0,
                    nextAttemptAt: Math.ceil(firstStats.mtimeMs + settleMs),
                });
                continue;
            }
            try {
                const content = await fs_1.promises.readFile(sidecarPath, 'utf8');
                const secondStats = await fs_1.promises.stat(sidecarPath);
                const secondFingerprint = this.sidecarFingerprint(secondStats.size, secondStats.mtimeMs);
                if (!secondStats.isFile() || secondFingerprint !== fingerprint) {
                    deferredSidecars += 1;
                    this.retrySidecars.set(sidecarPath, {
                        attempts: retry?.attempts ?? 0,
                        nextAttemptAt: Date.now() + Math.max(250, settleMs),
                    });
                    continue;
                }
                const parsed = JSON.parse(content);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new errors_1.ValidationError('The sidecar root must be a JSON object.');
                }
                const wasActive = this.isPathActive(sidecarPath);
                builder.addDocument(parsed, sidecarPath);
                successfulPaths.push({ path: sidecarPath, wasActive });
                this.sidecarFingerprints.set(sidecarPath, secondFingerprint);
                this.retrySidecars.delete(sidecarPath);
            }
            catch (error) {
                const normalized = (0, errors_1.toError)(error);
                if (normalized instanceof RangeError && /allocation|heap|array length/iu.test(normalized.message)) {
                    throw new errors_1.AppError('The live index reached the available JavaScript heap. Lower the index limits or start Node with a larger --max-old-space-size value.', { statusCode: 503, code: 'INDEX_MEMORY_LIMIT', expose: true });
                }
                const code = error.code;
                if (code === 'ENOENT' || code === 'ENOTDIR') {
                    const wasActive = this.isPathActive(sidecarPath);
                    this.knownSidecars.delete(sidecarPath);
                    this.sidecarFingerprints.delete(sidecarPath);
                    this.retrySidecars.delete(sidecarPath);
                    removedPaths.push({ path: sidecarPath, wasActive });
                    continue;
                }
                invalidSidecars += 1;
                this.sidecarFingerprints.set(sidecarPath, fingerprint);
                this.scheduleRetry(sidecarPath, normalized.message, errorSamples, true);
            }
            if (pathIndex > 0 && pathIndex % 100 === 0)
                await (0, helpers_1.yieldToEventLoop)();
        }
        let addedVideos = 0;
        let updatedVideos = 0;
        let removedVideos = 0;
        for (const item of successfulPaths) {
            if (item.wasActive)
                updatedVideos += 1;
            else
                addedVideos += 1;
        }
        for (const item of removedPaths) {
            if (item.wasActive)
                removedVideos += 1;
        }
        const changed = successfulPaths.length > 0 || removedVideos > 0;
        let compactionRecommended = false;
        if (changed) {
            const nextGeneration = this.generation + 1;
            const nextVersions = new Map(this.pathVersions);
            let nextSegments = this.liveSegments;
            if (successfulPaths.length > 0) {
                const segment = builder.finalize(nextGeneration, {
                    sidecarFilesFound: paths.length,
                    processedFiles: paths.length,
                    indexedVideos: successfulPaths.length,
                    invalidSidecars,
                    oversizedSidecars,
                    errorSamples,
                    durationMs: Date.now() - startedAt,
                });
                nextSegments = [...this.liveSegments, segment];
                for (const item of successfulPaths)
                    nextVersions.set(item.path, nextGeneration);
                this.liveDocumentCount += successfulPaths.length;
            }
            for (const item of removedPaths) {
                if (item.wasActive || this.baseIndexedPaths.has(item.path) || this.pathVersions.has(item.path)) {
                    nextVersions.set(item.path, null);
                }
            }
            this.generation = nextGeneration;
            this.liveSegments = nextSegments;
            this.pathVersions = nextVersions;
            this.activeIndexedVideos = Math.max(0, this.activeIndexedVideos + addedVideos - removedVideos);
            this.progress.indexedVideos = this.activeIndexedVideos;
            compactionRecommended =
                this.liveDocumentCount >= (this.config.autoIndexCompactDocuments ?? 1_000) ||
                    this.liveSegments.length >= (this.config.autoIndexCompactSegments ?? 64);
        }
        const result = {
            requestedPaths: paths.length,
            addedVideos,
            updatedVideos,
            removedVideos,
            unchangedFiles,
            invalidSidecars,
            oversizedSidecars,
            deferredSidecars,
            changed,
            fullRefresh: false,
            compactionRecommended,
            errorSamples,
            durationMs: Date.now() - startedAt,
        };
        this.lastSyncAt = Date.now();
        this.lastSync = result;
        return result;
    }
    isPathActive(sidecarPath) {
        const version = this.pathVersions.get(sidecarPath);
        if (version !== undefined)
            return version !== null;
        return this.baseIndexedPaths.has(sidecarPath);
    }
    sidecarFingerprint(size, mtimeMs) {
        return `${size}:${Math.trunc(mtimeMs)}`;
    }
    scheduleRetry(sidecarPath, message, errorSamples, incrementAttempt) {
        const previous = this.retrySidecars.get(sidecarPath);
        const attempts = Math.min(5, (previous?.attempts ?? 0) + (incrementAttempt ? 1 : 0));
        const delayMs = attempts >= 5 ? 60_000 : Math.min(30_000, 500 * 2 ** attempts);
        this.retrySidecars.set(sidecarPath, { attempts, nextAttemptAt: Date.now() + delayMs });
        this.recordErrorSample(errorSamples, sidecarPath, message);
    }
    async *iterateSidecarPaths(onError) {
        const rootStats = await fs_1.promises.stat(this.config.searchDirectory).catch((error) => {
            throw new errors_1.AppError(`Unable to access YTDLP_DIRECTORY '${this.config.searchDirectory}': ${(0, errors_1.toError)(error).message}`, {
                statusCode: 503,
                code: 'INDEX_DIRECTORY_UNAVAILABLE',
                expose: true,
            });
        });
        if (!rootStats.isDirectory()) {
            throw new errors_1.AppError(`YTDLP_DIRECTORY '${this.config.searchDirectory}' is not a directory.`, {
                statusCode: 503,
                code: 'INDEX_DIRECTORY_INVALID',
                expose: true,
            });
        }
        const directories = [this.config.searchDirectory];
        let visitedDirectories = 0;
        while (directories.length > 0) {
            const directory = directories.pop();
            let entries;
            try {
                // opendir streams entries. readdir({ withFileTypes: true }) would
                // materialize every filename in a flat library directory at once.
                entries = await fs_1.promises.opendir(directory);
            }
            catch (error) {
                onError?.(directory, error);
                this.logger.warn(`Unable to read directory '${directory}'; it will be skipped.`, error);
                continue;
            }
            try {
                for await (const entry of entries) {
                    const entryPath = path_1.default.join(directory, entry.name);
                    if (entry.isDirectory()) {
                        if (this.config.recursive)
                            directories.push(entryPath);
                        continue;
                    }
                    if (entry.isFile() && this.isSidecarFile(entry.name))
                        yield entryPath;
                }
            }
            catch (error) {
                onError?.(directory, error);
                this.logger.warn(`Unable to finish reading directory '${directory}'; remaining entries will be skipped.`, error);
            }
            visitedDirectories += 1;
            if (visitedDirectories % 100 === 0)
                await (0, helpers_1.yieldToEventLoop)();
        }
    }
    isSidecarFile(fileName) {
        const lowerName = fileName.toLowerCase();
        if (lowerName.endsWith('.embedding.json'))
            return false;
        return this.config.sidecarSuffixes.some((suffix) => lowerName.endsWith(suffix));
    }
    removeSidecarSuffix(sidecarPath) {
        const lowerPath = sidecarPath.toLowerCase();
        for (const suffix of this.config.sidecarSuffixes) {
            if (lowerPath.endsWith(suffix))
                return sidecarPath.slice(0, -suffix.length);
        }
        return path_1.default.join(path_1.default.dirname(sidecarPath), path_1.default.parse(sidecarPath).name);
    }
    async waitUntilReady(signal) {
        if (this.state === 'ready' && this.snapshot)
            return;
        assertNotAborted(signal);
        const readiness = this.state === 'idle' ? this.refresh().then(() => undefined) : this.readyPromise;
        await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => signal?.removeEventListener('abort', abortHandler);
            const finish = (callback) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                callback();
            };
            const abortHandler = () => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new errors_1.CancelledError()));
            if (signal)
                signal.addEventListener('abort', abortHandler, { once: true });
            readiness.then(() => finish(resolve), (error) => finish(() => reject(error)));
        });
    }
    waitForIdleSearches() {
        if (this.activeSearches === 0)
            return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }
    createReadyPromise() {
        this.readyPromise = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        // A failed background initialization should be visible in status/logs, but
        // must not create an unhandled rejection when no search is currently waiting.
        this.readyPromise.catch(() => undefined);
    }
    recordErrorSample(samples, file, message) {
        if (samples.length < MAX_ERROR_SAMPLES)
            samples.push({ file, message });
    }
    touchMediaCache(cacheKey, value) {
        this.mediaPathCache.delete(cacheKey);
        this.mediaPathCache.set(cacheKey, value);
        while (this.mediaPathCache.size > MAX_MEDIA_CACHE_ENTRIES) {
            const oldest = this.mediaPathCache.keys().next().value;
            if (oldest === undefined)
                break;
            this.mediaPathCache.delete(oldest);
        }
    }
}
exports.SidecarSearchIndex = SidecarSearchIndex;
//# sourceMappingURL=search-index.js.map