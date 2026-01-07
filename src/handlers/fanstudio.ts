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

            // Identify type based on fields
            // Earthquake Warning (CEA, CWA, JMA EEW)
            if (msgData.epiIntensity !== undefined || msgData.magnitude !== undefined && msgData.isFinal !== undefined) {
                return this.parseEarthquakeWarning(msgData)
            }

            // Earthquake Info (CENC, USGS, JMA Info) - usually has 'type' or specific fields
            // But FanStudio might normalize them.
            // Let's look at CENC/USGS fields from previous analysis if possible, or infer.
            // CENC usually has "cenc_earthquake" or similar if it was tagged, but here we just have raw data.
            // If it has 'eventId' and 'magnitude' but no 'epiIntensity', it might be earthquake info.
            if (msgData.eventId && msgData.magnitude !== undefined && msgData.epiIntensity === undefined) {
                return this.parseEarthquakeInfo(msgData)
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

    private parseEarthquakeWarning(data: any): DisasterEvent {
        // Determine source more specifically if possible, otherwise default to CEA
        // This is a simplification. In reality we might need to check specific fields to distinguish CEA/CWA/JMA
        let source = DataSource.FAN_STUDIO_CEA
        // If it has 'scale' instead of 'intensity', it might be JMA
        // If it has 'province' like '台湾', it might be CWA

        // For now, let's map based on some heuristics or default to CEA

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
            place_name: data.placeName || '',
            province: data.province,
            updates: data.updates || 1,
            is_final: data.isFinal || false,
            is_cancel: false, // TODO: Check for cancel signal
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

    private parseEarthquakeInfo(data: any): DisasterEvent {
        // CENC or USGS
        const earthquake: EarthquakeData = {
            id: data.id || '',
            event_id: data.eventId || data.id || '',
            source: DataSource.FAN_STUDIO_CENC, // Default to CENC
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
            source: DataSource.FAN_STUDIO_CENC,
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
            affected_areas: [], // TODO: Parse affected areas if available
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
