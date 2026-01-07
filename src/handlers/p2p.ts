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
            // Return a cancelled event so it can be broadcasted
            const earthquake: EarthquakeData = {
                id: data.id || '',
                event_id: issueInfo.eventId || data.id || '',
                source: DataSource.P2P_EEW,
                disaster_type: DisasterType.EARTHQUAKE_WARNING,
                shock_time: new Date().toISOString(),
                latitude: 0,
                longitude: 0,
                place_name: '取消',
                updates: 1,
                is_final: true,
                is_cancel: true,
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
            updates: 1,
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
        if (isNaN(depth)) depth = 0

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
        // P2P Tsunami format (code 552)
        // Reference: https://www.p2pquake.net/json_api_v2/
        const issueInfo = data.issue || {}
        const areas = data.areas || []

        // Determine tsunami level from areas
        let maxGrade = ''
        const gradeOrder = ['Warning', 'Watch', 'Advisory', 'Unknown']

        for (const area of areas) {
            const grade = area.grade || ''
            if (!maxGrade || gradeOrder.indexOf(grade) < gradeOrder.indexOf(maxGrade)) {
                maxGrade = grade
            }
        }

        // Map grade to Chinese
        const gradeMap: Record<string, string> = {
            'MajorWarning': '大津波警报',
            'Warning': '津波警报',
            'Watch': '津波注意报',
            'Advisory': '津波予报',
            'Unknown': '未知'
        }

        const forecasts = areas.map((a: any) => ({
            name: a.name || '',
            grade: gradeMap[a.grade] || a.grade || '',
            immediate: a.immediate || false,
            firstHeight: a.firstHeight,
            maxHeight: a.maxHeight
        }))

        const tsunami: TsunamiData = {
            id: data.id || `tsunami_${Date.now()}`,
            code: String(data.code),
            source: DataSource.P2P_TSUNAMI,
            title: issueInfo.type === 'Focus' ? '津波情報（各地の満潮時刻・津波到達予想時刻）' : '津波予報',
            level: gradeMap[maxGrade] || maxGrade || 'Unknown',
            disaster_type: DisasterType.TSUNAMI,
            org_unit: '気象庁',
            issue_time: this.parseDateTime(issueInfo.time),
            forecasts: forecasts,
            monitoring_stations: [],
            raw_data: data
        }

        return {
            id: tsunami.id,
            data: tsunami,
            source: DataSource.P2P_TSUNAMI,
            disaster_type: DisasterType.TSUNAMI,
            receive_time: new Date().toISOString(),
            push_count: 0,
            raw_data: data
        }
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
