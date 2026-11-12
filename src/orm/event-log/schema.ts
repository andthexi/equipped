import { v } from 'valleyed'

import { Instance } from '../../instance/index.js'
import { Schema } from '../schema.js'

export const EventLogSchema = Schema.from('event_log')
	.pk('key', v.string(), () => Instance.createId())
	.field('name', v.string())
	.field('ts', v.number())
	.field('body', v.any())
	.field('by', v.nullable(v.string()))
	.build()
