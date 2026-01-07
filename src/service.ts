import { Context, Logger } from 'koishi'
import { Config } from './index'
import { WebSocket } from 'ws'
import { DisasterEvent } from './models'
import { FanStudioHandler, P2PHandler, WolfxHandler, GlobalQuakeHandler } from './handlers'
import { MessagePushManager } from './pusher'

const logger = new Logger('disaster-warning')

export class DisasterWarningService {
    private config: Config
    private connections: Record<string, WebSocket> = {}
    private reconnectTimers: Record<string, NodeJS.Timeout> = {}
    private pusher: MessagePushManager
    private ctx: Context

    private handlers: {
        fanStudio: FanStudioHandler,
        p2p: P2PHandler,
        wolfx: WolfxHandler,
        globalQuake: GlobalQuakeHandler
    }

    constructor(ctx: Context, config: Config) {
        this.ctx = ctx
        this.config = config
        this.pusher = new MessagePushManager(ctx, config)
        this.handlers = {
            fanStudio: new FanStudioHandler(),
            p2p: new P2PHandler(),
            wolfx: new WolfxHandler('wolfx'),
            globalQuake: new GlobalQuakeHandler()
        }
    }

    async start() {
        if (!this.config.enabled) return
        logger.info('Disaster Warning Service starting...')
        this.connectAll()
    }

    async stop() {
        logger.info('Disaster Warning Service stopping...')
        for (const key in this.connections) {
            this.connections[key].close()
        }
        for (const key in this.reconnectTimers) {
            clearTimeout(this.reconnectTimers[key])
        }
    }

    private connectAll() {
        if (this.config.data_sources.fan_studio.enabled) {
            this.connectFanStudio()
        }
        if (this.config.data_sources.p2p_earthquake.enabled) {
            this.connectP2P()
        }
        if (this.config.data_sources.wolfx.enabled) {
            this.connectWolfx()
        }
        if (this.config.data_sources.global_quake.enabled) {
            this.connectGlobalQuake()
        }
    }

    private connectWebSocket(name: string, url: string, onMessage: (data: any) => void) {
        if (this.connections[name]) {
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
            logger.warn(`Disconnected from ${name}, reconnecting in 10s...`)
            delete this.connections[name]
            this.reconnectTimers[name] = setTimeout(() => {
                this.connectWebSocket(name, url, onMessage)
            }, 10000)
        })

        ws.on('error', (err) => {
            logger.error(`Error in ${name} connection:`, err)
        })

        this.connections[name] = ws
    }

    private async handleEvent(event: DisasterEvent | null) {
        if (!event) return
        await this.pusher.pushEvent(event)
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

    private connectWolfx() {
        const wolfx_sources = {
            "japan_jma_eew": "wss://ws-api.wolfx.jp/jma_eew",
            "china_cenc_eew": "wss://ws-api.wolfx.jp/cenc_eew",
            "taiwan_cwa_eew": "wss://ws-api.wolfx.jp/cwa_eew",
            "japan_jma_earthquake": "wss://ws-api.wolfx.jp/jma_eqlist",
            "china_cenc_earthquake": "wss://ws-api.wolfx.jp/cenc_eqlist",
        }

        for (const [key, url] of Object.entries(wolfx_sources)) {
            if (this.config.data_sources.wolfx[key as keyof typeof this.config.data_sources.wolfx]) {
                this.connectWebSocket(`wolfx_${key}`, url, (data) => {
                    const handler = new WolfxHandler(`wolfx_${key}`)
                    const event = handler.parseMessage(data)
                    this.handleEvent(event)
                })
            }
        }
    }

    private connectGlobalQuake() {
        const url = "wss://gqm.aloys233.top/ws"
        this.connectWebSocket('global_quake', url, (data) => {
            const event = this.handlers.globalQuake.parseMessage(data)
            this.handleEvent(event)
        })
    }
}
