import { BaseDataHandler } from './base'
import { DisasterEvent, DataSource, DisasterType, EarthquakeData } from '../models'

export class WolfxHandler extends BaseDataHandler {
    constructor(sourceId: string) {
        super(sourceId)
    }

    parseMessage(data: any): DisasterEvent | null {
        try {
            const type = data.type
            if (type === 'jma_eew') {
                return this.parseJMAEEW(data)
            } else if (type === 'cenc_eew') {
                return this.parseCENCEEW(data)
            } else if (type === 'jma_eqlist') {
                return this.parseJMAEqList(data)
            } else if (type === 'cenc_eqlist') {
                // TODO: Implement CENC EqList
                return null
            }
            return null
        } catch (e) {
            this.logger.error(`[${this.sourceId}] Error parsing message:`, e)
            return null
        }
    }

    private parseJMAEEW(data: any): DisasterEvent {
        const earthquake: EarthquakeData = {
            id: data.EventID || '',
            event_id: data.EventID || '',
            source: DataSource.WOLFX_JMA_EEW,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            shock_time: this.parseDateTime(data.OriginTime) || new Date().toISOString(),
            latitude: Number(data.Latitude) || 0,
            longitude: Number(data.Longitude) || 0,
            depth: Number(data.Depth),
            magnitude: Number(data.Magunitude || data.Magnitude),
            place_name: data.Hypocenter || '',
            scale: this.parseJMAScale(data.MaxIntensity),
            is_final: data.isFinal || false,
            is_cancel: data.isCancel || false,
            is_training: data.isTraining || false,
            updates: 1,
            raw_data: data
        }

        return {
            id: earthquake.id,
            data: earthquake,
            source: DataSource.WOLFX_JMA_EEW,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseCENCEEW(data: any): DisasterEvent {
        const earthquake: EarthquakeData = {
            id: data.ID || '',
            event_id: data.EventID || '',
            source: DataSource.WOLFX_CENC_EEW,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            shock_time: this.parseDateTime(data.OriginTime) || new Date().toISOString(),
            latitude: Number(data.Latitude) || 0,
            longitude: Number(data.Longitude) || 0,
            depth: Number(data.Depth),
            magnitude: Number(data.Magnitude),
            intensity: Number(data.MaxIntensity),
            place_name: data.HypoCenter || '',
            updates: Number(data.ReportNum) || 1,
            is_final: data.isFinal || false,
            is_cancel: false,
            raw_data: data
        }

        return {
            id: earthquake.id,
            data: earthquake,
            source: DataSource.WOLFX_CENC_EEW,
            disaster_type: DisasterType.EARTHQUAKE_WARNING,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseJMAEqList(data: any): DisasterEvent | null {
        // Find the latest earthquake (usually No1 or similar key, or we iterate)
        // The original code iterated and found the one with 'No' prefix
        let eqInfo: any = null
        for (const key in data) {
            if (key.startsWith('No') && typeof data[key] === 'object') {
                eqInfo = data[key]
                break // Assuming first one is latest
            }
        }

        if (!eqInfo) return null

        let depth = Number(eqInfo.depth)
        if (isNaN(depth) && typeof eqInfo.depth === 'string' && eqInfo.depth.endsWith('km')) {
            depth = Number(eqInfo.depth.replace('km', ''))
        }

        const earthquake: EarthquakeData = {
            id: eqInfo.md5 || '',
            event_id: eqInfo.md5 || '',
            source: DataSource.WOLFX_JMA_EQ,
            disaster_type: DisasterType.EARTHQUAKE,
            shock_time: this.parseDateTime(eqInfo.time) || new Date().toISOString(),
            latitude: Number(eqInfo.latitude) || 0,
            longitude: Number(eqInfo.longitude) || 0,
            depth: depth || 0,
            magnitude: Number(eqInfo.magnitude),
            place_name: eqInfo.location || '',
            scale: this.parseJMAScale(eqInfo.shindo),
            updates: 1,
            is_final: true,
            is_cancel: false,
            raw_data: data
        }

        return {
            id: earthquake.id,
            data: earthquake,
            source: DataSource.WOLFX_JMA_EQ,
            disaster_type: DisasterType.EARTHQUAKE,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
    }

    private parseJMAScale(scaleStr: string): number | undefined {
        if (!scaleStr) return undefined
        const match = scaleStr.match(/(\d+)(弱|強)?/)
        if (match) {
            const base = parseInt(match[1])
            const suffix = match[2]
            if (suffix === '弱') return base - 0.5
            if (suffix === '強') return base + 0.5
            return base
        }
        return undefined
    }
}
