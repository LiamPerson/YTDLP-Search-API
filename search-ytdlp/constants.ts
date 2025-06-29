// Enums
export const SORT_OPTIONS = {
	fuzzy: 'fuzzy',
	language: 'language',
	normal: 'normal',
	random: 'random',
}

// Default configuration constants
export const DEFAULT_SEARCH_DIRECTORY = process.env.YTDLP_DIRECTORY || ''
export const DEFAULT_WORKER_CORES_LIMIT = 8
export const DEFAULT_RESULTS_LIMIT = 5
export const DEFAULT_SORT = SORT_OPTIONS.normal
