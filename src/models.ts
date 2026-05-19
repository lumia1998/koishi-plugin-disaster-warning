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
 * 用 place+magnitude+分钟桶 作为指纹，窗口期内同一事件只推一次
 */
export class EventDeduplicator {
    // fingerprint -> first-seen timestamp (ms)
    private seen = new Map<string, number>()
    private windowMs: number

    constructor(windowMs = 5 * 60 * 1000) {
        this.windowMs = windowMs
    }

    /** 返回 true 表示已见过（应丢弃），false 表示首次（应推送） */
    isDuplicate(event: DisasterEvent): boolean {
        this.evict()
        const fp = this.fingerprint(event)
        if (this.seen.has(fp)) return true
        this.seen.set(fp, Date.now())
        return false
    }

    private fingerprint(event: DisasterEvent): string {
        const data = event.data as EarthquakeData
        if (event.disaster_type === DisasterType.EARTHQUAKE || event.disaster_type === DisasterType.EARTHQUAKE_WARNING) {
            // 优先用 event_id，相同机构的多数据源共享同一 event_id
            if (data.event_id) return `eq:${data.event_id}`
            // 降级：地点 + 震级 + 分钟桶
            const bucket = data.shock_time ? data.shock_time.slice(0, 16) : 'unknown'
            return `eq:${data.place_name}|${data.magnitude?.toFixed(1)}|${bucket}`
        }
        // 海啸/气象用 id 即可
        return `${event.disaster_type}:${event.id}`
    }

    private evict() {
        const cutoff = Date.now() - this.windowMs
        for (const [fp, ts] of this.seen) {
            if (ts < cutoff) this.seen.delete(fp)
        }
    }
}
