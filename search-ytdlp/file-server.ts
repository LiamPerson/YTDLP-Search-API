import fileSystem from 'fs/promises'
import { constants } from 'fs'
import path from 'path'
import type { Request, Response } from 'express'
import mime from 'mime-types'
import { spawn } from 'child_process'

// Helper function to run a command and collect its output.
const runCommand = (command: string, args: string[]): Promise<Buffer> => {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args)
		const chunks: Buffer[] = []

		child.stdout.on('data', (data) => {
			chunks.push(data)
		})
		child.stderr.on('data', (data) => {
			// ffprobe sends information to stderr, so ignore or log if needed.
		})
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks))
			} else {
				reject(new Error(`${command} exited with code ${code}`))
			}
		})
	})
}

// Function to get the video duration using ffprobe.
const getVideoDuration = async (filePath: string): Promise<number> => {
	const args = [
		'-v',
		'error',
		'-select_streams',
		'v:0',
		'-show_entries',
		'format=duration',
		'-of',
		'default=noprint_wrappers=1:nokey=1',
		filePath,
	]
	try {
		const result = await runCommand('ffprobe', args)
		const duration = parseFloat(result.toString().trim())
		if (isNaN(duration) || duration <= 0) {
			throw new Error('Could not determine video duration.')
		}
		return duration
	} catch (error) {
		throw new Error('Error retrieving video duration: ' + (error instanceof Error ? error.message : ''))
	}
}

// Function to extract a single frame at a given time (in seconds) using ffmpeg.
const extractFrame = async (filePath: string, time: number): Promise<Buffer> => {
	return new Promise((resolve, reject) => {
		const args = ['-ss', time.toString(), '-i', filePath, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']
		const child = spawn('ffmpeg', args)
		const chunks: Buffer[] = []

		child.stdout.on('data', (data) => {
			chunks.push(data)
		})
		child.stderr.on('data', (data) => {
			// Optionally log ffmpeg stderr output if debugging.
		})
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks))
			} else {
				reject(new Error('ffmpeg exited with code ' + code))
			}
		})
	})
}

export const handleSend = async (request: Request, response: Response): Promise<void> => {
	// Retrieve the file URL from the query parameter "url"
	const fileUrlParam = request.query.url
	if (typeof fileUrlParam !== 'string') {
		response.status(400).json({ error: 'No file URL provided.' })
		return
	}

	// Variables to store our resolved file path and a flag for thumbnail extraction.
	let absoluteFilePath = fileUrlParam
	let thumbnailRequested = false

	// Check if a separate "thumbnail" query parameter exists.
	if (request.query.thumbnail === 'true') {
		thumbnailRequested = true
	}

	// If the provided string starts with "file://", parse it as a URL.
	if (absoluteFilePath.startsWith('file://')) {
		try {
			const parsedUrl = new URL(absoluteFilePath)
			// If the file URL itself contains a "thumbnail" search parameter, use it.
			if (!thumbnailRequested && parsedUrl.searchParams.get('thumbnail') === 'true') {
				thumbnailRequested = true
			}
			// Use only the pathname (discarding the query string)
			absoluteFilePath = parsedUrl.pathname

			// On Windows, the pathname might start with a slash (e.g. /C:/path),
			// so adjust it accordingly.
			if (process.platform === 'win32' && absoluteFilePath.startsWith('/')) {
				absoluteFilePath = absoluteFilePath.substring(1)
			}
		} catch (error) {
			// If URL parsing fails, fall back to string manipulation.
			absoluteFilePath = absoluteFilePath.replace('file://', '')
		}
	}

	// Resolve the absolute path (can help with relative path issues)
	absoluteFilePath = path.resolve(absoluteFilePath)
	console.log('Resolved file path:', absoluteFilePath, 'Thumbnail requested:', thumbnailRequested)

	// Check if the file is accessible with read permissions.
	try {
		await fileSystem.access(absoluteFilePath, constants.R_OK)
	} catch {
		response.status(403).json({ error: `The file at '${absoluteFilePath}' is not accessible.` })
		return
	}

	// If a thumbnail is requested for a video file, extract and send it.
	if (thumbnailRequested) {
		try {
			// Get the video duration, choose a random timestamp.
			const duration = await getVideoDuration(absoluteFilePath)
			const randomTime = Math.random() * duration

			// Extract a thumbnail frame.
			const frameBuffer = await extractFrame(absoluteFilePath, randomTime)

			// Respond with the JPEG image.
			response.setHeader('Content-Type', 'image/jpeg')
			response.setHeader('Content-Length', frameBuffer.length.toString())
			response.send(frameBuffer)
		} catch (error: unknown) {
			let errorMessage = 'An unexpected error occurred while generating thumbnail.'
			if (error instanceof Error) {
				errorMessage = error.message
			}
			console.error(error)
			response.status(500).json({ error: errorMessage })
		}
		return
	}

	// Otherwise, return the full file content.
	try {
		// Express will stat + stream the file under the hood to allow sending files larger than 2GB.
		// It also handles Range requests if you pass `acceptRanges: true`.
		response.sendFile(absoluteFilePath, { acceptRanges: true }, (error) => {
			if (error && !response.headersSent) {
				console.error(error)
				response.status(500).json({ error: error.message })
			}
		})
	} catch (error: unknown) {
		let errorMessage = 'An unexpected error occurred.'
		if (error instanceof Error) {
			errorMessage = error.message
		}
		console.error(error)
		response.status(500).json({ error: errorMessage })
	}
}
