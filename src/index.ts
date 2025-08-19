import pino from 'pino'
import { config } from './config'
import PouchDB from 'pouchdb-node'
import scanner from './scanner'
import app from './app'
import { MediaDatabase, MediaDocument } from './db'

// Add error handling for config loading
try {
	console.log('🚀 Media Scanner starting with config:', {
		casparConfigPath: config.caspar?.config,
		httpPort: config.http?.port,
		httpHost: config.http?.host
	})
} catch (error) {
	console.error('❌ Failed to load config:', error)
	process.exit(1)
}

const logger = pino(
	Object.assign({}, config.logger, {
		serializers: {
			err: pino.stdSerializers.err,
		},
	})
)

const db: MediaDatabase = new PouchDB<MediaDocument>(`_media`)

logger.info(config)

try {
	scanner(logger, db, config)
	app(logger, db, config).listen(config.http.port, config.http.host)
	console.log(`✅ Media Scanner started successfully on ${config.http.host}:${config.http.port}`)
} catch (error) {
	console.error('❌ Failed to start Media Scanner:', error)
	process.exit(1)
}
