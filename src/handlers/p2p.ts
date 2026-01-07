import { BaseDataHandler } from './base'
import { DisasterEvent, DataSource, DisasterType, EarthquakeData, TsunamiData } from '../models'

export class P2PHandler extends BaseDataHandler {
    constructor() {
        super('p2p_earthquake')
    }

    parseMessage(data: any): DisasterEvent | null {
        try {
            const code = data.code
            if (code === 556) {
                return this.parseEEW(data)
            } else if (code === 551) {
                return this.parseEarthquake(data)
            } else if (code === 552) {
                return this.parseTsunami(data)
            }
            return null
        } catch (e) {
            this.logger.error(`[${this.sourceId}] Error parsing message:`, e)
            return null
        }
    }

    private parseEEW(data: any): DisasterEvent | null {
        const earthquakeInfo = data.earthquake || {}
        const hypocenter = earthquakeInfo.hypocenter || {}
        const issueInfo = data.issue || {}
        const areas = data.areas || []

        if (data.cancelled) {
            this.logger.info(`[${this.sourceId}] EEW Cancelled`)
            // We might want to handle cancellation
            return null
        }

        let maxScale = -1
        if (earthquakeInfo.maxScale !== undefined) maxScale = earthquakeInfo.maxScale
        else if (earthquakeInfo.max_scale !== undefined) maxScale = earthquakeInfo.max_scale
        else {
            // Calculate from areas
            const scales = areas.map((a: any) => Math.max(a.scaleFrom || 0, a.scaleTo || 0))
            if (scales.length > 0) maxScale = Math.max(...scales)
        }

        const scale = maxScale !== -1 ? this.convertP2PScale(maxScale) : undefined

        const earthquake: EarthquakeData = {
            id: data.id || '',
            event_id: issueInfo.eventId || data.id || '',
            source: DataSource.P2P_EEW,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            shock_time: this.parseDateTime(earthquakeInfo.time || earthquakeInfo.originTime) || new Date().toISOString(),
            latitude: Number(hypocenter.latitude) || 0,
            longitude: Number(hypocenter.longitude) || 0,
            depth: Number(hypocenter.depth),
            magnitude: Number(hypocenter.magnitude),
            place_name: hypocenter.name || 'Unknown',
            scale: scale,
            max_scale: maxScale,
            is_final: data.is_final || false,
            is_cancel: data.cancelled || false,
            is_training: data.test || false,
            serial: issueInfo.serial,
            updates: 1, // P2P doesn't explicitly send update count in the same way, but serial might be it
            raw_data: data
        }

        return {
            id: earthquake.id,
            data: earthquake,
            source: DataSource.P2P_EEW,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseEarthquake(data: any): DisasterEvent | null {
        const earthquakeInfo = data.earthquake || {}
        const hypocenter = earthquakeInfo.hypocenter || {}

        const magnitude = Number(hypocenter.magnitude)
        const lat = Number(hypocenter.latitude)
        const lon = Number(hypocenter.longitude)

        if (isNaN(magnitude) || isNaN(lat) || isNaN(lon)) return null

        const maxScale = earthquakeInfo.maxScale !== undefined ? earthquakeInfo.maxScale : -1
        const scale = maxScale !== -1 ? this.convertP2PScale(maxScale) : undefined

        let depth = Number(hypocenter.depth)
        if (isNaN(depth)) depth = 0 // Or undefined

        const earthquake: EarthquakeData = {
            id: data.id || '',
            event_id: data.id || '',
            source: DataSource.P2P_EARTHQUAKE,
            disaster_type: DisasterType.EARTHQUAKE,
            shock_time: this.parseDateTime(earthquakeInfo.time) || new Date().toISOString(),
            latitude: lat,
            longitude: lon,
            depth: depth,
            magnitude: magnitude,
            place_name: hypocenter.name || 'Unknown',
            scale: scale,
            max_scale: maxScale,
            domestic_tsunami: earthquakeInfo.domesticTsunami,
            foreign_tsunami: earthquakeInfo.foreignTsunami,
            updates: 1,
            is_final: true,
            is_cancel: false,
            raw_data: data
        }

        return {
            id: earthquake.id,
            data: earthquake,
            source: DataSource.P2P_EARTHQUAKE,
            disaster_type: DisasterType.EARTHQUAKE,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseTsunami(data: any): DisasterEvent | null {
        // TODO: Implement Tsunami parsing if needed
        // For now return null or basic implementation
        return null
    }

    private convertP2PScale(scale: number): number | undefined {
        const mapping: Record<number, number> = {
            10: 1.0, 20: 2.0, 30: 3.0, 40: 4.0,
            45: 4.5, 46: 4.6, 50: 5.0, 55: 5.5,
            60: 6.0, 70: 7.0
        }
        return mapping[scale]
    }
}
