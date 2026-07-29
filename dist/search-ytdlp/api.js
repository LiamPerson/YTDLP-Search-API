"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = exports.createApplication = void 0;
const http_1 = require("http");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
const constants_1 = require("./constants");
const errors_1 = require("./errors");
const file_server_1 = require("./file-server");
const helpers_1 = require("./helpers");
const search_index_1 = require("./search-index");
const search_queue_1 = require("./search-queue");
const sidecar_auto_updater_1 = require("./sidecar-auto-updater");
const getParameter = (searchParameters, name) => {
    const value = searchParameters.get(name);
    return value === null ? undefined : value;
};
const parseIntegerParameter = (searchParameters, options) => {
    const stringValue = getParameter(searchParameters, options.name);
    if (stringValue === undefined || stringValue.trim() === '')
        return options.fallback;
    const parsed = Number(stringValue);
    if (!Number.isSafeInteger(parsed) || parsed < options.minimum || parsed > options.maximum) {
        throw new errors_1.ValidationError(`${options.name} must be an integer between ${options.minimum} and ${options.maximum}.`);
    }
    return parsed;
};
const parseBooleanParameter = (searchParameters, name) => {
    const text = getParameter(searchParameters, name)?.trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
};
const parseSearchParameters = (requestUrl, config) => {
    const query = getParameter(requestUrl.searchParams, 'q')?.trim() ?? '';
    const sortValue = (getParameter(requestUrl.searchParams, 's')?.trim().toLowerCase() || constants_1.SORT_OPTIONS.normal);
    if (!Object.values(constants_1.SORT_OPTIONS).includes(sortValue)) {
        throw new errors_1.ValidationError(`Unknown sort mode '${sortValue}'. Use normal, fuzzy, language or random.`);
    }
    if (!query && sortValue !== constants_1.SORT_OPTIONS.random)
        throw new errors_1.ValidationError("Missing required search parameter 'q'.");
    if (query.length > config.maxQueryLength) {
        throw new errors_1.ValidationError(`Search query is longer than the ${config.maxQueryLength}-character limit.`);
    }
    const requestedDirectory = getParameter(requestUrl.searchParams, 'd')?.trim();
    if (requestedDirectory && path_1.default.resolve(requestedDirectory) !== config.searchDirectory) {
        throw new errors_1.ValidationError('Per-request directory changes are not supported by the reusable index. Set YTDLP_DIRECTORY, then call POST /index/refresh.');
    }
    return {
        query: query || 'random',
        limit: parseIntegerParameter(requestUrl.searchParams, {
            name: 'r',
            fallback: config.defaultResults,
            minimum: 1,
            maximum: config.maxResults,
        }),
        offset: parseIntegerParameter(requestUrl.searchParams, {
            name: 'offset',
            fallback: 0,
            minimum: 0,
            maximum: 1_000_000,
        }),
        sort: sortValue,
    };
};
const mapWithConcurrency = async (values, concurrency, mapper) => {
    const results = new Array(values.length);
    let cursor = 0;
    const worker = async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= values.length)
                return;
            results[index] = await mapper(values[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, values.length || 1)) }, () => worker()));
    return results;
};
const publicBaseUrlForRequest = (requestUrl, config) => {
    const publicBaseUrl = new URL(config.publicBaseUrl ?? `${requestUrl.origin}/`);
    if (!publicBaseUrl.pathname.endsWith('/'))
        publicBaseUrl.pathname += '/';
    return publicBaseUrl;
};
const toPublicUrl = (relativeUrl, publicBaseUrl) => {
    return new URL(relativeUrl.replace(/^\//u, ''), publicBaseUrl).href;
};
const addBooleanQueryParameter = (url, name) => {
    return `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(name)}=true`;
};
const createRelativeFileUrl = (relativePath, thumbnail = false) => {
    const parameters = new URLSearchParams({ path: relativePath });
    if (thumbnail)
        parameters.set('thumbnail', 'true');
    return `/file?${parameters.toString()}`;
};
const createApiResponse = async (index, execution, parameters, publicBaseUrl, signal) => {
    const results = await mapWithConcurrency(execution.results, 8, async (result, resultIndex) => {
        const relativeSidecarPath = index.toRelativeMediaPath(result.sidecarPath);
        if (!relativeSidecarPath) {
            throw new errors_1.AppError('An indexed sidecar resolved outside YTDLP_DIRECTORY.', {
                statusCode: 500,
                code: 'INDEX_PATH_INVALID',
            });
        }
        const mediaParameters = new URLSearchParams({
            sidecar: relativeSidecarPath,
            id: result.id,
            generation: String(result.indexGeneration),
        });
        const relativePreferredPath = index.toRelativeMediaPath(result.preferredMediaPath ?? null);
        if (relativePreferredPath)
            mediaParameters.set('preferred', relativePreferredPath);
        const relativeResolverUrl = `/media?${mediaParameters.toString()}`;
        const mediaPath = await index.resolveMediaPath(result, signal);
        const relativeMediaPath = index.toRelativeMediaPath(mediaPath);
        // Prefer a plain /file route.  When yt-dlp has already written a sidecar
        // but is still finishing the media file, its recorded filename is still a
        // valid stable URL: the same <video src> begins working as soon as the file
        // appears.  Fall back to /media only when the sidecar does not identify a
        // usable future filename.
        const directRelativeMediaPath = relativeMediaPath ?? relativePreferredPath;
        const relativeStreamUrl = directRelativeMediaPath
            ? createRelativeFileUrl(directRelativeMediaPath)
            : relativeResolverUrl;
        const relativeThumbnailUrl = directRelativeMediaPath
            ? createRelativeFileUrl(directRelativeMediaPath, true)
            : addBooleanQueryParameter(relativeResolverUrl, 'thumbnail');
        const relativeSidecarUrl = createRelativeFileUrl(relativeSidecarPath);
        const streamUrl = toPublicUrl(relativeStreamUrl, publicBaseUrl);
        const thumbnailUrl = toPublicUrl(relativeThumbnailUrl, publicBaseUrl);
        const sidecarUrl = toPublicUrl(relativeSidecarUrl, publicBaseUrl);
        return {
            index: parameters.offset + resultIndex + 1,
            title: result.title,
            id: result.id,
            uploader: result.uploader,
            duration: (0, helpers_1.formatDuration)(result.duration),
            durationSeconds: result.duration,
            similarity: `${(result.similarity * 100).toFixed(2)}%`,
            fuzzyScore: `${(result.fuzzyScore * 100).toFixed(2)}%`,
            languageSimilarity: `${(result.languageSimilarity * 100).toFixed(2)}%`,
            directMatchScore: `${(result.directMatchScore * 100).toFixed(2)}%`,
            createdAt: result.createdAt,
            fileUrl: streamUrl,
            streamUrl,
            stream: streamUrl,
            thumbnailUrl,
            thumbnail: thumbnailUrl,
            sidecarUrl,
            infoJsonUrl: sidecarUrl,
            metadataUrl: sidecarUrl,
            relativeFileUrl: relativeStreamUrl,
            relativeStreamUrl,
            relativeThumbnailUrl,
            relativeSidecarUrl,
            relativeInfoJsonUrl: relativeSidecarUrl,
            relativeMetadataUrl: relativeSidecarUrl,
            resolverUrl: toPublicUrl(relativeResolverUrl, publicBaseUrl),
            relativeResolverUrl,
            localFileUrl: index.toFileUrl(mediaPath),
            localSidecarUrl: index.toFileUrl(result.sidecarPath),
            mediaAvailable: mediaPath !== null,
        };
    });
    return {
        query: execution.query,
        results,
        meta: {
            candidateCount: execution.candidateCount,
            indexedVideos: execution.indexedVideos,
            searchDurationMs: execution.durationMs,
            indexGeneration: execution.indexGeneration,
        },
    };
};
const sendJson = (response, statusCode, body) => {
    if (response.writableEnded || response.destroyed)
        return;
    const serialized = JSON.stringify(body);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(serialized),
        'Cache-Control': 'no-store',
    });
    response.end(serialized);
};
const STATIC_CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};
const findPublicRoot = async () => {
    const candidates = [path_1.default.resolve(__dirname, '..', 'public'), path_1.default.resolve(process.cwd(), 'public')];
    for (const candidate of candidates) {
        try {
            if ((await fs_1.promises.stat(candidate)).isDirectory())
                return candidate;
        }
        catch {
            // Try the next location.
        }
    }
    return candidates[0];
};
const serveStaticFile = async (publicRoot, request, response, pathname) => {
    const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'styles.css', 'app.js'].includes(fileName))
        return false;
    const filePath = path_1.default.resolve(publicRoot, fileName);
    if (!(0, helpers_1.isPathInside)(publicRoot, filePath))
        return false;
    let data;
    try {
        data = await fs_1.promises.readFile(filePath);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    response.writeHead(200, {
        'Content-Type': STATIC_CONTENT_TYPES[path_1.default.extname(filePath)] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': fileName === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (request.method === 'HEAD')
        response.end();
    else
        response.end(data);
    return true;
};
const applyCors = (response, config) => {
    if (config.corsOrigin === false)
        return;
    response.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-Modified-Since, If-None-Match');
    response.setHeader('Access-Control-Expose-Headers', 'X-Search-Job-Id, X-Search-Queue-Position, X-Search-Cache, Accept-Ranges, Content-Range, Content-Disposition, Last-Modified');
};
const createApplication = async (config, dependencies = {}) => {
    const logger = dependencies.logger ?? console;
    const index = dependencies.index ?? new search_index_1.SidecarSearchIndex(config, logger);
    const queue = new search_queue_1.SearchQueue({
        concurrency: config.queueConcurrency,
        queueLimit: config.queueLimit,
        timeoutMs: config.searchTimeoutMs,
        cacheSize: config.searchCacheSize,
        cacheTtlMs: config.searchCacheTtlMs,
        historySize: config.jobHistorySize,
        historyTtlMs: config.jobHistoryTtlMs,
        getCacheKey: (parameters) => `${index.getStatus().generation}:${JSON.stringify(parameters)}`,
        processor: (parameters, signal) => index.search(parameters, signal),
        logger,
    });
    const fileServer = (0, file_server_1.createFileServer)(config, logger);
    const autoUpdater = new sidecar_auto_updater_1.SidecarAutoUpdater(config, index, () => queue.clearCache(), logger);
    const publicRoot = await findPublicRoot();
    const handleRequest = async (request, response) => {
        applyCors(response, config);
        try {
            if (request.method === 'OPTIONS') {
                response.writeHead(204);
                response.end();
                return;
            }
            const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
            const method = request.method ?? 'GET';
            const pathname = requestUrl.pathname;
            if ((method === 'GET' || method === 'HEAD') && (await serveStaticFile(publicRoot, request, response, pathname)))
                return;
            if (method === 'GET' && pathname === '/search') {
                const parameters = parseSearchParameters(requestUrl, config);
                const publicBaseUrl = publicBaseUrlForRequest(requestUrl, config);
                if (requestUrl.searchParams.has('c'))
                    response.setHeader('Warning', '299 - "The c/cores parameter is deprecated and ignored."');
                const enqueued = queue.enqueue(parameters);
                response.setHeader('X-Search-Job-Id', enqueued.jobId);
                response.setHeader('X-Search-Queue-Position', enqueued.position.toString());
                response.setHeader('X-Search-Cache', enqueued.cached ? 'HIT' : 'MISS');
                if (parseBooleanParameter(requestUrl.searchParams, 'async')) {
                    const relativeStatusUrl = `/search/jobs/${encodeURIComponent(enqueued.jobId)}`;
                    sendJson(response, enqueued.cached ? 200 : 202, {
                        jobId: enqueued.jobId,
                        status: enqueued.cached ? 'completed' : 'queued',
                        position: enqueued.position,
                        cached: enqueued.cached,
                        statusUrl: toPublicUrl(relativeStatusUrl, publicBaseUrl),
                        cancelUrl: toPublicUrl(relativeStatusUrl, publicBaseUrl),
                        relativeStatusUrl,
                        relativeCancelUrl: relativeStatusUrl,
                    });
                    return;
                }
                const responseController = new AbortController();
                const disconnectHandler = () => {
                    if (!responseController.signal.aborted) {
                        responseController.abort(new errors_1.CancelledError('The client disconnected before the response completed.'));
                    }
                    if (!response.writableEnded)
                        queue.cancel(enqueued.jobId, 'The client disconnected before the search completed.');
                };
                request.once('aborted', disconnectHandler);
                response.once('close', disconnectHandler);
                try {
                    const execution = await enqueued.promise;
                    const result = await createApiResponse(index, execution, parameters, publicBaseUrl, responseController.signal);
                    sendJson(response, 200, parseBooleanParameter(requestUrl.searchParams, 'meta') ? result : result.results);
                }
                finally {
                    request.removeListener('aborted', disconnectHandler);
                    response.removeListener('close', disconnectHandler);
                }
                return;
            }
            const jobMatch = /^\/search\/jobs\/([^/]+)$/u.exec(pathname);
            if (jobMatch && method === 'GET') {
                const jobId = decodeURIComponent(jobMatch[1]);
                const job = queue.getJob(jobId);
                if (!job)
                    throw new errors_1.JobNotFoundError(jobId);
                const result = job.result
                    ? await createApiResponse(index, job.result, job.parameters, publicBaseUrlForRequest(requestUrl, config))
                    : undefined;
                sendJson(response, 200, { ...job, result });
                return;
            }
            if (jobMatch && method === 'DELETE') {
                const jobId = decodeURIComponent(jobMatch[1]);
                const job = queue.getJob(jobId);
                if (!job)
                    throw new errors_1.JobNotFoundError(jobId);
                const cancelled = queue.cancel(jobId, 'Search cancelled by API request.');
                const finalJob = queue.getJob(jobId) ?? job;
                const result = finalJob.result
                    ? await createApiResponse(index, finalJob.result, finalJob.parameters, publicBaseUrlForRequest(requestUrl, config))
                    : undefined;
                sendJson(response, cancelled ? 202 : 200, { ...finalJob, result });
                return;
            }
            if (method === 'GET' && pathname === '/search/queue') {
                const jobs = queue.listJobs().map(({ result: _result, ...job }) => job);
                sendJson(response, 200, { stats: queue.getStats(), jobs });
                return;
            }
            if (method === 'POST' && pathname === '/index/sync') {
                const syncResult = await index.synchronizeFromDisk();
                if (syncResult.changed)
                    queue.clearCache();
                sendJson(response, 200, { status: index.getStatus(), sync: syncResult });
                return;
            }
            if (method === 'POST' && pathname === '/index/refresh') {
                queue.clearCache();
                const refreshPromise = index.refresh().finally(() => queue.clearCache());
                if (parseBooleanParameter(requestUrl.searchParams, 'wait')) {
                    const stats = await refreshPromise;
                    sendJson(response, 200, { status: index.getStatus(), stats });
                    return;
                }
                void refreshPromise.catch((error) => logger.error('Background index refresh failed:', error));
                sendJson(response, 202, { message: 'Index refresh started.', status: index.getStatus() });
                return;
            }
            if (method === 'GET' && pathname === '/index/status') {
                sendJson(response, 200, index.getStatus());
                return;
            }
            if (method === 'GET' && pathname === '/health') {
                const indexStatus = index.getStatus();
                const healthy = indexStatus.state !== 'error';
                sendJson(response, healthy ? 200 : 503, {
                    ok: healthy,
                    index: indexStatus,
                    searchQueue: queue.getStats(),
                    thumbnailQueue: fileServer.getThumbnailQueueStats(),
                    autoIndex: autoUpdater.getStatus(),
                    uptimeSeconds: Math.floor(process.uptime()),
                });
                return;
            }
            if ((method === 'GET' || method === 'HEAD') && pathname === '/media') {
                const relativeSidecarPath = requestUrl.searchParams.get('sidecar')?.trim();
                const id = requestUrl.searchParams.get('id')?.trim();
                if (!relativeSidecarPath || !id) {
                    throw new errors_1.ValidationError("The media endpoint requires 'sidecar' and 'id'.");
                }
                if (relativeSidecarPath.includes('\0') || id.includes('\0') || id.length > 1_000) {
                    throw new errors_1.ValidationError('The media lookup parameters are invalid.');
                }
                const sidecarPath = path_1.default.resolve(config.searchDirectory, relativeSidecarPath);
                if (!index.isSidecarPath(sidecarPath)) {
                    throw new errors_1.AppError('The requested sidecar is outside YTDLP_DIRECTORY or has an unsupported suffix.', {
                        statusCode: 403,
                        code: 'SIDECAR_OUTSIDE_LIBRARY',
                        expose: true,
                    });
                }
                const generationText = requestUrl.searchParams.get('generation') ?? '0';
                const generation = Number(generationText);
                if (!Number.isSafeInteger(generation) || generation < 0 || generation > 0x7fffffff) {
                    throw new errors_1.ValidationError('The media generation is invalid.');
                }
                let preferredMediaPath;
                const relativePreferredPath = requestUrl.searchParams.get('preferred')?.trim();
                if (relativePreferredPath) {
                    const candidate = path_1.default.resolve(config.searchDirectory, relativePreferredPath);
                    if (!(0, helpers_1.isPathInside)(config.searchDirectory, candidate) || !constants_1.MEDIA_EXTENSIONS.has(path_1.default.extname(candidate).toLowerCase())) {
                        throw new errors_1.AppError('The preferred media path is outside YTDLP_DIRECTORY or has an unsupported type.', {
                            statusCode: 403,
                            code: 'MEDIA_OUTSIDE_LIBRARY',
                            expose: true,
                        });
                    }
                    preferredMediaPath = candidate;
                }
                const mediaPath = await index.resolveMediaPath({
                    id,
                    sidecarPath,
                    preferredMediaPath,
                    indexGeneration: generation,
                });
                const relativeMediaPath = index.toRelativeMediaPath(mediaPath);
                if (!relativeMediaPath) {
                    throw new errors_1.AppError('The sidecar is indexed, but its media file is not available yet. yt-dlp may still be downloading it.', {
                        statusCode: 404,
                        code: 'MEDIA_NOT_READY',
                        expose: true,
                    });
                }
                const fileUrl = new URL(requestUrl.toString());
                fileUrl.pathname = '/file';
                fileUrl.search = '';
                fileUrl.searchParams.set('path', relativeMediaPath);
                if (parseBooleanParameter(requestUrl.searchParams, 'thumbnail'))
                    fileUrl.searchParams.set('thumbnail', 'true');
                await fileServer.handleSend(request, response, fileUrl);
                return;
            }
            if ((method === 'GET' || method === 'HEAD') && pathname === '/file') {
                await fileServer.handleSend(request, response, requestUrl);
                return;
            }
            sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
        }
        catch (error) {
            if (response.headersSent || response.writableEnded || response.destroyed)
                return;
            const normalized = (0, errors_1.toError)(error);
            const statusCode = normalized instanceof errors_1.AppError ? normalized.statusCode : 500;
            if (statusCode >= 500)
                logger.error(`${request.method} ${request.url} failed:`, normalized);
            else if (!(normalized instanceof errors_1.CancelledError))
                logger.warn(`${request.method} ${request.url}: ${normalized.message}`);
            sendJson(response, statusCode, (0, errors_1.publicErrorBody)(normalized, process.env.NODE_ENV === 'development'));
        }
    };
    return { handleRequest, index, queue, getThumbnailQueueStats: fileServer.getThumbnailQueueStats, autoUpdater };
};
exports.createApplication = createApplication;
const startServer = async (config = (0, config_1.getAppConfig)()) => {
    const runtime = await (0, exports.createApplication)(config);
    const server = (0, http_1.createServer)((request, response) => {
        void runtime.handleRequest(request, response);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    console.log(`YTDLP Search is available at http://${config.host}:${config.port}`);
    const initialIndexBuild = runtime.index.initialize();
    runtime.autoUpdater.start();
    void initialIndexBuild.catch((error) => console.error('Initial index build failed:', error));
    let refreshTimer;
    if (config.indexRefreshIntervalMs > 0) {
        refreshTimer = setInterval(() => {
            runtime.queue.clearCache();
            void runtime.index
                .refresh()
                .then(() => runtime.queue.clearCache())
                .catch((error) => console.error('Scheduled index refresh failed:', error));
        }, config.indexRefreshIntervalMs);
        refreshTimer.unref?.();
    }
    const shutdown = (signal) => {
        console.log(`${signal} received. Stopping new work and closing the server ...`);
        if (refreshTimer)
            clearInterval(refreshTimer);
        runtime.autoUpdater.stop();
        runtime.queue.stop();
        server.close((error) => {
            if (error)
                console.error('Server shutdown error:', error);
            process.exitCode = error ? 1 : 0;
        });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    server.on('clientError', (error, socket) => {
        console.warn('HTTP client error:', error.message);
        if (socket.writable)
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    return { server, runtime };
};
exports.startServer = startServer;
if (require.main === module) {
    (0, exports.startServer)().catch((error) => {
        console.error('Unable to start YTDLP Search:', (0, errors_1.toError)(error));
        process.exitCode = 1;
    });
}
//# sourceMappingURL=api.js.map