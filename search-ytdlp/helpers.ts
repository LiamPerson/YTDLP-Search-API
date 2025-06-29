import natural from 'natural'
import Fuse from 'fuse.js'
import fs from 'fs'
import path from 'path'

import { ExpectedJsonItem, Item, Singular } from './types'
import { SORT_OPTIONS } from './constants'
import cloneDeep from 'lodash.clonedeep'

/**
 * The weight of natural language processing VS fuzzy string matching
 * - Increase the fuzzy weight to improve how close you want the text to match.
 * - Increase the language weight to improve how closely you want the sentiment of all the text to match.
 * - Increase the direct match weight to improve how closely you want the query to match exactly to the video
 *
 * I recommend having directMatch > language > fuzzy.
 * Fuzzy and direct matching are very similar. Language captures intent. You want to show exactly what people typed first though,
 * then related after.
 *
 * @note the sum of the numbers **must** equal 1
 */
const scoreWeights = { language: 0.3, fuzzy: 0.2, directMatch: 0.5 }

/**
 * Weights to apply when natural language processing.
 * Adjust these to put more weight onto a specific field.
 * @note the sum of the numbers **must** equal 1
 */
const languageWeights = { title: 0.6, description: 0.25, tags: 0.05, author: 0.1 }
/**
 * Weights to apply to the fuzzy scoring.
 * Adjust these to put more weight onto a specific field.
 * @note the sum of the numbers is normalized and can equal anything.
 */
const fuzzyWeights = { title: 5, description: 0.025, tags: 0.025, author: 0.5 }

/**
 * Weights to apply to the exact matching.
 * The higher the number, the more important the field is when finding an exact match.
 * The sum of all values must equal 1 (100%)
 */
const exactMatchWeights = { title: 0.6, description: 0.25, tags: 0.05, author: 0.1 }

/**
 * Normalizes a given text string by converting to lowercase, removing special characters,
 * normalizing spaces, and trimming whitespace.
 *
 * @param {string} text - The text string to normalize.
 * @returns {string} - The normalized text string.
 */
const normalizeText = (text: string) => {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, '') // Remove special characters
		.replace(/\s+/g, ' ') // Normalize spaces
		.trim() // Remove leading/trailing whitespace
}

/**
 * Computes the Levenshtein similarity between two strings.
 *
 * @param {string} a - The first string.
 * @param {string} b - The second string.
 * @returns {number} - A similarity score between 0 and 1, where 1 indicates identical strings.
 */
const computeLevenshteinSimilarity = (a: string, b: string) => {
	const distance = natural.LevenshteinDistance(a, b)
	const maxLength = Math.max(a.length, b.length)
	return (maxLength - distance) / maxLength
}

/**
 * Computes the phonetic similarity between two strings using the SoundEx algorithm.
 *
 * @param {string} a - The first string.
 * @param {string} b - The second string.
 * @returns {number} - A similarity score of 1 if the strings sound similar, otherwise 0.
 */
const computePhoneticSimilarity = (a: string, b: string) => {
	const soundEx = new natural.SoundEx()
	const soundexA = soundEx.process(a)
	const soundexB = soundEx.process(b)
	return soundexA === soundexB ? 1 : 0
}

type Weights = {
	title: number
	description: number
	tags: number
	author: number
}

/**
 * Computes a combined similarity score between a query string and a data object using natural language processing.
 *
 * @param {string} query - The query string.
 * @param {Object} data - The data object containing text fields to compare against.
 * @param {Object} weights - An object specifying the weight of each similarity measure.
 * @returns {number} - A similarity score between 0 and 1.
 */
const computeLanguageSimilarity = (query: string, data: ItemForAnalysis, weights: Weights) => {
	const queryNormalized = normalizeText(query)
	const titleNormalized = normalizeText(data.title || '')
	const descriptionNormalized = normalizeText(data.description || '')
	const tagsNormalized = (data.tags || []).map((tag) => normalizeText(tag)).join(' ')
	const authorNormalized = normalizeText(data.uploader || '')

	// Compute similarities
	const titleSimilarity = computeLevenshteinSimilarity(queryNormalized, titleNormalized)
	const descriptionSimilarity = computeLevenshteinSimilarity(queryNormalized, descriptionNormalized)
	const tagsSimilarity = computeLevenshteinSimilarity(queryNormalized, tagsNormalized)
	const authorSimilarity = computePhoneticSimilarity(queryNormalized, authorNormalized)

	// Combine similarity scores with weighted contributions
	return (
		weights.title * titleSimilarity +
		weights.description * descriptionSimilarity +
		weights.tags * tagsSimilarity +
		weights.author * authorSimilarity
	)
}

/**
 * Calculates the fuzzy search threshold based on the length of the search query.
 * The function uses a logarithmic scale to adjust the threshold dynamically
 * between a minimum and maximum value.
 *
 *    Threshold (0.8)
 *    |                          ................... |
 *    |                  .......                     |
 *    |              ....                            |
 *    |           ...                                |
 *    |         ..                                   |
 *    |       ..                                     |
 *    |     ..                                       |
 *    |  ..                                          |
 *    |...___________________________________________|
 *   Threshold (0.1)                      Character Length (150)
 *  Character Length (1)
 *
 * @param {number} length - The length of the search query. This should be a positive integer representing the number of characters in the query.
 * @returns {number} The calculated threshold for fuzzy search, which will be a number between 0.1 and 0.8.
 */
function calculateThreshold(length: number) {
	// Set the minimum and maximum threshold values
	const minThreshold = 0.1
	const maxThreshold = 0.8

	// Set the maximum query length for scaling
	const maxQueryLength = 150

	// Calculate the logarithmic threshold
	const threshold = minThreshold + (Math.log(length) / Math.log(maxQueryLength)) * (maxThreshold - minThreshold)

	// Ensure the threshold stays within the bounds
	// console.log('Using threshold', threshold)
	return Math.max(minThreshold, Math.min(maxThreshold, threshold))
}

/**
 * Calculates how far into the JSON string to expect the query for fuzzy
 * searches.
 *
 * This number is arbitrarily decided.
 *
 * @param {number} queryLength - The length of the query to search the JSON strings
 * @returns {number} - the approximate location to expect the string
 */
function calculateLocation(queryLength: number) {
	return 0 // I have no idea why this works best. You would think the query's string length would matter ...
}

export type ItemForAnalysis = Pick<ExpectedJsonItem, 'title' | 'description' | 'tags' | 'uploader' | 'id' | 'duration'>

const convertArrayOrStringToString = (value: string | string[]) => {
	return Array.isArray(value) ? value.join(' ') : value
}

/**
 * Gets a score based on how much the exact query matches the exact result weighted by key.
 * The result is the percentage of query matched in the string multiplied by the weight.
 * @example
 * const query = 'title'
 * const item = { title: 'this is a title' }
 * const score = computeDirectMatch(query, item) // pre-score = 5 characters in query out of 10 characters in sentence = 5 / 10 = 0.5
 * console.log(score) // final score = pre-score (0.5) * weight (0.5) = 0.25
 */
const computeDirectMatch = (query: string, item: ItemForAnalysis) => {
	const keys = [
		{
			name: 'title',
			weight: exactMatchWeights.title,
		},
		{
			name: 'description',
			weight: exactMatchWeights.description,
		},
		{
			name: 'tags',
			weight: exactMatchWeights.tags,
		},
		{
			name: 'uploader',
			weight: exactMatchWeights.author,
		},
	] as const
	const itemCloned = cloneDeep(item)
	// console.log('Query', query)
	const queryNormalized = query.toLowerCase().trim()
	const queryLength = queryNormalized.length

	// I have kept the keys separate for easier debugging
	const keyScores = keys.map((key) => {
		// console.log('key being analyzed', key)
		// console.log('item key', itemCloned[key.name])
		const itemKeyNormalized =
			convertArrayOrStringToString(itemCloned[key.name] || '')
				.toLowerCase()
				.trim() || ''
		const itemKeyLength = itemKeyNormalized.length
		const hasMatch = itemKeyNormalized.includes(queryNormalized)
		const score = hasMatch ? queryLength / itemKeyLength : 0

		return { name: key.name, score: score * key.weight }
	})
	const keyValues = Object.values(keyScores)
	return keyValues.reduce((sum, value) => sum + value.score, 0)
}

/**
 * Adds the similarity scores to all items.
 *
 * @param {string} query - The query string to search for.
 * @param {Array<Object>} items - An array of data objects to search through.
 * @returns {Array<Object>} - An array of the top matching data objects, sorted by similarity score.
 */
export const computeSimilarity = (query: string, items: ItemForAnalysis[]) => {
	// Adjusted Fuse.js configuration for more permissive fuzzy matching
	const fuseOptions = {
		includeScore: true,
		isCaseSensitive: false,
		// ignoreLocation: true,
		location: calculateLocation(query.length),
		distance: 250,
		fieldNormWeight: 0.8,
		threshold: calculateThreshold(query.length),
		keys: [
			{
				name: 'title',
				weight: fuzzyWeights.title,
			},
			{
				name: 'description',
				weight: fuzzyWeights.description,
			},
			{
				name: 'tags',
				weight: fuzzyWeights.tags,
			},
			{
				name: 'uploader',
				weight: fuzzyWeights.author,
			},
		],
	}

	const fuse = new Fuse(items, fuseOptions)
	const fuzzyResults = fuse.search(query)
	// 👇 Used to test the query "candy shoppe bionicle" to find "Bionicle Adventures: The Candy Shoppe Revolt" with ID: "-_wV4_yHhnA"
	// const funnyVideo = fuzzyResults.find((result) => result.item.id === '-_wV4_yHhnA')
	// const nonFunnyVideo = fuzzyResults.find((result) => result.item.id === '_MH906rmmKA')
	// if (funnyVideo) console.log('Specific video', funnyVideo.score)
	// if (nonFunnyVideo) console.log('Random video', nonFunnyVideo.score)

	const results = items.map((data) => {
		// Compute combined similarity using Levenshtein and phonetic similarities
		const languageSimilarity = computeLanguageSimilarity(query, data, languageWeights)

		// Find fuzzy result score from fuse.js
		const fuzzyResult = fuzzyResults.find((result) => result.item.id === data.id)
		const fuzzyScore = fuzzyResult ? 1 - (fuzzyResult.score || 0) : 0

		// Find direct match score
		const directMatchScore = computeDirectMatch(query, data)

		// Final similarity combining both
		const weightedLanguageScore = scoreWeights.language * languageSimilarity
		const weightedFuzzyScore = scoreWeights.fuzzy * fuzzyScore
		const weightedDirectMatchScore = scoreWeights.directMatch * directMatchScore
		const finalSimilarity = weightedLanguageScore + weightedFuzzyScore + weightedDirectMatchScore

		return {
			...data,
			similarity: finalSimilarity,
			languageSimilarity,
			fuzzyScore,
			directMatchScore,
		} satisfies Item
	})

	return results.sort((a, b) => b.similarity - a.similarity)
}

/**
 * Reads and parses JSON files from a specified directory.
 *
 * @param {string} directory - The directory containing JSON files.
 * @param {Array<string>} files - An array of JSON file names to read.
 * @returns {Array<Object>} - An array of parsed JSON objects.
 */
export const readJsonFiles = (directory: string, files: string[]) => {
	return files.map((file) => {
		const content = fs.readFileSync(path.join(directory, file), 'utf-8')
		return JSON.parse(content)
	})
}

/**
 * Formats a duration in seconds into a human-readable string (minutes and seconds).
 *
 * @param {number} duration - The duration in seconds.
 * @returns {string} - The formatted duration string in "Xm Ys" format.
 */
export const formatDuration = (duration: number) => {
	const minutes = Math.floor(duration / 60)
	const seconds = Math.floor(duration % 60) // Flooring this too as floating point numbers kill it sometimes
	return `${minutes}m ${seconds}s`
}

type GetSortAlgorithmReturn = (a: Item, b: Item) => number
const getSortAlgorithm = (sortAlgorithm: string): GetSortAlgorithmReturn => {
	switch (sortAlgorithm) {
		case SORT_OPTIONS.fuzzy:
			return (a, b) => b.fuzzyScore - a.fuzzyScore
		case SORT_OPTIONS.language:
			return (a, b) => b.languageSimilarity - a.languageSimilarity
		case SORT_OPTIONS.random:
			return () => Math.random() - 0.5
		default:
			return (a, b) => b.similarity - a.similarity
	}
}

/**
 * Finds the file URL for a specific video file based on its ID.
 *
 * @param {string} baseDirectory - The base directory to search within.
 * @param {string} id - The item ID to find.
 * @returns {string|null} - The file URL if found, otherwise null.
 */
export const findFileUrl = (baseDirectory: string, id: string) => {
	const extensions = ['webm', 'mp4', 'mkv', 'mp3', 'wav', 'flac', 'flv', 'opus']
	for (const ext of extensions) {
		const filePath = path.join(baseDirectory, `${id}.${ext}`)
		if (fs.existsSync(filePath)) {
			return `file://${filePath}`
		}
	}
	return null
}

/**
 * Gets the combined results from workers, sliced to the amount specified, and sorted according to the sortAlgorithm.
 * Expect this to error!!!
 */
export const sliceAndSortResults = (results: Item[], limit: number, sortAlgorithm: string) => {
	return results.sort(getSortAlgorithm(sortAlgorithm)).slice(0, limit)
}
