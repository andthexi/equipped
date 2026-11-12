import type { Pipe } from 'valleyed'

import type { InferAdapterConfig } from '../../adapter.js'
import type { OrmAdapterLike } from '../../adapters/base.js'
import { composeSchemaConfig } from '../../schema-validations.js'
import { currentTransforms } from '../als.js'

type ConfigState<C> = {
	resolve: (name: string) => C
	pipe?: Pipe<any, any>
}

const states = new WeakMap<object, ConfigState<any>>()

export function registerRepoConfig<A extends OrmAdapterLike<any>>(
	repo: object,
	resolve: (name: string) => InferAdapterConfig<A>,
	pipe?: Pipe<any, any>,
): void {
	states.set(repo, { resolve, pipe })
}

export function resolveRepoConfig<A extends OrmAdapterLike<any>>(repo: object, name: string): InferAdapterConfig<A> {
	const state = states.get(repo) as ConfigState<InferAdapterConfig<A>> | undefined
	if (!state) throw new Error('Repo config resolver is not registered')

	const transforms = [...currentTransforms<InferAdapterConfig<A>>()]
	if (state.pipe) {
		return composeSchemaConfig(state.resolve, transforms, name, state.pipe) as InferAdapterConfig<A>
	}

	let config = state.resolve(name)
	for (const transform of transforms) config = transform(config, name)
	return config
}
