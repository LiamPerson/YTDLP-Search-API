import { SORT_OPTIONS } from './constants'
import { computeSimilarity, getSortAlgorithm, ItemForAnalysis } from './helpers'

const mockJsonData: ItemForAnalysis[] = [
	{
		id: '1',
		title: 'Roblox goes crazy',
		description: 'Wow, this roblox video is crazy!',
		tags: ['games'],
		uploader: 'Crazy Videos!',
		duration: 12,
	},
	{
		id: '2',
		title: 'Relaxing game music',
		description: 'This video has music from all my favorite games like roblox',
		tags: ['music'],
		uploader: 'Music channel 12345',
		duration: 6002,
	},
	{
		id: '3',
		title: 'Extreme parkour',
		description: 'Just a bunch of crazy parkour',
		tags: ['city', 'jumps'],
		uploader: 'parkour city!',
		duration: 120,
	},
]

describe(computeSimilarity.name, () => {
	it('should return the Roblox video first when mentioning roblox', () => {
		const sortedMatches = computeSimilarity('roblox', mockJsonData).sort(getSortAlgorithm(SORT_OPTIONS.normal))

		console.log('Order when searching "roblox"', sortedMatches)

		expect(sortedMatches[0].title).toBe('Roblox goes crazy') // "Roblox goes crazy" should be #1
		expect(sortedMatches[1].title).toBe('Relaxing game music')
		expect(sortedMatches[2].title).toBe('Extreme parkour') // "Extreme parkour" has no mention of roblox and should be last.
	})
	it('should return the Roblox video first when searching for "crazy" but the parkour video second.', () => {
		const sortedMatches = computeSimilarity('crazy', mockJsonData).sort(getSortAlgorithm(SORT_OPTIONS.normal))

		console.log('Order when searching "crazy"', sortedMatches)

		expect(sortedMatches[0].title).toBe('Roblox goes crazy') // "Roblox goes crazy" should be #1
		expect(sortedMatches[1].title).toBe('Extreme parkour')
		expect(sortedMatches[2].title).toBe('Relaxing game music') // "Relaxing game music" has no mention of crazy and should be last.
	})
	it('should return the Game Music video first when searching for "games" but the roblox video second.', () => {
		const sortedMatches = computeSimilarity('games', mockJsonData).sort(getSortAlgorithm(SORT_OPTIONS.normal))

		console.log('Order when searching "games"', sortedMatches)

		expect(sortedMatches[0].title).toBe('Relaxing game music') // Game is in the title, so it goes first
		expect(sortedMatches[1].title).toBe('Roblox goes crazy') // Gaming is in the description and should be second
		expect(sortedMatches[2].title).toBe('Extreme parkour')
	})
})
