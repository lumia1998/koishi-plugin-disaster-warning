import { Context, Logger, h } from 'koishi'
import { Config } from './index'
import { DisasterWarningService } from './service'

const logger = new Logger('disaster-commands')

export function applyCommands(ctx: Context, config: Config, service: DisasterWarningService) {
    ctx.command('disaster', '灾害预警插件')

    ctx.command('disaster.test', '发送测试预警消息')
        .action(async ({ session }) => {
            if (!session) return
            await session.send('正在发送测试消息...')

            const testEvent = {
                id: 'test_event_' + Date.now(),
                data: {
                    id: 'test_id',
                    event_id: 'test_event_id',
                    source: 'Test Source',
                    disaster_type: 'earthquake_warning',
                    shock_time: new Date().toISOString(),
                    latitude: 30.0,
                    longitude: 120.0,
                    depth: 10,
                    magnitude: 5.0,
                    intensity: 4.0,
                    place_name: '测试地点',
                    updates: 1,
                    is_final: false,
                    is_cancel: false,
                    raw_data: {}
                },
                source: 'test' as any,
                disaster_type: 'earthquake_warning' as any,
                receive_time: new Date().toISOString(),
                push_count: 0,
                raw_data: {}
            }

            // We can use the service's pusher to format and send, 
            // but pusher broadcasts to configured groups. 
            // Here we might want to send to the current session.
            // Let's manually format it using a simplified version or expose pusher's formatter.
            // For simplicity, let's just send a text message here.

            const msg = [
                '【测试消息】',
                '这是一个测试用的地震预警消息。',
                '震源：测试地点',
                `时间：${new Date().toLocaleString()}`,
                '震级：M5.0',
                '最大烈度：4.0'
            ].join('\n')

            return msg
        })

    ctx.command('disaster.history', '查看最近地震记录 (CENC)')
        .action(async ({ session }) => {
            try {
                const data = await ctx.http.get('https://api.wolfx.jp/cenc_eqlist.json')
                if (!data) return '获取数据失败'

                const list = []
                let count = 0
                for (const key in data) {
                    if (key.startsWith('No') && count < 5) {
                        const eq = data[key]
                        list.push(eq)
                        count++
                    }
                }

                if (list.length === 0) return '未找到最近地震记录'

                const messages = list.map(eq => {
                    return `时间: ${eq.time}\n地点: ${eq.location}\n震级: M${eq.magnitude}\n深度: ${eq.depth}km`
                })

                return messages.join('\n\n')
            } catch (e) {
                logger.error('Failed to fetch history:', e)
                return '获取历史记录失败，请检查网络或日志。'
            }
        })
}
