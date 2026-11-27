import { v } from 'valleyed'

import { Instance } from '../../instance/index.js'
import { Schema } from '../schema.js'

export const EventLogSchema = Schema.from('event_log')
	.pk('key', { input: v.string(), generate: () => Instance.createId() })
	.field('name', { input: v.string() })
	.field('ts', { input: v.number() })
	.field('body', { input: v.any() })
	.field('by', { input: v.nullable(v.string()) })
	.build()
