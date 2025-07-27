import path from 'path'
import os from 'os'
import { mkdirp } from 'mkdirp'
import cp from 'child_process'
import fs from 'fs'
import util from 'util'
import moment from 'moment'
import { MediaDocument, PouchDBMediaDocument } from './db'
import { getId } from './util'

const statAsync = util.promisify(fs.stat)
const unlinkAsync = util.promisify(fs.unlink)
const readFileAsync = util.promisify(fs.readFile)

export async function generateThumb(config: Record<string, any>, doc: PouchDBMediaDocument): Promise<void> {
	const tmpPath = path.join(os.tmpdir(), Math.random().toString(16)) + '.png'

	const args = [
		// TODO (perf) Low priority process?
		config.paths.ffmpeg,
		'-hide_banner',
		'-i',
		`"${doc.mediaPath}"`,
		'-vf select=gt\\(scene,0.4\\)',
		`-vf scale=${config.thumbnails.width}:${config.thumbnails.height}`,
		'-frames:v 1',
		'-threads 1',
		tmpPath,
	]

	await mkdirp(path.dirname(tmpPath))
	await new Promise<void>((resolve, reject) => {
		cp.exec(args.join(' '), (err) => (err ? reject(err) : resolve()))
	})

	const thumbStat = await statAsync(tmpPath)
	doc.thumbSize = thumbStat.size
	doc.thumbTime = thumbStat.mtime.getTime()
	doc.tinf =
		[
			`"${getId(config.paths.media, doc.mediaPath)}"`,
			moment(doc.thumbTime).format('YYYYMMDDTHHmmss'),
			// TODO (fix) Binary or base64 size?
			doc.thumbSize,
		].join(' ') + '\r\n'

	doc._attachments = {
		'thumb.png': {
			content_type: 'image/png',
			data: await readFileAsync(tmpPath),
		},
	}
	await unlinkAsync(tmpPath)
}

export async function generateInfo(config: Record<string, any>, doc: PouchDBMediaDocument): Promise<void> {
	const json = await new Promise((resolve, reject) => {
		const args = [
			// TODO (perf) Low priority process?
			config.paths.ffprobe,
			'-hide_banner',
			'-i',
			`"${doc.mediaPath}"`,
			'-show_streams',
			'-show_format',
			'-print_format',
			'json',
		]
		cp.exec(args.join(' '), (err, stdout) => {
			if (err) {
				return reject(err)
			}

			const json = JSON.parse(stdout)
			if (!json.streams || !json.streams[0]) {
				return reject(new Error('not media'))
			}

			resolve(json)
		})
	})

	doc.cinf = generateCinf(config, doc, json)

	if (config.metadata !== null) {
		doc.mediainfo = await generateMediainfo(config, doc, json)
		// Add audio loudness analysis for audio streams
		await analyzeAudioLoudness(config, doc, json)
	}
}

async function analyzeAudioLoudness(config: Record<string, any>, doc: PouchDBMediaDocument, json: any) {
	const audioStreams = json.streams.filter((s: any) => s.codec_type === 'audio')

	if (audioStreams.length === 0) {
		console.log(`No audio streams found for ${doc._id}`)
		return
	}

	console.log(`Found ${audioStreams.length} audio stream(s) for ${doc._id}`)

	// Analyze loudness for each audio stream
	for (let audioStreamIndex = 0; audioStreamIndex < audioStreams.length; audioStreamIndex++) {
		const stream = audioStreams[audioStreamIndex]
		console.log(`Analyzing loudness for stream ${audioStreamIndex} of ${doc._id} (${stream.channels} channels)`)

		// Use the audio stream index (0-based within audio streams only)
		const loudnessData = await analyzeStreamLoudnessPerChannel(
			config,
			doc.mediaPath,
			audioStreamIndex,
			stream.channels,
			json.format.duration
		)

		if (loudnessData) {
			console.log(`Loudness data obtained for stream ${audioStreamIndex} of ${doc._id}`)
			// Add loudness data to the stream in mediainfo
			if (!doc.mediainfo) {
				doc.mediainfo = {}
			}
			if (!doc.mediainfo.streams) {
				doc.mediainfo.streams = []
			}

			// Find the corresponding stream in mediainfo by index
			// Get all audio streams from mediainfo
			const mediainfoAudioStreams = doc.mediainfo.streams.filter((s: any) => s.codec?.type === 'audio')

			if (mediainfoAudioStreams[audioStreamIndex]) {
				mediainfoAudioStreams[audioStreamIndex].loudness = loudnessData
				console.log(`Loudness data added to mediainfo stream ${audioStreamIndex} for ${doc._id}`)
			} else {
				console.log(`Could not find audio stream ${audioStreamIndex} in mediainfo for ${doc._id}`)
			}
		} else {
			console.log(`No loudness data obtained for stream ${audioStreamIndex} of ${doc._id}`)
		}
	}
}

async function analyzeStreamLoudnessPerChannel(
	config: Record<string, any>,
	mediaPath: string,
	streamIndex: number,
	channelCount: number,
	duration: number
) {
	try {
		const loudnessData: any = {}

		// Analyze each channel individually as mono
		for (let channel = 0; channel < channelCount; channel++) {
			console.log(`Analyzing channel ${channel} of ${channelCount}`)

			// For faster analysis, analyze just a portion of the audio
			// This is especially useful for long files where we want quick measurements
			const analysisDuration = Math.min(10, duration) // Analyze max 10 seconds for speed
			const startTime = 0 // Start from beginning to catch any audio content

			// Use ebur128 for professional broadcast loudness measurement
			// framelog=quiet gives us just the summary output
			const filterChain = `"pan=mono|c0=c${channel},ebur128=peak=true:dualmono=false:framelog=quiet"`

			const args = [
				config.paths.ffmpeg,
				'-hide_banner',
				'-ss',
				startTime.toString(),
				'-t',
				analysisDuration.toString(),
				'-i',
				`"${mediaPath}"`,
				'-map',
				`0:a:${streamIndex}`,
				'-af',
				filterChain,
				'-f',
				'null',
				'-',
			]

			console.log(`Running FFmpeg command for channel ${channel}: ${args.join(' ')}`)

			const result = await new Promise<string>((resolve, reject) => {
				const child = cp.exec(args.join(' '), { timeout: 300000 }, (err, stdout, stderr) => {
					if (err) {
						// FFmpeg returns error code when using loudnorm filter, but stderr contains the data
						if (err.signal === 'SIGTERM') {
							reject(new Error('FFmpeg loudness analysis timed out'))
						} else {
							console.log(`FFmpeg error for channel ${channel}: ${err.message}`)
							console.log(`FFmpeg stderr: ${stderr}`)
							console.log(`FFmpeg stdout: ${stdout}`)
							resolve(stderr)
						}
					} else {
						console.log(`FFmpeg completed successfully for channel ${channel}`)
						console.log(`FFmpeg stderr: ${stderr}`)
						console.log(`FFmpeg stdout: ${stdout}`)
						// Use stderr for loudness data as that's where FFmpeg outputs it
						resolve(stderr)
					}
				})

				// Add a timeout handler
				setTimeout(() => {
					child.kill()
					reject(new Error('FFmpeg loudness analysis timed out'))
				}, 300000) // 5 minutes timeout
			})

			// Parse the loudness data from FFmpeg output
			console.log(`FFmpeg output length for channel ${channel}: ${result.length}`)
			console.log(`FFmpeg output preview for channel ${channel}: ${result.substring(0, 200)}...`)

			// Parse EBU R128 loudness measurements from the output
			const lines = result.split('\n')
			let integratedLoudness = null
			let loudnessRange = null
			let truePeak = null

			// Look for EBU R128 summary measurements in the output
			// The actual format from FFmpeg output shows:
			// [Parsed_ebur128_1 @ 000001fcc6cb5fc0] Summary:
			//   Integrated loudness:
			//     I:         -70.0 LUFS
			//     Threshold:   0.0 LUFS
			//   Loudness range:
			//     LRA:         0.0 LU
			//     Threshold:   0.0 LUFS
			//     LRA low:     0.0 LUFS
			//     LRA high:    0.0 LUFS
			//   True peak:
			//     Peak:       -inf dBFS

			// Parse the actual format from the logs
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]

				// Look for the I: line (Integrated loudness)
				const integratedMatch = line.match(/I:\s*([-\d.]+)\s+LUFS/)
				if (integratedMatch) {
					integratedLoudness = parseFloat(integratedMatch[1])
				}

				// Look for the LRA: line (Loudness range)
				const lraMatch = line.match(/LRA:\s*([-\d.]+)\s+LU/)
				if (lraMatch) {
					loudnessRange = parseFloat(lraMatch[1])
				}

				// Look for the Peak: line (True peak)
				const peakMatch = line.match(/Peak:\s*([-\d.]+)\s+dBFS/)
				if (peakMatch) {
					truePeak = parseFloat(peakMatch[1])
				}
			}

			// If we found any EBU R128 loudness data, store it
			if (integratedLoudness !== null || loudnessRange !== null || truePeak !== null) {
				console.log(
					`Found EBU R128 summary data for channel ${channel}: I=${integratedLoudness}, LRA=${loudnessRange}, TP=${truePeak}`
				)
				try {
					loudnessData[`channel_${channel}`] = {
						integrated: integratedLoudness, // I: Integrated loudness (entire program)
						lra: loudnessRange, // LRA: Loudness Range
						true_peak: truePeak, // True peak level
						measurement_standard: 'EBU R128',
					}
					console.log(`Successfully parsed EBU R128 summary data for channel ${channel}`)
				} catch (parseError) {
					console.warn(`Failed to parse EBU R128 data for channel ${channel}:`, parseError)
				}
			} else {
				console.log(`No EBU R128 summary data found in FFmpeg output for channel ${channel}`)
				// Log a sample of the output to help debug
				const relevantLines = lines.filter(
					(line) =>
						line.includes('ebur128') || line.includes('Summary:') || line.includes('I:') || line.includes('LRA:')
				)
				if (relevantLines.length > 0) {
					console.log(`Relevant EBU R128 lines found:`, relevantLines)
				}
			}
		}

		// Return null if no channels were successfully analyzed
		return Object.keys(loudnessData).length > 0 ? loudnessData : null
	} catch (error) {
		console.warn('Failed to analyze audio loudness per channel:', error)
		return null
	}
}

type Timebase = [number, number]

function generateCinf(config: Record<string, any>, doc: MediaDocument, json: any) {
	const dur = parseFloat(json.format.duration) || 1 / 24
	const stillLimit = 0.1

	let audioTb: Timebase | null = null
	let videoTb: Timebase | null = null
	let stillTb: Timebase | null = null
	let audioDur = 0

	for (const stream of json.streams) {
		if (stream.codec_type === 'audio') {
			if (!audioTb) {
				audioTb = (stream.time_base || '1/25').split('/')
				audioDur = parseFloat(stream.duration)
			}
		} else if (stream.codec_type === 'video') {
			// Sometimes the stream has no duration, so fallback to using the file duration
			const streamDuration = Number(stream.duration || json.format.duration) || 0

			if (streamDuration < stillLimit || stream.codec_name == 'gif' || stream.disposition.attached_pic === 1) {
				if (!stillTb) stillTb = [0, 1]
			} else {
				if (!videoTb) {
					const fr = String(stream.avg_frame_rate || stream.r_frame_rate || '').split('/')
					if (fr.length === 2) {
						videoTb = [Number(fr[1]), Number(fr[0])]
					} else {
						videoTb = (stream.time_base || '1/25').split('/')
					}
				}
			}
		}
	}

	let type: string
	let tb: Timebase
	if (videoTb) {
		type = ' MOVIE '
		tb = videoTb
	} else if ((stillTb && !audioTb) || (stillTb && audioTb && audioDur < stillLimit)) {
		type = ' STILL '
		tb = stillTb
	} else {
		type = ' AUDIO '
		tb = audioTb ?? [0, 1]
	}

	return (
		[
			`"${getId(config.paths.media, doc.mediaPath)}"`,
			type,
			doc.mediaSize,
			moment(doc.mediaTime).format('YYYYMMDDHHmmss'),
			tb[0] === 0 ? 0 : Math.floor((dur * tb[1]) / tb[0]),
			`${tb[0]}/${tb[1]}`,
		].join(' ') + '\r\n'
	)
}

async function generateMediainfo(config: Record<string, any>, doc: PouchDBMediaDocument, json: any) {
	const fieldOrder = await new Promise((resolve, reject) => {
		if (!config.metadata.fieldOrder) {
			return resolve('unknown')
		}

		const args = [
			// TODO (perf) Low priority process?
			config.paths.ffmpeg,
			'-hide_banner',
			'-filter:v',
			'idet',
			'-frames:v',
			config.metadata.fieldOrderScanDuration,
			'-an',
			'-f',
			'rawvideo',
			'-y',
			process.platform === 'win32' ? 'NUL' : '/dev/null',
			'-i',
			`"${doc.mediaPath}"`,
		]
		cp.exec(args.join(' '), (err, _stdout, stderr) => {
			if (err) {
				return reject(err)
			}

			const resultRegex = /Multi frame detection: TFF:\s+(\d+)\s+BFF:\s+(\d+)\s+Progressive:\s+(\d+)/
			const res = resultRegex.exec(stderr)
			if (res === null) {
				return resolve('unknown')
			}

			const tff = parseInt(res[1])
			const bff = parseInt(res[2])
			const fieldOrder = tff <= 10 && bff <= 10 ? 'progressive' : tff > bff ? 'tff' : 'bff'

			resolve(fieldOrder)
		})
	})

	return {
		name: doc._id,
		path: doc.mediaPath,
		size: doc.mediaSize,
		time: doc.mediaTime,
		field_order: fieldOrder,

		streams: json.streams.map((s: any) => ({
			codec: {
				long_name: s.codec_long_name,
				type: s.codec_type,
				time_base: s.codec_time_base,
				tag_string: s.codec_tag_string,
				is_avc: s.is_avc,
			},

			// Video
			width: s.width,
			height: s.height,
			sample_aspect_ratio: s.sample_aspect_ratio,
			display_aspect_ratio: s.display_aspect_ratio,
			pix_fmt: s.pix_fmt,
			bits_per_raw_sample: s.bits_per_raw_sample,

			// Audio
			sample_fmt: s.sample_fmt,
			sample_rate: s.sample_rate,
			channels: s.channels,
			channel_layout: s.channel_layout,
			bits_per_sample: s.bits_per_sample,

			// Common
			time_base: s.time_base,
			start_time: s.start_time,
			duration_ts: s.duration_ts,
			duration: s.duration,

			bit_rate: s.bit_rate,
			max_bit_rate: s.max_bit_rate,
			nb_frames: s.nb_frames,
		})),
		format: {
			name: json.format.format_name,
			long_name: json.format.format_long_name,
			size: json.format.time,

			start_time: json.format.start_time,
			duration: json.format.duration,
			bit_rate: json.format.bit_rate,
			max_bit_rate: json.format.max_bit_rate,
		},
	}
}
