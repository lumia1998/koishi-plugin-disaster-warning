export enum DisasterType {
    EARTHQUAKE = "earthquake",
    EARTHQUAKE_WARNING = "earthquake_warning",
    TSUNAMI = "tsunami",
    WEATHER_ALARM = "weather_alarm",
}

export enum DataSource {
    // FAN Studio
    FAN_STUDIO_CENC = "fan_studio_cenc",
    FAN_STUDIO_CEA = "fan_studio_cea",
    FAN_STUDIO_CWA = "fan_studio_cwa",
    FAN_STUDIO_USGS = "fan_studio_usgs",
    FAN_STUDIO_JMA = "fan_studio_jma",
    FAN_STUDIO_WEATHER = "fan_studio_weather",
    FAN_STUDIO_TSUNAMI = "fan_studio_tsunami",

    // P2P
    P2P_EEW = "p2p_eew",
    P2P_EARTHQUAKE = "p2p_earthquake",
    P2P_TSUNAMI = "p2p_tsunami",

    // Wolfx
    WOLFX_JMA_EEW = "wolfx_jma_eew",
    WOLFX_CENC_EEW = "wolfx_cenc_eew",
    WOLFX_CWA_EEW = "wolfx_cwa_eew",
    WOLFX_CENC_EQ = "wolfx_cenc_eq",
    WOLFX_JMA_EQ = "wolfx_jma_eq",

    // Global Quake
    GLOBAL_QUAKE = "global_quake",
}

export const DATA_SOURCE_MAPPING: Record<string, DataSource> = {
    "cea_fanstudio": DataSource.FAN_STUDIO_CEA,
    "cea_wolfx": DataSource.WOLFX_CENC_EEW,
    "cwa_fanstudio": DataSource.FAN_STUDIO_CWA,
    "cwa_wolfx": DataSource.WOLFX_CWA_EEW,
    "jma_fanstudio": DataSource.FAN_STUDIO_JMA,
    "jma_p2p": DataSource.P2P_EEW,
    "jma_wolfx": DataSource.WOLFX_JMA_EEW,
    "global_quake": DataSource.GLOBAL_QUAKE,
    "cenc_fanstudio": DataSource.FAN_STUDIO_CENC,
    "cenc_wolfx": DataSource.WOLFX_CENC_EQ,
    "jma_p2p_info": DataSource.P2P_EARTHQUAKE,
    "jma_wolfx_info": DataSource.WOLFX_JMA_EQ,
    "usgs_fanstudio": DataSource.FAN_STUDIO_USGS,
    "china_weather_fanstudio": DataSource.FAN_STUDIO_WEATHER,
    "china_tsunami_fanstudio": DataSource.FAN_STUDIO_TSUNAMI,
    "jma_tsunami_p2p": DataSource.P2P_TSUNAMI,
}

export function getDataSourceFromId(id: string): DataSource | undefined {
    return DATA_SOURCE_MAPPING[id];
}

export interface EarthquakeData {
    id: string;
    event_id: string;
    source: DataSource;
    disaster_type: DisasterType;
    shock_time: string; // ISO string
    latitude: number;
    longitude: number;
    place_name: string;
    depth?: number;
    magnitude?: number;
    intensity?: number;
    scale?: number;
    max_intensity?: number;
    max_scale?: number;
    province?: string;
    updates: number;
    is_final: boolean;
    is_cancel: boolean;
    info_type?: string;
    domestic_tsunami?: string;
    foreign_tsunami?: string;
    update_time?: string;
    create_time?: string;
    source_id?: string;
    report_num?: number;
    serial?: string;
    is_training?: boolean;
    revision?: number;
    max_pga?: number;
    stations?: Record<string, number>;
    raw_data: any;
}

export interface TsunamiData {
    id: string;
    code: string;
    source: DataSource;
    title: string;
    level: string;
    disaster_type: DisasterType;
    subtitle?: string;
    org_unit: string;
    issue_time?: string;
    forecasts: any[];
    monitoring_stations: any[];
    source_id?: string;
    estimated_arrival_time?: string;
    max_wave_height?: string;
    raw_data: any;
}

export interface WeatherAlarmData {
    id: string;
    source: DataSource;
    headline: string;
    title: string;
    description: string;
    type: string;
    effective_time: string;
    disaster_type: DisasterType;
    issue_time?: string;
    longitude?: number;
    latitude?: number;
    source_id?: string;
    alert_level?: string;
    affected_areas: string[];
    raw_data: any;
}

export interface DisasterEvent {
    id: string;
    data: EarthquakeData | TsunamiData | WeatherAlarmData;
    source: DataSource;
    disaster_type: DisasterType;
    receive_time: string;
    source_id?: string;
    processing_time?: string;
    is_filtered?: boolean;
    filter_reason?: string;
    push_count: number;
    raw_data: any;
}

/**
 * 跨数据源事件去重器
 * 地震预警按报次去重，允许后续修正继续推送；震后测定按内容去重，同一事件只推一次。
 */
export class EventDeduplicator {
    // fingerprint -> expire timestamp (ms)
    private seen = new Map<string, number>()
    private warningWindowMs: number
    private earthquakeInfoWindowMs: number

    constructor(warningWindowMs = 8 * 60 * 1000, earthquakeInfoWindowMs = 7 * 24 * 60 * 60 * 1000) {
        this.warningWindowMs = warningWindowMs
        this.earthquakeInfoWindowMs = earthquakeInfoWindowMs
    }

    /** 返回 true 表示已见过（应丢弃），false 表示首次（应推送） */
    isDuplicate(event: DisasterEvent): boolean {
        this.evict()
        const fp = this.fingerprint(event)
        if (this.seen.has(fp)) return true
        this.seen.set(fp, Date.now() + this.ttlFor(event))
        return false
    }

    private fingerprint(event: DisasterEvent): string {
        const data = event.data as EarthquakeData
        if (event.disaster_type === DisasterType.EARTHQUAKE_WARNING) {
            const eventId = data.event_id || this.fallbackEarthquakeId(data)
            const revision = data.revision ?? data.report_num ?? data.serial ?? data.updates ?? 'unknown'
            const status = data.is_cancel ? 'cancel' : data.is_final ? 'final' : 'update'
            return `eqw:${eventId}|${revision}|${status}`
        }

        if (event.disaster_type === DisasterType.EARTHQUAKE) {
            return `eq:${this.earthquakeInfoFingerprint(data)}`
        }
        // 海啸/气象用 id 即可
        return `${event.disaster_type}:${event.id}`
    }

    private ttlFor(event: DisasterEvent): number {
        return event.disaster_type === DisasterType.EARTHQUAKE
            ? this.earthquakeInfoWindowMs
            : this.warningWindowMs
    }

    private earthquakeInfoFingerprint(data: EarthquakeData): string {
        const originTime = this.normalizeTime(data.shock_time)
        const location = this.normalizeLocation(data)
        const magnitude = this.normalizeNumber(data.magnitude, 1)
        const depth = this.normalizeNumber(data.depth, 1)
        const intensity = this.normalizeNumber(data.intensity, 1)
        const scale = this.normalizeNumber(data.scale, 1)
        return `${location}|${originTime}|M${magnitude}|D${depth}|I${intensity}|S${scale}`
    }

    private fallbackEarthquakeId(data: EarthquakeData): string {
        const originTime = this.normalizeTime(data.shock_time)
        const location = this.normalizeLocation(data)
        return `${location}|${data.magnitude?.toFixed(1)}|${originTime}`
    }

    private normalizeLocation(data: EarthquakeData): string {
        const place = data.place_name?.replace(/\s+/g, '').trim()
        if (place) return place

        const lat = Number.isFinite(data.latitude) ? data.latitude.toFixed(2) : 'unknown'
        const lon = Number.isFinite(data.longitude) ? data.longitude.toFixed(2) : 'unknown'
        return `${lat},${lon}`
    }

    private normalizeTime(time: string | undefined): string {
        if (!time) return 'unknown'
        const date = new Date(time)
        if (isNaN(date.getTime())) return time.slice(0, 19)
        return date.toISOString().slice(0, 19)
    }

    private normalizeNumber(value: number | undefined, digits: number): string {
        return Number.isFinite(value) ? value!.toFixed(digits) : 'unknown'
    }

    private evict() {
        const now = Date.now()
        for (const [fp, expiresAt] of this.seen) {
            if (expiresAt < now) this.seen.delete(fp)
        }
    }
}
