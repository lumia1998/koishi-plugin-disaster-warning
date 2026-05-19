import { Context, Logger } from 'koishi'
import { Config } from './index'
import { DisasterWarningService } from './service'

const logger = new Logger('disaster-commands')

export function applyCommands(ctx: Context, config: Config, service: DisasterWarningService) {
    ctx.command('disaster', '灾害预警插件')

    // disaster.status — 查看各 WebSocket 连接状态
    ctx.command('disaster.status', '查看各数据源连接状态')
        .action(() => {
            const status = service.getStatus()
            const lines = ['📡 数据源连接状态：']
            for (const [name, s] of Object.entries(status)) {
                const icon = s.connected ? '🟢' : '🔴'
                const retry = s.retryCount > 0 ? ` (重试: ${s.retryCount})` : ''
                lines.push(`${icon} ${name}${retry}`)
            }
            return lines.join('\n')
        })

    // disaster.test — 发送测试消息
    ctx.command('disaster.test', '发送测试预警消息')
        .action(() => {
            return [
                '【测试消息】',
                '这是一个测试用的地震预警消息。',
                '震源：测试地点',
                `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
                '震级：M5.0',
                '最大烈度：4.0'
            ].join('\n')
        })

    // disaster.history — 查询最近地震记录
    ctx.command('disaster.history [source:string] [count:number]', '查询最近地震记录')
        .usage('source: cenc（中国）或 jma（日本），默认 cenc\ncount: 条数，默认 5，最多 10')
        .action(async ({ session }, source = 'cenc', count = 5) => {
            source = source.toLowerCase()
            if (source !== 'cenc' && source !== 'jma') {
                return '❌ 数据源只支持 cenc 或 jma'
            }
            count = Math.min(Math.max(1, count), 10)

            // 先尝试从内存缓存读取（避免重复 HTTP 请求）
            const cache = service.getEqListCache()
            let data = cache[source as 'cenc' | 'jma']

            // 缓存为空时实时拉取
            if (!data || Object.keys(data).length === 0) {
                try {
                    const url = source === 'cenc'
                        ? 'https://api.wolfx.jp/cenc_eqlist.json'
                        : 'https://api.wolfx.jp/jma_eqlist.json'
                    data = await ctx.http.get(url)
                } catch (e) {
                    logger.error('Failed to fetch eqlist:', e)
                    return '❌ 获取数据失败，请检查网络或日志。'
                }
            }

            if (!data) return '❌ 未获取到数据'

            const items: any[] = []
            let n = 1
            while (items.length < count && data[`No${n}`]) {
                items.push(data[`No${n}`])
                n++
            }

            if (!items.length) return '暂无地震记录'

            const sourceName = source === 'cenc' ? 'CENC 中国地震台网' : 'JMA 日本气象厅'
            const lines = [`📋 最近 ${items.length} 条地震记录（${sourceName}）：`, '']
            items.forEach((eq, i) => {
                const intensity = eq.shindo
                    ? `震度 ${eq.shindo}`
                    : eq.intensity
                        ? `烈度 ${eq.intensity}`
                        : ''
                lines.push(
                    `[${i + 1}] ${eq.time}`,
                    `    📍 ${eq.location}  M${eq.magnitude}  深度 ${eq.depth}${intensity ? `  ${intensity}` : ''}`,
                    ''
                )
            })

            return lines.join('\n').trim()
        })
}
