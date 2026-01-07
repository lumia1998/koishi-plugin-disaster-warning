import { Logger } from 'koishi'
import { DisasterEvent } from '../models'

const logger = new Logger('disaster-warning')

export abstract class BaseDataHandler {
    protected sourceId: string
    protected logger: Logger

    constructor(sourceId: string) {
        this.sourceId = sourceId
        this.logger = logger
    }

    abstract parseMessage(message: any): DisasterEvent | null

    protected parseDateTime(timeStr: string): string | undefined {
        if (!timeStr) return undefined
        try {
            // Try to parse as ISO string or other formats
            // JS Date constructor is quite flexible
            const date = new Date(timeStr)
            if (isNaN(date.getTime())) {
                this.logger.warn(`[${this.sourceId}] Failed to parse time: ${timeStr}`)
                return undefined
            }
            return date.toISOString()
        } catch (e) {
            this.logger.warn(`[${this.sourceId}] Failed to parse time: ${timeStr}`)
            return undefined
        }
    }
}
