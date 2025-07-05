// example.ts
import { TfIdfIndex } from './tfidfIndex'
import { Item } from './types'
import { readFileSync } from 'fs'
import path from 'path'

// 1) Build once and save to disk
async function buildAndSave() {
	// Read the JSON file
	const jsonFilePath = path.resolve('/run/media/user/HardDisk3TB/YTDLP-Search-API/test/example.json')
	const rawData = readFileSync(jsonFilePath, 'utf-8')

	// Parse the JSON data
	const items: Item[] = JSON.parse(rawData)
	console.log('Sample item', items[10])
	const idx = new TfIdfIndex()
	idx.build(items)
	await idx.saveToFile('./my-tfidf-index.json')
}

buildAndSave()
