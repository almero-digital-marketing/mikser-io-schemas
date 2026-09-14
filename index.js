// mikser-io-schemas
//
// Zod-backed entity validation for mikser-io. Schemas live as plain .js
// modules in `schemas/` — one per layout — and validate the `meta`
// front-matter of every loaded entity that uses that layout. A
// TypeScript declaration file is regenerated on every build so SDK
// consumers get typed access to entity meta.
//
// Layout matching:
//   schemas/article.js  →  entities where meta.layout === 'article'
//
// Configuration:
//   schemas: {
//       schemasFolder: 'schemas',        // default
//       typesFile:     'entities.d.ts',  // emitted at workingFolder root
//       onError:       'warn',           // 'warn' | 'fail' | 'off'
//       schemaKey:     'meta.layout',    // REQUIRED. Dotted front-matter
//                                        // path that names the schema to
//                                        // validate against. No default —
//                                        // pick the field your project
//                                        // actually uses for dispatch:
//                                        // SSG projects typically pass
//                                        // 'meta.layout'; SPA projects
//                                        // (no rendered HTML, no layout)
//                                        // typically pass 'meta.component'.
//                                        // When unset, validation is off
//                                        // and every loaded schema
//                                        // triggers a finalize warning.
//   }
//
// Behavior:
//   - 'warn' (default): log validation errors, leave the entity in the
//     catalog. Right for migrating an existing project; loud enough to
//     notice, soft enough to not block deploys.
//   - 'fail': any validation error throws — the entity is marked invalid
//     by the lifecycle and the build surfaces a non-zero exit.
//   - 'off':  validate nothing. Schemas still load (so the .d.ts emit
//     still runs) but entity contents are not checked. Useful when types
//     are the only thing you care about.
//
// Reference handling:
//   References between entities are plain href strings (see
//   mikser-io-sdk-vue's useDocument / useHref). A schema field for a
//   reference is just z.string() — no special reference type. This keeps
//   schemas portable and avoids coupling the validation layer to the
//   resolution layer.

import path from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'
import _ from 'lodash'
import { extractRefs, isRefKey, findEntity, findEntities, refFilter, useDatabase,
         provideService, useService, cliOption } from 'mikser-io'
import { writeTypes } from './src/typegen.js'

// Friendly per-issue messages — overrides Zod's defaults for the cases
// where Zod's wording is technically correct but reads awkwardly for
// people editing markdown. Returning `{ message }` overrides for that
// issue; falling through to ctx.defaultError keeps Zod's text.
//
// String codes (not zod's ZodIssueCode imports) so the plugin keeps
// zod as a peer dependency with no direct require — every schema
// already brings its own zod.
function friendlyErrorMap(issue, ctx) {
    switch (issue.code) {
        case 'invalid_type':
            if (issue.received === 'undefined') return { message: 'is missing' }
            return { message: `expected ${issue.expected}, got ${issue.received}` }
        case 'too_small':
            if (issue.type === 'string') return { message: `is too short (min ${issue.minimum} chars)` }
            if (issue.type === 'number') return { message: `is too small (min ${issue.minimum})` }
            if (issue.type === 'array')  return { message: `needs at least ${issue.minimum} item${issue.minimum === 1 ? '' : 's'}` }
            break
        case 'too_big':
            if (issue.type === 'string') return { message: `is too long (max ${issue.maximum} chars)` }
            if (issue.type === 'number') return { message: `is too large (max ${issue.maximum})` }
            if (issue.type === 'array')  return { message: `has too many items (max ${issue.maximum})` }
            break
        case 'invalid_string':
            if (issue.validation === 'email') return { message: 'is not a valid email' }
            if (issue.validation === 'url')   return { message: 'is not a valid URL' }
            if (issue.validation === 'uuid')  return { message: 'is not a valid UUID' }
            if (issue.validation === 'regex') return { message: 'does not match the required pattern' }
            break
        case 'invalid_enum_value':
            return { message: `must be one of: ${(issue.options ?? []).join(', ')}` }
        case 'unrecognized_keys': {
            const keys = issue.keys ?? []
            return { message: `unknown field${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}` }
        }
        case 'invalid_union':
        case 'invalid_union_discriminator':
            return { message: 'does not match any expected shape' }
    }
    return { message: ctx.defaultError }
}

export function schemas(options = {}) {
    return ({
        runtime,
        onLoaded,
        onValidate,
        onFinalized,
        onSync,
        watch,
        useLogger,
        matchEntity,
        constants: { OPERATION, ACTION },
    }) => {
    const collection = 'schemas'
    const type = 'schema'

    // schema name → { name, schema, source, revision }
    const schemas = {}

    // Names of schemas that actually matched at least one entity during
    // the run. Anything in `schemas` but missing from `usedSchemas` at
    // finalize triggers a warning — catches the silent-skip failure
    // mode where validation is configured but never runs (wrong
    // schemaKey, typo, missing front-matter, no docs with that
    // dispatch token).
    const usedSchemas = new Set()

    // Generated .d.ts gets stamped from a stable journal-of-edits, not
    // wall-clock time — wrote() flips true on any schema-folder sync so
    // onFinalized knows it needs to re-emit.
    let dirty = true

    // Reference-validation state. Per ADR-0007 A6 we never error on ref
    // problems — they're routine mid-edit state (article saved before
    // its author, entity renamed leaving N referencing entities
    // temporarily broken). Instead we keep the open issues by entity id
    // and re-evaluate every cycle, so newly-resolved refs auto-clear and
    // newly-broken refs surface promptly.
    //
    //   pending = Map<entityId, RefIssue[]>
    //   RefIssue = { kind: 'shape'|'collision'|'missing', path, ...detail }
    //
    // Logging is transition-based: a warning fires the first time an
    // entity's ref-issue set differs from what's already recorded, and
    // a tidy "cleared" info fires when an entity that previously had
    // issues comes back clean. Subsequent cycles with the same set are
    // silent to keep log noise down.
    const pending = new Map()

    function getSchemaName(entity, schemaKey) {
        return _.get(entity, schemaKey)
    }

    // Walk meta looking for $-keys whose values are neither strings nor
    // string arrays. Skips array elements that aren't strings — those
    // produce per-element issues. Only walks plain objects; arrays of
    // objects are walked too.
    function findShapeIssues(meta) {
        const issues = []
        walk(meta, '')
        return issues

        function walk(node, prefix) {
            if (node === null || typeof node !== 'object') return
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) {
                    walk(node[i], prefix ? `${prefix}.${i}` : String(i))
                }
                return
            }
            for (const [k, v] of Object.entries(node)) {
                const here = prefix ? `${prefix}.${k}` : k
                if (isRefKey(k)) {
                    if (typeof v === 'string') {
                        // valid
                    } else if (Array.isArray(v)) {
                        const badIdx = v.findIndex(x => typeof x !== 'string')
                        if (badIdx >= 0) {
                            issues.push({
                                kind: 'shape',
                                path: here,
                                detail: `array element at index ${badIdx} is not a string`,
                            })
                        }
                    } else {
                        issues.push({
                            kind: 'shape',
                            path: here,
                            detail: `value must be string or string array, got ${v === null ? 'null' : typeof v}`,
                        })
                    }
                } else {
                    walk(v, here)
                }
            }
        }
    }

    // Walk meta looking for collisions — sibling keys where both `key`
    // and `$key` are declared in the same object. Per ADR-0007 A4 the
    // $-version wins in the projection deterministically; we surface a
    // warning so editors know they have orphaned non-ref state.
    function findCollisionIssues(meta) {
        const issues = []
        walk(meta, '')
        return issues

        function walk(node, prefix) {
            if (node === null || typeof node !== 'object') return
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) {
                    walk(node[i], prefix ? `${prefix}.${i}` : String(i))
                }
                return
            }
            const dollarStems = new Set()
            const plainKeys   = new Set()
            for (const k of Object.keys(node)) {
                if (isRefKey(k)) dollarStems.add(k.slice(1))
                else plainKeys.add(k)
            }
            for (const stem of dollarStems) {
                if (plainKeys.has(stem)) {
                    const here = prefix ? `${prefix}.${stem}` : stem
                    issues.push({
                        kind: 'collision',
                        path: here,
                        detail: `both \`${stem}\` and \`$${stem}\` declared; $-version wins in render`,
                    })
                }
            }
            for (const [k, v] of Object.entries(node)) {
                walk(v, prefix ? `${prefix}.${k}` : k)
            }
        }
    }

    // Check whether a ref string resolves to an entity in the catalog.
    //
    // Delegated to core's refFilter rather than spelling the forms out
    // here. Hand-matching them makes this a second copy of the relation,
    // and a copy that omits one form reports every ref written in that
    // form as broken — `meta.url`, the served path (ADR-0011) a
    // `$hero: /hero.jpg` resolves through, is the one to miss. Under
    // onError: 'fail' that fails the build on a valid reference.
    //
    // refFilter also returns a sift-shaped OBJECT, which matters twice:
    // it pushes down into the WHERE clause instead of scanning per ref,
    // and a function filter forces a full scan (mikser-io < 9.19.0
    // discarded one outright, which made this check answer true for
    // everything). findEntity stops at the first match.
    async function refExists(ref) {
        return !!(await findEntity(refFilter(ref)))
    }

    async function validateEntityRefs(entity) {
        const issues = []
        if (!entity?.meta || typeof entity.meta !== 'object') return issues

        issues.push(...findShapeIssues(entity.meta))
        issues.push(...findCollisionIssues(entity.meta))

        // Existence check runs over the valid string refs only — shape
        // issues already flag the malformed ones, no double-warning.
        for (const { path: refPath, ref } of extractRefs(entity.meta)) {
            if (!(await refExists(ref))) {
                issues.push({ kind: 'missing', path: refPath, ref })
            }
        }
        return issues
    }

    function formatIssueLine(issue) {
        switch (issue.kind) {
            case 'shape':     return `  ${issue.path}: ${issue.detail}`
            case 'collision': return `  ${issue.path}: ${issue.detail}`
            case 'missing':   return `  ${issue.path}: reference ${issue.ref} does not resolve`
            default:          return `  ${issue.path}: ${JSON.stringify(issue)}`
        }
    }

    function issueSet(issues) {
        return new Set(issues.map(i => `${i.kind}:${i.path}:${i.ref ?? ''}:${i.detail ?? ''}`))
    }

    function issuesEqual(a, b) {
        if (a.length !== b.length) return false
        const sa = issueSet(a)
        for (const k of issueSet(b)) {
            if (!sa.has(k)) return false
        }
        return true
    }

    // Load (or reload) a single schema file. Used both for the initial
    // folder scan in onLoaded and for live onSync CREATE/UPDATE events.
    // Returns true on successful load (caller can flip `dirty`).
    async function loadSchemaFile(name, source) {
        const logger = useLogger()
        try {
            const mod = await import(`${source}?stamp=${Date.now()}`)
            const schema = mod.default
            if (!schema || typeof schema.safeParse !== 'function') {
                logger.error(
                    'Schema %s: default export is not a Zod schema (no safeParse method)',
                    name,
                )
                return false
            }
            // `export const external = true` — this schema is consumed by
            // something that imports it directly, so the registry will never
            // see it match an entity and must not call it unused.
            //
            // A named export beside `revision`, because the schema's author
            // is who knows: the file is imported by a plugin's own config,
            // which the registry cannot see from here. Reported by a
            // consumer whose extraction plugin imports its schema directly —
            // the warning fired on every build, was accurate about what it
            // observed, and its advice was wrong for that project.
            schemas[name] = {
                name, schema, source,
                revision: mod.revision ?? 1,
                external: mod.external === true,
            }
            dirty = true
            logger.info('Schema loaded: %s', name)
            return true
        } catch (err) {
            logger.error('Schema %s: load failed: %s', name, err.message)
            return false
        }
    }

    // Offered as the `schemas` service so consumer plugins (mikser-io-ocr's
    // name-mode dispatch, mikser-io-forms' validation, mikser-io-layouts'
    // check tool) can resolve a schema by its filename stem without
    // importing internals — and without naming this package.
    //
    // Provided at factory-eval time — before any hook runs — so a consumer's
    // onLoaded sees it whatever the plugin order. It used to be assigned to
    // runtime.options.schemas, which coupled every consumer to this package
    // through an object none of them own, and cost `--schemas` its name.
    // Possible only now that runtime.options.schemas no longer holds the
    // lookup API: commander names the option after the flag, so this would
    // have overwritten that object after the load phase.
    cliOption('--schemas <folder>',
        'folder holding the schema modules, relative to the working folder (default: schemas)')

    provideService('schemas', {
        // Return the registered zod schema for `name`, or undefined.
        // Lookup is by the filename stem (`schemas/article.js` → 'article').
        lookup(name) {
            const definition = schemas[name]
            if (!definition) return undefined
            // A schema someone resolved by name is in use, even though no
            // front-matter names it through `schemaKey`. Without this, the
            // unused-schema warning fired at every consumer listed above:
            // mikser-io-ocr dispatches extraction by schema NAME, so the
            // schema does its whole job through this call and never touches
            // `schemaIssues` — and the build closed by advising the user to
            // check a `schemaKey` that was not the mechanism in play. A
            // warning that cannot be acted on teaches people to ignore the
            // ones that can.
            usedSchemas.add(name)
            return definition.schema
        },
        // List every loaded schema name. Useful for "what schemas are
        // available" inspection from MCP / debug tooling.
        names() {
            return Object.keys(schemas).sort()
        },
    }, { plugin: 'mikser-io-schemas' })

    // Ids the early hook managed to validate this cycle, so the finalize pass
    // does not report them a second time. Cleared at the end of each finalize.
    const validatedEarly = new Set()
    // Last message per entity, so an unchanged problem is not re-logged every
    // cycle and a fixed one says so once. Mirrors how ref issues are tracked.
    const schemaPending = new Map()

    onLoaded(async () => {
        const logger = useLogger()
        const config = options

        // --schemas wins, then the config, then the collection name.
        //
        // Read HERE rather than at construction: the option table is not
        // parsed until every plugin has been constructed, so a value read in
        // the factory is always undefined. Absolute is taken as given;
        // anything else is relative to the working folder.
        runtime.options.schemasFolderName =
            runtime.options.schemas ?? config.schemasFolder ?? collection
        runtime.options.schemasFolder = path.isAbsolute(runtime.options.schemasFolderName)
            ? runtime.options.schemasFolderName
            : path.join(runtime.options.workingFolder, runtime.options.schemasFolderName)
        runtime.options.schemasTypesFile = path.join(
            runtime.options.workingFolder,
            config.typesFile || 'entities.d.ts',
        )

        await mkdir(runtime.options.schemasFolder, { recursive: true })
        logger.info('Schemas folder: %s', runtime.options.schemasFolder)
        logger.info('Schemas types:  %s', runtime.options.schemasTypesFile)

        // Initial scan — load every existing schema file. Chokidar (started
        // by watch() below) defaults to ignoreInitial: true and only runs
        // in --watch mode at all, so without this loop a cold start would
        // silently ignore every schema already on disk.
        const entries = await readdir(runtime.options.schemasFolder, { withFileTypes: true })
        const schemaFiles = entries
            .filter(entry => entry.isFile())
            .filter(entry => entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
        for (const entry of schemaFiles) {
            const name = entry.name.replace(path.extname(entry.name), '')
            const source = path.join(runtime.options.schemasFolder, entry.name)
            await loadSchemaFile(name, source)
        }

        watch(collection, runtime.options.schemasFolder)
    })

    // Discover schema modules. Each file in schemasFolder becomes one
    // schema keyed by its filename stem ('article.js' → 'article').
    // The default export must be a Zod schema (anything with a
    // `.safeParse()` method is treated as one — we don't `instanceof`
    // ZodType so users can pass a `.refine(...)`/`.transform(...)` chain
    // or even a custom validator with a safeParse-shaped surface).
    //
    // onSync fires from chokidar events after the initial scan. Files
    // already on disk at startup are picked up by the readdir loop in
    // onLoaded.
    onSync(collection, async ({ action, context }) => {
        if (!context.relativePath) return false
        const { relativePath } = context
        if (!relativePath.endsWith('.js') && !relativePath.endsWith('.mjs')) return false

        const logger = useLogger()
        const name = relativePath.replace(path.extname(relativePath), '')
        const source = path.join(runtime.options.schemasFolder, relativePath)

        switch (action) {
            case ACTION.CREATE:
            case ACTION.UPDATE: {
                await loadSchemaFile(name, source)
                return true
            }
            case ACTION.DELETE: {
                if (schemas[name]) {
                    delete schemas[name]
                    dirty = true
                    logger.info('Schema removed: %s', name)
                }
                return true
            }
        }
        return false
    })

    // Reference validation runs in `onFinalized` because that's the
    // earliest phase where the catalog is fully populated:
    //
    //   process    — yaml / front-matter plugins parse `meta`
    //   processed  — layouts plugin annotates entities
    //   persist    — entries flow into the catalog (findEntities works
    //                from here onwards)
    //   render / postprocess
    //   finalize  ← here. We can walk findEntities() and resolve refs.
    //
    // The earlier `onValidate` hook doesn't work for source documents
    // because it fires at createEntity time, before front-matter has
    // populated `meta`. Earlier process-phase hooks see only the current
    // cycle's mutations through the journal, but ref resolution needs
    // the *catalog* — which entities currently exist — and that's the
    // post-persist view.
    //
    // Per ADR-0007 A6 ref validation is always WARNINGS, never errors.
    // `config.onError: 'fail'` does not apply — broken refs are routine
    // mid-edit state, not unrecoverable failures.
    //
    // Logging is transition-based: a warning fires the first time an
    // entity's issue set appears or changes, and a tidy "cleared" info
    // fires when an entity that previously had issues comes back clean.
    // Stable repeats are silent so a single broken ref doesn't flood the
    // log on every cycle.

    // Validate per-entity on CREATE/UPDATE. Returning a string surfaces
    // it as a validator warning via mikser's onValidate semantics;
    // throwing fails the entry. Mode picked from runtime.config.schemas.onError.
    // One validation, two callers.
    //
    // Returns the message describing what is wrong with `entity`, or null when
    // it is fine, when nothing names a schema, or when no schema answers to
    // that name. Marking the schema used is part of the job, so a schema that
    // only ever matches through the finalize pass is not reported as unused.
    function schemaIssues(entity) {
        const schemaKey = options.schemaKey
        if (!schemaKey) return null
        if (!entity || !entity.meta) return null

        const schemaName = getSchemaName(entity, schemaKey)
        if (!schemaName) return null

        const definition = schemas[schemaName]
        if (!definition) return null            // no schema for this name — silently skip

        usedSchemas.add(schemaName)

        const result = definition.schema.safeParse(entity.meta, { errorMap: friendlyErrorMap })
        if (result.success) { noteUndeclared(entity, definition, schemaName); return null }

        // Multi-line message: one issue per line, source identified up
        // front. Logs and thrown errors both render this readably; an
        // editor scanning the log can spot exactly which file + which
        // field needs attention.
        const sourceId = entity.id || '<unknown source>'
        const lines = result.error.issues
            .map(i => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        return `schema(${schemaName}) ${sourceId}:\n${lines.join('\n')}`
    }


    // A key the schema never heard of.
    //
    // Zod objects are non-strict by default: an undeclared key is dropped from
    // `result.data` and the parse SUCCEEDS. Nothing here reads `result.data` — the
    // entity keeps the key and renders with it — so the whole section exists,
    // renders, and validates clean while no schema knows its shape. A green that
    // cannot go red, which is the shape of every silent failure in this stack: the
    // widened `match` that matched nothing, the forwarded `--clear` that cleared
    // nothing.
    //
    // Warned rather than failed, and outside the `fail` mode deliberately: a
    // project that has been running with undeclared keys should learn about them,
    // not have its build stop on the upgrade that added the check. A schema that
    // wants them rejected can say `.strict()`, which zod already reports as
    // `unrecognized_keys` and which this never reaches.
    const undeclared = new Map()
    
    // The keys the ENGINE puts in meta, which no schema declares and which are
    // nobody's mistake.
    //
    // Derived from the catalog's own `meta_*` columns rather than written out
    // here, so a column added to the engine does not turn into a wave of false
    // warnings in this plugin. `presets` is the one addition that cannot be
    // derived that way: the assets plugin stamps it onto the source entity
    // (ADR-0011) and it is not a column.
    let engineKeys = null
    function engineOwnedKeys() {
        if (engineKeys) return engineKeys
        engineKeys = new Set(['presets'])
        try {
            for (const column of useDatabase().handle.prepare('PRAGMA table_info(mikser_entities)').all()) {
                if (column.name.startsWith('meta_')) engineKeys.add(column.name.slice('meta_'.length))
            }
        } catch { /* no database yet — the built-in set still covers the common ones */ }
        return engineKeys
    }
    
    // `.shape` survives .refine()/.superRefine(); anything that is not an object
    // schema has none, and is left alone rather than guessed at.
    function declaredKeys(schema) {
        const shape = schema?.shape
        return shape && typeof shape === 'object' ? Object.keys(shape) : null
    }
    
    function noteUndeclared(entity, definition, schemaName) {
        const declared = declaredKeys(definition.schema)
        if (!declared) return
        const owned = engineOwnedKeys()
        const extra = Object.keys(entity.meta ?? {})
            .filter(key => !declared.includes(key) && !owned.has(key))
        if (extra.length) undeclared.set(entity.id, { schemaName, keys: extra })
    }

    onValidate([OPERATION.CREATE, OPERATION.UPDATE], async entry => {
        const mode = options.onError ?? 'warn'
        if (mode === 'off') return

        // `schemaKey` is the dotted front-matter path that names the
        // schema to validate against. Required — no default. SSG
        // projects typically pass 'meta.layout' (same field mikser uses
        // for template dispatch); SPA projects pass 'meta.component'
        // since their docs have no layout. Anything else works too —
        // e.g. 'meta.type' if your schemas key off a separate
        // content-type field. When unset, validation is off; the
        // finalize hook below warns about every loaded schema so the
        // off state is loud, not silent.
        const entity = entry.entity

        // This hook fires at createEntity time, which is BEFORE the yaml and
        // front-matter plugins populate `meta`. For a source document that is
        // every time, so validation used to silently do nothing and every
        // schema reported itself as never matched — the plugin was inert for
        // exactly the projects it is written for.
        //
        // Entities that DO arrive with meta (created programmatically, or
        // through a plugin that fills it earlier) are still validated here,
        // where `fail` can reject the entry before anything renders. The rest
        // are caught by the finalize pass below, and remembered so they are not
        // reported twice.
        if (!entity?.meta || !Object.keys(entity.meta).length) return
        if (entity.id) validatedEarly.add(entity.id)

        const message = schemaIssues(entity)
        if (!message) return
        if (mode === 'fail') throw new Error(message)
        return message                          // 'warn' — surfaces via mikser's logger
    })

    onFinalized(async () => {
        const logger = useLogger()
        const entities = await findEntities()
        const stillPresent = new Set()

        // Schema validation for everything the early hook could not see, which
        // for a file-based project is all of it: `meta` is populated by the
        // yaml and front-matter plugins during process, long after
        // createEntity. Finalize is the first phase where the catalog holds
        // entities with their meta filled in.
        //
        // `fail` cannot reject an entry from here — the render has already
        // happened — so it fails the CYCLE instead, and it does so after
        // reporting every offender rather than the first.
        const mode = options.onError ?? 'warn'
        const failures = []
        // Cleared per cycle, and populated by the validation pass below and by
        // the early hook. Accumulating across a watcher's cycles would report
        // the same key on every rebuild forever.
        const carried = new Map(undeclared)
        undeclared.clear()
        if (mode !== 'off') {
            for (const entity of entities) {
                if (!entity?.id || validatedEarly.has(entity.id)) continue
                const message = schemaIssues(entity)
                const previous = schemaPending.get(entity.id) ?? null
                if (message !== previous) {
                    if (message) logger.warn('%s', message)
                    else if (previous) logger.info('Schema OK again: %s', entity.id)
                }
                if (message) { schemaPending.set(entity.id, message); failures.push(message) }
                else schemaPending.delete(entity.id)
            }
        }
        validatedEarly.clear()
        // Undeclared keys, after the validation pass has filled the map.
        //
        // Reported before the `fail` throw below so they are still said when a
        // cycle is about to fail on a real validation error — the two are
        // usually the same edit, and a key nobody declared is often WHY the
        // other thing broke.
        // No `mode` check here: `undeclared` is only ever populated by
        // schemaIssues, and both of its call sites already return early when
        // the mode is 'off'. A second guard reads like defence and is
        // unreachable — a branch no test can distinguish from its absence,
        // which is the kind of code that later gets trusted for something it
        // never did.
        {
            for (const [id, { schemaName, keys }] of undeclared) carried.set(id, { schemaName, keys })
            const SHOWN = 10
            const shown = [...carried].slice(0, SHOWN)
            for (const [id, { schemaName, keys }] of shown) {
                logger.warn({ code: 'schema-undeclared-key', id, schema: schemaName, keys },
                    '%s has %s that schema(%s) does not declare: %s. Zod drops what it does not '
                    + 'know about and the parse still succeeds, so this validated clean — the field '
                    + 'exists and renders while nothing knows its shape. Declare it, or say '
                    + '.strict() on the schema to make it an error.',
                    id, keys.length === 1 ? 'a field' : 'fields', schemaName, keys.join(', '))
            }
            if (carried.size) {
                logger.warn({ code: 'schema-undeclared-key-summary', entities: carried.size },
                    '%d entity/entities carry fields no schema declares%s. Engine-stamped keys are '
                    + 'excluded, so these are all authored.',
                    carried.size, carried.size > SHOWN ? `, ${SHOWN} shown` : '')
            }
        }
        undeclared.clear()

        if (failures.length && mode === 'fail') {
            throw new Error(`${failures.length} entity/entities failed schema validation`)
        }

        for (const entity of entities) {
            if (!entity?.id) continue
            stillPresent.add(entity.id)

            const newIssues = await validateEntityRefs(entity)
            const oldIssues = pending.get(entity.id) ?? []

            if (!issuesEqual(newIssues, oldIssues)) {
                if (newIssues.length > 0) {
                    logger.warn(
                        'Refs problem: %s\n%s',
                        entity.id,
                        newIssues.map(formatIssueLine).join('\n'),
                    )
                } else if (oldIssues.length > 0) {
                    logger.info('Refs cleared: %s', entity.id)
                }
            }

            if (newIssues.length > 0) pending.set(entity.id, newIssues)
            else                       pending.delete(entity.id)
        }
        // Drop pending entries for entities that have been deleted from
        // the catalog — they can't be re-validated, and keeping them in
        // pending would leak forever.
        for (const id of [...pending.keys()]) {
            if (!stillPresent.has(id)) pending.delete(id)
        }
    })

    // Expose the current pending-validation list via the MCP substrate so
    // editors, dashboards, and AI agents can ask "what's currently
    // broken?" without scraping logs. Read-only snapshot of the in-memory
    // pending Map.
    onLoaded(() => {
        // A resource, not a tool: core deliberately has no vocabulary for
        // resources, so this stays MCP's. Asked for from a hook, by which
        // point every factory has run.
        const mcp = useService('mcp')
        if (!mcp) return
        try {
            mcp.registerResource(
                'mikser-schemas-pending',
                'mikser://schemas/pending',
                {
                    title: 'Pending schema-validation issues',
                    description: 'Per-entity reference issues currently flagged by mikser-io-schemas — shape problems, collisions, missing targets. Re-evaluated each cycle, so entries clear when their targets appear and new entries surface as references break.',
                    mimeType: 'application/json',
                },
                async (uri) => ({
                    contents: [{
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            count: pending.size,
                            entries: Array.from(pending.entries()).map(([id, issues]) => ({
                                id,
                                issues: issues.map(i => ({ kind: i.kind, path: i.path, ref: i.ref, detail: i.detail })),
                            })),
                        }, null, 2),
                    }],
                }),
            )
        } catch (err) {
            useLogger().debug('mikser://schemas/pending registration skipped: %s', err.message)
        }
    })

    // Regenerate the .d.ts at the end of every build. Idempotent — only
    // rewrites if something actually changed in the schemas map.
    onFinalized(async () => {
        const logger = useLogger()
        const config = options
        const mode = config.onError ?? 'warn'

        // Unused-schema warning: every loaded schema that never matched
        // an entity during the run is almost certainly a config mistake
        // — schemaKey not set at all, or pointing at a field your
        // front-matter doesn't declare, or a typo in either the schema
        // filename or the dispatch value, or simply no docs of that
        // kind. Silent skip would let a project ship with validation
        // effectively off, so we surface it at finalize. Suppressed
        // when mode is 'off' (the user opted out explicitly).
        if (mode !== 'off' && Object.keys(schemas).length > 0) {
            const schemaKey = config.schemaKey
            const unused = Object.keys(schemas)
                .filter(n => !usedSchemas.has(n))
                .filter(n => !schemas[n]?.external)
            for (const name of unused) {
                if (!schemaKey) {
                    logger.warn(
                        'Schema "%s" loaded but `schemas.schemaKey` is not set — validation is off. Set it to the front-matter path that names the schema, e.g. \'meta.layout\' (SSG) or \'meta.component\' (SPA).',
                        name,
                    )
                } else {
                    // Phrased as what was OBSERVED, with both explanations,
                    // because the registry cannot tell them apart: a schema
                    // consumed by a plugin that imported it directly does its
                    // whole job without the registry seeing anything, and
                    // telling that author to check `schemaKey` sends them
                    // after a mechanism they are not using. A warning whose
                    // advice is wrong for your project is one you learn to
                    // skip — and this one is here to catch validation that
                    // silently is not running.
                    logger.warn(
                        'Schema "%s" loaded but nothing in this build matched it. If it is meant to validate '
                        + 'front-matter, check `schemaKey` (currently \'%s\') and that documents declare '
                        + '{ %s: \'%s\' }. If it is consumed directly by a plugin that imports it, add '
                        + '`export const external = true` to the schema file and this will stop.',
                        name, schemaKey, schemaKey.replace(/^meta\./, ''), name,
                    )
                }
            }
        }

        if (!dirty) return
        try {
            await writeTypes({
                schemas,
                outputPath: runtime.options.schemasTypesFile,
            })
            dirty = false
            logger.info(
                'Schemas types emitted: %d schemas → %s',
                Object.keys(schemas).length,
                runtime.options.schemasTypesFile,
            )
        } catch (err) {
            logger.error('Schemas types emit failed: %s', err.message)
        }
    })

    return { collection, type, module: import.meta.url }
    }
}
