import { BaseDataHandler } from './base'
import { DisasterEvent, DataSource, DisasterType, EarthquakeData } from '../models'

/**
 * GlobalQuake WebSocket 消息解析器
 *
 * JSON 格式字段（来自 astrbot 参考实现）：
 *   id, latitude, longitude, depth, magnitude, region,
 *   originTimeIso / origin_time_iso / origin_time_ms,
 *   revisionId / revision_id
 */
export class GlobalQuakeHandler extends BaseDataHandler {
    constructor() {
        super('global_quake')
    }

    parseMessage(data: any): DisasterEvent | null {
        try {
            const id = data.id
            if (!id || data.magnitude == null) return null

            const lat = Number(data.latitude)
            const lon = Number(data.longitude)
            if (isNaN(lat) || isNaN(lon)) return null

            const originTime =
                data.originTimeIso ||
                data.origin_time_iso ||
                (data.origin_time_ms ? new Date(data.origin_time_ms).toISOString() : null)

            const earthquake: EarthquakeData = {
                id: String(id),
                event_id: String(id),
                source: DataSource.GLOBAL_QUAKE,
                disaster_type: DisasterType.EARTHQUAKE_WARNING,
                shock_time: (originTime && this.parseDateTime(originTime)) || new Date().toISOString(),
                latitude: lat,
                longitude: lon,
                depth: data.depth != null ? Number(data.depth) : undefined,
                magnitude: Number(data.magnitude),
                place_name: data.region || 'Global',
                updates: data.revisionId ?? data.revision_id ?? 1,
                is_final: false,
                is_cancel: false,
                raw_data: data
            }

            return {
                id: earthquake.id,
                data: earthquake,
                source: DataSource.GLOBAL_QUAKE,
                disaster_type: DisasterType.EARTHQUAKE_WARNING,
                receive_time: new Date().toISOString(),
                push_count: 0,
                raw_data: data
            }
        } catch (e) {
            this.logger.error(`[${this.sourceId}] Error parsing message:`, e)
            return null
        }
    }
}
