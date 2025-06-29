/**
 * Gets the singular type of an array or the type itself if it's not an array.
 */
export type Singular<T> = T extends Array<infer U> ? U : T

export type WorkerInformation = {
	query: string
	workerFiles: string[]
	jsonDirectory: string
}

export type Item = {
	id: string
	title?: string
	uploader: string
	duration: number
	similarity: number
	fuzzyScore: number
	languageSimilarity: number
	directMatchScore: number
	[x: string]: unknown
}

export type ExpectedJsonItem = {
	id: string
	title?: string
	description?: string
	tags?: string[]
	categories?: string[]
	/**
	 * The URL to the thumbnail online
	 */
	thumbnail: string
	channel_id: string
	/**
	 * The URL to the channel online
	 * @example "https://www.youtube.com/channel/UCsGk5vVqFmvH2WSiMK5gWDQw"
	 */
	channel_url: string
	/**
	 * The duration in seconds
	 */
	duration: number
	view_count: number
	/**
	 * The URL of the acquired resource
	 */
	webpage_url: string
	comment_count: number
	like_count: number
	/**
	 * The name of the author / channel
	 */
	channel: string
	channel_follower_count: number
	uploader: string
	uploader_id: string
	uploader_url: string
	/**
	 * The date of the upload written as YYYYMMDD
	 * @example 20220810
	 */
	upload_date: string
	/**
	 * The timestamp of the upload
	 */
	timestamp: number
	availability: string
	/**
	 * The domain the resource is from
	 * @example "youtube.com"
	 */
	webpage_url_domain: string
	/**
	 * The language the resource is in
	 * @example "en"
	 */
	language: string
	/**
	 * How many bytes the filesize is approximately
	 * @example 1504628
	 */
	filesize_approx: number
	width: number
	height: number
	/**
	 * The resource's resolution if available
	 * @example "720x1280"
	 */
	resolution: string
	/**
	 * The width divided by the height
	 * @example 0.56
	 */
	aspect_ratio: number
}
