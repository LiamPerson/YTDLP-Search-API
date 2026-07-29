"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchQueue = void 0;
const crypto_1 = require("crypto");
const errors_1 = require("./errors");
class BoundedTtlCache {
    maximumSize;
    ttlMs;
    entries = new Map();
    constructor(maximumSize, ttlMs) {
        this.maximumSize = maximumSize;
        this.ttlMs = ttlMs;
    }
    get(key) {
        if (this.maximumSize <= 0 || this.ttlMs <= 0)
            return undefined;
        const cached = this.entries.get(key);
        if (!cached)
            return undefined;
        if (cached.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.value;
    }
    set(key, value) {
        if (this.maximumSize <= 0 || this.ttlMs <= 0)
            return;
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        while (this.entries.size > this.maximumSize) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined)
                break;
            this.entries.delete(oldestKey);
        }
    }
    clear() {
        this.entries.clear();
    }
    get size() {
        return this.entries.size;
    }
}
const createDeferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    // Jobs submitted in asynchronous/polling mode may not have an immediate
    // promise consumer. Keep failures from becoming unhandled rejections.
    promise.catch(() => undefined);
    return { promise, resolve, reject };
};
class SearchQueue {
    options;
    pending = [];
    active = new Map();
    jobs = new Map();
    cache;
    logger;
    stopped = false;
    constructor(options) {
        this.options = options;
        this.cache = new BoundedTtlCache(options.cacheSize, options.cacheTtlMs);
        this.logger = options.logger ?? console;
    }
    enqueue(parameters) {
        if (this.stopped)
            throw new errors_1.AppError('The search queue is shutting down.', { statusCode: 503, code: 'QUEUE_STOPPED', expose: true });
        this.pruneHistory();
        const cacheKey = this.options.getCacheKey(parameters);
        const cachedResult = this.cache.get(cacheKey);
        if (cachedResult !== undefined) {
            const job = this.createJob(parameters, cacheKey, true);
            job.status = 'completed';
            job.startedAt = job.createdAt;
            job.completedAt = job.createdAt;
            job.result = cachedResult;
            job.deferred.resolve(cachedResult);
            this.jobs.set(job.id, job);
            this.touchJob(job);
            return { jobId: job.id, position: 0, cached: true, promise: job.deferred.promise };
        }
        if (this.pending.length >= this.options.queueLimit)
            throw new errors_1.QueueFullError(this.options.queueLimit);
        const job = this.createJob(parameters, cacheKey, false);
        this.pending.push(job);
        this.jobs.set(job.id, job);
        const position = this.pending.length;
        this.logger.log(`Search job ${job.id} queued at position ${position}.`);
        this.pump();
        return { jobId: job.id, position, cached: false, promise: job.deferred.promise };
    }
    getJob(jobId) {
        this.pruneHistory();
        const job = this.jobs.get(jobId);
        return job ? this.toView(job) : undefined;
    }
    listJobs() {
        this.pruneHistory();
        return [...this.jobs.values()]
            .sort((left, right) => right.createdAt - left.createdAt)
            .map((job) => this.toView(job));
    }
    cancel(jobId, reason = 'Search cancelled.') {
        const job = this.jobs.get(jobId);
        if (!job || this.isTerminal(job.status))
            return false;
        const cancellation = new errors_1.CancelledError(reason);
        if (job.status === 'queued') {
            const queueIndex = this.pending.findIndex((pendingJob) => pendingJob.id === jobId);
            if (queueIndex >= 0)
                this.pending.splice(queueIndex, 1);
            job.status = 'cancelled';
            job.completedAt = Date.now();
            job.error = cancellation;
            job.controller.abort(cancellation);
            job.deferred.reject(cancellation);
            this.touchJob(job);
            this.pump();
            return true;
        }
        job.controller.abort(cancellation);
        return true;
    }
    clearCache() {
        this.cache.clear();
    }
    getStats() {
        return {
            waiting: this.pending.length,
            running: this.active.size,
            concurrency: this.options.concurrency,
            limit: this.options.queueLimit,
            cachedEntries: this.cache.size,
            trackedJobs: this.jobs.size,
        };
    }
    stop(reason = 'The server is shutting down.') {
        this.stopped = true;
        for (const job of [...this.pending])
            this.cancel(job.id, reason);
        for (const job of this.active.values())
            this.cancel(job.id, reason);
    }
    createJob(parameters, cacheKey, cached) {
        return {
            id: (0, crypto_1.randomUUID)(),
            parameters,
            cacheKey,
            status: 'queued',
            createdAt: Date.now(),
            cached,
            controller: new AbortController(),
            deferred: createDeferred(),
        };
    }
    pump() {
        if (this.stopped)
            return;
        while (this.active.size < this.options.concurrency && this.pending.length > 0) {
            const job = this.pending.shift();
            if (!job)
                break;
            void this.run(job);
        }
    }
    async run(job) {
        job.status = 'running';
        job.startedAt = Date.now();
        this.active.set(job.id, job);
        this.logger.log(`Search job ${job.id} started after ${job.startedAt - job.createdAt}ms in the queue.`);
        const timeout = setTimeout(() => {
            job.controller.abort(new errors_1.SearchTimeoutError(this.options.timeoutMs));
        }, this.options.timeoutMs);
        try {
            const result = await this.options.processor(job.parameters, job.controller.signal);
            if (job.controller.signal.aborted) {
                const reason = job.controller.signal.reason;
                throw reason instanceof Error ? reason : new errors_1.CancelledError();
            }
            job.status = 'completed';
            job.result = result;
            job.completedAt = Date.now();
            this.cache.set(job.cacheKey, result);
            job.deferred.resolve(result);
            this.logger.log(`Search job ${job.id} completed in ${job.completedAt - job.startedAt}ms.`);
        }
        catch (error) {
            const normalizedError = job.controller.signal.reason instanceof Error ? job.controller.signal.reason : (0, errors_1.toError)(error);
            job.status = (0, errors_1.isAbortError)(normalizedError) ? 'cancelled' : 'failed';
            job.error = normalizedError;
            job.completedAt = Date.now();
            job.deferred.reject(normalizedError);
            if (job.status === 'cancelled')
                this.logger.log(`Search job ${job.id} was cancelled.`);
            else
                this.logger.error(`Search job ${job.id} failed:`, normalizedError);
        }
        finally {
            clearTimeout(timeout);
            this.active.delete(job.id);
            this.touchJob(job);
            this.pruneHistory();
            this.pump();
        }
    }
    toView(job) {
        const queueIndex = job.status === 'queued' ? this.pending.findIndex((pendingJob) => pendingJob.id === job.id) : -1;
        const appError = job.error instanceof errors_1.AppError ? job.error : undefined;
        return {
            id: job.id,
            status: job.status,
            position: queueIndex >= 0 ? queueIndex + 1 : 0,
            parameters: job.parameters,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            queueWaitMs: job.startedAt === undefined ? undefined : job.startedAt - job.createdAt,
            durationMs: job.startedAt === undefined || job.completedAt === undefined ? undefined : job.completedAt - job.startedAt,
            cached: job.cached,
            result: job.result,
            error: job.error
                ? {
                    code: appError?.code ?? 'SEARCH_FAILED',
                    message: appError?.expose ? appError.message : job.error.message,
                    statusCode: appError?.statusCode ?? 500,
                }
                : undefined,
        };
    }
    touchJob(job) {
        this.jobs.delete(job.id);
        this.jobs.set(job.id, job);
    }
    pruneHistory() {
        const now = Date.now();
        for (const [jobId, job] of this.jobs) {
            if (!this.isTerminal(job.status) || job.completedAt === undefined)
                continue;
            if (this.options.historyTtlMs === 0 || now - job.completedAt > this.options.historyTtlMs)
                this.jobs.delete(jobId);
        }
        let terminalCount = 0;
        for (const job of this.jobs.values())
            if (this.isTerminal(job.status))
                terminalCount += 1;
        if (terminalCount <= this.options.historySize)
            return;
        for (const [jobId, job] of this.jobs) {
            if (!this.isTerminal(job.status))
                continue;
            this.jobs.delete(jobId);
            terminalCount -= 1;
            if (terminalCount <= this.options.historySize)
                break;
        }
    }
    isTerminal(status) {
        return status === 'completed' || status === 'failed' || status === 'cancelled';
    }
}
exports.SearchQueue = SearchQueue;
//# sourceMappingURL=search-queue.js.map