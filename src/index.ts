import { Context, Schema, Logger, Service } from 'koishi'
import { DisasterWarningService } from './service'
import { applyCommands } from './commands'

export const name = 'disaster-warning'
export const inject = {
    required: ['http'],
    optional: ['database']
}

export interface Config {
    enabled: boolean
    target_groups: string[]
    data_sources: {
        fan_studio: {
            enabled: boolean
            china_earthquake_warning: boolean
            taiwan_cwa_earthquake: boolean
            china_cenc_earthquake: boolean
            japan_jma_eew: boolean
            usgs_earthquake: boolean
            china_weather_alarm: boolean
            china_tsunami: boolean
        }
        p2p_earthquake: {
            enabled: boolean
            japan_jma_eew: boolean
            japan_jma_earthquake: boolean
            japan_jma_tsunami: boolean
        }
        wolfx: {
            enabled: boolean
            japan_jma_eew: boolean
            china_cenc_eew: boolean
            taiwan_cwa_eew: boolean
            japan_jma_earthquake: boolean
            china_cenc_earthquake: boolean
        }
        global_quake: {
            enabled: boolean
        }
    }
    earthquake_filters: {
        intensity_filter: {
            enabled: boolean
            min_magnitude: number
            min_intensity: number
        }
        scale_filter: {
            enabled: boolean
            min_magnitude: number
            min_scale: number
        }
        magnitude_only_filter: {
            enabled: boolean
            min_magnitude: number
        }
    }
}

export const Config: Schema<Config> = Schema.object({
    enabled: Schema.boolean().default(true).description('启用灾害预警插件'),
    target_groups: Schema.array(Schema.string()).default([]).description('需要推送消息的群号列表'),
    data_sources: Schema.object({
        fan_studio: Schema.object({
            enabled: Schema.boolean().default(true).description('启用FAN Studio数据源'),
            china_earthquake_warning: Schema.boolean().default(true).description('中国地震网地震预警'),
            taiwan_cwa_earthquake: Schema.boolean().default(true).description('台湾中央气象署：强震即时警报'),
            china_cenc_earthquake: Schema.boolean().default(false).description('中国地震台网（CENC）：地震测定'),
            japan_jma_eew: Schema.boolean().default(false).description('日本气象厅（JMA）：紧急地震速报'),
            usgs_earthquake: Schema.boolean().default(false).description('美国地质调查局（USGS）：地震测定'),
            china_weather_alarm: Schema.boolean().default(false).description('中国气象局：气象预警'),
            china_tsunami: Schema.boolean().default(false).description('自然资源部海啸预警中心：海啸预警信息'),
        }).description('FAN Studio WebSocket 数据源'),
        p2p_earthquake: Schema.object({
            enabled: Schema.boolean().default(false).description('启用P2P地震情報数据源'),
            japan_jma_eew: Schema.boolean().default(true).description('日本気象庁：緊急地震速報'),
            japan_jma_earthquake: Schema.boolean().default(true).description('日本気象庁（JMA）：地震情報'),
            japan_jma_tsunami: Schema.boolean().default(true).description('日本気象庁：津波予報'),
        }).description('P2P地震情報 WebSocket 数据源'),
        wolfx: Schema.object({
            enabled: Schema.boolean().default(false).description('启用Wolfx数据源'),
            japan_jma_eew: Schema.boolean().default(true).description('日本気象庁：緊急地震速報'),
            china_cenc_eew: Schema.boolean().default(true).description('中国地震台网（CENC）：地震预警'),
            taiwan_cwa_eew: Schema.boolean().default(true).description('台湾中央气象署：地震预警'),
            japan_jma_earthquake: Schema.boolean().default(true).description('日本気象庁（JMA）：地震情報'),
            china_cenc_earthquake: Schema.boolean().default(true).description('中国地震台网（CENC）：地震测定'),
        }).description('Wolfx API 数据源'),
        global_quake: Schema.object({
            enabled: Schema.boolean().default(false).description('启用Global Quake数据源'),
        }).description('Global Quake 服务器推送'),
    }).description('数据源配置'),
    earthquake_filters: Schema.object({
        intensity_filter: Schema.object({
            enabled: Schema.boolean().default(true).description('启用烈度过滤器'),
            min_magnitude: Schema.number().default(2.0).description('最小震级'),
            min_intensity: Schema.number().default(4.0).description('最小烈度'),
        }).description('基于震级和烈度的地震过滤器'),
        scale_filter: Schema.object({
            enabled: Schema.boolean().default(true).description('启用震度过滤器'),
            min_magnitude: Schema.number().default(2.0).description('最小震级'),
            min_scale: Schema.number().default(1.0).description('最小震度'),
        }).description('基于震级和震度的地震过滤器'),
        magnitude_only_filter: Schema.object({
            enabled: Schema.boolean().default(true).description('启用仅震级过滤器'),
            min_magnitude: Schema.number().default(4.5).description('最小震级'),
        }).description('USGS震级过滤器'),
    }).description('地震信息过滤器配置'),
})

export function apply(ctx: Context, config: Config) {
    const service = new DisasterWarningService(ctx, config)
    ctx.on('ready', () => service.start())
    ctx.on('dispose', () => service.stop())
    applyCommands(ctx, config, service)
}
