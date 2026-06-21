import { convert } from '@openapi-contrib/json-schema-to-openapi-schema'
import type { OpenAPIV3_1 } from 'openapi-types'
import { capitalize, type JsonSchema } from 'valleyed'

import { Instance } from '../instance'
import type { ServerConfig } from './adapters/base'
import { Router } from './routes'
import { StatusCodes, type Route } from './types'

declare module 'openapi-types' {
	namespace OpenAPIV3 {
		interface Document {
			'x-tagGroups': { name: string; tags: string[] }[]
		}
		interface TagObject {
			'x-displayName': string
		}
	}
}

export type OpenApiSchemaDef = {
	request: Partial<Record<'body' | 'query' | 'params' | 'headers' | 'response', JsonSchema>>
	response: Partial<Record<'response' | 'responseHeaders', { status: number; schema: JsonSchema; contentType: string }[]>>
}

export const openapi = (config: ServerConfig) => {
	const instance = Instance.get()
	const { app } = instance.settings
	const baseOpenapiDoc: OpenAPIV3_1.Document = {
		openapi: '3.0.0',
		info: {
			title: `${app.name} ${instance.id}`,
			version: config.openapi.docsVersion ?? '',
		},
		servers: config.openapi.docsBaseUrl?.map((url) => ({ url })),
		paths: {},
		components: {
			schemas: {},
			securitySchemes: {
				Authorization: {
					type: 'apiKey',
					name: 'authorization',
					in: 'header',
				},
				RefreshToken: {
					type: 'apiKey',
					name: 'x-refresh-token',
					in: 'header',
				},
				ApiKey: {
					type: 'apiKey',
					name: 'x-api-key',
					in: 'header',
				},
			},
		},
		tags: [],
		'x-tagGroups': [],
	}

	const registeredTags: Record<string, boolean> = {}
	const registeredTagGroups: Record<string, { name: string; tags: string[] }> = {}

	const flattenForParameters = (node: JsonSchema): JsonSchema[] => {
		const { allOf, oneOf, anyOf, ...schema } = node
		if (allOf) return allOf.flatMap((n) => flattenForParameters(n))
		return [schema]
	}

	const visit = (node: JsonSchema) => {
		if (!node || typeof node !== 'object') return node
		if (typeof node.$refId === 'string') {
			const { $refId: id, ...rest } = node
			const res = visit(rest)
			if (baseOpenapiDoc.components?.schemas) {
				baseOpenapiDoc.components.schemas[id] = res
				return { $ref: `#/components/schemas/${id}` }
			} else return res
		}

		if (Array.isArray(node)) return node.map((n) => visit(n)) as any
		return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value as any)]))
	}

	const buildTag = (groups: NonNullable<Route<any>['groups']>) => {
		if (!groups.length) return undefined
		const parsed = groups.map((g) => (typeof g === 'string' ? { name: g } : g))
		const name = parsed.map((g) => g.name).join(' > ')
		const displayName = parsed.at(-1)?.name ?? ''
		const description = parsed
			.map((g) => g.description?.trim() ?? '')
			.filter(Boolean)
			.join('\n\n\n\n')

		if (!registeredTags[name]) {
			registeredTags[name] = true
			baseOpenapiDoc.tags!.push({ name, 'x-displayName': displayName, description })

			const tagGroups = parsed.slice(0, -1)
			const groupName = tagGroups.map((g) => g.name).join(' > ') || 'default'
			if (!registeredTagGroups[groupName]) {
				const group = { name: groupName, tags: [] }
				baseOpenapiDoc['x-tagGroups'].push(group)
				registeredTagGroups[groupName] = group
			}
			registeredTagGroups[groupName].tags = [...new Set([...registeredTagGroups[groupName].tags, name])]
		}

		return name
	}

	const addRouteToOpenApiDoc = async (path: string, method: string, def: OpenApiSchemaDef, methodObj: OpenAPIV3_1.OperationObject) => {
		if (def.response.response?.length) {
			methodObj.responses ??= {}
			for (const resp of def.response.response) {
				methodObj.responses[resp.status] ??= { description: '', content: {} }
				if (resp.status === StatusCodes.NoContent) {
					delete (methodObj.responses[resp.status] as OpenAPIV3_1.ResponseObject).content
					continue
				}
				const res = methodObj.responses[resp.status] as OpenAPIV3_1.ResponseObject
				res.content![resp.contentType] = { schema: await convert(visit(resp.schema)) }
			}
		}

		if (def.response.responseHeaders?.length) {
			methodObj.responses ??= {}
			for (const resp of def.response.responseHeaders) {
				methodObj.responses[resp.status] ??= { description: '', content: {} }
				methodObj.responses[resp.status] as OpenAPIV3_1.ResponseObject
				const res = methodObj.responses[resp.status] as OpenAPIV3_1.ResponseObject
				res.headers = { schema: (await convert(visit(resp.schema))) as any }
			}
		}

		if (def.request.body)
			methodObj.requestBody = {
				required: true,
				content: {
					'application/json': { schema: await convert(visit(def.request.body)) },
				},
			}

		const parameters: OpenAPIV3_1.ParameterObject[] = []

		const addParams = async (location: 'query' | 'path' | 'header', schema: JsonSchema | undefined) => {
			if (!schema) return
			const flat = flattenForParameters(schema)
			for (const schema of flat) {
				if (!schema.properties) continue
				for (const [name, value] of Object.entries(schema.properties))
					parameters.push({
						name,
						in: location,
						schema: await convert(visit(value)),
						required: (schema.required || []).includes(name),
					})
			}
		}

		await Promise.all([
			addParams('query', def.request.query),
			addParams('path', def.request.params),
			addParams('header', def.request.headers),
		])
		if (parameters.length) methodObj.parameters = parameters

		if (!baseOpenapiDoc.paths) baseOpenapiDoc.paths = {}
		if (!baseOpenapiDoc.paths[path]) baseOpenapiDoc.paths[path] = {}
		baseOpenapiDoc.paths[path]![method] = methodObj
	}

	const html = (jsonPath: string) => {
		const title = capitalize(`${app.name} ${instance.id}`)
		return `
<!doctype html>
<html>
  <head>
    <title>${title}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
	<style>
      .darklight-reference {
        display: none;
      }
    </style>
  </head>
  <body>
    <script id="api-reference" data-url="${jsonPath}"></script>
    <script>
      const configuration = { theme: 'purple' };
      document.getElementById('api-reference').dataset.configuration = JSON.stringify(configuration);
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.38.0"></script>
  </body>
</html>
`
	}

	const cleanPath = (path: string) => {
		let cleaned = path.replace(/(\/\s*)+/g, '/')
		if (!cleaned.startsWith('/')) cleaned = `/${cleaned}`
		if (cleaned !== '/' && cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1)
		return cleaned
	}

	const register = async (route: Route<any>, def: OpenApiSchemaDef) => {
		if (route.hide) return

		const tag = buildTag(route.groups ?? [])

		const cleanedPath = cleanPath(route.path)
		const operationId = `(${route.method.toUpperCase()}) ${cleanedPath}`
		await addRouteToOpenApiDoc(cleanedPath, route.method.toLowerCase(), def, {
			operationId,
			summary: route.title ?? cleanedPath,
			description: route.descriptions?.join('\n\n'),
			tags: tag ? [tag] : undefined,
			security: route.security,
		})
	}

	const jsonPath = '/openapi.json'
	const router = new Router({ path: config.openapi.docsPath ?? '/', hide: true })
	router.get('/index.html', { schema: { defaultContentType: 'text/html' } })((req) =>
		req.res({ body: html(`.${jsonPath}`), contentType: 'text/html', headers: {}, cookies: {} }),
	)
	router.get(jsonPath)((req) => req.res({ body: baseOpenapiDoc, headers: {}, cookies: {} }))

	return {
		router,
		register,
		cleanPath,
	}
}
