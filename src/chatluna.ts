import { Context, Logger } from 'koishi'
import { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { Config } from './index'
import { DisasterWarningService } from './service'
import { WeatherAlarmData } from './models'

const logger = new Logger('disaster-chatluna')

const sourceSchema = z.enum(['all', 'cenc', 'jma', 'usgs'])
const actionSchema = z.enum(['recent_earthquakes', 'status'])

const toolSchema = z.object({
    action: actionSchema.optional().describe('操作类型：recent_earthquakes 查询近期地震，status 查询数据源连接状态。默认 recent_earthquakes。'),
    source: sourceSchema.optional().describe('数据源：all 综合查询，cenc 中国地震台网列表，jma 日本气象厅列表，usgs USGS 全球地震。默认使用插件配置。'),
    location: z.string().optional().describe('可选，地点关键词、国家、地区或城市，例如“四川”“台湾”“日本”“智利”“Chile”。'),
    min_magnitude: z.number().min(0).max(10).optional().describe('可选，最低震级，默认使用插件配置。'),
    days: z.number().int().min(1).max(30).optional().describe('可选，查询最近多少天，默认使用插件配置，最多 30 天。'),
    limit: z.number().int().min(1).max(50).optional().describe('可选，最多返回多少条地震记录，默认使用插件配置。')
})

const weatherToolSchema = z.object({
    location: z.string().optional().describe('可选，地区关键词，例如“全国”“广东”“深圳”“海淀”。不填或填“全国”时查询全国。'),
    type: z.string().optional().describe('可选，气象预警类型，例如“暴雨”“台风”“雷电”“高温”。'),
    color: z.enum(['白色', '蓝色', '黄色', '橙色', '红色']).optional().describe('可选，预警颜色级别。'),
    hours: z.number().int().min(1).max(72).optional().describe('可选，查询最近多少小时，默认 24 小时，最多 72 小时。'),
    limit: z.number().int().min(1).max(50).optional().describe('可选，最多返回多少条，默认 10 条。'),
    id: z.string().optional().describe('可选，预警 ID。指定后精确查询该预警详情，其他过滤条件会被忽略。')
})

type ToolSource = 'all' | 'cenc' | 'jma' | 'usgs'
type ToolInput = {
    action?: 'recent_earthquakes' | 'status'
    source?: ToolSource
    location?: string
    min_magnitude?: number
    days?: number
    limit?: number
}

type WeatherToolInput = {
    location?: string
    type?: string
    color?: '白色' | '蓝色' | '黄色' | '橙色' | '红色'
    hours?: number
    limit?: number
    id?: string
}

interface ChatLunaToolConfig {
    enabled: boolean
    name: string
    description: string
    weather_name: string
    weather_description: string
    default_source: ToolSource
    default_limit: number
    default_days: number
    min_magnitude: number
    include_usgs_when_all: boolean
}

interface EarthquakeRecord {
    source: ToolSource
    source_name: string
    id?: string
    time?: string
    location: string
    magnitude?: number
    depth_km?: number
    intensity?: string
    scale?: string
    latitude?: number
    longitude?: number
    url?: string
}

interface QueryOptions {
    source: ToolSource
    location?: string
    minMagnitude: number
    days: number
    limit: number
}

const DEFAULT_CHATLUNA_CONFIG: ChatLunaToolConfig = {
    enabled: false,
    name: 'disaster_warning',
    description: '查询近期地震和灾害预警数据源状态，可按地点、震级、时间范围过滤。适合回答“哪里地震了”“某地最近有没有地震”“关心的人所在地区是否有地震”等问题。',
    weather_name: 'weather_warning',
    weather_description: '查询中国近期气象预警，可按地区、预警类型、颜色级别和时间范围过滤，也可按预警 ID 查询详情。适合回答“某地近期有天气预警吗”“有哪些暴雨或台风预警”等问题。',
    default_source: 'all',
    default_limit: 8,
    default_days: 7,
    min_magnitude: 4,
    include_usgs_when_all: true
}

export class WeatherWarningTool extends StructuredTool<any, WeatherToolInput, WeatherToolInput, string> {
    name: string
    description: string
    schema: any = weatherToolSchema

    constructor(private config: Config, private service: DisasterWarningService) {
        super({})
        const cfg = getChatLunaConfig(config)
        this.name = normalizeToolName(cfg.weather_name, DEFAULT_CHATLUNA_CONFIG.weather_name)
        this.description = cfg.weather_description.trim() || DEFAULT_CHATLUNA_CONFIG.weather_description
    }

    async _call(input: WeatherToolInput) {
        try {
            const alarms = this.service.getWeatherAlarmCache()
            if (input.id?.trim()) {
                const id = input.id.trim()
                const alarm = alarms.find((item) => item.id === id)
                return JSON.stringify(compact({
                    type: 'weather_warning_detail',
                    generated_at: new Date().toISOString(),
                    found: Boolean(alarm),
                    warning: alarm ? formatWeatherAlarm(alarm, true) : undefined,
                    note: alarm ? undefined : '当前 72 小时内接收到的气象预警中未找到该 ID。'
                }), null, 2)
            }

            const location = input.location?.trim()
            const warningType = input.type?.trim()
            const hours = clamp(input.hours ?? 24, 1, 72)
            const limit = clamp(input.limit ?? 10, 1, 50)
            const cutoff = Date.now() - hours * 3600_000
            const filtered = alarms
                .filter((alarm) => weatherTimeValue(alarm) >= cutoff)
                .filter((alarm) => !location || ['全国', '全國'].includes(location) || matchesWeatherText(alarm, location))
                .filter((alarm) => !warningType || matchesWeatherText(alarm, warningType))
                .filter((alarm) => !input.color || detectWeatherColor(alarm) === input.color)
                .sort((a, b) => weatherTimeValue(b) - weatherTimeValue(a))
                .slice(0, limit)

            return JSON.stringify(compact({
                type: 'recent_weather_warnings',
                generated_at: new Date().toISOString(),
                query: { location: location || '全国', warning_type: warningType, color: input.color, hours, limit },
                count: filtered.length,
                warnings: filtered.map((alarm) => formatWeatherAlarm(alarm, false)),
                note: alarms.length
                    ? '结果来自插件运行期间接收的 FAN Studio 中国气象局实时预警，最多保留 72 小时。'
                    : '尚未接收到气象预警数据。工具仅能查询插件启动后通过实时数据源收到的预警。'
            }), null, 2)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(`ChatLuna weather tool call failed: ${message}`)
            return `气象预警查询失败：${message}`
        }
    }
}

export class DisasterWarningTool extends StructuredTool<any, ToolInput, ToolInput, string> {
    name: string
    description: string
    schema: any = toolSchema

    constructor(
        private ctx: Context,
        private config: Config,
        private service: DisasterWarningService
    ) {
        super({})
        const cfg = getChatLunaConfig(config)
        this.name = normalizeToolName(cfg.name, DEFAULT_CHATLUNA_CONFIG.name)
        this.description = cfg.description.trim() || DEFAULT_CHATLUNA_CONFIG.description
    }

    async _call(input: ToolInput) {
        const action = input.action || 'recent_earthquakes'
        try {
            if (action === 'status') {
                return JSON.stringify(this.formatStatus(), null, 2)
            }

            const cfg = getChatLunaConfig(this.config)
            const options: QueryOptions = {
                source: input.source || cfg.default_source,
                location: input.location?.trim() || undefined,
                minMagnitude: input.min_magnitude ?? cfg.min_magnitude,
                days: clamp(input.days ?? cfg.default_days, 1, 30),
                limit: clamp(input.limit ?? cfg.default_limit, 1, 50)
            }

            const result = await this.queryRecentEarthquakes(options)
            return JSON.stringify(result, null, 2)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(`ChatLuna tool call failed: ${message}`)
            return `灾害预警查询失败：${message}`
        }
    }

    private formatStatus() {
        const status = this.service.getStatus()
        return {
            type: 'disaster_warning_status',
            generated_at: new Date().toISOString(),
            sources: Object.entries(status).map(([name, item]) => ({
                name,
                connected: item.connected,
                retry_count: item.retryCount,
                url: item.url
            }))
        }
    }

    private async queryRecentEarthquakes(options: QueryOptions) {
        const cfg = getChatLunaConfig(this.config)
        const sources = expandSources(options.source, cfg.include_usgs_when_all)
        const settled = await Promise.allSettled(sources.map((source) => this.fetchSource(source, options)))

        const errors: Array<{ source: ToolSource; message: string }> = []
        const records: EarthquakeRecord[] = []
        settled.forEach((item, index) => {
            const source = sources[index]
            if (item.status === 'fulfilled') {
                records.push(...item.value)
            } else {
                const message = item.reason instanceof Error ? item.reason.message : String(item.reason)
                errors.push({ source, message })
            }
        })

        const terms = buildSearchTerms(options.location)
        const filtered = records
            .filter((record) => record.magnitude === undefined || record.magnitude >= options.minMagnitude)
            .filter((record) => isWithinDays(record.time, options.days))
            .filter((record) => matchesLocation(record, terms))
            .sort((a, b) => timeValue(b.time) - timeValue(a.time))
            .slice(0, options.limit)

        return compact({
            type: 'recent_earthquakes',
            generated_at: new Date().toISOString(),
            query: {
                source: options.source,
                expanded_sources: sources,
                location: options.location,
                min_magnitude: options.minMagnitude,
                days: options.days,
                limit: options.limit
            },
            count: filtered.length,
            earthquakes: filtered,
            errors: errors.length ? errors : undefined,
            note: '地震查询工具用于对话查询，不会改变群推送过滤配置。regions.global 关闭时仍可通过工具主动查询全球地震。'
        })
    }

    private fetchSource(source: ToolSource, options: QueryOptions): Promise<EarthquakeRecord[]> {
        if (source === 'cenc') return this.fetchWolfxList('cenc')
        if (source === 'jma') return this.fetchWolfxList('jma')
        if (source === 'usgs') return this.fetchUsgs(options)
        return Promise.resolve([])
    }

    private async fetchWolfxList(type: 'cenc' | 'jma'): Promise<EarthquakeRecord[]> {
        const cache = this.service.getEqListCache()
        let data = cache[type]
        if (!data || Object.keys(data).length === 0) {
            const url = type === 'cenc'
                ? 'https://api.wolfx.jp/cenc_eqlist.json'
                : 'https://api.wolfx.jp/jma_eqlist.json'
            data = await this.ctx.http.get(url)
        }

        const keys = Object.keys(data || {})
            .filter((key) => /^No\d+$/.test(key))
            .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))

        return keys
            .map((key) => parseWolfxRecord(type, data[key]))
            .filter((record): record is EarthquakeRecord => Boolean(record))
    }

    private async fetchUsgs(options: QueryOptions): Promise<EarthquakeRecord[]> {
        const url = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query')
        url.searchParams.set('format', 'geojson')
        url.searchParams.set('orderby', 'time')
        url.searchParams.set('starttime', new Date(Date.now() - options.days * 86400_000).toISOString())
        url.searchParams.set('minmagnitude', String(options.minMagnitude))
        url.searchParams.set('limit', String(Math.min(Math.max(options.limit * 5, 50), 200)))

        const data = await this.ctx.http.get(url.toString()) as any
        const features: any[] = Array.isArray(data?.features) ? data.features : []
        return features.map(parseUsgsFeature).filter((record): record is EarthquakeRecord => Boolean(record))
    }
}

export function applyChatLunaTools(ctx: Context, config: Config, service: DisasterWarningService) {
    ctx.on('ready', () => {
        const cfg = getChatLunaConfig(config)
        if (!cfg.enabled) return

        const chatluna = (ctx as any).chatluna
        if (!chatluna?.platform?.registerTool) {
            logger.warn('未检测到 ChatLuna 服务，跳过注册灾害预警工具。')
            return
        }

        const toolName = normalizeToolName(cfg.name, DEFAULT_CHATLUNA_CONFIG.name)
        ctx.effect(() => chatluna.platform.registerTool(toolName, {
            description: cfg.description.trim() || DEFAULT_CHATLUNA_CONFIG.description,
            selector() {
                return true
            },
            createTool() {
                return new DisasterWarningTool(ctx, config, service)
            },
            meta: {
                source: 'extension',
                group: 'disaster-warning',
                tags: ['disaster', 'earthquake', 'warning'],
                defaultAvailability: {
                    enabled: true,
                    main: true,
                    chatluna: true,
                    characterScope: 'all'
                }
            }
        }))

        const weatherToolName = normalizeToolName(cfg.weather_name, DEFAULT_CHATLUNA_CONFIG.weather_name)
        ctx.effect(() => chatluna.platform.registerTool(weatherToolName, {
            description: cfg.weather_description.trim() || DEFAULT_CHATLUNA_CONFIG.weather_description,
            selector() {
                return true
            },
            createTool() {
                return new WeatherWarningTool(config, service)
            },
            meta: {
                source: 'extension',
                group: 'disaster-warning',
                tags: ['disaster', 'weather', 'warning'],
                defaultAvailability: {
                    enabled: true,
                    main: true,
                    chatluna: true,
                    characterScope: 'all'
                }
            }
        }))

        logger.info(`已注册 ChatLuna 灾害预警工具：${toolName}, ${weatherToolName}`)
    })
}

export function getChatLunaConfig(config: Config): ChatLunaToolConfig {
    return {
        ...DEFAULT_CHATLUNA_CONFIG,
        ...(config.chatluna || {})
    }
}

function normalizeToolName(name: string | undefined, fallback: string): string {
    const normalized = (name || fallback).trim()
    return normalized || fallback
}

function expandSources(source: ToolSource, includeUsgsWhenAll: boolean): ToolSource[] {
    if (source !== 'all') return [source]
    return includeUsgsWhenAll ? ['cenc', 'jma', 'usgs'] : ['cenc', 'jma']
}

function parseWolfxRecord(type: 'cenc' | 'jma', item: any): EarthquakeRecord | null {
    if (!item || typeof item !== 'object') return null
    const magnitude = toNumber(item.magnitude)
    return compact({
        source: type,
        source_name: type === 'cenc' ? 'CENC 中国地震台网' : 'JMA 日本气象厅',
        id: item.md5 || item.id,
        time: normalizeTime(item.time),
        location: item.location || item.hypocenter || '',
        magnitude,
        depth_km: parseDepth(item.depth),
        intensity: item.intensity ? String(item.intensity) : undefined,
        scale: item.shindo ? String(item.shindo) : undefined,
        latitude: toNumber(item.latitude),
        longitude: toNumber(item.longitude)
    }) as EarthquakeRecord
}

function parseUsgsFeature(feature: any): EarthquakeRecord | null {
    const props = feature?.properties || {}
    const coordinates = feature?.geometry?.coordinates || []
    if (!props.place && props.mag === undefined) return null
    return compact({
        source: 'usgs',
        source_name: 'USGS',
        id: feature.id,
        time: props.time ? new Date(props.time).toISOString() : undefined,
        location: props.place || '',
        magnitude: toNumber(props.mag),
        depth_km: toNumber(coordinates[2]),
        latitude: toNumber(coordinates[1]),
        longitude: toNumber(coordinates[0]),
        url: props.url
    }) as EarthquakeRecord
}

function normalizeTime(value: unknown): string | undefined {
    if (!value) return undefined
    const text = String(value).trim()
    const date = new Date(text.replace(/\//g, '-'))
    if (!Number.isFinite(date.getTime())) return text
    return date.toISOString()
}

function parseDepth(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined
    const match = String(value).match(/-?\d+(?:\.\d+)?/)
    return match ? Number(match[0]) : undefined
}

function toNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
}

function isWithinDays(time: string | undefined, days: number): boolean {
    const value = timeValue(time)
    if (!value) return true
    return value >= Date.now() - days * 86400_000
}

function timeValue(time: string | undefined): number {
    if (!time) return 0
    const value = new Date(time).getTime()
    return Number.isFinite(value) ? value : 0
}

function matchesLocation(record: EarthquakeRecord, terms: string[]): boolean {
    if (!terms.length) return true
    const haystack = normalizeText([
        record.location,
        record.source_name,
        record.latitude,
        record.longitude
    ].filter((item) => item !== undefined).join(' '))
    return terms.some((term) => haystack.includes(term))
}

function buildSearchTerms(location: string | undefined): string[] {
    if (!location) return []
    const base = normalizeText(location)
    const aliases: Record<string, string[]> = {
        '智利': ['chile'],
        '印尼': ['indonesia'],
        '印度尼西亚': ['indonesia'],
        '菲律宾': ['philippines'],
        '秘鲁': ['peru'],
        '墨西哥': ['mexico'],
        '阿根廷': ['argentina'],
        '土耳其': ['turkey'],
        '希腊': ['greece'],
        '俄罗斯': ['russia'],
        '美国': ['unitedstates', 'usa'],
        '阿拉斯加': ['alaska'],
        '加州': ['california'],
        '新西兰': ['newzealand'],
        '巴布亚': ['papua'],
        '汤加': ['tonga'],
        '斐济': ['fiji'],
        '瓦努阿图': ['vanuatu'],
        '日本': ['japan'],
        '台湾': ['taiwan', '臺灣', '台灣'],
        '中国': ['china'],
        '四川': ['sichuan'],
        '云南': ['yunnan'],
        '西藏': ['tibet', 'xizang'],
        '新疆': ['xinjiang'],
        '青海': ['qinghai'],
        '甘肃': ['gansu']
    }
    const terms = new Set<string>([base])
    for (const [key, values] of Object.entries(aliases)) {
        if (base.includes(normalizeText(key))) {
            values.forEach((value) => terms.add(normalizeText(value)))
        }
    }
    return Array.from(terms).filter(Boolean)
}

function normalizeText(value: unknown): string {
    return String(value ?? '').toLowerCase().replace(/[\s,，、()（）-]/g, '')
}

function weatherTimeValue(alarm: WeatherAlarmData): number {
    return timeValue(alarm.issue_time || alarm.effective_time)
}

function matchesWeatherText(alarm: WeatherAlarmData, keyword: string): boolean {
    const needle = normalizeText(keyword)
    const haystack = normalizeText([
        alarm.title,
        alarm.headline,
        alarm.description,
        alarm.type,
        alarm.alert_level,
        ...(alarm.affected_areas || [])
    ].join(' '))
    return haystack.includes(needle)
}

function detectWeatherColor(alarm: WeatherAlarmData): string | undefined {
    const text = `${alarm.alert_level || ''} ${alarm.type || ''} ${alarm.title || ''} ${alarm.headline || ''}`.toLowerCase()
    const colors: Array<[string, string[]]> = [
        ['红色', ['红色', '_red', '-red']],
        ['橙色', ['橙色', '_orange', '-orange']],
        ['黄色', ['黄色', '_yellow', '-yellow']],
        ['蓝色', ['蓝色', '_blue', '-blue']],
        ['白色', ['白色', '_white', '-white']]
    ]
    return colors.find(([, aliases]) => aliases.some((alias) => text.includes(alias)))?.[0]
}

function formatWeatherAlarm(alarm: WeatherAlarmData, includeDescription: boolean) {
    return compact({
        id: alarm.id,
        source: 'FAN Studio / 中国气象局',
        title: alarm.title,
        headline: alarm.headline,
        warning_type: alarm.type,
        color: detectWeatherColor(alarm),
        alert_level: alarm.alert_level,
        issue_time: alarm.issue_time,
        effective_time: alarm.effective_time,
        affected_areas: alarm.affected_areas,
        latitude: alarm.latitude,
        longitude: alarm.longitude,
        description: includeDescription ? alarm.description : undefined
    })
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

function compact<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => compact(item)) as T
    if (!value || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined || item === null || item === '') continue
        const next = compact(item)
        if (Array.isArray(next) && next.length === 0) continue
        out[key] = next
    }
    return out as T
}
