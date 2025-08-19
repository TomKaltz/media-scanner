import nconf from 'nconf'
import fs from 'fs'
import xml2js from 'xml2js'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json')

const defaults = {
	caspar: {
		config: process.env.CASPARCG_CONFIG_PATH || './casparcg.config',
	},
	paths: {
		template: './template',
		media: './media',
		font: './font',
		ffmpeg: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
		ffprobe: process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
	},
	scanner: {
		paths: null,
		// Note: See https://www.npmjs.com/package/chokidar#api.
	},
	thumbnails: {
		width: 256,
		height: -1,
	},
	metadata: {
		fieldOrder: false, // This is an expensive check, as it requires decoding the beginning of the video
		fieldOrderScanDuration: 200, // Frames. Note: Needs sufficient motion (Not titlecard)
	},
	isProduction: process.env.NODE_ENV === 'production',
	logger: {
		level: process.env.NODE_ENV === 'production' ? 'info' : 'trace',
		name: pkg.name,
		print: process.env.NODE_ENV !== 'production',
	},
	http: {
		port: 8000,
		host: '0.0.0.0',
	},
}

export const config = nconf.argv().env('__').defaults(defaults).get()

// Log the final config for debugging
console.log('🔧 Media Scanner Config:', {
	casparConfigPath: config.caspar.config,
	ffmpegPath: config.paths.ffmpeg,
	ffprobePath: config.paths.ffprobe,
	mediaPath: config.paths.media,
	templatePath: config.paths.template,
	httpPort: config.http.port,
	httpHost: config.http.host
})

if (config.caspar && config.caspar.config) {
	try {
		// Check if the config file exists and is actually a file (not a directory)
		const configPath = config.caspar.config
		console.log(`🔍 Checking CasparCG config path: ${configPath}`)
		
		// First check if the path exists
		if (!fs.existsSync(configPath)) {
			console.warn(`⚠️  CasparCG config file does not exist: ${configPath}`)
			console.warn('⚠️  Skipping CasparCG config parsing, using default paths')
		} else {
			const stats = fs.statSync(configPath)
			console.log(`📁 Path stats: isFile=${stats.isFile()}, isDirectory=${stats.isDirectory()}, size=${stats.size}`)
			
			if (!stats.isFile()) {
				console.warn(`⚠️  CasparCG config path is not a file: ${configPath}`)
				console.warn('⚠️  Skipping CasparCG config parsing, using default paths')
			} else {
				console.log(`📖 Reading CasparCG config file: ${configPath}`)
				const parser = new xml2js.Parser()
				const data = fs.readFileSync(configPath)
				console.log(`📄 Config file content length: ${data.length} bytes`)
				
				parser.parseString(data, (err, result) => {
					if (err) {
						console.warn(`⚠️  Failed to parse CasparCG config: ${err.message}`)
						console.warn('⚠️  Using default paths')
						return
					}
					
					try {
						if (result.configuration && result.configuration.paths && result.configuration.paths[0]) {
							for (const path in result.configuration.paths[0]) {
								config.paths[path.split('-')[0]] = result.configuration.paths[0][path][0]
							}
							console.log('✅ Successfully loaded CasparCG config paths')
						}
					} catch (parseError) {
						console.warn(`⚠️  Error processing CasparCG config paths: ${parseError}`)
						console.warn('⚠️  Using default paths')
					}
				})
			}
		}
	} catch (error) {
		console.warn(`⚠️  Could not read CasparCG config from ${config.caspar.config}: ${error}`)
		console.warn('⚠️  Using default paths')
	}
}

if (!config.scanner.path) {
	config.scanner.paths = config.paths.media
}
