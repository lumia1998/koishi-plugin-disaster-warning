import { Context, Logger, h } from 'koishi'
import { Config } from './index'
import { DisasterEvent, DisasterType, EarthquakeData, TsunamiData, WeatherAlarmData } from './models'

const logger = new Logger('disaster-pusher')

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
        if (event.disaster_type === DisasterType.EARTHQUAKE || event.disaster_type === DisasterType.EARTHQUAKE_WARNING) {
            const data = event.data as EarthquakeData
            const filters = this.config.earthquake_filters

            // Intensity Filter
            if (filters.intensity_filter.enabled) {
                const minMag = filters.intensity_filter.min_magnitude
                const minInt = filters.intensity_filter.min_intensity

                // Pass if magnitude OR intensity condition is met (OR logic as per schema hint)
                // Wait, schema hint says "Satisfy magnitude requirement OR satisfy intensity requirement"
                // Usually it means if (mag >= minMag || int >= minInt) -> Pass

                let magPass = false
                let intPass = false

                if (data.magnitude !== undefined && data.magnitude >= minMag) magPass = true
                if (data.intensity !== undefined && data.intensity >= minInt) intPass = true

                // If neither is met (and relevant fields exist), filter out
                // If fields are missing, we might be lenient or strict. Let's be lenient if one is missing but other passes.
                if (!magPass && !intPass) return true
            }

            // Scale Filter (Japan)
            if (filters.scale_filter.enabled && data.scale !== undefined) {
                const minMag = filters.scale_filter.min_magnitude
                const minScale = filters.scale_filter.min_scale

                let magPass = false
                let scalePass = false

                if (data.magnitude !== undefined && data.magnitude >= minMag) magPass = true
                if (data.scale >= minScale) scalePass = true

                if (!magPass && !scalePass) return true
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
        const type = data.disaster_type === DisasterType.EARTHQUAKE_WARNING ? '地震预警' : '地震信息'
        const finalStr = data.is_final ? '【最终报】' : `【第${data.updates}报】`
        const cancelStr = data.is_cancel ? '【已取消】' : ''

        let msg = `${cancelStr}${type} ${finalStr}\n`
        msg += `震源：${data.place_name}\n`
        msg += `时间：${this.formatTime(data.shock_time)}\n`
        msg += `震级：M${data.magnitude?.toFixed(1) || '未知'}\n`
        msg += `深度：${data.depth !== undefined ? data.depth + 'km' : '未知'}\n`

        if (data.intensity !== undefined) {
            msg += `最大烈度：${data.intensity.toFixed(1)}\n`
        }
        if (data.scale !== undefined) {
            msg += `最大震度：${this.formatScale(data.scale)}\n`
        }

        msg += `数据源：${data.source}`
        return msg
    }

    private formatTsunami(data: TsunamiData): string {
        let msg = `【海啸预警】${data.title}\n`
        msg += `级别：${data.level}\n`
        msg += `发布单位：${data.org_unit}\n`
        if (data.forecasts && data.forecasts.length > 0) {
            msg += `预报区域：\n`
            data.forecasts.slice(0, 5).forEach((f: any) => {
                msg += `- ${f.name || f.areaName}: ${f.grade || f.level}\n`
            })
            if (data.forecasts.length > 5) msg += `...等${data.forecasts.length}个区域\n`
        }
        return msg
    }

    private formatWeather(data: WeatherAlarmData): string {
        let msg = `【气象预警】${data.headline}\n`
        msg += `类型：${data.type}\n`
        msg += `发布时间：${this.formatTime(data.issue_time || data.effective_time)}\n`
        msg += `详情：${data.description}\n`
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
        // Convert numeric scale back to JMA string (e.g. 5.5 -> 5强)
        if (scale === 4.5) return '5弱'
        if (scale === 5.0) return '5强' // Wait, 5.0 is 5强 in my logic? 
        // In p2p.ts: 50 -> 5.0. 
        // Usually 5- is 5 Lower, 5+ is 5 Upper.
        // Let's stick to simple formatting or check logic.
        // 5.0 -> 5强, 4.5 -> 5弱.
        // 5.5 -> 6弱, 6.0 -> 6强.
        if (scale === 4.5) return '5弱'
        if (scale === 5.0) return '5强'
        if (scale === 5.5) return '6弱'
        if (scale === 6.0) return '6强'
        return scale.toString()
    }

    private async broadcast(message: string | h[]) {
        for (const groupId of this.config.target_groups) {
            // Construct session string like "platform:groupId" or use bot.sendMessage
            // Koishi's broadcast method usually takes channelIds.
            // If platform_name is 'onebot', channelId is usually the group number.
            // We need to find the bot first or use ctx.broadcast.

            // ctx.broadcast(channels, content)
            // channels can be [`${platform}:${groupId}`]

            const channelId = `${this.config.platform_name}:${groupId}`
            try {
                await this.ctx.broadcast([channelId], message)
            } catch (e) {
                logger.error(`Failed to send to ${channelId}:`, e)
            }
        }
    }
}
