import { BaseDataHandler } from './base'
import { DisasterEvent, DataSource, DisasterType, EarthquakeData, TsunamiData, WeatherAlarmData } from '../models'

/**
 * FanStudio WebSocket /all 端点消息解析器
 *
 * 协议格式：
 *   { type: "update",       source: "<src>", Data: { ... } }
 *   { type: "initial_all",  "<src>": { ... }, ... }
 *
 * source 取值：cea | cenc | jma | cwa | cwa-eew | usgs | weatheralarm | tsunami | cea-pr
 */

const FS_SOURCE_MAP: Record<string, DataSource> = {
    'cea':          DataSource.FAN_STUDIO_CEA,
    'cea-pr':       DataSource.FAN_STUDIO_CEA,
    'cenc':         DataSource.FAN_STUDIO_CENC,
    'jma':          DataSource.FAN_STUDIO_JMA,
    'cwa':          DataSource.FAN_STUDIO_CWA,
    'cwa-eew':      DataSource.FAN_STUDIO_CWA,
    'usgs':         DataSource.FAN_STUDIO_USGS,
    'weatheralarm': DataSource.FAN_STUDIO_WEATHER,
    'tsunami':      DataSource.FAN_STUDIO_TSUNAMI,
}

export class FanStudioHandler extends BaseDataHandler {
    constructor() {
        super('fan_studio')
    }

    parseMessage(data: any): DisasterEvent | null {
        try {
            if (data.type === 'update') {
                return this.parseUpdate(data)
            } else if (data.type === 'initial_all') {
                return this.parseInitialAll(data)
            }
            return null
        } catch (e) {
            this.logger.error(`[${this.sourceId}] Error parsing message:`, e)
            return null
        }
    }

    private parseUpdate(msg: any): DisasterEvent | null {
        const src = String(msg.source || '').toLowerCase()
        const source = FS_SOURCE_MAP[src]
        if (!source) return null

        const payload = msg.Data || msg.data
        if (!payload) return null

        return this.dispatchBySource(source, src, payload)
    }

    private parseInitialAll(msg: any): DisasterEvent | null {
        // initial_all 包含多个数据源快照，取第一个有效的推送
        for (const [key, payload] of Object.entries(msg)) {
            if (key === 'type') continue
            const src = key.toLowerCase()
            const source = FS_SOURCE_MAP[src]
            if (!source || !payload) continue
            const event = this.dispatchBySource(source, src, payload)
            if (event) return event
        }
        return null
    }

    private dispatchBySource(source: DataSource, src: string, data: any): DisasterEvent | null {
        switch (source) {
            case DataSource.FAN_STUDIO_CEA:
                return this.parseEarthquakeWarning(data, source)
            case DataSource.FAN_STUDIO_CWA:
                // cwa-eew 是预警，cwa 是地震报告
                if (src === 'cwa-eew') return this.parseEarthquakeWarning(data, source)
                return this.parseEarthquakeInfo(data, source)
            case DataSource.FAN_STUDIO_JMA:
                // jma 消息既有 EEW 也有地震信息，通过 isFinal/epiIntensity 判断
                if (data.epiIntensity !== undefined || data.isFinal !== undefined) {
                    return this.parseEarthquakeWarning(data, source)
                }
                return this.parseEarthquakeInfo(data, source)
            case DataSource.FAN_STUDIO_CENC:
                return this.parseEarthquakeInfo(data, source)
            case DataSource.FAN_STUDIO_USGS:
                return this.parseEarthquakeInfo(data, source)
            case DataSource.FAN_STUDIO_WEATHER:
                return this.parseWeather(data)
            case DataSource.FAN_STUDIO_TSUNAMI:
                return this.parseTsunami(data)
            default:
                return null
        }
    }

    private parseEarthquakeWarning(data: any, source: DataSource): DisasterEvent | null {
        if (!data.id && !data.eventId) return null

        const earthquake: EarthquakeData = {
            id: data.id || data.eventId || '',
            event_id: data.eventId || data.id || '',
            source: source,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            shock_time: this.parseDateTime(data.shockTime) || new Date().toISOString(),
            latitude: Number(data.latitude) || 0,
            longitude: Number(data.longitude) || 0,
            depth: Number(data.depth),
            magnitude: Number(data.magnitude),
            intensity: data.epiIntensity !== undefined ? Number(data.epiIntensity) : undefined,
            scale: data.scale !== undefined ? Number(data.scale) : undefined,
            place_name: data.placeName || '',
            province: data.province,
            updates: data.updates || 1,
            is_final: data.isFinal || false,
            is_cancel: data.isCancel || false,
            raw_data: data
        }

        return {
            id: earthquake.id,
            data: earthquake,
            source: source,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseEarthquakeInfo(data: any, source: DataSource): DisasterEvent | null {
        if (!data.id && !data.eventId) return null

        const earthquake: EarthquakeData = {
            id: data.id || data.eventId || '',
            event_id: data.eventId || data.id || '',
            source: source,
            disaster_type: DisasterType.EARTHQUAKE,
            shock_time: this.parseDateTime(data.shockTime) || new Date().toISOString(),
            latitude: Number(data.latitude) || 0,
            longitude: Number(data.longitude) || 0,
            depth: Number(data.depth),
            magnitude: Number(data.magnitude),
            intensity: data.epiIntensity !== undefined ? Number(data.epiIntensity) : undefined,
            scale: data.scale !== undefined ? Number(data.scale) : undefined,
            place_name: data.placeName || '',
            updates: 1,
            is_final: true,
            is_cancel: false,
            raw_data: data
        }

        return {
            id: earthquake.id,
            data: earthquake,
            source: source,
            disaster_type: DisasterType.EARTHQUAKE,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseWeather(data: any): DisasterEvent | null {
        if (!data.headline && !data.title) return null

        const weather: WeatherAlarmData = {
            id: data.id || `weather_${Date.now()}`,
            source: DataSource.FAN_STUDIO_WEATHER,
            headline: data.headline || data.title || '',
            title: data.title || data.headline || '',
            description: data.description || '',
            type: data.type || 'unknown',
            effective_time: this.parseDateTime(data.effectiveTime) || new Date().toISOString(),
            disaster_type: DisasterType.WEATHER_ALARM,
            issue_time: this.parseDateTime(data.issueTime),
            affected_areas: data.affectedAreas || [],
            raw_data: data
        }

        return {
            id: weather.id,
            data: weather,
            source: DataSource.FAN_STUDIO_WEATHER,
            disaster_type: DisasterType.WEATHER_ALARM,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseTsunami(data: any): DisasterEvent | null {
        if (!data.title && !data.warningInfo) return null

        const tsunami: TsunamiData = {
            id: data.id || `tsunami_${Date.now()}`,
            code: data.code || '',
            source: DataSource.FAN_STUDIO_TSUNAMI,
            title: data.title || '',
            level: data.level || '',
            disaster_type: DisasterType.TSUNAMI,
            org_unit: data.orgUnit || '',
            forecasts: data.forecasts || [],
            monitoring_stations: [],
            raw_data: data
        }

        return {
            id: tsunami.id,
            data: tsunami,
            source: DataSource.FAN_STUDIO_TSUNAMI,
            disaster_type: DisasterType.TSUNAMI,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }
}
