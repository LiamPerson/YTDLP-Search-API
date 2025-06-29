// Just error if the person doesn't have their .env setup
const searchDirectory = process.env.YTDLP_DIRECTORY
if (!searchDirectory) {
	throw Error('You are missing your `YTDLP_DIRECTORY` in your `.env` file. Make sure you have this set up.')
}

// Enums
export const SORT_OPTIONS = {
	fuzzy: 'fuzzy',
	language: 'language',
	normal: 'normal',
	random: 'random',
}

// Default configuration constants
export const DEFAULT_SEARCH_DIRECTORY = searchDirectory
export const DEFAULT_WORKER_CORES_LIMIT = 8
export const DEFAULT_RESULTS_LIMIT = 5
export const DEFAULT_SORT = SORT_OPTIONS.normal
