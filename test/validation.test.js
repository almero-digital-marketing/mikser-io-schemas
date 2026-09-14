// Schema loading and entity validation.
//
// The plugin's stated purpose is to be loud when content does not match
// its schema, so the failure that matters most is validation that
// silently does not run. The plugin already guards one such case (a
// schema that matched nothing gets a finalize warning); these tests pin
// that guard down along with the three onError modes, because "off" and
// "never ran" look identical from the outside.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { createHarness } from 'mikser-io/testing/harness.js'
import { schemas } from '../index.js'
import { useService, constants } from 'mikser-io'

const { ACTION } = constants

const ARTICLE_SCHEMA = `
import { z } from 'zod'
export default z.object({
    layout: z.literal('article'),
    title:  z.string().min(3),
    weight: z.number().optional(),
})
`

// A working folder with a schemas/ dir, the plugin installed, and
// onLoaded run so the initial folder scan has happened.
// The working folder lives INSIDE this package, not in os.tmpdir().
// Schema files are loaded by dynamic import and they `import { z } from
// 'zod'`, which only resolves if the file sits somewhere Node can walk
// up to a node_modules containing zod. From /tmp it cannot, so every
// schema failed to load and the plugin dutifully reported zero schemas —
// a fixture problem that looks exactly like a plugin bug.
async function withPlugin({ schemaFiles = {}, options = {}, entities = [] }, fn) {
    const root = await mkdtemp(path.join(import.meta.dirname, '.tmp-'))
    await mkdir(path.join(root, 'schemas'), { recursive: true })
    for (const [name, body] of Object.entries(schemaFiles)) {
        await writeFile(path.join(root, 'schemas', name), body)
    }
    try {
        const harness = createHarness({ entities, options: { workingFolder: root } })
        schemas(options)(harness.core)
        await harness.runHook('loaded')
        // Drive the validate hooks the way the engine does: every
        // registered hook whose operation list covers this entry.
        harness.validate = async (entry, operation = 'create') => {
            const results = []
            for (const { operations, cb } of harness.hooks.validate) {
                if (!operations || operations.includes(operation)) {
                    results.push(await cb(entry))
                }
            }
            return results.filter(r => r !== undefined)
        }
        return await fn(harness, root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

const said = (harness, level) =>
    harness.logs.filter(l => l.level === level).map(l => l.args.join(' ')).join('\n')

describe('schema loading', () => {
    it('loads a .js schema keyed by its filename stem', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            assert.deepEqual(useService('schemas').names(), ['article'])
            assert.ok(useService('schemas').lookup('article'))
            assert.equal(useService('schemas').lookup('nope'), undefined)
        })
    })

    it('reports a schema whose default export is not a validator', async () => {
        await withPlugin({
            schemaFiles: { 'broken.js': 'export default { not: "a schema" }\n' },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            assert.match(said(h, 'error'), /broken/)
            assert.deepEqual(useService('schemas').names(), [])
        })
    })

    it('reports a schema module that throws on import', async () => {
        await withPlugin({
            schemaFiles: { 'throws.js': 'throw new Error("boom")\n' },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            assert.match(said(h, 'error'), /throws/)
            assert.deepEqual(useService('schemas').names(), [])
        })
    })

    it('ignores non-JS files in the schemas folder', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA, 'notes.md': '# not a schema\n' },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            assert.deepEqual(useService('schemas').names(), ['article'])
        })
    })
})

describe('entity validation', () => {
    const valid = { id: '/documents/a.md', meta: { layout: 'article', title: 'Hello' } }
    const invalid = { id: '/documents/b.md', meta: { layout: 'article', title: 'no' } }

    it('passes a conforming entity', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            assert.deepEqual(await h.validate({ entity: valid }), [])
        })
    })

    it('warns on a non-conforming entity, naming the file and the field', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            const [message] = await h.validate({ entity: invalid })
            assert.match(message, /\/documents\/b\.md/, 'must name the source')
            assert.match(message, /title/, 'must name the field')
        })
    })

    it('throws under onError: fail', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout', onError: 'fail' },
        }, async (h) => {
            await assert.rejects(() => h.validate({ entity: invalid }), /title/)
        })
    })

    it('validates nothing under onError: off', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout', onError: 'off' },
        }, async (h) => {
            assert.deepEqual(await h.validate({ entity: invalid }), [])
        })
    })

    it('skips an entity whose schema name has no schema', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            const other = { id: '/documents/c.md', meta: { layout: 'gallery', title: 'x' } }
            assert.deepEqual(await h.validate({ entity: other }), [])
        })
    })

    it('honours a schemaKey other than meta.layout', async () => {
        // SPA projects dispatch on meta.component rather than a layout.
        const componentSchema = `
import { z } from 'zod'
export default z.object({ component: z.literal('Hero'), title: z.string().min(3) })
`
        await withPlugin({
            schemaFiles: { 'Hero.js': componentSchema },
            options: { schemaKey: 'meta.component' },
        }, async (h) => {
            const bad = { id: '/documents/d.md', meta: { component: 'Hero', title: 'x' } }
            const [message] = await h.validate({ entity: bad })
            assert.match(message, /title/)
        })
    })
})

describe('the silent-skip guards', () => {
    it('warns at finalize about a schema that matched nothing', async () => {
        // The failure this package exists to avoid: validation configured,
        // wired up, and never actually running — a typo in schemaKey, or
        // no document carrying that dispatch token.
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            await h.runHook('finalized')
            assert.match(said(h, 'warn'), /article/,
                'a loaded-but-unused schema must be reported')
        })
    })

    it('does not warn about a schema that did match', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            await h.validate({ entity: { id: '/documents/a.md', meta: { layout: 'article', title: 'Hello' } } })
            await h.runHook('finalized')
            assert.doesNotMatch(said(h, 'warn'), /article/)
        })
    })

    it('a schema resolved through lookup() counts as used', async () => {
        // schemaKey is not the only way a schema gets used. mikser-io-ocr
        // dispatches extraction by schema NAME through the `schemas`
        // service, so the schema can do its entire job without a single
        // entity naming it in front-matter. Reported from a real build:
        // ocr resolved 'janus-report', extracted with it, and the build
        // still closed with "never matched any entity — check schemaKey",
        // pointing at a mechanism that was not in play.
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            assert.ok(useService('schemas').lookup('article'), 'precondition: it resolves')
            await h.runHook('finalized')
            assert.doesNotMatch(said(h, 'warn'), /never matched/,
                'resolving a schema by name is using it')
        })
    })

    it('a lookup that misses does not pre-mark the name as used', async () => {
        // Under --watch a schema file can be written after something asked
        // for it: a consumer looks up 'article', gets nothing, the author
        // then adds schemas/article.js. Marking the name on the way past
        // would bank that miss and suppress the warning for the schema that
        // arrives later — which is the one the guard is there for.
        await withPlugin({
            schemaFiles: {},
            options: { schemaKey: 'meta.layout' },
        }, async (h, root) => {
            assert.equal(useService('schemas').lookup('article'), undefined,
                'precondition: nothing to resolve yet')

            await writeFile(path.join(root, 'schemas', 'article.js'), ARTICLE_SCHEMA)
            await h.runSync('schemas', {
                action: ACTION.CREATE,
                context: { relativePath: 'article.js' },
            })
            assert.ok(useService('schemas').names().includes('article'),
                'precondition: the watch add registered it')

            await h.runHook('finalized')
            assert.match(said(h, 'warn'), /never matched/,
                'a schema added after a failed lookup is still unused')
        })
    })

    it('listing the names is not using them', async () => {
        // names() is inspection — MCP tooling calls it to answer "what is
        // available". If that counted as use, one debug call would switch
        // the guard off for the whole build.
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: { schemaKey: 'meta.layout' },
        }, async (h) => {
            assert.deepEqual(useService('schemas').names(), ['article'])
            await h.runHook('finalized')
            assert.match(said(h, 'warn'), /never matched/)
        })
    })

    it('validation is off with no schemaKey, and says so', async () => {
        await withPlugin({
            schemaFiles: { 'article.js': ARTICLE_SCHEMA },
            options: {},
        }, async (h) => {
            const invalid = { id: '/documents/b.md', meta: { layout: 'article', title: 'no' } }
            assert.deepEqual(await h.validate({ entity: invalid }), [],
                'no schemaKey means no validation')
            await h.runHook('finalized')
            assert.ok(said(h, 'warn').length > 0,
                'the off state must be loud, not silent')
        })
    })
})

// Validation for documents whose meta arrives LATE.
//
// `onValidate` fires at createEntity time, which is before the yaml and
// front-matter plugins populate `meta`. For a file-based project that is every
// document, so validation silently did nothing and every schema reported itself
// as never matched — the plugin was inert for exactly the projects it is for.
//
// The catalog holds entities with their meta filled in by `finalized`, so
// anything the early hook could not see is validated there.
describe('validation for source documents', () => {
    const NAV_SCHEMA = `import { z } from 'zod'
export default z.object({ schema: z.string(), title: z.string(), menuLabel: z.string() })
`
    // What the engine hands the early hook for a source document: an entity
    // that exists but whose meta has not been parsed yet.
    const bare = { id: '/documents/nav.yml', meta: {} }
    const filled = (meta) => ({ id: '/documents/nav.yml', collection: 'documents', meta })

    it('validates an entity the early hook could not see', async () => {
        await withPlugin({
            schemaFiles: { 'nav.js': NAV_SCHEMA },
            options: { schemaKey: 'meta.schema' },
            entities: [filled({ schema: 'nav', title: 'T' })],   // menuLabel missing
        }, async (h) => {
            assert.deepEqual(await h.validate({ entity: bare }), [],
                'nothing to say at createEntity time — meta is empty')
            await h.runHook('finalized')
            assert.match(said(h, 'warn'), /schema\(nav\)/)
            assert.match(said(h, 'warn'), /menuLabel/)
        })
    })

    it('stops calling a schema unused when only the late pass matched it', async () => {
        // The symptom that made this visible: every schema loaded, none matched.
        await withPlugin({
            schemaFiles: { 'nav.js': NAV_SCHEMA },
            options: { schemaKey: 'meta.schema' },
            entities: [filled({ schema: 'nav', title: 'T', menuLabel: 'M' })],
        }, async (h) => {
            await h.runHook('finalized')
            assert.doesNotMatch(said(h, 'warn'), /never matched/)
        })
    })

    it('says nothing about a document that satisfies its schema', async () => {
        await withPlugin({
            schemaFiles: { 'nav.js': NAV_SCHEMA },
            options: { schemaKey: 'meta.schema' },
            entities: [filled({ schema: 'nav', title: 'T', menuLabel: 'M' })],
        }, async (h) => {
            await h.runHook('finalized')
            assert.doesNotMatch(said(h, 'warn'), /schema\(nav\)/)
        })
    })

    it('does not report the same problem twice per entity', async () => {
        // The early hook still owns entities whose meta IS ready, and the late
        // pass must not repeat them.
        await withPlugin({
            schemaFiles: { 'nav.js': NAV_SCHEMA },
            options: { schemaKey: 'meta.schema' },
            entities: [filled({ schema: 'nav', title: 'T' })],
        }, async (h) => {
            const early = await h.validate({ entity: filled({ schema: 'nav', title: 'T' }) })
            assert.equal(early.length, 1, 'a ready entity is still validated early')
            await h.runHook('finalized')
            const warned = (said(h, 'warn').match(/schema\(nav\)/g) ?? []).length
            assert.equal(warned, 0, 'the late pass must not repeat what the early one reported')
        })
    })
})

describe('where the schemas folder comes from', () => {
    // The flag could not exist while runtime.options.schemas held the lookup
    // API: commander names an option after its long flag, so `--schemas`
    // would have landed a folder string on top of that object after the load
    // phase, and the failure would have surfaced in whichever consumer read
    // it next — forms, ocr or layouts, never here.
    const resolved = async (options, cliValue) => {
        const root = await mkdtemp(path.join(import.meta.dirname, '.tmp-'))
        try {
            const harness = createHarness({
                options: { workingFolder: root, ...(cliValue ? { schemas: cliValue } : {}) },
            })
            schemas(options)(harness.core)
            await harness.runHook('loaded')
            return { folder: harness.runtime.options.schemasFolder, root }
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }

    it('defaults to the collection name', async () => {
        const { folder, root } = await resolved({})
        assert.equal(folder, path.join(root, 'schemas'))
    })

    it('takes --schemas over the config', async () => {
        const { folder, root } = await resolved({ schemasFolder: 'from-config' }, 'from-cli')
        assert.equal(folder, path.join(root, 'from-cli'))
    })

    it('takes an absolute --schemas as given', async () => {
        const absolute = path.join(tmpdir(), 'mikser-schemas-absolute')
        const { folder } = await resolved({}, absolute)
        assert.equal(folder, absolute)
    })
})
