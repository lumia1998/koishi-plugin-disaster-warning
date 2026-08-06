import { Context, Logger } from 'koishi'
import { Config } from './index'
import { WebSocket } from 'ws'
import { DisasterEvent, DataSource, DisasterType, EarthquakeData, EventDeduplicator, WeatherAlarmData } from './models'
import { FanStudioHandler, P2PHandler, WolfxHandler, GlobalQuakeHandler } from './handlers'
import { MessagePushManager } from './pusher'

const logger = new Logger('disaster-warning')

// Wolfx HTTP 列表轮询间隔（5 分钟）
const WOLFX_HTTP_INTERVAL_MS = 5 * 60 * 1000
const WEATHER_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000
const WEATHER_CACHE_LIMIT = 5000

// FanStudio 备用服务器
const FAN_STUDIO_PRIMARY = 'wss://ws.fanstudio.tech/all'
const FAN_STUDIO_BACKUP  = 'wss://ws.fanstudio.hk/all'

// WebSocket 重连延迟，超过阈值次数后切换到备用服务器
const RECONNECT_DELAY_MS       = 10_000
const FALLBACK_RETRY_THRESHOLD = 5

type GeographicRegion = 'china' | 'taiwan' | 'japan' | 'global' | 'unknown'

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
    private weatherAlarmCache = new Map<string, WeatherAlarmData>()

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
        const { regions, data_types } = this.config

        // FanStudio /all：覆盖中国(CEA/CENC/气象/海啸)、台湾(CWA)、日本(JMA)、全球(USGS)
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

        if (this.config.chatluna?.enabled) {
            this.openConnection(
                'fan_studio_weather',
                'wss://ws.fanstudio.tech/weatheralarm',
                'wss://ws.fanstudio.hk/weatheralarm',
                (data) => this.handleEvent(this.handlers.fanStudio.parseMessage(data))
            )
        }

        // P2P：日本 EEW / 地震情报 / 海啸
        if (regions.japan &&
            (data_types.earthquake_warning || data_types.earthquake_info || data_types.tsunami_warning)) {
            this.openConnection('p2p', 'wss://api.p2pquake.net/v2/ws', undefined, (data) => {
                this.handleEvent(this.handlers.p2p.parseMessage(data))
            })
        }

        // Wolfx /all_eew：中国/台湾/日本 EEW（仅预警类型）
        if (data_types.earthquake_warning &&
            (regions.china || regions.taiwan || regions.japan)) {
            this.openConnection('wolfx_eew', 'wss://ws-api.wolfx.jp/all_eew', undefined, (data) => {
                this.handleEvent(this.wolfxHandler.parseMessage(data))
            })
        }

        // GlobalQuake：全球实时预警
        if (regions.global && data_types.earthquake_warning) {
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

    // ---- Wolfx HTTP 轮询（地震列表）------------------------------------

    private startWolfxHttpPoller() {
        const { regions, data_types } = this.config
        if (!data_types.earthquake_info) return
        if (!regions.china && !regions.japan) return

        const poll = async () => {
            if (this.stopped) return
            try {
                if (regions.china) {
                    const data = await this.ctx.http.get('https://api.wolfx.jp/cenc_eqlist.json')
                    if (data) this.handleEvent(this.wolfxHandler.parseEqList(data, 'cenc'))
                }
                if (regions.japan) {
                    const data = await this.ctx.http.get('https://api.wolfx.jp/jma_eqlist.json')
                    if (data) this.handleEvent(this.wolfxHandler.parseEqList(data, 'jma'))
                }
            } catch (e) {
                logger.warn('[wolfx_http] Fetch failed:', e)
            }
        }

        // 延迟首次拉取，避免重启时将旧地震当新事件推送
        // 去重窗口（8分钟）> 轮询间隔（5分钟），不会漏报
        this.wolfxHttpTimer = setInterval(poll, WOLFX_HTTP_INTERVAL_MS)
    }

    // ---- 事件处理 --------------------------------------------------------

    private async handleEvent(event: DisasterEvent | null) {
        if (!event) return
        if (event.disaster_type === DisasterType.WEATHER_ALARM) {
            this.cacheWeatherAlarm(event.data as WeatherAlarmData)
        }
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
        const isEarthquakeInfo    = event.disaster_type === DisasterType.EARTHQUAKE
        const isTsunami           = event.disaster_type === DisasterType.TSUNAMI
        const isWeather           = event.disaster_type === DisasterType.WEATHER_ALARM

        if (isEarthquakeWarning && !data_types.earthquake_warning) return false
        if (isEarthquakeInfo    && !data_types.earthquake_info)    return false
        if (isTsunami           && !data_types.tsunami_warning)    return false
        if (isWeather           && !data_types.weather_alarm)      return false

        const src = event.source

        const japanSources  = [DataSource.P2P_EEW, DataSource.P2P_EARTHQUAKE, DataSource.P2P_TSUNAMI,
                               DataSource.WOLFX_JMA_EEW, DataSource.WOLFX_JMA_EQ, DataSource.FAN_STUDIO_JMA]
        const chinaSources  = [DataSource.FAN_STUDIO_CEA, DataSource.FAN_STUDIO_CENC, DataSource.FAN_STUDIO_WEATHER,
                               DataSource.FAN_STUDIO_TSUNAMI, DataSource.WOLFX_CENC_EEW, DataSource.WOLFX_CENC_EQ]
        const taiwanSources = [DataSource.FAN_STUDIO_CWA, DataSource.WOLFX_CWA_EEW]
        const globalSources = [DataSource.FAN_STUDIO_USGS, DataSource.GLOBAL_QUAKE]

        if (japanSources.includes(src)  && !regions.japan)  return false
        if (chinaSources.includes(src)  && !regions.china)  return false
        if (taiwanSources.includes(src) && !regions.taiwan) return false
        if (globalSources.includes(src) && !regions.global) return false

        if ((isEarthquakeWarning || isEarthquakeInfo) && !this.shouldPushEarthquakeByLocation(event)) {
            const data = event.data as EarthquakeData
            logger.debug(`[region] Skipping earthquake outside enabled regions: ${data.place_name || event.id}`)
            return false
        }

        return true
    }

    private shouldPushEarthquakeByLocation(event: DisasterEvent): boolean {
        const region = this.detectEarthquakeRegion(event.data as EarthquakeData, event.source)
        switch (region) {
            case 'china':
                return this.config.regions.china
            case 'taiwan':
                return this.config.regions.taiwan
            case 'japan':
                return this.config.regions.japan
            case 'global':
                return this.config.regions.global
            case 'unknown':
                return this.shouldAllowUnknownEarthquakeRegion(event.source)
        }
    }

    private detectEarthquakeRegion(data: EarthquakeData, source: DataSource): GeographicRegion {
        const place = data.place_name?.replace(/\s+/g, '').toLowerCase() || ''

        const placeRegion = this.detectRegionByPlace(place)
        if (placeRegion) return placeRegion

        const lat = this.validLatitude(data.latitude)
        const lon = this.validLongitude(data.longitude)
        if (lat === undefined || lon === undefined) return this.fallbackRegionForMissingCoordinates(data, source, place)

        // Many upstream cancellation packets use 0,0 when coordinates are unavailable.
        if (lat === 0 && lon === 0) return this.fallbackRegionForMissingCoordinates(data, source, place)

        if (this.isTaiwanCoordinate(lat, lon)) return 'taiwan'
        if (this.isJapanCoordinate(lat, lon)) return 'japan'
        if (this.isMainlandChinaCoordinate(lat, lon)) return 'china'
        return 'global'
    }

    private detectRegionByPlace(place: string): GeographicRegion | null {
        if (!place) return null

        if (this.includesAny(place, [
            '台湾', '臺灣', '台灣', 'taiwan', '花莲', '花蓮', '宜兰', '宜蘭', '台东', '臺東', '台東',
            '台北', '臺北', '新北', '桃园', '桃園', '台中', '臺中', '台南', '臺南', '高雄', '嘉义', '嘉義',
            '屏东', '屏東', '南投', '澎湖'
        ])) return 'taiwan'

        if (this.includesAny(place, [
            '日本', 'japan', '北海道', '本州', '四国', '四國', '九州', '沖縄', '冲绳', '琉球', '小笠原',
            '伊豆', '鳥島', '鸟岛', '青森', '岩手', '宮城', '宫城', '秋田', '山形', '福島', '福岛',
            '茨城', '栃木', '群馬', '群马', '埼玉', '千葉', '千叶', '東京', '东京', '神奈川', '新潟',
            '富山', '石川', '福井', '山梨', '長野', '长野', '岐阜', '静岡', '静冈', '愛知', '爱知',
            '三重', '滋賀', '滋贺', '京都', '大阪', '兵庫', '兵库', '奈良', '和歌山', '鳥取', '鸟取',
            '島根', '岛根', '岡山', '冈山', '広島', '广岛', '山口', '徳島', '德岛', '香川', '愛媛',
            '爱媛', '高知', '福岡', '福冈', '佐賀', '佐贺', '長崎', '长崎', '熊本', '大分', '宮崎',
            '宫崎', '鹿児島', '鹿儿岛'
        ])) return 'japan'

        if (this.includesAny(place, [
            '中国', 'china', '北京', '天津', '河北', '山西', '内蒙古', '辽宁', '遼寧', '吉林', '黑龙江',
            '黑龍江', '上海', '江苏', '江蘇', '浙江', '安徽', '福建', '江西', '山东', '山東', '河南',
            '湖北', '湖南', '广东', '廣東', '广西', '廣西', '海南', '重庆', '重慶', '四川', '贵州',
            '貴州', '云南', '雲南', '西藏', '陕西', '陝西', '甘肃', '甘肅', '青海', '宁夏', '寧夏',
            '新疆', '香港', '澳门', '澳門'
        ])) return 'china'

        return null
    }

    private includesAny(text: string, keywords: string[]): boolean {
        return keywords.some((keyword) => text.includes(keyword.toLowerCase()))
    }

    private validLatitude(value: number): number | undefined {
        return Number.isFinite(value) && value >= -90 && value <= 90 ? value : undefined
    }

    private validLongitude(value: number): number | undefined {
        return Number.isFinite(value) && value >= -180 && value <= 180 ? value : undefined
    }

    private isTaiwanCoordinate(lat: number, lon: number): boolean {
        return lat >= 21.5 && lat <= 26.5 && lon >= 119 && lon <= 123.8
    }

    private isJapanCoordinate(lat: number, lon: number): boolean {
        const mainIslands = lat >= 30 && lat <= 46.5 && lon >= 129 && lon <= 146.5
        const ryukyu = lat >= 24 && lat < 30 && lon >= 122 && lon <= 131.5
        const izuOgasawara = lat >= 20 && lat <= 34 && lon >= 139 && lon <= 154.5
        return mainIslands || ryukyu || izuOgasawara
    }

    private isMainlandChinaCoordinate(lat: number, lon: number): boolean {
        if (lat >= 18 && lat <= 20.5 && lon >= 108 && lon <= 111.5) return true

        // Rough mainland China outline. Place-name detection runs first, this is only a coordinate fallback.
        return this.pointInPolygon(lon, lat, [
            [73.5, 39.5],
            [74.9, 37.2],
            [75.5, 35.4],
            [78.4, 32.5],
            [78.7, 30.2],
            [80.5, 30.0],
            [81.8, 28.5],
            [85.2, 28.3],
            [88.9, 27.3],
            [91.0, 27.8],
            [93.3, 28.7],
            [95.5, 28.2],
            [97.3, 23.8],
            [98.9, 24.1],
            [100.1, 21.4],
            [101.8, 21.2],
            [103.8, 22.5],
            [106.8, 20.0],
            [108.7, 18.2],
            [111.3, 18.0],
            [113.7, 21.8],
            [116.7, 22.7],
            [118.5, 24.5],
            [121.8, 29.0],
            [122.2, 31.8],
            [121.5, 35.0],
            [124.0, 39.8],
            [126.8, 41.9],
            [130.0, 42.3],
            [134.7, 48.2],
            [131.0, 47.7],
            [128.0, 49.6],
            [123.3, 53.5],
            [119.5, 50.0],
            [117.0, 49.6],
            [111.0, 49.2],
            [105.0, 45.0],
            [97.0, 42.8],
            [91.0, 45.2],
            [87.0, 49.0],
            [82.0, 47.2],
            [79.0, 43.0],
        ])
    }

    private pointInPolygon(lon: number, lat: number, polygon: number[][]): boolean {
        let inside = false
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i][0]
            const yi = polygon[i][1]
            const xj = polygon[j][0]
            const yj = polygon[j][1]
            const intersects = ((yi > lat) !== (yj > lat)) &&
                (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)
            if (intersects) inside = !inside
        }
        return inside
    }

    private fallbackRegionForMissingCoordinates(data: EarthquakeData, source: DataSource, place: string): GeographicRegion {
        if (place && !data.is_cancel) return 'global'
        return this.fallbackRegionBySource(source)
    }

    private shouldAllowUnknownEarthquakeRegion(source: DataSource): boolean {
        const fallback = this.fallbackRegionBySource(source)
        if (fallback === 'unknown') return this.config.regions.global
        return this.isRegionEnabled(fallback)
    }

    private fallbackRegionBySource(source: DataSource): GeographicRegion {
        if ([DataSource.FAN_STUDIO_CEA, DataSource.FAN_STUDIO_CENC, DataSource.WOLFX_CENC_EEW, DataSource.WOLFX_CENC_EQ].includes(source)) return 'china'
        if ([DataSource.FAN_STUDIO_CWA, DataSource.WOLFX_CWA_EEW].includes(source)) return 'taiwan'
        if ([DataSource.FAN_STUDIO_JMA, DataSource.P2P_EEW, DataSource.P2P_EARTHQUAKE, DataSource.WOLFX_JMA_EEW, DataSource.WOLFX_JMA_EQ].includes(source)) return 'japan'
        if ([DataSource.FAN_STUDIO_USGS, DataSource.GLOBAL_QUAKE].includes(source)) return 'global'
        return 'unknown'
    }

    private isRegionEnabled(region: GeographicRegion): boolean {
        if (region === 'china') return this.config.regions.china
        if (region === 'taiwan') return this.config.regions.taiwan
        if (region === 'japan') return this.config.regions.japan
        if (region === 'global') return this.config.regions.global
        return false
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

    getWeatherAlarmCache(): WeatherAlarmData[] {
        this.evictWeatherAlarmCache()
        return Array.from(this.weatherAlarmCache.values())
    }

    private cacheWeatherAlarm(data: WeatherAlarmData) {
        this.weatherAlarmCache.set(data.id, data)
        this.evictWeatherAlarmCache()
        while (this.weatherAlarmCache.size > WEATHER_CACHE_LIMIT) {
            const oldest = this.weatherAlarmCache.keys().next().value
            if (oldest === undefined) break
            this.weatherAlarmCache.delete(oldest)
        }
    }

    private evictWeatherAlarmCache() {
        const cutoff = Date.now() - WEATHER_CACHE_TTL_MS
        for (const [id, alarm] of this.weatherAlarmCache) {
            const timestamp = new Date(alarm.issue_time || alarm.effective_time).getTime()
            if (Number.isFinite(timestamp) && timestamp < cutoff) this.weatherAlarmCache.delete(id)
        }
    }
}
