import { type ConditionalObjectKeys, type PipeInput, type PipeOutput, v } from 'valleyed'

export const instanceSettingsPipe = () =>
	v.object({
		app: v.object({
			name: v.string(),
		}),
		log: v.defaults(
			v.object({
				level: v.defaults(
					v.in(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const),
					'info',
				),
			}),
			{},
		),
		utils: v.defaults(
			v.object({
				hashSaltRounds: v.defaults(v.number(), 10),
				paginationDefaultLimit: v.defaults(v.number(), 100),
				maxFileUploadSizeInMb: v.defaults(v.number(), 500),
			}),
			{},
		),
	})

export type Settings = PipeOutput<ReturnType<typeof instanceSettingsPipe>>
export type SettingsInput = ConditionalObjectKeys<PipeInput<ReturnType<typeof instanceSettingsPipe>>>
