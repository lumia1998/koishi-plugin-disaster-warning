import { Context, Logger } from 'koishi'
import { Config } from './index'
import { WebSocket } from 'ws'
import { DisasterEvent, DataSource, DisasterType, EventDeduplicator } from './models'
import { FanStudioHandler, P2PHandler, WolfxHandler, GlobalQuakeHandler } from './handlers'
import { MessagePushManager } from './pusher'

const logger = new Logger('disaster-warning')

// Wolfx HTTP 列表获取间隔（5 分钟）
const WOLFX_HTTP_INTERVAL_MS = 5 * 60 * 1000

// FanStudio 备用服务器
const FAN_STUDIO_PRIMARY = 'wss://ws.fanstudio.tech/all'
const FAN_STUDIO_BACKUP = 'wss://ws.fanstudio.hk/all'

// WebSocket 重连延迟（秒），超过 MAX_RETRY 次后切备用服务器
const RECONNECT_DELAY_MS = 10_000
const FALLBACK_RETRY_THRESHOLD = 5

interface ConnectionEntry {
    url: string
    backupUrl?: string
    retryCount: number
    ws: WebSocket | null
    reconnectTimer: ReturnType<typeof setTimeout> | null
}

export class DisasterWarningService {
    private config: Config
    private ctx: Context
    private stopped = false
    private pusher: MessagePushManager
    private deduplicator = new EventDeduplicator()

    private handlers: {
        fanStudio: FanStudioHandler
        p2p: P2PHandler
        globalQuake: GlobalQuakeHandler
    }
    private wolfxHandler: WolfxHandler

    private connections: Record<string, ConnectionEntry> = {}
    private wolfxHttpTimer: ReturnType<typeof setInterval> | null = null

    constructor(ctx: Context, config: Config) {
        this.ctx = ctx
        this.config = config
        this.pusher = new MessagePushManager(ctx, config)
        this.handlers = {
            fanStudio: new FanStudioHandler(),
            p2p: new P2PHandler(),
            globalQuake: new GlobalQuakeHandler()
        }
        this.wolfxHandler = new WolfxHandler('wolfx_all')
    }

    async start() {
        if (!this.config.enabled) return
        this.stopped = false
        logger.info('Disaster Warning Service starting...')
        this.connectAll()
        this.startWolfxHttpPoller()
    }

    async stop() {
        logger.info('Disaster Warning Service stopping...')
        this.stopped = true

        if (this.wolfxHttpTimer) {
            clearInterval(this.wolfxHttpTimer)
            this.wolfxHttpTimer = null
        }

        for (const name in this.connections) {
            const entry = this.connections[name]
            if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
            if (entry.ws) {
                entry.ws.removeAllListeners('close')
                entry.ws.close()
            }
        }
        this.connections = {}
        logger.info('Disaster Warning Service stopped.')
    }

    // ---- 连接调度 --------------------------------------------------------

    private connectAll() {
        const { regions, data_types, data_sources } = this.config

        // FAN Studio — 单连接 /all，覆盖中国/台湾/USGS/日本/气象/海啸
        if (data_sources.fan_studio) {
            const needFanStudio =
                (regions.china && (data_types.earthquake_warning || data_types.earthquake_info || data_types.weather_alarm || data_types.tsunami_warning)) ||
                (regions.taiwan && (data_types.earthquake_warning || data_types.earthquake_info)) ||
                (regions.japan && (data_types.earthquake_warning || data_types.earthquake_info)) ||
                (regions.global && data_types.earthquake_info)
            if (needFanStudio) {
                this.openConnection('fan_studio', FAN_STUDIO_PRIMARY, FAN_STUDIO_BACKUP, (data) => {
                    this.handleEvent(this.handlers.fanStudio.parseMessage(data))
                })
            }
        }

        // P2P — 日本 EEW / 地震情报 / 海啸
        if (data_sources.p2p && regions.japan &&
            (data_types.earthquake_warning || data_types.earthquake_info || data_types.tsunami_warning)) {
            this.openConnection('p2p', 'wss://api.p2pquake.net/v2/ws', undefined, (data) => {
                this.handleEvent(this.handlers.p2p.parseMessage(data))
            })
        }

        // Wolfx — /all_eew 合并端点，接收中国/台湾/日本 EEW
        // eqlist 改为 HTTP 轮询（见 startWolfxHttpPoller）
        if (data_sources.wolfx &&
            (data_types.earthquake_warning) &&
            (regions.china || regions.taiwan || regions.japan)) {
            this.openConnection('wolfx_eew', 'wss://ws-api.wolfx.jp/all_eew', undefined, (data) => {
                this.handleEvent(this.wolfxHandler.parseMessage(data))
            })
        }

        // GlobalQuake — 全球实时预警
        if (data_sources.global_quake && regions.global && data_types.earthquake_warning) {
            this.openConnection('global_quake', 'wss://gqm.aloys233.top/ws', undefined, (data) => {
                this.handleEvent(this.handlers.globalQuake.parseMessage(data))
            })
        }
    }

    // ---- WebSocket 生命周期 ----------------------------------------------

    private openConnection(
        name: string,
        url: string,
        backupUrl: string | undefined,
        onMessage: (data: any) => void
    ) {
        if (this.stopped) return

        const entry: ConnectionEntry = {
            url,
            backupUrl,
            retryCount: 0,
            ws: null,
            reconnectTimer: null
        }
        this.connections[name] = entry
        this.doConnect(name, onMessage)
    }

    private doConnect(name: string, onMessage: (data: any) => void) {
        if (this.stopped) return
        const entry = this.connections[name]
        if (!entry) return

        // 超过阈值切换到备用服务器
        const useBackup = entry.backupUrl && entry.retryCount >= FALLBACK_RETRY_THRESHOLD
        const url = useBackup ? entry.backupUrl! : entry.url

        logger.info(`[${name}] Connecting to ${url}${useBackup ? ' (backup)' : ''}...`)

        const ws = new WebSocket(url)
        entry.ws = ws

        ws.on('open', () => {
            logger.info(`[${name}] Connected`)
            entry.retryCount = 0
        })

        ws.on('message', (raw) => {
            try {
                onMessage(JSON.parse(raw.toString()))
            } catch (e) {
                logger.warn(`[${name}] Parse error:`, e)
            }
        })

        ws.on('close', () => {
            if (this.stopped) return
            entry.retryCount++
            logger.warn(`[${name}] Disconnected (retry #${entry.retryCount}), reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
            entry.reconnectTimer = setTimeout(() => this.doConnect(name, onMessage), RECONNECT_DELAY_MS)
        })

        ws.on('error', (err) => {
            logger.error(`[${name}] Error:`, err)
        })
    }

    // ---- Wolfx HTTP 轮询（地震列表） -------------------------------------

    private startWolfxHttpPoller() {
        if (!this.config.data_sources.wolfx || !this.config.data_types.earthquake_info) return

        const poll = async () => {
            if (this.stopped) return
            try {
                if (this.config.regions.china) {
                    const data = await this.ctx.http.get('https://api.wolfx.jp/cenc_eqlist.json')
                    if (data) this.handleEvent(this.wolfxHandler.parseEqList(data, 'cenc'))
                }
                if (this.config.regions.japan) {
                    const data = await this.ctx.http.get('https://api.wolfx.jp/jma_eqlist.json')
                    if (data) this.handleEvent(this.wolfxHandler.parseEqList(data, 'jma'))
                }
            } catch (e) {
                logger.warn('[wolfx_http] Fetch failed:', e)
            }
        }

        // 立即执行一次，然后每 5 分钟轮询
        poll()
        this.wolfxHttpTimer = setInterval(poll, WOLFX_HTTP_INTERVAL_MS)
    }

    // ---- 事件处理 --------------------------------------------------------

    private async handleEvent(event: DisasterEvent | null) {
        if (!event) return
        if (!this.shouldPushEvent(event)) return
        if (this.deduplicator.isDuplicate(event)) {
            logger.debug(`[dedup] Skipping duplicate event: ${event.id}`)
            return
        }
        await this.pusher.pushEvent(event)
    }

    private shouldPushEvent(event: DisasterEvent): boolean {
        const { data_types, regions } = this.config

        const isEarthquakeWarning = event.disaster_type === DisasterType.EARTHQUAKE_WARNING
        const isEarthquakeInfo = event.disaster_type === DisasterType.EARTHQUAKE
        const isTsunami = event.disaster_type === DisasterType.TSUNAMI
        const isWeather = event.disaster_type === DisasterType.WEATHER_ALARM

        if (isEarthquakeWarning && !data_types.earthquake_warning) return false
        if (isEarthquakeInfo && !data_types.earthquake_info) return false
        if (isTsunami && !data_types.tsunami_warning) return false
        if (isWeather && !data_types.weather_alarm) return false

        const src = event.source
        const japanSources = [
            DataSource.P2P_EEW, DataSource.P2P_EARTHQUAKE, DataSource.P2P_TSUNAMI,
            DataSource.WOLFX_JMA_EEW, DataSource.WOLFX_JMA_EQ, DataSource.FAN_STUDIO_JMA
        ]
        const chinaSources = [
            DataSource.FAN_STUDIO_CEA, DataSource.FAN_STUDIO_CENC, DataSource.FAN_STUDIO_WEATHER,
            DataSource.FAN_STUDIO_TSUNAMI, DataSource.WOLFX_CENC_EEW, DataSource.WOLFX_CENC_EQ
        ]
        const taiwanSources = [DataSource.FAN_STUDIO_CWA, DataSource.WOLFX_CWA_EEW]
        const globalSources = [DataSource.FAN_STUDIO_USGS, DataSource.GLOBAL_QUAKE]

        if (japanSources.includes(src) && !regions.japan) return false
        if (chinaSources.includes(src) && !regions.china) return false
        if (taiwanSources.includes(src) && !regions.taiwan) return false
        if (globalSources.includes(src) && !regions.global) return false

        return true
    }

    // ---- 状态查询（供 commands 使用）------------------------------------

    getStatus(): Record<string, { connected: boolean; retryCount: number; url: string }> {
        const result: Record<string, { connected: boolean; retryCount: number; url: string }> = {}
        for (const [name, entry] of Object.entries(this.connections)) {
            result[name] = {
                connected: entry.ws?.readyState === WebSocket.OPEN,
                retryCount: entry.retryCount,
                url: entry.url
            }
        }
        // Wolfx HTTP poller 状态
        result['wolfx_http_poller'] = {
            connected: this.wolfxHttpTimer !== null,
            retryCount: 0,
            url: 'https://api.wolfx.jp/{cenc,jma}_eqlist.json'
        }
        return result
    }

    /** 给 commands 用：拿到 wolfxHandler 最新的 eqlist 缓存 */
    getEqListCache(): { cenc: Record<string, any>; jma: Record<string, any> } {
        return this.wolfxHandler.getEqListCache()
    }
}
