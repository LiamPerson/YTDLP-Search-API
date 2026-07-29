"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidecarAutoUpdater = void 0;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const errors_1 = require("./errors");
class SidecarAutoUpdater {
    config;
    index;
    onIndexChanged;
    logger;
    watcher;
    scanTimer;
    debounceTimer;
    retryTimer;
    pendingPaths = new Set();
    fullScanPending = false;
    started = false;
    running = false;
    rerun = false;
    watchMode = 'disabled';
    lastEventAt;
    lastRunAt;
    lastError;
    constructor(config, index, onIndexChanged, logger = console) {
        this.config = config;
        this.index = index;
        this.onIndexChanged = onIndexChanged;
        this.logger = logger;
    }
    start() {
        if (this.started || !this.config.autoIndex)
            return;
        this.started = true;
        this.openWatcher();
        const scanIntervalMs = this.config.autoIndexScanIntervalMs ?? 15_000;
        if (scanIntervalMs > 0) {
            this.scanTimer = setInterval(() => this.requestFullScan(), scanIntervalMs);
            this.scanTimer.unref?.();
        }
        if (!this.watcher)
            this.watchMode = 'polling';
        this.logger.log(`Automatic sidecar updates enabled (${this.watchMode} watcher, ` +
            `${scanIntervalMs > 0 ? `${scanIntervalMs.toLocaleString()}ms reconciliation` : 'watch events only'}).`);
    }
    stop() {
        this.started = false;
        this.watcher?.close();
        this.watcher = undefined;
        if (this.scanTimer)
            clearInterval(this.scanTimer);
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        if (this.retryTimer)
            clearTimeout(this.retryTimer);
        this.scanTimer = undefined;
        this.debounceTimer = undefined;
        this.retryTimer = undefined;
        this.pendingPaths.clear();
        this.fullScanPending = false;
        this.watchMode = 'disabled';
    }
    getStatus() {
        return {
            enabled: this.config.autoIndex,
            started: this.started,
            running: this.running,
            watchMode: this.watchMode,
            pendingPaths: this.pendingPaths.size,
            fullScanPending: this.fullScanPending,
            lastEventAt: this.lastEventAt,
            lastRunAt: this.lastRunAt,
            lastError: this.lastError,
        };
    }
    requestFullScan() {
        if (!this.started)
            return;
        this.fullScanPending = true;
        this.lastEventAt = Date.now();
        this.scheduleFlush();
    }
    openWatcher() {
        const handleEvent = (eventType, fileName) => {
            if (!this.started)
                return;
            this.lastEventAt = Date.now();
            if (fileName) {
                const candidate = path_1.default.resolve(this.config.searchDirectory, fileName.toString());
                if (this.index.isSidecarPath(candidate)) {
                    this.pendingPaths.add(candidate);
                }
                else if (eventType === 'rename') {
                    // Video finalization also produces rename events. Only a new directory
                    // requires a whole-tree reconciliation; media files can be ignored.
                    void fs_1.promises
                        .stat(candidate)
                        .then((stats) => {
                        if (!stats.isDirectory() || !this.started)
                            return;
                        this.fullScanPending = true;
                        this.scheduleFlush();
                    })
                        .catch(() => undefined);
                }
            }
            else {
                this.fullScanPending = true;
            }
            this.scheduleFlush();
        };
        try {
            this.watcher = (0, fs_1.watch)(this.config.searchDirectory, { persistent: false, recursive: this.config.recursive }, handleEvent);
            this.watchMode = this.config.recursive ? 'recursive' : 'root';
        }
        catch (error) {
            this.logger.warn('Recursive directory watching is unavailable; using a root watcher plus periodic reconciliation.', error);
            try {
                this.watcher = (0, fs_1.watch)(this.config.searchDirectory, { persistent: false }, handleEvent);
                this.watchMode = 'root';
            }
            catch (fallbackError) {
                this.lastError = (0, errors_1.toError)(fallbackError).message;
                this.logger.warn('Directory watching is unavailable; periodic sidecar reconciliation remains enabled.', fallbackError);
                this.watchMode = 'polling';
            }
        }
        this.watcher?.on('error', (error) => {
            this.lastError = (0, errors_1.toError)(error).message;
            this.logger.warn('The sidecar watcher stopped; periodic reconciliation will continue.', error);
            this.watcher?.close();
            this.watcher = undefined;
            this.watchMode = 'polling';
        });
    }
    scheduleFlush(delayMs = this.config.autoIndexDebounceMs ?? 1_500) {
        if (!this.started)
            return;
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            void this.flush();
        }, Math.max(0, delayMs));
        this.debounceTimer.unref?.();
    }
    async flush() {
        if (!this.started)
            return;
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.running = true;
        const runFullScan = this.fullScanPending;
        this.fullScanPending = false;
        const paths = [...this.pendingPaths];
        this.pendingPaths.clear();
        try {
            const result = runFullScan
                ? await this.index.synchronizeFromDisk()
                : await this.index.applySidecarChanges(paths);
            this.lastRunAt = Date.now();
            this.lastError = undefined;
            if (result.changed)
                this.onIndexChanged();
            this.logResult(result);
            if (result.compactionRecommended) {
                this.logger.log('Compacting accumulated live sidecar updates into the main index ...');
                await this.index.refresh();
                this.onIndexChanged();
            }
            if (result.deferredSidecars > 0) {
                if (this.retryTimer)
                    clearTimeout(this.retryTimer);
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = undefined;
                    this.requestFullScan();
                }, Math.max(500, (this.config.autoIndexSettleMs ?? 1_000) + 250));
                this.retryTimer.unref?.();
            }
        }
        catch (error) {
            const normalized = (0, errors_1.toError)(error);
            this.lastError = normalized.message;
            this.logger.error('Automatic sidecar update failed; the server will keep running and retry later.', normalized);
        }
        finally {
            this.running = false;
            if (this.rerun || this.fullScanPending || this.pendingPaths.size > 0) {
                this.rerun = false;
                this.scheduleFlush(0);
            }
        }
    }
    logResult(result) {
        if (!result.changed &&
            result.invalidSidecars === 0 &&
            result.oversizedSidecars === 0 &&
            result.deferredSidecars === 0) {
            return;
        }
        this.logger.log(`Automatic sidecar update: ${result.addedVideos} added, ${result.updatedVideos} updated, ` +
            `${result.removedVideos} removed, ${result.invalidSidecars} invalid, ` +
            `${result.deferredSidecars} still being written (${result.durationMs.toLocaleString()}ms).`);
    }
}
exports.SidecarAutoUpdater = SidecarAutoUpdater;
//# sourceMappingURL=sidecar-auto-updater.js.map