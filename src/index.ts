import { Context, Schema } from 'koishi'
import { DisasterWarningService } from './service'
import { applyCommands } from './commands'

export const name = 'disaster-warning'
export const inject = {
    required: ['http'],
    optional: ['database']
}

export interface Config {
    target_groups: string[]

    data_types: {
        earthquake_warning: boolean
        earthquake_info: boolean
        tsunami_warning: boolean
        weather_alarm: boolean
    }

    regions: {
        china: boolean
        taiwan: boolean
        japan: boolean
        global: boolean
    }

    filter: {
        min_magnitude_absolute: number
        min_magnitude_for_push: number
        min_intensity_for_push: number
        min_scale_for_push: number
    }
}

export const Config: Schema<Config> = Schema.object({
    target_groups: Schema.array(Schema.string())
        .default([])
        .description('推送目标群号列表，直接填写群号即可，例如 123456789'),

    data_types: Schema.object({
        earthquake_warning: Schema.boolean().default(true).description('地震预警（实时速报，震前预警，会持续推送刷屏）'),
        earthquake_info: Schema.boolean().default(true).description('地震信息（震后测定报告，同一事件只推一次）'),
        tsunami_warning: Schema.boolean().default(true).description('海啸预警'),
        weather_alarm: Schema.boolean().default(false).description('气象预警（中国）'),
    }).description('接收的灾害类型'),

    regions: Schema.object({
        china: Schema.boolean().default(true).description('中国大陆（CEA预警 / CENC地震台网 / 气象 / 海啸）'),
        taiwan: Schema.boolean().default(true).description('台湾（CWA预警与地震报告）'),
        japan: Schema.boolean().default(true).description('日本（JMA EEW / P2P地震情报 / 海啸）'),
        global: Schema.boolean().default(false).description('全球（USGS 地震信息 / GlobalQuake 实时预警）'),
    }).description('接收的地区（数据源连接将依据此项自动开启，地震类事件会按震中位置过滤）'),

    filter: Schema.object({
        min_magnitude_absolute: Schema.number().default(3.0).description('绝对过滤震级：低于此震级直接丢弃（不推送）'),
        min_magnitude_for_push: Schema.number().default(4.0).description('推送震级门槛：震级达到此值则推送'),
        min_intensity_for_push: Schema.number().default(4.0).description('推送烈度门槛（中国）：最大烈度达到此值则推送'),
        min_scale_for_push: Schema.number().default(4.0).description('推送震度门槛（日本）：最大震度达到此值则推送（4 = 震度4）'),
    }).description('过滤阈值（地震类事件，海啸/气象不受此限制）'),
})

export function apply(ctx: Context, config: Config) {
    const service = new DisasterWarningService(ctx, config)
    ctx.on('ready', () => service.start())
    ctx.on('dispose', () => service.stop())
    applyCommands(ctx, config, service)
}
