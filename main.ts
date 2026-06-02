import { startGateway, GATEWAY_VERSION } from './gateway'
import { loadLineConfig } from './env'

// Default 3456 matches what LINE webhook URL (in the LINE Developers
// console) is configured to send to — cutover from claude-line-channel is
// done, legacy plugin no longer binds this port. Override via
// LINE_GATEWAY_PORT for dev work so a local gateway doesn't steal LINE
// traffic from a running production gateway.
const PORT = parseInt(process.env.LINE_GATEWAY_PORT ?? '3456', 10)

const lineConfig = loadLineConfig()

const handle = startGateway({ port: PORT, lineConfig })

process.stderr.write(`line-gateway ${GATEWAY_VERSION}: listening on http://127.0.0.1:${PORT}\n`)
process.stderr.write(`line-gateway:   LINE credentials ${lineConfig.configured ? 'loaded' : 'MISSING — /webhook returns 503'}\n`)
process.stderr.write(`line-gateway:   state dir: ${lineConfig.stateDir}\n`)
process.stderr.write(`line-gateway:   /ws       WebSocket for session plugins\n`)
process.stderr.write(`line-gateway:   /webhook  LINE webhook inbound\n`)
process.stderr.write(`line-gateway:   /healthz  liveness probe\n`)

const shutdown = async (): Promise<void> => {
  process.stderr.write('line-gateway: shutting down\n')
  await handle.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
