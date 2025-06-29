/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
	testEnvironment: 'node',
	transform: {
		'^.+\\.tsx?$': ['ts-jest', {}],
	},
	extensionsToTreatAsEsm: ['.ts', '.tsx'], // Treat .ts and .tsx files as ESM
	moduleDirectories: ['node_modules', '<rootDir>/'],
	moduleNameMapper: {
		'^@/(.*)$': '<rootDir>/$1',
	},
}
