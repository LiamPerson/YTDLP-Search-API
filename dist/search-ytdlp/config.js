"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAppConfig = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const constants_1 = require("./constants");
const errors_1 = require("./errors");
const loadEnvironmentFile = (filePath = path_1.default.resolve(process.cwd(), '.env')) => {
    let content;
    try {
        content = fs_1.default.readFileSync(filePath, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    for (const rawLine of content.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const separator = line.indexOf('=');
        if (separator <= 0)
            continue;
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || process.env[key] !== undefined)
            continue;
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
};
loadEnvironmentFile();
const parseInteger = (value, fallback, name, minimum = 0) => {
    if (value === undefined || value.trim() === '')
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new errors_1.ValidationError(`${name} must be an integer greater than or equal to ${minimum}.`);
    }
    return parsed;
};
const parseIntegerRange = (value, fallback, name, minimum, maximum) => {
    const parsed = parseInteger(value, fallback, name, minimum);
    if (parsed > maximum)
        throw new errors_1.ValidationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
    return parsed;
};
const parseBoolean = (value, fallback) => {
    if (value === undefined || value.trim() === '')
        return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};
const parseCorsOrigin = (value) => {
    if (value === undefined || value.trim() === '' || value.trim() === '*')
        return '*';
    if (['false', 'off', 'none'].includes(value.trim().toLowerCase()))
        return false;
    return value.trim();
};
const parsePublicBaseUrl = (value) => {
    if (value === undefined || value.trim() === '')
        return undefined;
    let parsed;
    try {
        parsed = new URL(value.trim());
    }
    catch {
        throw new errors_1.ValidationError('PUBLIC_BASE_URL must be a valid absolute http:// or https:// URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new errors_1.ValidationError('PUBLIC_BASE_URL must use http:// or https://.');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new errors_1.ValidationError('PUBLIC_BASE_URL cannot contain credentials, a query string, or a fragment.');
    }
    if (!parsed.pathname.endsWith('/'))
        parsed.pathname += '/';
    return parsed.href;
};
const parseSuffixes = (value) => {
    const raw = value
        ? value
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
        : constants_1.DEFAULT_SIDECAR_SUFFIXES;
    const normalized = raw.map((entry) => (entry.startsWith('.') ? entry : `.${entry}`));
    return [...new Set(normalized)];
};
const getAppConfig = (environment = process.env) => {
    const configuredDirectory = environment.YTDLP_DIRECTORY?.trim();
    if (!configuredDirectory) {
        throw new errors_1.ValidationError('YTDLP_DIRECTORY is not configured. Add it to .env or set it in the process environment before starting the app.');
    }
    const maxResults = parseInteger(environment.MAX_RESULTS, constants_1.DEFAULT_MAX_RESULTS_LIMIT, 'MAX_RESULTS', 1);
    const defaultResults = Math.min(parseInteger(environment.DEFAULT_RESULTS, constants_1.DEFAULT_RESULTS_LIMIT, 'DEFAULT_RESULTS', 1), maxResults);
    return {
        searchDirectory: path_1.default.resolve(configuredDirectory),
        port: parseIntegerRange(environment.PORT, 5020, 'PORT', 1, 65_535),
        host: environment.HOST?.trim() || '127.0.0.1',
        publicBaseUrl: parsePublicBaseUrl(environment.PUBLIC_BASE_URL),
        corsOrigin: parseCorsOrigin(environment.CORS_ORIGIN),
        defaultResults,
        maxResults,
        queueConcurrency: parseIntegerRange(environment.SEARCH_CONCURRENCY, constants_1.DEFAULT_QUEUE_CONCURRENCY, 'SEARCH_CONCURRENCY', 1, 32),
        queueLimit: parseInteger(environment.SEARCH_QUEUE_LIMIT, constants_1.DEFAULT_QUEUE_LIMIT, 'SEARCH_QUEUE_LIMIT', 1),
        searchTimeoutMs: parseInteger(environment.SEARCH_TIMEOUT_MS, constants_1.DEFAULT_SEARCH_TIMEOUT_MS, 'SEARCH_TIMEOUT_MS', 1),
        searchCacheTtlMs: parseInteger(environment.SEARCH_CACHE_TTL_MS, constants_1.DEFAULT_SEARCH_CACHE_TTL_MS, 'SEARCH_CACHE_TTL_MS', 0),
        searchCacheSize: parseInteger(environment.SEARCH_CACHE_SIZE, constants_1.DEFAULT_SEARCH_CACHE_SIZE, 'SEARCH_CACHE_SIZE', 0),
        jobHistoryTtlMs: parseInteger(environment.SEARCH_JOB_HISTORY_TTL_MS, constants_1.DEFAULT_JOB_HISTORY_TTL_MS, 'SEARCH_JOB_HISTORY_TTL_MS', 0),
        jobHistorySize: parseInteger(environment.SEARCH_JOB_HISTORY_SIZE, constants_1.DEFAULT_JOB_HISTORY_SIZE, 'SEARCH_JOB_HISTORY_SIZE', 1),
        maxQueryLength: parseInteger(environment.MAX_QUERY_LENGTH, constants_1.DEFAULT_MAX_QUERY_LENGTH, 'MAX_QUERY_LENGTH', 1),
        maxQueryTokens: parseIntegerRange(environment.MAX_QUERY_TOKENS, constants_1.DEFAULT_MAX_QUERY_TOKENS, 'MAX_QUERY_TOKENS', 1, 31),
        maxCandidates: parseInteger(environment.MAX_SEARCH_CANDIDATES, constants_1.DEFAULT_MAX_CANDIDATES, 'MAX_SEARCH_CANDIDATES', 100),
        recursive: parseBoolean(environment.INDEX_RECURSIVE, true),
        sidecarSuffixes: parseSuffixes(environment.YTDLP_SIDECAR_SUFFIXES),
        maxSidecarBytes: parseInteger(environment.MAX_SIDECAR_BYTES, constants_1.DEFAULT_MAX_SIDECAR_BYTES, 'MAX_SIDECAR_BYTES', 1_024),
        indexReadConcurrency: parseIntegerRange(environment.INDEX_READ_CONCURRENCY, constants_1.DEFAULT_INDEX_READ_CONCURRENCY, 'INDEX_READ_CONCURRENCY', 1, 64),
        descriptionExcerptChars: parseInteger(environment.DESCRIPTION_EXCERPT_CHARS, constants_1.DEFAULT_DESCRIPTION_EXCERPT_CHARS, 'DESCRIPTION_EXCERPT_CHARS', 0),
        descriptionIndexChars: parseInteger(environment.DESCRIPTION_INDEX_CHARS, constants_1.DEFAULT_DESCRIPTION_INDEX_CHARS, 'DESCRIPTION_INDEX_CHARS', 0),
        descriptionTokensPerDocument: parseInteger(environment.DESCRIPTION_TOKENS_PER_DOCUMENT, constants_1.DEFAULT_DESCRIPTION_TOKENS_PER_DOCUMENT, 'DESCRIPTION_TOKENS_PER_DOCUMENT', 0),
        metadataSearchChars: parseInteger(environment.METADATA_SEARCH_CHARS, constants_1.DEFAULT_METADATA_SEARCH_CHARS, 'METADATA_SEARCH_CHARS', 0),
        metadataTokensPerDocument: parseInteger(environment.METADATA_TOKENS_PER_DOCUMENT, constants_1.DEFAULT_METADATA_TOKENS_PER_DOCUMENT, 'METADATA_TOKENS_PER_DOCUMENT', 0),
        maxIndexPostings: parseInteger(environment.MAX_INDEX_POSTINGS, constants_1.DEFAULT_MAX_INDEX_POSTINGS, 'MAX_INDEX_POSTINGS', 10_000),
        maxPostingsPerTerm: parseInteger(environment.MAX_POSTINGS_PER_TERM, constants_1.DEFAULT_MAX_POSTINGS_PER_TERM, 'MAX_POSTINGS_PER_TERM', 100),
        indexProgressEvery: parseInteger(environment.INDEX_PROGRESS_EVERY, constants_1.DEFAULT_INDEX_PROGRESS_EVERY, 'INDEX_PROGRESS_EVERY', 100),
        indexRefreshIntervalMs: parseInteger(environment.INDEX_REFRESH_INTERVAL_MS, 0, 'INDEX_REFRESH_INTERVAL_MS', 0),
        autoIndex: parseBoolean(environment.INDEX_AUTO_UPDATE, true),
        autoIndexDebounceMs: parseInteger(environment.INDEX_AUTO_DEBOUNCE_MS, constants_1.DEFAULT_AUTO_INDEX_DEBOUNCE_MS, 'INDEX_AUTO_DEBOUNCE_MS', 0),
        autoIndexSettleMs: parseInteger(environment.INDEX_AUTO_SETTLE_MS, constants_1.DEFAULT_AUTO_INDEX_SETTLE_MS, 'INDEX_AUTO_SETTLE_MS', 0),
        autoIndexScanIntervalMs: parseInteger(environment.INDEX_AUTO_SCAN_INTERVAL_MS, constants_1.DEFAULT_AUTO_INDEX_SCAN_INTERVAL_MS, 'INDEX_AUTO_SCAN_INTERVAL_MS', 0),
        autoIndexMaxBatch: parseInteger(environment.INDEX_AUTO_MAX_BATCH, constants_1.DEFAULT_AUTO_INDEX_MAX_BATCH, 'INDEX_AUTO_MAX_BATCH', 1),
        autoIndexCompactDocuments: parseInteger(environment.INDEX_AUTO_COMPACT_DOCUMENTS, constants_1.DEFAULT_AUTO_INDEX_COMPACT_DOCUMENTS, 'INDEX_AUTO_COMPACT_DOCUMENTS', 1),
        autoIndexCompactSegments: parseInteger(environment.INDEX_AUTO_COMPACT_SEGMENTS, constants_1.DEFAULT_AUTO_INDEX_COMPACT_SEGMENTS, 'INDEX_AUTO_COMPACT_SEGMENTS', 1),
        thumbnailConcurrency: parseIntegerRange(environment.THUMBNAIL_CONCURRENCY, constants_1.DEFAULT_THUMBNAIL_CONCURRENCY, 'THUMBNAIL_CONCURRENCY', 1, 16),
        thumbnailQueueLimit: parseInteger(environment.THUMBNAIL_QUEUE_LIMIT, constants_1.DEFAULT_THUMBNAIL_QUEUE_LIMIT, 'THUMBNAIL_QUEUE_LIMIT', 1),
        thumbnailTimeoutMs: parseInteger(environment.THUMBNAIL_TIMEOUT_MS, constants_1.DEFAULT_THUMBNAIL_TIMEOUT_MS, 'THUMBNAIL_TIMEOUT_MS', 1_000),
        thumbnailMaxBytes: parseInteger(environment.THUMBNAIL_MAX_BYTES, constants_1.DEFAULT_THUMBNAIL_MAX_BYTES, 'THUMBNAIL_MAX_BYTES', 64 * 1024),
    };
};
exports.getAppConfig = getAppConfig;
//# sourceMappingURL=config.js.map