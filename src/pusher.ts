import { Context, Logger, h } from 'koishi'
import { Config } from './index'
import { DisasterEvent, DisasterType, EarthquakeData, TsunamiData, WeatherAlarmData } from './models'

const logger = new Logger('disaster-pusher')

// Hardcoded filter thresholds - no user configuration needed
const FILTER_THRESHOLDS = {
    MIN_MAGNITUDE_ABSOLUTE: 3.0,      // Always ignore earthquakes below M3.0
    MIN_MAGNITUDE_FOR_PUSH: 4.0,      // Push if magnitude >= 4.0
    MIN_INTENSITY_FOR_PUSH: 4.0,      // Or push if intensity >= 4.0 (China)
    MIN_SCALE_FOR_PUSH: 4.0,          // Or push if shindo scale >= 4 (Japan)
}

export class MessagePushManager {
    constructor(private ctx: Context, private config: Config) { }

    async pushEvent(event: DisasterEvent) {
        if (this.shouldFilter(event)) {
            logger.debug(`Event ${event.id} filtered.`)
            return
        }

        const message = this.formatMessage(event)
        if (!message) return

        logger.info(`Pushing event ${event.id} to ${this.config.target_groups.length} groups.`)
        await this.broadcast(message)
    }

    private shouldFilter(event: DisasterEvent): boolean {
        // Only filter earthquake events
        if (event.disaster_type !== DisasterType.EARTHQUAKE && event.disaster_type !== DisasterType.EARTHQUAKE_WARNING) {
            return false // Don't filter tsunami/weather
        }

        const data = event.data as EarthquakeData
        const { MIN_MAGNITUDE_ABSOLUTE, MIN_MAGNITUDE_FOR_PUSH, MIN_INTENSITY_FOR_PUSH, MIN_SCALE_FOR_PUSH } = FILTER_THRESHOLDS

        // Always filter out very small earthquakes
        if (data.magnitude !== undefined && data.magnitude < MIN_MAGNITUDE_ABSOLUTE) {
            return true
        }

        // Pass if magnitude is significant
        if (data.magnitude !== undefined && data.magnitude >= MIN_MAGNITUDE_FOR_PUSH) {
            return false
        }

        // Pass if intensity is significant (Chinese sources)
        if (data.intensity !== undefined && data.intensity >= MIN_INTENSITY_FOR_PUSH) {
            return false
        }

        // Pass if scale is significant (Japanese sources)
        if (data.scale !== undefined && data.scale >= MIN_SCALE_FOR_PUSH) {
            return false
        }

        // If magnitude is between 3.0-4.0 and no significant intensity/scale, filter out
        if (data.magnitude !== undefined && data.magnitude >= MIN_MAGNITUDE_ABSOLUTE && data.magnitude < MIN_MAGNITUDE_FOR_PUSH) {
            // Only filter if we don't have intensity/scale data that would make it significant
            if (data.intensity === undefined && data.scale === undefined) {
                return true
            }
        }

        return false
    }

    private formatMessage(event: DisasterEvent): string | h[] {
        switch (event.disaster_type) {
            case DisasterType.EARTHQUAKE:
            case DisasterType.EARTHQUAKE_WARNING:
                return this.formatEarthquake(event.data as EarthquakeData)
            case DisasterType.TSUNAMI:
                return this.formatTsunami(event.data as TsunamiData)
            case DisasterType.WEATHER_ALARM:
                return this.formatWeather(event.data as WeatherAlarmData)
            default:
                return `Unknown disaster event: ${event.disaster_type}`
        }
    }

    private formatEarthquake(data: EarthquakeData): string {
        const type = data.disaster_type === DisasterType.EARTHQUAKE_WARNING ? '🚨 地震预警' : '📋 地震信息'
        const finalStr = data.is_final ? '【最终报】' : `【第${data.updates}报】`
        const cancelStr = data.is_cancel ? '【已取消】' : ''

        let msg = `${cancelStr}${type} ${finalStr}\n`
        msg += `📍 震源：${data.place_name}\n`
        msg += `🕐 时间：${this.formatTime(data.shock_time)}\n`
        msg += `📊 震级：M${data.magnitude?.toFixed(1) || '未知'}\n`
        msg += `📏 深度：${data.depth !== undefined ? data.depth + 'km' : '未知'}\n`

        if (data.intensity !== undefined) {
            msg += `🔥 最大烈度：${data.intensity.toFixed(1)}\n`
        }
        if (data.scale !== undefined) {
            msg += `🎚️ 最大震度：${this.formatScale(data.scale)}\n`
        }

        msg += `📡 数据源：${this.formatSource(data.source)}`
        return msg
    }

    private formatTsunami(data: TsunamiData): string {
        let msg = `🌊 【海啸预警】${data.title}\n`
        msg += `⚠️ 级别：${data.level}\n`
        msg += `🏛️ 发布单位：${data.org_unit}\n`
        if (data.forecasts && data.forecasts.length > 0) {
            msg += `📍 预报区域：\n`
            data.forecasts.slice(0, 5).forEach((f: any) => {
                msg += `  • ${f.name || f.areaName}: ${f.grade || f.level}\n`
            })
            if (data.forecasts.length > 5) msg += `  ...等${data.forecasts.length}个区域\n`
        }
        return msg
    }

    private formatWeather(data: WeatherAlarmData): string {
        let msg = `⛈️ 【气象预警】${data.headline}\n`
        msg += `📋 类型：${data.type}\n`
        msg += `🕐 发布时间：${this.formatTime(data.issue_time || data.effective_time)}\n`
        msg += `📝 详情：${data.description}\n`
        return msg
    }

    private formatTime(isoStr: string): string {
        try {
            return new Date(isoStr).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        } catch {
            return isoStr
        }
    }

    private formatScale(scale: number): string {
        const scaleMap: Record<number, string> = {
            1.0: '1', 2.0: '2', 3.0: '3', 4.0: '4',
            4.5: '5弱', 5.0: '5强', 5.5: '6弱', 6.0: '6强', 7.0: '7'
        }
        return scaleMap[scale] || scale.toString()
    }

    private formatSource(source: string): string {
        const sourceMap: Record<string, string> = {
            'fan_studio_cea': '中国地震预警网',
            'fan_studio_cwa': '台湾中央气象署',
            'fan_studio_cenc': '中国地震台网',
            'fan_studio_jma': '日本气象厅',
            'fan_studio_usgs': 'USGS',
            'fan_studio_weather': '中国气象局',
            'fan_studio_tsunami': '海啸预警中心',
            'p2p_eew': 'P2P地震情報',
            'p2p_earthquake': 'P2P地震情報',
            'p2p_tsunami': '日本气象厅',
            'wolfx_jma_eew': 'Wolfx-JMA',
            'wolfx_cenc_eew': 'Wolfx-CENC',
            'wolfx_cwa_eew': 'Wolfx-CWA',
            'wolfx_jma_eq': 'Wolfx-JMA',
            'wolfx_cenc_eq': 'Wolfx-CENC',
            'global_quake': 'GlobalQuake'
        }
        return sourceMap[source] || source
    }

    private async broadcast(message: string | h[]) {
        for (const groupId of this.config.target_groups) {
            const channelId = groupId.includes(':') ? groupId : `onebot:${groupId}`
            try {
                await this.ctx.broadcast([channelId], message)
            } catch (e) {
                logger.error(`Failed to send to ${channelId}:`, e)
            }
        }
    }
}
