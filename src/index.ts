import { Context, Schema, Logger } from 'koishi'
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

    // 数据类型
    data_types: {
        earthquake_warning: boolean  // 地震预警（实时速报）
        earthquake_info: boolean     // 地震信息（震后报告）
        tsunami_warning: boolean     // 海啸预警
        weather_alarm: boolean       // 气象预警
    }

    // 地区过滤
    regions: {
        china: boolean      // 中国大陆
        taiwan: boolean     // 台湾
        japan: boolean      // 日本
        global: boolean     // 全球（USGS/GlobalQuake）
    }

    // 数据源优先级
    source_priority: 'auto' | 'wolfx' | 'fanstudio' | 'p2p'
}

export const Config: Schema<Config> = Schema.object({
    enabled: Schema.boolean().default(true).description('启用灾害预警插件'),
    target_groups: Schema.array(Schema.string()).default([]).description('推送目标群号列表，格式: 平台:群号（如 onebot:123456）'),

    data_types: Schema.object({
        earthquake_warning: Schema.boolean().default(true).description('地震预警（实时速报，震前预警）'),
        earthquake_info: Schema.boolean().default(true).description('地震信息（震后测定报告）'),
        tsunami_warning: Schema.boolean().default(true).description('海啸预警'),
        weather_alarm: Schema.boolean().default(false).description('气象预警（中国）'),
    }).description('接收的灾害类型'),

    regions: Schema.object({
        china: Schema.boolean().default(true).description('中国大陆'),
        taiwan: Schema.boolean().default(true).description('台湾'),
        japan: Schema.boolean().default(true).description('日本'),
        global: Schema.boolean().default(false).description('全球（USGS/GlobalQuake）'),
    }).description('接收的地区'),

    source_priority: Schema.union([
        Schema.const('auto').description('自动选择最佳数据源'),
        Schema.const('wolfx').description('优先使用 Wolfx API'),
        Schema.const('fanstudio').description('优先使用 FAN Studio'),
        Schema.const('p2p').description('优先使用 P2P地震情報'),
    ]).default('auto').description('数据源优先级'),
})

export function apply(ctx: Context, config: Config) {
    const service = new DisasterWarningService(ctx, config)
    ctx.on('ready', () => service.start())
    ctx.on('dispose', () => service.stop())
    applyCommands(ctx, config, service)
}
