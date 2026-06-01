import { Context, Schema } from 'koishi'
import { DisasterWarningService } from './service'
import { applyCommands } from './commands'
import { applyChatLunaTools } from './chatluna'

export const name = 'disaster-warning'
export const inject = {
    required: ['http'],
    optional: ['database', 'chatluna']
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

    chatluna: {
        enabled: boolean
        name: string
        description: string
        default_source: 'all' | 'cenc' | 'jma' | 'usgs'
        default_limit: number
        default_days: number
        min_magnitude: number
        include_usgs_when_all: boolean
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

    chatluna: Schema.object({
        enabled: Schema.boolean().default(false).description('开启后注册 ChatLuna 工具，供模型主动查询近期地震与数据源状态'),
        name: Schema.string().default('disaster_warning').description('ChatLuna 工具名称'),
        description: Schema.string().default('查询近期地震和灾害预警数据源状态，可按地点、震级、时间范围过滤。适合回答“哪里地震了”“某地最近有没有地震”“关心的人所在地区是否有地震”等问题。').description('ChatLuna 工具描述'),
        default_source: Schema.union([
            Schema.const('all').description('综合 CENC / JMA / USGS'),
            Schema.const('cenc').description('中国地震台网 / Wolfx CENC'),
            Schema.const('jma').description('日本气象厅 / Wolfx JMA'),
            Schema.const('usgs').description('USGS 全球地震')
        ]).default('all').description('模型未指定数据源时的默认查询源'),
        default_limit: Schema.number().default(8).min(1).max(50).description('模型未指定 limit 时最多返回多少条'),
        default_days: Schema.number().default(7).min(1).max(30).description('模型未指定 days 时查询最近多少天'),
        min_magnitude: Schema.number().default(4.0).min(0).max(10).description('模型未指定 min_magnitude 时的最低震级'),
        include_usgs_when_all: Schema.boolean().default(true).description('default_source/all 查询时是否包含 USGS 全球地震')
    }).description('ChatLuna 工具调用'),
})

export function apply(ctx: Context, config: Config) {
    const service = new DisasterWarningService(ctx, config)
    ctx.on('ready', () => service.start())
    ctx.on('dispose', () => service.stop())
    applyCommands(ctx, config, service)
    applyChatLunaTools(ctx, config, service)
}
