import { v } from 'valleyed'

import { Instance } from '../../instance'
import { Schema } from '../schema'

export const EventLogSchema = Schema.from('event_log')
	.pk('key', v.string(), () => Instance.createId())
	.field('name', v.string())
	.field('ts', v.number())
	.field('body', v.any())
	.field('by', v.nullable(v.string()))
	.build()
