"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFileServer = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const fs_2 = require("fs");
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const constants_1 = require("./constants");
const errors_1 = require("./errors");
const helpers_1 = require("./helpers");
class TaskLimiter {
    concurrency;
    queueLimit;
    active = 0;
    pending = [];
    constructor(concurrency, queueLimit) {
        this.concurrency = concurrency;
        this.queueLimit = queueLimit;
    }
    run(task, signal) {
        if (signal?.aborted)
            return Promise.reject(signal.reason instanceof Error ? signal.reason : new errors_1.CancelledError());
        if (this.pending.length >= this.queueLimit) {
            return Promise.reject(new errors_1.AppError(`The thumbnail queue is full (${this.queueLimit} waiting requests).`, {
                statusCode: 429,
                code: 'THUMBNAIL_QUEUE_FULL',
                expose: true,
            }));
        }
        return new Promise((resolve, reject) => {
            const queued = { task, resolve, reject, signal };
            if (signal) {
                queued.abortHandler = () => {
                    const index = this.pending.indexOf(queued);
                    if (index < 0)
                        return;
                    this.pending.splice(index, 1);
                    signal.removeEventListener('abort', queued.abortHandler);
                    reject(signal.reason instanceof Error ? signal.reason : new errors_1.CancelledError());
                };
                signal.addEventListener('abort', queued.abortHandler, { once: true });
            }
            this.pending.push(queued);
            if (signal?.aborted)
                queued.abortHandler?.();
            else
                this.pump();
        });
    }
    getStats() {
        return { running: this.active, waiting: this.pending.length, concurrency: this.concurrency, limit: this.queueLimit };
    }
    pump() {
        while (this.active < this.concurrency && this.pending.length > 0) {
            const queued = this.pending.shift();
            if (!queued)
                break;
            if (queued.abortHandler)
                queued.signal?.removeEventListener('abort', queued.abortHandler);
            if (queued.signal?.aborted) {
                queued.reject(queued.signal.reason instanceof Error ? queued.signal.reason : new errors_1.CancelledError());
                continue;
            }
            this.active += 1;
            void queued
                .task()
                .then(queued.resolve, queued.reject)
                .finally(() => {
                this.active -= 1;
                this.pump();
            });
        }
    }
}
const runCommand = (command, args, options) => {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        const errorChunks = [];
        let outputBytes = 0;
        let errorBytes = 0;
        let settled = false;
        let timeout;
        const cleanup = () => {
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abortHandler);
        };
        const finish = (error, output) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (error)
                reject(error);
            else
                resolve(output ?? Buffer.alloc(0));
        };
        const terminate = () => {
            if (!child.killed)
                child.kill('SIGKILL');
        };
        const abortHandler = () => {
            terminate();
            finish(options.signal?.reason instanceof Error ? options.signal.reason : new errors_1.CancelledError());
        };
        timeout = setTimeout(() => {
            terminate();
            finish(new errors_1.AppError(`${command} exceeded its ${options.timeoutMs}ms time limit.`, {
                statusCode: 504,
                code: 'MEDIA_COMMAND_TIMEOUT',
                expose: true,
            }));
        }, options.timeoutMs);
        timeout.unref?.();
        options.signal?.addEventListener('abort', abortHandler, { once: true });
        child.stdout?.on('data', (data) => {
            if (settled)
                return;
            outputBytes += data.length;
            if (outputBytes > options.maxOutputBytes) {
                terminate();
                finish(new errors_1.AppError(`${command} produced more than ${options.maxOutputBytes.toLocaleString()} bytes of output.`, {
                    statusCode: 500,
                    code: 'MEDIA_OUTPUT_TOO_LARGE',
                }));
                return;
            }
            chunks.push(data);
        });
        child.stderr?.on('data', (data) => {
            if (errorBytes >= 64 * 1024)
                return;
            const chunk = data.subarray(0, 64 * 1024 - errorBytes);
            errorChunks.push(chunk);
            errorBytes += chunk.length;
        });
        child.once('error', (error) => {
            if (error.code === 'ENOENT') {
                finish(new errors_1.AppError(`${command} is not installed or is not available in PATH.`, {
                    statusCode: 503,
                    code: 'MEDIA_TOOL_UNAVAILABLE',
                    expose: true,
                }));
                return;
            }
            finish(error);
        });
        child.once('close', (code, signal) => {
            if (settled)
                return;
            if (code === 0) {
                finish(undefined, Buffer.concat(chunks, outputBytes));
                return;
            }
            const stderr = Buffer.concat(errorChunks, errorBytes).toString('utf8').trim();
            finish(new errors_1.AppError(`${command} failed${code === null ? ` after signal ${signal}` : ` with exit code ${code}`}${stderr ? `: ${stderr}` : '.'}`, {
                statusCode: 500,
                code: 'MEDIA_COMMAND_FAILED',
                expose: true,
            }));
        });
    });
};
const getVideoDuration = async (filePath, timeoutMs, signal) => {
    const output = await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { maxOutputBytes: 64 * 1024, timeoutMs, signal });
    const duration = Number(output.toString('utf8').trim());
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new errors_1.AppError('ffprobe could not determine the media duration.', {
            statusCode: 422,
            code: 'MEDIA_DURATION_UNAVAILABLE',
            expose: true,
        });
    }
    return duration;
};
const extractFrame = async (filePath, time, config, signal) => {
    return runCommand('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-ss',
        time.toFixed(3),
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        'scale=min(640\\,iw):-2',
        '-q:v',
        '4',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
    ], { maxOutputBytes: config.thumbnailMaxBytes, timeoutMs: config.thumbnailTimeoutMs, signal });
};
const MIME_TYPES = {
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.avi': 'video/x-msvideo',
    '.flv': 'video/x-flv',
    '.ts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.opus': 'audio/ogg',
    '.ogg': 'audio/ogg',
};
const classifyLibraryFile = (absolutePath, config) => {
    if (constants_1.MEDIA_EXTENSIONS.has(path_1.default.extname(absolutePath).toLowerCase()))
        return 'media';
    const lowerPath = absolutePath.toLowerCase();
    if (config.sidecarSuffixes.some((suffix) => lowerPath.endsWith(suffix.toLowerCase())))
        return 'sidecar';
    throw new errors_1.FileAccessError('The requested file type is not an allowed media file or yt-dlp sidecar.', 415, 'UNSUPPORTED_LIBRARY_FILE_TYPE');
};
const resolveRequestedFile = (requestUrl, config) => {
    const relativePath = requestUrl.searchParams.get('path');
    const fileUrl = requestUrl.searchParams.get('url');
    let thumbnailRequested = ['true', '1'].includes(requestUrl.searchParams.get('thumbnail') ?? '');
    let absolutePath;
    if (relativePath?.trim()) {
        if (relativePath.includes('\0'))
            throw new errors_1.FileAccessError('The requested path is invalid.', 400, 'INVALID_FILE_PATH');
        absolutePath = path_1.default.resolve(config.searchDirectory, relativePath);
    }
    else if (fileUrl?.trim()) {
        const value = fileUrl.trim();
        if (value.startsWith('file:')) {
            try {
                const parsed = new URL(value);
                if (parsed.searchParams.get('thumbnail') === 'true')
                    thumbnailRequested = true;
                absolutePath = path_1.default.resolve((0, url_1.fileURLToPath)(parsed));
            }
            catch (error) {
                throw new errors_1.FileAccessError(`The file URL is invalid: ${(0, errors_1.toError)(error).message}`, 400, 'INVALID_FILE_URL');
            }
        }
        else {
            absolutePath = path_1.default.resolve(value);
        }
    }
    else {
        throw new errors_1.FileAccessError("Provide either the 'path' or 'url' query parameter.", 400, 'MISSING_FILE_PATH');
    }
    if (!(0, helpers_1.isPathInside)(config.searchDirectory, absolutePath)) {
        throw new errors_1.FileAccessError('The requested file is outside YTDLP_DIRECTORY.', 403, 'FILE_OUTSIDE_LIBRARY');
    }
    const fileKind = classifyLibraryFile(absolutePath, config);
    if (thumbnailRequested && fileKind !== 'media') {
        throw new errors_1.FileAccessError('Thumbnails can only be generated from media files.', 415, 'THUMBNAIL_REQUIRES_MEDIA');
    }
    return { absolutePath, thumbnailRequested, fileKind };
};
const parseRange = (header, size) => {
    if (!header)
        return undefined;
    const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
    if (!match)
        throw new errors_1.FileAccessError('Only a single byte range is supported.', 416, 'INVALID_RANGE');
    const [, startText, endText] = match;
    let start;
    let end;
    if (!startText && !endText)
        throw new errors_1.FileAccessError('The byte range is empty.', 416, 'INVALID_RANGE');
    if (!startText) {
        const suffixLength = Number(endText);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)
            throw new errors_1.FileAccessError('The byte range is invalid.', 416, 'INVALID_RANGE');
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    }
    else {
        start = Number(startText);
        end = endText ? Number(endText) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        throw new errors_1.FileAccessError('The requested byte range is outside the file.', 416, 'RANGE_NOT_SATISFIABLE');
    }
    return { start, end: Math.min(end, size - 1) };
};
const createFileServer = (config, logger = console) => {
    const thumbnailLimiter = new TaskLimiter(config.thumbnailConcurrency, config.thumbnailQueueLimit);
    const canonicalRootPromise = fs_2.promises.realpath(config.searchDirectory);
    const handleSend = async (request, response, requestUrl) => {
        const abortController = new AbortController();
        const abortForDisconnect = () => {
            if (!response.writableEnded && !abortController.signal.aborted) {
                abortController.abort(new errors_1.CancelledError('The client disconnected.'));
            }
        };
        request.once('aborted', abortForDisconnect);
        response.once('close', abortForDisconnect);
        let { absolutePath, thumbnailRequested, fileKind } = resolveRequestedFile(requestUrl, config);
        let stats;
        try {
            await fs_2.promises.access(absolutePath, fs_1.constants.R_OK);
            const [canonicalRoot, canonicalFile] = await Promise.all([canonicalRootPromise, fs_2.promises.realpath(absolutePath)]);
            if (!(0, helpers_1.isPathInside)(canonicalRoot, canonicalFile)) {
                throw new errors_1.FileAccessError('The requested file resolves outside YTDLP_DIRECTORY.', 403, 'FILE_OUTSIDE_LIBRARY');
            }
            absolutePath = canonicalFile;
            fileKind = classifyLibraryFile(absolutePath, config);
            if (thumbnailRequested && fileKind !== 'media') {
                throw new errors_1.FileAccessError('Thumbnails can only be generated from media files.', 415, 'THUMBNAIL_REQUIRES_MEDIA');
            }
            stats = await fs_2.promises.stat(absolutePath);
            if (!stats.isFile())
                throw new errors_1.FileAccessError('The requested path is not a file.', 404);
        }
        catch (error) {
            if (error instanceof errors_1.FileAccessError)
                throw error;
            const code = error.code;
            if (code === 'EACCES' || code === 'EPERM') {
                throw new errors_1.FileAccessError('The requested file is not readable by this process.', 403, 'FILE_NOT_READABLE');
            }
            throw new errors_1.FileAccessError('The requested file does not exist.', 404, 'FILE_NOT_FOUND');
        }
        if (thumbnailRequested) {
            const frame = await thumbnailLimiter.run(async () => {
                const duration = await getVideoDuration(absolutePath, config.thumbnailTimeoutMs, abortController.signal);
                const seekTime = Math.max(0, Math.min(duration * 0.15, Math.max(0, duration - 0.05)));
                return extractFrame(absolutePath, seekTime, config, abortController.signal);
            }, abortController.signal);
            response.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': frame.length,
                'Cache-Control': 'private, max-age=86400',
                'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${path_1.default.parse(absolutePath).name}.jpg`)}`,
                'Cross-Origin-Resource-Policy': 'cross-origin',
            });
            if (request.method === 'HEAD')
                response.end();
            else
                response.end(frame);
            return;
        }
        let range;
        try {
            range = parseRange(typeof request.headers.range === 'string' ? request.headers.range : undefined, stats.size);
        }
        catch (error) {
            if (error instanceof errors_1.FileAccessError && error.statusCode === 416)
                response.setHeader('Content-Range', `bytes */${stats.size}`);
            throw error;
        }
        const start = range?.start ?? 0;
        const end = range?.end ?? stats.size - 1;
        const contentLength = Math.max(0, end - start + 1);
        const headers = {
            'Content-Type': fileKind === 'sidecar'
                ? 'application/json; charset=utf-8'
                : MIME_TYPES[path_1.default.extname(absolutePath).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': contentLength,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=0, must-revalidate',
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path_1.default.basename(absolutePath))}`,
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'X-Content-Type-Options': 'nosniff',
            'Last-Modified': stats.mtime.toUTCString(),
        };
        if (range)
            headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
        response.writeHead(range ? 206 : 200, headers);
        if (request.method === 'HEAD') {
            response.end();
            return;
        }
        if (stats.size === 0) {
            response.end();
            return;
        }
        await new Promise((resolve, reject) => {
            const stream = (0, fs_1.createReadStream)(absolutePath, { start, end });
            let settled = false;
            const finish = (error) => {
                if (settled)
                    return;
                settled = true;
                request.removeListener('aborted', closeHandler);
                response.removeListener('close', closeHandler);
                if (error)
                    reject(error);
                else
                    resolve();
            };
            const closeHandler = () => {
                stream.destroy();
                finish();
            };
            request.once('aborted', closeHandler);
            response.once('close', closeHandler);
            stream.once('error', finish);
            stream.once('end', () => finish());
            stream.once('close', () => finish());
            stream.pipe(response);
        }).catch((error) => {
            if (!response.headersSent)
                throw error;
            logger.warn(`Streaming '${absolutePath}' ended with an error:`, error);
        });
    };
    return { handleSend, getThumbnailQueueStats: () => thumbnailLimiter.getStats() };
};
exports.createFileServer = createFileServer;
//# sourceMappingURL=file-server.js.map