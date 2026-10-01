import { describe, it, expect } from 'bun:test'
import { Elysia, t } from '../../src'

// #1972: guard `detail` is only visible in the generated OpenAPI document,
// so these read the merged hook from `app.routes`
const hooksOf = (app: Elysia<any, any>, path: string) =>
	(app.routes.find((r) => r.path === path) as any)?.hooks

const detailOf = (app: Elysia<any, any>, path: string) =>
	hooksOf(app, path)?.detail

const body = t.Object({ name: t.String() })

describe('guard detail', () => {
	it('applies to a route that declares its own hook', () => {
		const app = new Elysia().guard({ detail: { tags: ['Admin'] } }, (app) =>
			app.get('/plain', () => 'ok').post('/hook', { body }, () => 'ok')
		)

		expect(detailOf(app, '/plain')).toEqual({ tags: ['Admin'] })
		expect(detailOf(app, '/hook')).toEqual({ tags: ['Admin'] })
	})

	it('applies from an inline guard', () => {
		const app = new Elysia()
			.guard({ detail: { tags: ['Admin'] } })
			.get('/plain', () => 'ok')
			.post('/hook', { body }, () => 'ok')

		expect(detailOf(app, '/plain')).toEqual({ tags: ['Admin'] })
		expect(detailOf(app, '/hook')).toEqual({ tags: ['Admin'] })
	})

	it('merges with the detail of the route, route wins', () => {
		const app = new Elysia().guard(
			{ detail: { tags: ['Admin'], summary: 'guard' } },
			(app) =>
				app.post(
					'/own',
					{ body, detail: { summary: 'route', description: 'own' } },
					() => 'ok'
				)
		)

		expect(detailOf(app, '/own')).toEqual({
			tags: ['Admin'],
			summary: 'route',
			description: 'own'
		})
	})

	it('merges chained guards', () => {
		const app = new Elysia()
			.guard({ detail: { tags: ['A'], summary: 'first' } })
			.guard({ detail: { summary: 'second' } })
			.get('/plain', () => 'ok')
			.post('/hook', { body }, () => 'ok')

		const expected = { tags: ['A'], summary: 'second' }

		expect(detailOf(app, '/plain')).toEqual(expected)
		expect(detailOf(app, '/hook')).toEqual(expected)
	})

	it('merges nested guards, inner wins', () => {
		const app = new Elysia().guard(
			{ detail: { tags: ['Outer'], summary: 'outer' } },
			(app) =>
				app.guard(
					{ detail: { tags: ['Inner'], description: 'inner' } },
					(app) =>
						app
							.get('/plain', () => 'ok')
							.post('/hook', { body }, () => 'ok')
				)
		)

		// array replace instead of concat
		const expected = {
			tags: ['Inner'],
			summary: 'outer',
			description: 'inner'
		}

		expect(detailOf(app, '/plain')).toEqual(expected)
		expect(detailOf(app, '/hook')).toEqual(expected)
	})

	it('merges guards of separate plugins', () => {
		const auth = new Elysia({ name: 'auth' }).guard('plugin', {
			detail: { security: [{ jwt: [] }] }
		})

		const frozen = new Elysia({ name: 'frozen' }).guard('plugin', {
			detail: { responses: { 423: { description: 'Locked' } } }
		})

		const app = new Elysia()
			.use(auth)
			.use(frozen)
			.get('/plain', () => 'ok')
			.post('/hook', { body, detail: { summary: 'route' } }, () => 'ok')

		const inherited = {
			security: [{ jwt: [] }],
			responses: { 423: { description: 'Locked' } }
		}

		expect(detailOf(app, '/plain')).toEqual(inherited)
		expect(detailOf(app, '/hook')).toEqual({
			...inherited,
			summary: 'route'
		})
	})

	it('merges global guard into a plugin route', () => {
		const app = new Elysia()
			.guard('global', { detail: { tags: ['Global'] } })
			.use(
				new Elysia()
					.guard({ detail: { summary: 'plugin' } })
					.post('/hook', { body }, () => 'ok')
			)

		expect(detailOf(app, '/hook')).toEqual({
			tags: ['Global'],
			summary: 'plugin'
		})
	})

	it('does not apply outside of the guard', () => {
		const app = new Elysia()
			.guard({ detail: { tags: ['Admin'] } }, (app) =>
				app.post('/guarded', { body }, () => 'ok')
			)
			.post('/outside', { body }, () => 'ok')

		expect(detailOf(app, '/guarded')).toEqual({ tags: ['Admin'] })
		expect(detailOf(app, '/outside')).toBeUndefined()
	})

	it('lets a route replace security, including opting out', () => {
		const app = new Elysia().guard(
			{ detail: { security: [{ apiKey: [] }] } },
			(app) =>
				app
					.post(
						'/scoped',
						{ body, detail: { security: [{ oauth2: ['admin'] }] } },
						() => 'ok'
					)
					.post(
						'/public',
						{ body, detail: { security: [] } },
						() => 'ok'
					)
		)

		expect(detailOf(app, '/scoped').security).toEqual([
			{ oauth2: ['admin'] }
		])
		expect(detailOf(app, '/public').security).toEqual([])
	})

	it('does not leak a route detail into its siblings', () => {
		const guard = {
			tags: ['Admin'],
			responses: { 400: { description: 'g' } }
		}

		const app = new Elysia().guard({ detail: guard }, (app) =>
			app
				.post(
					'/one',
					{
						body,
						detail: {
							summary: 'one',
							responses: { 400: { description: 'one' } }
						}
					},
					() => 'ok'
				)
				.post('/two', { body }, () => 'ok')
		)

		expect(detailOf(app, '/one')).toEqual({
			tags: ['Admin'],
			summary: 'one',
			responses: { 400: { description: 'one' } }
		})
		expect(detailOf(app, '/two')).toEqual({
			tags: ['Admin'],
			responses: { 400: { description: 'g' } }
		})

		// guard input is shared by every route, it must stay untouched
		expect(guard).toEqual({
			tags: ['Admin'],
			responses: { 400: { description: 'g' } }
		})
	})

	it('does not write into a schema the guard shares', () => {
		const model = t.Object({ message: t.String() })

		const app = new Elysia().guard(
			{ detail: { responses: { 400: model } } } as any,
			(app) =>
				app
					.post(
						'/one',
						{
							body,
							detail: {
								responses: { 400: { description: 'one' } }
							}
						} as any,
						() => 'ok'
					)
					.post('/two', { body }, () => 'ok')
		)

		expect(detailOf(app, '/one').responses[400]).toEqual({
			description: 'one'
		})
		expect(detailOf(app, '/two').responses[400]).toBe(model)
		expect('description' in model).toBe(false)
	})

	it('applies tags shorthand to a route that declares its own hook', () => {
		const app = new Elysia().guard({ tags: ['Admin'] }, (app) =>
			app
				.get('/plain', () => 'ok')
				.post('/hook', { body }, () => 'ok')
				.post('/own', { body, tags: ['Own'] }, () => 'ok')
		)

		expect(hooksOf(app, '/plain').tags).toEqual(['Admin'])
		expect(hooksOf(app, '/hook').tags).toEqual(['Admin'])
		expect(hooksOf(app, '/own').tags).toEqual(['Own'])
	})

	it('keeps handling request', async () => {
		const app = new Elysia()
			.guard({ detail: { tags: ['A'] } })
			.guard({ detail: { summary: 'S' } })
			.post(
				'/hook',
				{ body, detail: { description: 'D' } },
				({ body }) => body
			)

		const response = await app.handle(
			new Request('http://localhost/hook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'a' })
			})
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ name: 'a' })
	})
})
