import { Context, Logger } from 'koishi'
import { Config } from './index'
import { WebSocket } from 'ws'
import { DisasterEvent, DataSource, DisasterType } from './models'
import { FanStudioHandler, P2PHandler, WolfxHandler, GlobalQuakeHandler } from './handlers'
import { MessagePushManager } from './pusher'

const logger = new Logger('disaster-warning')

export class DisasterWarningService {
    private config: Config
    private connections: Record<string, WebSocket> = {}
    private reconnectTimers: Record<string, NodeJS.Timeout> = {}
    private pusher: MessagePushManager
    private ctx: Context
    private stopped: boolean = false  // Flag to prevent reconnection after stop

    private handlers: {
        fanStudio: FanStudioHandler,
        p2p: P2PHandler,
        globalQuake: GlobalQuakeHandler
    }

    private wolfxHandlers: Record<string, WolfxHandler> = {}

    constructor(ctx: Context, config: Config) {
        this.ctx = ctx
        this.config = config
        this.pusher = new MessagePushManager(ctx, config)
        this.handlers = {
            fanStudio: new FanStudioHandler(),
            p2p: new P2PHandler(),
            globalQuake: new GlobalQuakeHandler()
        }

        // Initialize Wolfx handlers
        const wolfxKeys = ['jma_eew', 'cenc_eew', 'cwa_eew', 'jma_eqlist', 'cenc_eqlist']
        for (const key of wolfxKeys) {
            this.wolfxHandlers[key] = new WolfxHandler(`wolfx_${key}`)
        }
    }

    async start() {
        if (!this.config.enabled) return
        this.stopped = false  // Reset stopped flag on start
        logger.info('Disaster Warning Service starting...')
        this.connectBasedOnConfig()
    }

    async stop() {
        logger.info('Disaster Warning Service stopping...')
        this.stopped = true  // Set stopped flag to prevent reconnection

        // Clear all reconnect timers first
        for (const key in this.reconnectTimers) {
            clearTimeout(this.reconnectTimers[key])
            delete this.reconnectTimers[key]
        }

        // Close all connections
        for (const key in this.connections) {
            const ws = this.connections[key]
            // Remove listeners to prevent reconnection attempts
            ws.removeAllListeners('close')
            ws.close()
            delete this.connections[key]
        }

        logger.info('Disaster Warning Service stopped.')
    }

    private connectBasedOnConfig() {
        const { regions, data_types, source_priority } = this.config

        // Determine which connections to make based on regions and source priority
        const needsJapan = regions.japan
        const needsChina = regions.china
        const needsTaiwan = regions.taiwan
        const needsGlobal = regions.global

        // Connect to appropriate sources based on priority
        if (source_priority === 'auto' || source_priority === 'wolfx') {
            // Wolfx is best for real-time EEW
            if (needsJapan && data_types.earthquake_warning) {
                this.connectWolfxSource('jma_eew', 'wss://ws-api.wolfx.jp/jma_eew')
            }
            if (needsChina && data_types.earthquake_warning) {
                this.connectWolfxSource('cenc_eew', 'wss://ws-api.wolfx.jp/cenc_eew')
            }
            if (needsTaiwan && data_types.earthquake_warning) {
                this.connectWolfxSource('cwa_eew', 'wss://ws-api.wolfx.jp/cwa_eew')
            }
            if (needsJapan && data_types.earthquake_info) {
                this.connectWolfxSource('jma_eqlist', 'wss://ws-api.wolfx.jp/jma_eqlist')
            }
            if (needsChina && data_types.earthquake_info) {
                this.connectWolfxSource('cenc_eqlist', 'wss://ws-api.wolfx.jp/cenc_eqlist')
            }
        }

        if (source_priority === 'auto' || source_priority === 'p2p') {
            // P2P is good for Japan data including tsunami
            if (needsJapan) {
                if (data_types.earthquake_warning || data_types.earthquake_info || data_types.tsunami_warning) {
                    this.connectP2P()
                }
            }
        }

        if (source_priority === 'auto' || source_priority === 'fanstudio') {
            // FAN Studio has Chinese weather and tsunami
            const needsFanStudio =
                (needsChina && data_types.weather_alarm) ||
                (needsChina && data_types.tsunami_warning) ||
                (needsGlobal && data_types.earthquake_info) // USGS via FanStudio

            if (needsFanStudio) {
                this.connectFanStudio()
            }
        }

        // Global Quake for global coverage
        if (needsGlobal && data_types.earthquake_warning) {
            this.connectGlobalQuake()
        }
    }

    private connectWebSocket(name: string, url: string, onMessage: (data: any) => void) {
        // Don't connect if service is stopped
        if (this.stopped) return

        if (this.connections[name]) {
            this.connections[name].removeAllListeners('close')
            this.connections[name].close()
        }

        logger.info(`Connecting to ${name} at ${url}...`)
        const ws = new WebSocket(url)

        ws.on('open', () => {
            logger.info(`Connected to ${name}`)
        })

        ws.on('message', (data) => {
            try {
                const parsed = JSON.parse(data.toString())
                onMessage(parsed)
            } catch (e) {
                logger.warn(`Failed to parse message from ${name}:`, e)
            }
        })

        ws.on('close', () => {
            // Only reconnect if service is not stopped
            if (!this.stopped) {
                logger.warn(`Disconnected from ${name}, reconnecting in 10s...`)
                delete this.connections[name]
                this.reconnectTimers[name] = setTimeout(() => {
                    this.connectWebSocket(name, url, onMessage)
                }, 10000)
            }
        })

        ws.on('error', (err) => {
            logger.error(`Error in ${name} connection:`, err)
        })

        this.connections[name] = ws
    }

    private async handleEvent(event: DisasterEvent | null) {
        if (!event) return
        if (!this.shouldPushEvent(event)) return
        await this.pusher.pushEvent(event)
    }

    private shouldPushEvent(event: DisasterEvent): boolean {
        const { data_types, regions } = this.config

        // Check disaster type
        const isEarthquakeWarning = event.disaster_type === DisasterType.EARTHQUAKE_WARNING
        const isEarthquakeInfo = event.disaster_type === DisasterType.EARTHQUAKE
        const isTsunami = event.disaster_type === DisasterType.TSUNAMI
        const isWeather = event.disaster_type === DisasterType.WEATHER_ALARM

        if (isEarthquakeWarning && !data_types.earthquake_warning) return false
        if (isEarthquakeInfo && !data_types.earthquake_info) return false
        if (isTsunami && !data_types.tsunami_warning) return false
        if (isWeather && !data_types.weather_alarm) return false

        // Check region based on data source
        const source = event.source
        const isJapanSource = [
            DataSource.P2P_EEW, DataSource.P2P_EARTHQUAKE, DataSource.P2P_TSUNAMI,
            DataSource.WOLFX_JMA_EEW, DataSource.WOLFX_JMA_EQ, DataSource.FAN_STUDIO_JMA
        ].includes(source)

        const isChinaSource = [
            DataSource.FAN_STUDIO_CEA, DataSource.FAN_STUDIO_CENC, DataSource.FAN_STUDIO_WEATHER,
            DataSource.FAN_STUDIO_TSUNAMI, DataSource.WOLFX_CENC_EEW, DataSource.WOLFX_CENC_EQ
        ].includes(source)

        const isTaiwanSource = [
            DataSource.FAN_STUDIO_CWA, DataSource.WOLFX_CWA_EEW
        ].includes(source)

        const isGlobalSource = [
            DataSource.FAN_STUDIO_USGS, DataSource.GLOBAL_QUAKE
        ].includes(source)

        if (isJapanSource && !regions.japan) return false
        if (isChinaSource && !regions.china) return false
        if (isTaiwanSource && !regions.taiwan) return false
        if (isGlobalSource && !regions.global) return false

        return true
    }

    private connectFanStudio() {
        const url = "wss://ws.fanstudio.tech/all"
        this.connectWebSocket('fan_studio', url, (data) => {
            const event = this.handlers.fanStudio.parseMessage(data)
            this.handleEvent(event)
        })
    }

    private connectP2P() {
        const url = "wss://api.p2pquake.net/v2/ws"
        this.connectWebSocket('p2p', url, (data) => {
            const event = this.handlers.p2p.parseMessage(data)
            this.handleEvent(event)
        })
    }

    private connectWolfxSource(key: string, url: string) {
        const handler = this.wolfxHandlers[key]
        this.connectWebSocket(`wolfx_${key}`, url, (data) => {
            const event = handler.parseMessage(data)
            this.handleEvent(event)
        })
    }

    private connectGlobalQuake() {
        const url = "wss://gqm.aloys233.top/ws"
        this.connectWebSocket('global_quake', url, (data) => {
            const event = this.handlers.globalQuake.parseMessage(data)
            this.handleEvent(event)
        })
    }
}
