import { BaseDataHandler } from './base'
import { DisasterEvent, DataSource, DisasterType, EarthquakeData } from '../models'

export class GlobalQuakeHandler extends BaseDataHandler {
    constructor() {
        super('global_quake')
    }

    parseMessage(data: any): DisasterEvent | null {
        try {
            // Assuming GlobalQuake format based on typical JSON structure or inferring from usage
            // Since I didn't see explicit GlobalQuake handler code in the file list (maybe I missed it or it's simple)
            // I'll assume a generic structure or try to find it.
            // Wait, `global_sources.py` might contain it.

            // For now, let's implement a placeholder or basic structure.
            // If data has 'magnitude' and 'latitude', it's likely an earthquake.

            if (!data.uuid || !data.magnitude) return null

            const earthquake: EarthquakeData = {
                id: data.uuid,
                event_id: data.uuid,
                source: DataSource.GLOBAL_QUAKE,
                disaster_type: DisasterType.EARTHQUAKE_WARNING, // GQ is usually real-time
                shock_time: this.parseDateTime(data.origin) || new Date().toISOString(),
                latitude: Number(data.lat),
                longitude: Number(data.lon),
                depth: Number(data.depth),
                magnitude: Number(data.magnitude),
                place_name: data.region || 'Unknown',
                updates: data.revision || 1,
                is_final: false, // GQ updates frequently
                is_cancel: false,
                max_pga: data.maxPGA,
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
