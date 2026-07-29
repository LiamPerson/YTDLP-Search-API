(() => {
	'use strict'

	const elements = {
		form: document.querySelector('#search-form'),
		query: document.querySelector('#query'),
		sort: document.querySelector('#sort'),
		limit: document.querySelector('#limit'),
		random: document.querySelector('#random'),
		refresh: document.querySelector('#refresh'),
		status: document.querySelector('#search-status'),
		health: document.querySelector('#health'),
		healthText: document.querySelector('#health-text'),
		queue: document.querySelector('#search-queue'),
		queueEmpty: document.querySelector('#queue-empty'),
		queueSummary: document.querySelector('#queue-summary'),
		queueClear: document.querySelector('#queue-clear'),
		resultsHeading: document.querySelector('#results-heading'),
		results: document.querySelector('#results'),
		resultCount: document.querySelector('#result-count'),
		empty: document.querySelector('#empty-state'),
		loadMore: document.querySelector('#load-more'),
		player: document.querySelector('#player'),
		playerPlaceholder: document.querySelector('#player-placeholder'),
		playingTitle: document.querySelector('#playing-title'),
		playingMeta: document.querySelector('#playing-meta'),
		openFile: document.querySelector('#open-file'),
		openSidecar: document.querySelector('#open-sidecar'),
	}

	const ACTIVE_STATUSES = new Set(['submitting', 'queued', 'running', 'cancelling'])
	const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
	const MAX_VISIBLE_TASKS = 40
	let tasks = []
	let sequence = 0
	let activeTaskId = null
	let preferredTaskId = null
	let selectedIndex = -1
	let monitorPromise = null

	const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
	const getTask = (taskId) => tasks.find((task) => task.id === taskId)
	const getActiveTask = () => getTask(activeTaskId)
	const getResults = () => getActiveTask()?.response?.results || []
	const setStatus = (message, error = false) => {
		elements.status.textContent = message
		elements.status.classList.toggle('error', error)
	}
	const getErrorMessage = (payload, fallback) => payload?.error?.message || payload?.error?.error?.message || fallback

	const requestJson = async (url, options = {}) => {
		const response = await fetch(url, options)
		let payload
		try {
			payload = await response.json()
		} catch {
			payload = null
		}
		if (!response.ok) throw new Error(getErrorMessage(payload, `${response.status} ${response.statusText}`))
		return payload
	}

	const describeTask = (task) => {
		if (task.status === 'submitting') return 'Submitting'
		if (task.status === 'queued') return task.position > 0 ? `Queue position ${task.position}` : 'Queued'
		if (task.status === 'running') return 'Searching now'
		if (task.status === 'cancelling') return 'Cancelling'
		if (task.status === 'failed') return task.error || 'Search failed'
		if (task.status === 'cancelled') return 'Cancelled'
		const count = task.append ? task.pageResultCount || 0 : task.response?.results?.length || 0
		const duration = task.response?.meta?.searchDurationMs
		return `${count.toLocaleString()} result${count === 1 ? '' : 's'}${duration === undefined ? '' : ` · ${duration.toLocaleString()}ms`}${task.cached ? ' · cache' : ''}`
	}

	const taskBadge = (task) => {
		if (task.status === 'queued' && task.position > 0) return String(task.position)
		return {
			submitting: 'new',
			queued: 'q',
			running: 'run',
			cancelling: '…',
			completed: 'ok',
			failed: '!',
			cancelled: '×',
		}[task.status] || '?'
	}

	const trimTasks = () => {
		while (tasks.length > MAX_VISIBLE_TASKS) {
			let removableIndex = -1
			for (let index = tasks.length - 1; index >= 0; index -= 1) {
				const task = tasks[index]
				if (TERMINAL_STATUSES.has(task.status) && task.id !== activeTaskId) {
					removableIndex = index
					break
				}
			}
			if (removableIndex < 0) break
			tasks.splice(removableIndex, 1)
		}
	}

	const renderQueue = () => {
		trimTasks()
		elements.queue.replaceChildren()
		elements.queueEmpty.hidden = tasks.length > 0
		const running = tasks.filter((task) => task.status === 'running').length
		const waiting = tasks.filter((task) => task.status === 'queued' || task.status === 'submitting').length
		elements.queueSummary.textContent = running || waiting ? `${running} running · ${waiting} waiting` : 'No pending searches'
		elements.queueClear.disabled = !tasks.some((task) => TERMINAL_STATUSES.has(task.status) && task.id !== activeTaskId)

		for (const task of tasks) {
			const item = document.createElement('li')
			item.className = `queue-item ${task.status}${task.id === activeTaskId ? ' active' : ''}`

			const select = document.createElement('button')
			select.type = 'button'
			select.className = 'queue-select'
			select.title = task.error || describeTask(task)

			const state = document.createElement('span')
			state.className = 'queue-state'
			state.textContent = taskBadge(task)
			const copy = document.createElement('span')
			copy.className = 'queue-copy'
			const query = document.createElement('span')
			query.className = 'queue-query'
			query.textContent = `${task.append ? 'More · ' : ''}${task.sort === 'random' ? 'Random videos' : task.query}`
			const meta = document.createElement('span')
			meta.className = 'queue-meta'
			meta.textContent = describeTask(task)
			copy.append(query, meta)
			select.append(state, copy)
			select.addEventListener('click', () => {
				if (task.append && task.parentId) {
					const parent = getTask(task.parentId)
					if (parent?.status === 'completed') activateTask(parent)
					return
				}
				preferredTaskId = task.id
				if (task.status === 'completed') activateTask(task)
				else if (task.status === 'failed') setStatus(task.error || 'Search failed.', true)
				else if (task.status === 'cancelled') setStatus('That queued search was cancelled.')
				else setStatus(`${task.sort === 'random' ? 'Random search' : `“${task.query}”`} is ${describeTask(task).toLowerCase()}. Current results remain usable.`)
				renderQueue()
			})

			const cancel = document.createElement('button')
			cancel.type = 'button'
			cancel.className = 'queue-cancel'
			cancel.textContent = '×'
			cancel.title = 'Cancel this search'
			cancel.hidden = !ACTIVE_STATUSES.has(task.status)
			cancel.addEventListener('click', (event) => {
				event.stopPropagation()
				void cancelTask(task)
			})

			item.append(select, cancel)
			elements.queue.append(item)
		}
	}

	const formatCompletedStatus = (task) => {
		const meta = task.response?.meta
		if (!meta) return 'Search complete.'
		return `${meta.indexedVideos.toLocaleString()} videos indexed · ${meta.candidateCount.toLocaleString()} candidates · ${meta.searchDurationMs.toLocaleString()}ms${task.cached ? ' · cache hit' : ''}`
	}

	const activateTask = (task) => {
		if (!task || task.append || task.status !== 'completed' || !task.response) return
		activeTaskId = task.id
		preferredTaskId = task.id
		selectedIndex = -1
		elements.query.value = task.sort === 'random' ? elements.query.value : task.query
		elements.sort.value = task.sort
		renderQueue()
		renderResults()
		setStatus(formatCompletedStatus(task))
		if (task.response.results.length > 0) selectResult(0, false)
		if (task.sort !== 'random') history.replaceState(null, '', `#${encodeURIComponent(task.query)}`)
	}

	const completeTask = (task, response) => {
		task.status = 'completed'
		task.response = response
		task.position = 0
		task.error = null
		if (task.append && task.parentId) {
			const parent = getTask(task.parentId)
			const incoming = response?.results || []
			task.pageResultCount = incoming.length
			if (parent?.response) {
				parent.response.results = parent.response.results.concat(incoming)
				parent.response.meta = response.meta || parent.response.meta
				parent.hasMore = incoming.length === task.limit
				if (activeTaskId === parent.id) {
					renderResults()
					setStatus(formatCompletedStatus(parent))
				}
			}
			return
		}

		task.hasMore = task.sort !== 'random' && (response?.results?.length || 0) === task.limit
		if (preferredTaskId === task.id || activeTaskId === null) activateTask(task)
	}

	const fetchCompletedTask = async (task) => {
		if (task.finalizing || !task.jobId || task.response) return
		task.finalizing = true
		try {
			const job = await requestJson(`/search/jobs/${encodeURIComponent(task.jobId)}`)
			if (job.status === 'completed' && job.result) completeTask(task, job.result)
			else if (job.status === 'failed') {
				task.status = 'failed'
				task.error = job.error?.message || 'Search failed.'
			} else if (job.status === 'cancelled') {
				task.status = 'cancelled'
			}
		} catch (error) {
			task.status = 'failed'
			task.error = error.message || 'Unable to retrieve the completed search.'
		} finally {
			task.finalizing = false
		}
	}

	const updateStatusFromQueue = () => {
		const running = tasks.filter((task) => task.status === 'running').length
		const waiting = tasks.filter((task) => task.status === 'queued' || task.status === 'submitting').length
		if (running || waiting) {
			setStatus(`${running} search${running === 1 ? '' : 'es'} running · ${waiting} waiting. Keep browsing the current results while they finish.`)
		}
	}

	const ensureMonitor = () => {
		if (monitorPromise) return
		monitorPromise = (async () => {
			while (tasks.some((task) => ACTIVE_STATUSES.has(task.status) && task.jobId)) {
				try {
					const snapshot = await requestJson('/search/queue')
					const jobs = new Map((snapshot.jobs || []).map((job) => [job.id, job]))
					const finalizers = []
					for (const task of tasks) {
						if (!task.jobId || !ACTIVE_STATUSES.has(task.status)) continue
						const job = jobs.get(task.jobId)
						if (!job) {
							finalizers.push(fetchCompletedTask(task))
							continue
						}
						task.status = job.status
						task.position = job.position || 0
						task.cached = Boolean(job.cached)
						if (job.status === 'completed') finalizers.push(fetchCompletedTask(task))
						else if (job.status === 'failed') task.error = job.error?.message || 'Search failed.'
					}
					await Promise.allSettled(finalizers)
					renderQueue()
					renderResults()
					updateStatusFromQueue()
				} catch (error) {
					setStatus(`Search queue monitor: ${error.message || 'server unavailable'}`, true)
					await sleep(1_000)
				}
				const hasRunning = tasks.some((task) => task.status === 'running')
				await sleep(hasRunning ? 250 : 550)
			}
		})().finally(() => {
			monitorPromise = null
			if (tasks.some((task) => ACTIVE_STATUSES.has(task.status) && task.jobId)) ensureMonitor()
		})
	}

	const cancelTask = async (task) => {
		if (!task || !ACTIVE_STATUSES.has(task.status)) return
		task.cancelRequested = true
		if (!task.jobId) {
			task.status = 'cancelled'
			renderQueue()
			return
		}
		task.status = 'cancelling'
		renderQueue()
		try {
			const job = await requestJson(`/search/jobs/${encodeURIComponent(task.jobId)}`, { method: 'DELETE' })
			task.status = job.status || 'cancelled'
			task.position = job.position || 0
			if (task.status === 'failed') task.error = job.error?.message || 'Cancellation failed.'
		} catch (error) {
			task.status = 'failed'
			task.error = error.message || 'Unable to cancel the search.'
		}
		renderQueue()
		ensureMonitor()
	}

	const submitTask = async (task) => {
		try {
			const parameters = new URLSearchParams({
				q: task.query,
				r: String(task.limit),
				offset: String(task.offset),
				s: task.sort,
				async: '1',
				meta: '1',
			})
			const queued = await requestJson(`/search?${parameters}`)
			task.jobId = queued.jobId
			task.position = queued.position || 0
			task.cached = Boolean(queued.cached)
			task.status = queued.status || 'queued'
			if (task.cancelRequested) await cancelTask(task)
			else {
				renderQueue()
				ensureMonitor()
			}
		} catch (error) {
			task.status = 'failed'
			task.error = error.message || 'Unable to queue the search.'
			renderQueue()
			setStatus(task.error, true)
		}
	}

	const createTask = ({ query, sort, limit, offset = 0, append = false, parentId = null }) => ({
		id: `local-${Date.now()}-${++sequence}`,
		query,
		sort,
		limit,
		offset,
		append,
		parentId,
		status: 'submitting',
		position: 0,
		cached: false,
		createdAt: Date.now(),
		response: null,
		error: null,
		hasMore: false,
	})

	const queueSearch = ({ random = false } = {}) => {
		const query = random ? 'random' : elements.query.value.trim()
		const sort = random ? 'random' : elements.sort.value
		if (!query && sort !== 'random') {
			elements.query.focus()
			setStatus('Enter something to search for.', true)
			return
		}

		const task = createTask({ query, sort, limit: Number(elements.limit.value) })
		tasks.unshift(task)
		preferredTaskId = task.id
		renderQueue()
		setStatus(`${sort === 'random' ? 'Random search' : `“${query}”`} added to the queue. Current results remain available.`)
		void submitTask(task)
	}

	const queueMore = () => {
		const parent = getActiveTask()
		if (!parent?.response || parent.sort === 'random' || !parent.hasMore) return
		if (tasks.some((task) => task.parentId === parent.id && ACTIVE_STATUSES.has(task.status))) return
		const task = createTask({
			query: parent.query,
			sort: parent.sort,
			limit: parent.limit,
			offset: parent.response.results.length,
			append: true,
			parentId: parent.id,
		})
		tasks.unshift(task)
		renderQueue()
		renderResults()
		setStatus(`The next page for “${parent.query}” was added to the queue.`)
		void submitTask(task)
	}

	const renderResults = () => {
		const task = getActiveTask()
		const results = getResults()
		elements.results.replaceChildren()
		elements.empty.hidden = results.length > 0
		elements.resultsHeading.textContent = task ? (task.sort === 'random' ? 'Random picks' : task.query) : 'Your library'
		elements.resultCount.textContent = results.length ? `${results.length.toLocaleString()} shown` : ''

		for (let index = 0; index < results.length; index += 1) {
			const item = results[index]
			const listItem = document.createElement('li')
			const button = document.createElement('button')
			button.type = 'button'
			button.className = `result-card${index === selectedIndex ? ' selected' : ''}`
			button.dataset.index = String(index)
			button.setAttribute('aria-label', `${item.title}, by ${item.uploader}`)

			const number = document.createElement('span')
			number.className = 'result-number'
			number.textContent = String(item.index)
			const copy = document.createElement('span')
			const title = document.createElement('strong')
			title.className = 'result-title'
			title.textContent = item.title
			const metadata = document.createElement('span')
			metadata.className = 'result-meta'
			const uploader = document.createElement('span')
			uploader.textContent = item.uploader
			const duration = document.createElement('span')
			duration.textContent = item.duration
			const availability = document.createElement('span')
			const playableUrl = item.fileUrl || item.streamUrl || item.stream
			const mediaAvailable = item.mediaAvailable === undefined ? Boolean(playableUrl) : item.mediaAvailable
			availability.className = mediaAvailable ? '' : 'missing'
			availability.textContent = mediaAvailable ? 'Ready to play' : 'Media may still be downloading'
			metadata.append(uploader, duration, availability)
			copy.append(title, metadata)
			const score = document.createElement('span')
			score.className = 'result-score'
			score.textContent = item.similarity
			button.append(number, copy, score)
			button.addEventListener('click', () => selectResult(index, false))
			button.addEventListener('dblclick', () => playResult(index))
			listItem.append(button)
			elements.results.append(listItem)
		}

		const appending = task && tasks.some((candidate) => candidate.parentId === task.id && ACTIVE_STATUSES.has(candidate.status))
		elements.loadMore.hidden = !task || task.sort === 'random' || !task.hasMore
		elements.loadMore.disabled = Boolean(appending)
		elements.loadMore.textContent = appending ? 'Next page queued…' : 'Load more'
	}

	const selectResult = (index, scroll = true) => {
		const results = getResults()
		if (index < 0 || index >= results.length) return
		selectedIndex = index
		document.querySelectorAll('.result-card').forEach((card, cardIndex) => card.classList.toggle('selected', cardIndex === index))
		const selected = document.querySelector(`.result-card[data-index="${index}"]`)
		if (scroll) selected?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
	}

	const playResult = (index = selectedIndex) => {
		const item = getResults()[index]
		if (!item) return
		const playableUrl = item.fileUrl || item.streamUrl || item.stream
		const sidecarUrl = item.sidecarUrl || item.infoJsonUrl || item.metadataUrl
		selectResult(index)
		elements.playingTitle.textContent = item.title
		elements.playingMeta.textContent = `${item.uploader} · ${item.duration} · ${item.similarity} relevance`
		elements.openSidecar.href = sidecarUrl || '#'
		elements.openSidecar.hidden = !sidecarUrl
		if (!playableUrl) {
			setStatus('The sidecar matched, but no media endpoint was available.', true)
			elements.openFile.hidden = true
			return
		}
		if (item.mediaAvailable === false) {
			setStatus('The sidecar is indexed, but yt-dlp may still be writing the media file. Selecting it again later retries the same resolver URL.')
		}
		elements.player.src = playableUrl
		elements.player.load()
		elements.playerPlaceholder.hidden = true
		elements.openFile.href = playableUrl
		elements.openFile.hidden = false
		elements.player.play().catch(() => undefined)
	}

	const updateHealth = async () => {
		try {
			const health = await requestJson('/health')
			const state = health.index.state
			elements.health.classList.toggle('ready', state === 'ready')
			elements.health.classList.toggle('error', state === 'error')
			if (state === 'ready') {
				const count = health.index.stats?.indexedVideos?.toLocaleString() || 0
				const auto = health.autoIndex?.enabled && health.autoIndex?.started
				const pending = (health.autoIndex?.pendingPaths || 0) + (health.autoIndex?.fullScanPending ? 1 : 0)
				elements.healthText.textContent = `${count} videos ready${auto ? ` · live updates on${pending ? ` · ${pending} pending` : ''}` : ''}`
			}
			else if (state === 'loading') {
				elements.healthText.textContent = `Indexing ${health.index.progress.processedFiles.toLocaleString()} / ${health.index.progress.sidecarFilesFound.toLocaleString()} discovered`
			} else if (state === 'error') elements.healthText.textContent = health.index.lastError || 'Index error'
			else elements.healthText.textContent = 'Index not started'
		} catch {
			elements.health.classList.remove('ready')
			elements.health.classList.add('error')
			elements.healthText.textContent = 'Server unavailable'
		}
	}

	elements.form.addEventListener('submit', (event) => {
		event.preventDefault()
		queueSearch()
	})
	elements.random.addEventListener('click', () => queueSearch({ random: true }))
	elements.loadMore.addEventListener('click', queueMore)
	elements.queueClear.addEventListener('click', () => {
		tasks = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status) || task.id === activeTaskId)
		renderQueue()
	})
	elements.refresh.addEventListener('click', async () => {
		elements.refresh.disabled = true
		try {
			await requestJson('/index/refresh', { method: 'POST' })
			setStatus('Full index compaction started. Automatic live updates remain enabled.')
			void updateHealth()
		} catch (error) {
			setStatus(error.message || 'Unable to refresh the index.', true)
		} finally {
			elements.refresh.disabled = false
		}
	})

	document.addEventListener('keydown', (event) => {
		const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
		if (event.key === '/' && !typing) {
			event.preventDefault()
			elements.query.focus()
			return
		}
		if (event.key === 'Escape') {
			elements.player.pause()
			setStatus('Playback stopped. Queued searches are still running.')
			return
		}
		if (typing) return
		if (event.key === 'ArrowDown' || event.key.toLowerCase() === 'j') {
			event.preventDefault()
			selectResult(Math.min(getResults().length - 1, selectedIndex + 1))
		} else if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'k') {
			event.preventDefault()
			selectResult(Math.max(0, selectedIndex - 1))
		} else if (event.key === 'Enter') {
			event.preventDefault()
			playResult()
		}
	})

	let initialQuery = ''
	try {
		initialQuery = decodeURIComponent(location.hash.replace(/^#/, ''))
	} catch {
		initialQuery = location.hash.replace(/^#/, '')
	}
	if (initialQuery) {
		elements.query.value = initialQuery
		queueSearch()
	}
	renderQueue()
	renderResults()
	void updateHealth()
	setInterval(updateHealth, 3_000)
})()
