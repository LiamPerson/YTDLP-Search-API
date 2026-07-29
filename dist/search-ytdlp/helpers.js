"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findFileUrl = exports.yieldToEventLoop = exports.isPathInside = exports.parseCreationTimestamp = exports.sliceAndSortResults = exports.getSortAlgorithm = exports.formatDuration = exports.computeSimilarity = exports.scoreItem = exports.calculateDirectMatchScore = exports.popCount32 = exports.broadCharacterTokenSimilarity = exports.fuzzyTokenSimilarity = exports.boundedLevenshteinDistance = exports.characterTrigramSimilarity = exports.createCompoundTokens = exports.tokenize = exports.stringArray = exports.safeNumber = exports.safeString = exports.normalizeText = exports.clamp = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const constants_1 = require("./constants");
const STOP_WORDS = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'has',
    'he',
    'in',
    'is',
    'it',
    'its',
    'of',
    'on',
    'or',
    'that',
    'the',
    'this',
    'to',
    'was',
    'were',
    'will',
    'with',
    'you',
    'your',
    'www',
    'http',
    'https',
    'com',
]);
const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));
exports.clamp = clamp;
const normalizeText = (value) => {
    if (typeof value !== 'string')
        return '';
    return value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};
exports.normalizeText = normalizeText;
const safeString = (value, maximumLength = 20_000) => {
    if (typeof value !== 'string')
        return '';
    const trimmed = value.trim();
    return trimmed.length <= maximumLength ? trimmed : trimmed.slice(0, maximumLength);
};
exports.safeString = safeString;
const safeNumber = (value, fallback = 0) => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
};
exports.safeNumber = safeNumber;
const stringArray = (value, maximumEntries = 500) => {
    if (!Array.isArray(value))
        return [];
    const result = [];
    for (const entry of value) {
        if (typeof entry !== 'string')
            continue;
        const text = entry.trim();
        if (text)
            result.push(text.slice(0, 500));
        if (result.length >= maximumEntries)
            break;
    }
    return result;
};
exports.stringArray = stringArray;
const tokenize = (value, options = {}) => {
    const normalized = (0, exports.normalizeText)(value);
    if (!normalized)
        return [];
    const maximumTokens = options.maximumTokens ?? Number.POSITIVE_INFINITY;
    if (maximumTokens <= 0)
        return [];
    const includeStopWords = options.includeStopWords ?? false;
    const unique = new Set();
    for (const token of normalized.split(' ')) {
        if (!token || token.length > 64)
            continue;
        if (!includeStopWords && STOP_WORDS.has(token))
            continue;
        if (token.length === 1 && !/\d/u.test(token))
            continue;
        unique.add(token);
        if (unique.size >= maximumTokens)
            break;
    }
    return [...unique];
};
exports.tokenize = tokenize;
/**
 * Creates bounded aliases for words that are commonly written either joined
 * or separated (for example, `sky diving` and `skydiving`).  Only adjacent
 * tokens are joined, and callers choose a small cap so the posting index stays
 * predictable on very large libraries.
 */
const createCompoundTokens = (tokens, options = {}) => {
    const maximumTokens = Math.max(0, options.maximumTokens ?? 24);
    if (maximumTokens === 0 || tokens.length < 2)
        return [];
    const maximumSpan = Math.max(2, Math.min(options.maximumSpan ?? 4, tokens.length));
    const maximumLength = Math.max(4, options.maximumLength ?? 64);
    const minimumComponentLength = Math.max(1, options.minimumComponentLength ?? 1);
    const alphabeticComponentsOnly = options.alphabeticComponentsOnly ?? false;
    const output = new Set();
    // Pairs are the most useful aliases and the least likely to be accidental,
    // so retain them before wider compounds when the cap is reached.
    for (let span = 2; span <= maximumSpan; span += 1) {
        for (let start = 0; start + span <= tokens.length; start += 1) {
            const components = tokens.slice(start, start + span);
            if (components.some((token) => token.length < minimumComponentLength))
                continue;
            if (alphabeticComponentsOnly && components.some((token) => !/^\p{L}+$/u.test(token)))
                continue;
            const compound = components.join('');
            if (compound.length < 4 || compound.length > maximumLength)
                continue;
            output.add(compound);
            if (output.size >= maximumTokens)
                return [...output];
        }
    }
    return [...output];
};
exports.createCompoundTokens = createCompoundTokens;
const compactSearchText = (value) => value.replace(/\s+/gu, '');
const characterTrigrams = (value) => {
    const compact = compactSearchText(value);
    if (!compact)
        return new Set();
    const padded = `  ${compact}  `;
    const output = new Set();
    for (let index = 0; index <= padded.length - 3; index += 1)
        output.add(padded.slice(index, index + 3));
    return output;
};
/**
 * Boundary-padded trigram Dice similarity.  Padding preserves useful prefix
 * and suffix evidence, which makes larger human misspellings such as
 * `skyfalling` -> `skydiving` discoverable without an embedding model.
 */
const characterTrigramSimilarity = (left, right) => {
    const compactLeft = compactSearchText(left);
    const compactRight = compactSearchText(right);
    if (!compactLeft || !compactRight)
        return 0;
    if (compactLeft === compactRight)
        return 1;
    const leftTrigrams = characterTrigrams(compactLeft);
    const rightTrigrams = characterTrigrams(compactRight);
    if (leftTrigrams.size === 0 || rightTrigrams.size === 0)
        return 0;
    let matches = 0;
    for (const trigram of leftTrigrams)
        if (rightTrigrams.has(trigram))
            matches += 1;
    return (0, exports.clamp)((2 * matches) / (leftTrigrams.size + rightTrigrams.size));
};
exports.characterTrigramSimilarity = characterTrigramSimilarity;
const commonPrefixLength = (left, right) => {
    const maximum = Math.min(left.length, right.length);
    let length = 0;
    while (length < maximum && left.charCodeAt(length) === right.charCodeAt(length))
        length += 1;
    return length;
};
const commonSuffixLength = (left, right) => {
    const maximum = Math.min(left.length, right.length);
    let length = 0;
    while (length < maximum &&
        left.charCodeAt(left.length - length - 1) === right.charCodeAt(right.length - length - 1)) {
        length += 1;
    }
    return length;
};
/**
 * Levenshtein distance with an upper bound. Returning maxDistance + 1 means
 * the strings are farther apart than the caller cares about.
 */
const boundedLevenshteinDistance = (left, right, maxDistance) => {
    if (left === right)
        return 0;
    if (maxDistance < 0)
        return maxDistance + 1;
    if (Math.abs(left.length - right.length) > maxDistance)
        return maxDistance + 1;
    if (left.length === 0)
        return right.length <= maxDistance ? right.length : maxDistance + 1;
    if (right.length === 0)
        return left.length <= maxDistance ? left.length : maxDistance + 1;
    let previous = new Uint16Array(right.length + 1);
    let current = new Uint16Array(right.length + 1);
    for (let column = 0; column <= right.length; column += 1)
        previous[column] = column;
    for (let row = 1; row <= left.length; row += 1) {
        current[0] = row;
        let rowMinimum = current[0];
        const leftCharacter = left.charCodeAt(row - 1);
        for (let column = 1; column <= right.length; column += 1) {
            const substitutionCost = leftCharacter === right.charCodeAt(column - 1) ? 0 : 1;
            const value = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + substitutionCost);
            current[column] = value;
            if (value < rowMinimum)
                rowMinimum = value;
        }
        if (rowMinimum > maxDistance)
            return maxDistance + 1;
        const swap = previous;
        previous = current;
        current = swap;
    }
    const distance = previous[right.length];
    return distance <= maxDistance ? distance : maxDistance + 1;
};
exports.boundedLevenshteinDistance = boundedLevenshteinDistance;
const fuzzyTokenSimilarity = (left, right) => {
    if (left === right)
        return 1;
    const longestLength = Math.max(left.length, right.length);
    if (longestLength < 3)
        return 0;
    const maxDistance = longestLength >= 9 ? 3 : longestLength >= 5 ? 2 : 1;
    const distance = (0, exports.boundedLevenshteinDistance)(left, right, maxDistance);
    if (distance > maxDistance)
        return 0;
    return (0, exports.clamp)(1 - distance / longestLength);
};
exports.fuzzyTokenSimilarity = fuzzyTokenSimilarity;
/**
 * A deliberately broader fallback used only for the tiny title-edge bucket,
 * never for the full vocabulary scan. Keeping it separate leaves ordinary
 * typo searches on the fast Levenshtein hot path.
 */
const broadCharacterTokenSimilarity = (left, right) => {
    if (left === right)
        return 1;
    const shortestLength = Math.min(left.length, right.length);
    if (shortestLength < 7 || Math.abs(left.length - right.length) > 3)
        return 0;
    const prefixLength = commonPrefixLength(left, right);
    const suffixLength = commonSuffixLength(left, right);
    if (prefixLength < 3 && suffixLength < 3)
        return 0;
    const trigramSimilarity = (0, exports.characterTrigramSimilarity)(left, right);
    const threshold = prefixLength >= 3 && suffixLength >= 3 ? 0.42 : 0.58;
    return trigramSimilarity >= threshold ? trigramSimilarity : 0;
};
exports.broadCharacterTokenSimilarity = broadCharacterTokenSimilarity;
const popCount32 = (value) => {
    let count = 0;
    let remaining = value >>> 0;
    while (remaining) {
        remaining &= remaining - 1;
        count += 1;
    }
    return count;
};
exports.popCount32 = popCount32;
const calculateDirectMatchScore = (query, fields) => {
    if (!query)
        return 0;
    let score = 0;
    if (fields.title === query)
        score = Math.max(score, 1);
    else if (fields.title.startsWith(query))
        score = Math.max(score, 0.95);
    else if (fields.title.includes(query))
        score = Math.max(score, 0.85);
    // Ignore word separators for titles so joined and separated spellings rank
    // as the same phrase rather than merely appearing as a weak fuzzy result.
    const compactQuery = compactSearchText(query);
    if (compactQuery.length >= 4) {
        const compactTitle = compactSearchText(fields.title);
        if (compactTitle === compactQuery)
            score = Math.max(score, 1);
        else if (compactTitle.startsWith(compactQuery))
            score = Math.max(score, 0.94);
        else if (compactTitle.includes(compactQuery))
            score = Math.max(score, 0.82);
    }
    if (fields.uploader.includes(query))
        score = Math.max(score, 0.25);
    if (fields.metadata.includes(query))
        score = Math.max(score, 0.05);
    if (fields.description.includes(query))
        score = Math.max(score, 0.03);
    return score;
};
exports.calculateDirectMatchScore = calculateDirectMatchScore;
const getMaximumEditDistance = (token) => (token.length >= 9 ? 3 : token.length >= 5 ? 2 : token.length >= 3 ? 1 : 0);
const bestFieldTokenMatch = (queryToken, fieldTokens, weight) => {
    let bestSimilarity = 0;
    const maxDistance = getMaximumEditDistance(queryToken);
    for (const fieldToken of fieldTokens) {
        if (fieldToken === queryToken) {
            bestSimilarity = 1;
            break;
        }
        if (maxDistance === 0 || fieldToken[0] !== queryToken[0])
            continue;
        const similarity = (0, exports.fuzzyTokenSimilarity)(queryToken, fieldToken);
        if (similarity > bestSimilarity)
            bestSimilarity = similarity;
    }
    return { weightedScore: bestSimilarity * weight, fuzzyScore: bestSimilarity };
};
const scoreItem = (query, item) => {
    const normalizedQuery = (0, exports.normalizeText)(query);
    const queryTokens = (0, exports.tokenize)(normalizedQuery, { maximumTokens: 24, includeStopWords: true });
    const title = (0, exports.normalizeText)(item.title);
    const uploader = (0, exports.normalizeText)(item.uploader);
    const metadata = (0, exports.normalizeText)([...(item.tags ?? []), ...(item.categories ?? [])].join(' '));
    const description = (0, exports.normalizeText)(item.description);
    const searchableFields = [
        { tokens: (0, exports.tokenize)(title, { includeStopWords: true }), weight: 6 },
        { tokens: (0, exports.tokenize)(uploader, { includeStopWords: true }), weight: 1.5 },
        { tokens: (0, exports.tokenize)(metadata, { includeStopWords: true }), weight: 2.5 },
        { tokens: (0, exports.tokenize)(description, { includeStopWords: true }), weight: 1 },
    ];
    let weightedScore = 0;
    let matchedMask = 0;
    let fuzzyScore = 0;
    for (let queryIndex = 0; queryIndex < queryTokens.length; queryIndex += 1) {
        const queryToken = queryTokens[queryIndex];
        let bestWeightedScore = 0;
        let bestSimilarity = 0;
        for (const field of searchableFields) {
            const match = bestFieldTokenMatch(queryToken, field.tokens, field.weight);
            if (match.weightedScore > bestWeightedScore)
                bestWeightedScore = match.weightedScore;
            if (match.fuzzyScore > bestSimilarity)
                bestSimilarity = match.fuzzyScore;
        }
        if (bestWeightedScore > 0) {
            weightedScore += bestWeightedScore;
            if (queryIndex < 31)
                matchedMask |= 1 << queryIndex;
        }
        fuzzyScore = Math.max(fuzzyScore, bestSimilarity);
    }
    const tokenCoverage = queryTokens.length === 0 ? 0 : (0, exports.popCount32)(matchedMask) / queryTokens.length;
    const fieldRelevance = queryTokens.length === 0 ? 0 : (0, exports.clamp)(weightedScore / (queryTokens.length * 10));
    const languageSimilarity = (0, exports.clamp)(tokenCoverage * 0.25 + fieldRelevance * 0.75);
    const directMatchScore = (0, exports.calculateDirectMatchScore)(normalizedQuery, { title, uploader, metadata, description });
    const similarity = (0, exports.clamp)(directMatchScore * 0.45 + languageSimilarity * 0.5 + fuzzyScore * 0.05);
    return {
        ...item,
        uploader: item.uploader || '',
        duration: (0, exports.safeNumber)(item.duration),
        similarity,
        fuzzyScore,
        languageSimilarity,
        directMatchScore,
    };
};
exports.scoreItem = scoreItem;
const computeSimilarity = (query, items) => {
    return items.map((item) => (0, exports.scoreItem)(query, item)).sort((left, right) => right.similarity - left.similarity);
};
exports.computeSimilarity = computeSimilarity;
const formatDuration = (duration) => {
    const totalSeconds = Math.max(0, Math.floor((0, exports.safeNumber)(duration)));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0)
        return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
};
exports.formatDuration = formatDuration;
const getSortAlgorithm = (sortAlgorithm) => {
    switch (sortAlgorithm) {
        case constants_1.SORT_OPTIONS.fuzzy:
            return (left, right) => right.fuzzyScore - left.fuzzyScore || right.similarity - left.similarity;
        case constants_1.SORT_OPTIONS.language:
            return (left, right) => right.languageSimilarity - left.languageSimilarity || right.similarity - left.similarity;
        case constants_1.SORT_OPTIONS.random:
            return () => Math.random() - 0.5;
        default:
            return (left, right) => right.similarity - left.similarity;
    }
};
exports.getSortAlgorithm = getSortAlgorithm;
const sliceAndSortResults = (results, limit, sortAlgorithm, offset = 0) => {
    return results.sort((0, exports.getSortAlgorithm)(sortAlgorithm)).slice(offset, offset + limit);
};
exports.sliceAndSortResults = sliceAndSortResults;
const parseCreationTimestamp = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        return Math.floor(value);
    if (typeof value !== 'string' || !value.trim())
        return undefined;
    const trimmed = value.trim();
    if (/^\d{8}$/.test(trimmed)) {
        const year = Number(trimmed.slice(0, 4));
        const month = Number(trimmed.slice(4, 6)) - 1;
        const day = Number(trimmed.slice(6, 8));
        const timestamp = Date.UTC(year, month, day) / 1000;
        return Number.isFinite(timestamp) ? timestamp : undefined;
    }
    const timestamp = Date.parse(trimmed);
    return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : undefined;
};
exports.parseCreationTimestamp = parseCreationTimestamp;
const isPathInside = (rootDirectory, candidatePath) => {
    const relative = path_1.default.relative(path_1.default.resolve(rootDirectory), path_1.default.resolve(candidatePath));
    return relative === '' || (!relative.startsWith('..') && !path_1.default.isAbsolute(relative));
};
exports.isPathInside = isPathInside;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
exports.yieldToEventLoop = yieldToEventLoop;
/** Compatibility helper. New code resolves media files lazily and asynchronously. */
const findFileUrl = (baseDirectory, id) => {
    for (const extension of constants_1.MEDIA_EXTENSIONS) {
        const filePath = path_1.default.join(baseDirectory, `${id}${extension}`);
        if (fs_1.default.existsSync(filePath))
            return `file://${filePath}`;
    }
    return null;
};
exports.findFileUrl = findFileUrl;
//# sourceMappingURL=helpers.js.map