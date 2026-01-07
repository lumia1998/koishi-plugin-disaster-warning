import { BaseDataHandler } from './base'
import { DisasterEvent, DataSource, DisasterType, EarthquakeData, TsunamiData, WeatherAlarmData } from '../models'

export class FanStudioHandler extends BaseDataHandler {
    constructor() {
        super('fan_studio')
    }

    parseMessage(data: any): DisasterEvent | null {
        try {
            // FanStudio data usually comes in a 'Data' or 'data' field, or just the object itself
            const msgData = data.Data || data.data || data
            if (!msgData) return null

            // Detect data source based on message content
            const source = this.detectSource(msgData)

            // Earthquake Warning (CEA, CWA, JMA EEW)
            if (msgData.epiIntensity !== undefined || (msgData.magnitude !== undefined && msgData.isFinal !== undefined)) {
                return this.parseEarthquakeWarning(msgData, source)
            }

            // Earthquake Info (CENC, USGS, JMA Info)
            if (msgData.eventId && msgData.magnitude !== undefined && msgData.epiIntensity === undefined) {
                return this.parseEarthquakeInfo(msgData, source)
            }

            // Weather
            if (msgData.headline && msgData.description) {
                return this.parseWeather(msgData)
            }

            // Tsunami
            if (msgData.warningInfo || (msgData.title && msgData.level && msgData.forecasts)) {
                return this.parseTsunami(msgData)
            }

            return null
        } catch (e) {
            this.logger.error(`[${this.sourceId}] Error parsing message:`, e)
            return null
        }
    }

    private detectSource(data: any): DataSource {
        // Check for explicit type field
        if (data.type) {
            const typeMap: Record<string, DataSource> = {
                'cenc_eew': DataSource.FAN_STUDIO_CEA,
                'cwa_eew': DataSource.FAN_STUDIO_CWA,
                'jma_eew': DataSource.FAN_STUDIO_JMA,
                'cenc_eq': DataSource.FAN_STUDIO_CENC,
                'usgs_eq': DataSource.FAN_STUDIO_USGS,
                'weather': DataSource.FAN_STUDIO_WEATHER,
                'tsunami': DataSource.FAN_STUDIO_TSUNAMI,
            }
            if (typeMap[data.type]) return typeMap[data.type]
        }

        // Check for source field
        if (data.source) {
            const sourceStr = String(data.source).toLowerCase()
            if (sourceStr.includes('cenc')) return DataSource.FAN_STUDIO_CENC
            if (sourceStr.includes('cwa') || sourceStr.includes('taiwan')) return DataSource.FAN_STUDIO_CWA
            if (sourceStr.includes('jma') || sourceStr.includes('japan')) return DataSource.FAN_STUDIO_JMA
            if (sourceStr.includes('usgs')) return DataSource.FAN_STUDIO_USGS
        }

        // Check province for Taiwan
        if (data.province && String(data.province).includes('台湾')) {
            return DataSource.FAN_STUDIO_CWA
        }

        // Check for Japan-specific fields (scale instead of intensity)
        if (data.scale !== undefined && data.epiIntensity === undefined) {
            return DataSource.FAN_STUDIO_JMA
        }

        // Check for USGS fields
        if (data.net === 'us' || data.properties?.net === 'us') {
            return DataSource.FAN_STUDIO_USGS
        }

        // Default to CEA for Chinese earthquake warnings
        return DataSource.FAN_STUDIO_CEA
    }

    private parseEarthquakeWarning(data: any, source: DataSource): DisasterEvent {
        const earthquake: EarthquakeData = {
            id: data.id || '',
            event_id: data.eventId || data.id || '',
            source: source,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            shock_time: this.parseDateTime(data.shockTime) || new Date().toISOString(),
            latitude: Number(data.latitude) || 0,
            longitude: Number(data.longitude) || 0,
            depth: Number(data.depth),
            magnitude: Number(data.magnitude),
            intensity: Number(data.epiIntensity),
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

    private parseEarthquakeInfo(data: any, source: DataSource): DisasterEvent {
        // Determine if USGS or CENC based on source detection
        const finalSource = source === DataSource.FAN_STUDIO_CEA ? DataSource.FAN_STUDIO_CENC : source

        const earthquake: EarthquakeData = {
            id: data.id || '',
            event_id: data.eventId || data.id || '',
            source: finalSource,
            disaster_type: DisasterType.EARTHQUAKE,
            shock_time: this.parseDateTime(data.shockTime) || new Date().toISOString(),
            latitude: Number(data.latitude) || 0,
            longitude: Number(data.longitude) || 0,
            depth: Number(data.depth),
            magnitude: Number(data.magnitude),
            place_name: data.placeName || '',
            updates: 1,
            is_final: true,
            is_cancel: false,
            raw_data: data
        }

        return {
            id: earthquake.id,
            data: earthquake,
            source: finalSource,
            disaster_type: DisasterType.EARTHQUAKE,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseWeather(data: any): DisasterEvent {
        const weather: WeatherAlarmData = {
            id: data.id || `weather_${Date.now()}`,
            source: DataSource.FAN_STUDIO_WEATHER,
            headline: data.headline,
            title: data.title || data.headline,
            description: data.description,
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

    private parseTsunami(data: any): DisasterEvent {
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
