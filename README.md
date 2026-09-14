# mikser-io-schemas

Zod-backed entity validation and TypeScript type generation for [mikser-io](https://github.com/almero-digital-marketing/mikser-io).

File-based content is mikser's superpower — but file-based content has no built-in schema. You discover the shape of an entity by reading its `meta` block, and drift between layouts ("did this layout want `publishedAt` or `published`?") accumulates silently until something breaks at render time. This plugin closes that gap *without giving up the file-based model*: schemas are plain `.js` modules next to your config, validation runs as part of the build, and the SDK's `.d.ts` gets regenerated so the frontend gets typed entity access.

## Install

```bash
npm install --save-dev mikser-io-schemas zod
```

`mikser-io ^9.0.0` is a peer dependency.

## Quick start

Add the plugin to your config and pick a folder for schemas (default `schemas/`):

```js
// mikser.config.js
import { documents, layouts } from 'mikser-io'
import { schemas } from 'mikser-io-schemas'

export default {
    plugins: [
        documents(),
        layouts(),
        schemas({
            // schemasFolder: 'schemas',       // default
            // typesFile:     'entities.d.ts', // default — emitted at the project root
            // onError:       'warn',          // 'warn' (default) | 'fail' | 'off' (schema-shape only)
            schemaKey:        'meta.layout',   // REQUIRED for schema-shape validation. No
                                               // default. Dotted front-matter path that
                                               // names the schema to match.
                                               // SSG projects typically pass 'meta.layout';
                                               // SPA projects (no rendered HTML) pass
                                               // 'meta.component' since their docs have no
                                               // layout. When unset, schema-shape validation
                                               // is off and every loaded schema triggers a
                                               // finalize warning so the off state is loud.
                                               //
                                               // Ref validation (per ADR-0007 A6) runs
                                               // regardless of schemaKey — every $-keyed
                                               // field is auto-validated for existence,
                                               // shape, and collision, as warnings.
        }),
    ],
}
```

Drop a schema file in `schemas/`:

```js
// schemas/article.js
import { z } from 'zod'

export default z.object({
    title:       z.string().min(1),
    layout:      z.literal('article'),
    publishedAt: z.string().datetime(),
    author:      z.string(),
    tags:        z.array(z.string()).default([]),
    hero:        z.string().url().optional(),
    summary:     z.string().max(280).optional(),
})
```

Each entity whose `meta[schemaKey] === 'article'` is now validated. The match is by filename stem — `schemas/article.js` matches docs declaring `article`, `schemas/landing-page.js` matches docs declaring `landing-page`, etc. `schemas.schemaKey` is **required** and has no default — pick the field your project actually uses for dispatch:

- **SSG projects:** `schemaKey: 'meta.layout'` (same field mikser uses for template dispatch)
- **SPA projects:** `schemaKey: 'meta.component'` (no rendered HTML, no layout)

If a schema file loads but never matches any document during a build, the plugin warns at finalize:

```
WARN  Schema "article" loaded but never matched any entity — check `schemaKey` (currently 'meta.layout') or verify front-matter declares { layout: 'article' }
```

If `schemaKey` is unset, every loaded schema generates a louder warning pointing at the missing config:

```
WARN  Schema "article" loaded but `schemas.schemaKey` is not set — validation is off. Set it to the front-matter path that names the schema, e.g. 'meta.layout' (SSG) or 'meta.component' (SPA).
```

That makes both failure modes — misconfigured key or no key at all — loud at finalize.

## What validation surfaces

The plugin runs on `onValidate` — mikser's per-entity validation hook. Behaviour depends on `onError`:

| Mode | Behaviour |
|---|---|
| `'warn'` *(default)* | Log the validation issue, keep the entity in the catalog, continue the build. Right for adopting schemas on an existing project — broken entries stay visible without breaking deploys. |
| `'fail'` | Throw on the first invalid entity. The lifecycle marks it as a validation error and the build exits non-zero. Right for greenfield projects or CI. |
| `'off'` | Validate nothing. Schemas still load and the `.d.ts` is still emitted — useful when you want types without the runtime check. |

Example warning output on a malformed article:

```
WARN  Validation problem: [CREATE] /content/blog/missing-author.md schema(article) author: Required; publishedAt: Invalid datetime
```

The error string lists every issue Zod reported. If you want stricter messages or want to fail only on certain fields, use `.refine(...)` inside the schema — every Zod feature works because the schema *is* a Zod object.

## Type generation

After every build, `mikser-io-schemas` regenerates a `.d.ts` describing the union of all schemas. The default location is `entities.d.ts` at the project root; override with `schemas.typesFile`.

```ts
// entities.d.ts — Generated by mikser-io-schemas. Do not edit by hand.

import type { z } from 'zod'
import ArticleSchema from './schemas/article.js'
import ProductSchema from './schemas/product.js'

export type ArticleMeta = z.infer<typeof ArticleSchema>
export type ProductMeta = z.infer<typeof ProductSchema>

export interface LayoutMap {
    'article': ArticleMeta
    'product': ProductMeta
}

export type LayoutName = keyof LayoutMap
export type MetaByLayout<L extends LayoutName> = LayoutMap[L]
```

Consumers — typically a Vue or React app using `mikser-io-sdk-api` — can now type the entities they fetch:

```ts
import type { MetaByLayout } from '../mikser-content/entities'
import { useDocument } from 'mikser-io-sdk-vue'

type Article = { meta: MetaByLayout<'article'> }

const { document } = useDocument<Article>('/content/blog/launch')
// document.value.meta.title   ← string
// document.value.meta.author  ← string
// document.value.meta.tags    ← string[]
```

For a discriminated union over layouts:

```ts
import type { LayoutMap, LayoutName } from '../mikser-content/entities'

type Entity = {
    [L in LayoutName]: { layout: L; meta: LayoutMap[L] }
}[LayoutName]
```

Now `if (entity.layout === 'article')` narrows `entity.meta` to `ArticleMeta` automatically.

## References between entities

[ADR-0007](https://github.com/almero-digital-marketing/mikser-io/blob/main/documentation/decisions/0007-references-declaration-and-expansion.md) makes references first-class via a tiny naming convention: any meta key starting with `$` is a reference. The value stays a plain string (a leading-slash href, no extension), so `sed`-replace, grep, and YAML/JSON portability are unchanged. What changes is that the engine now *knows* which fields are refs and treats them accordingly — render context normalization strips the `$` so templates see `meta.author` instead of `meta.$author`, the api can `expand` them in a single round-trip, and **this plugin auto-validates that every `$`-keyed value resolves to an actual entity in the catalog**.

```yaml
---
layout: article
title:    Launch
$author:  /authors/dick           # single ref
$hero:    /images/launch-hero
$related:                         # array of refs
  - /blog/old-post-1
  - /blog/old-post-2
seo:
  $ogImage: /images/og-launch     # nested $-keys also detected
---
```

Schema shape for the same article — no special "reference" type, just `z.string()` because that's what's on disk:

```js
import { z } from 'zod'

export default z.object({
    layout: z.literal('article'),
    title:  z.string(),
    $author:  z.string(),
    $hero:    z.string().optional(),
    $related: z.array(z.string()).default([]),
})
```

### Deferred, warning-only ref validation

Per ADR-0007 A6, file-based editing is multi-step: an article can be saved before its author file exists, an entity can be renamed leaving N referencing entities temporarily broken, a batch import can land in any order. Any model that errors on broken-ref state at parse time fights normal editing workflows.

This plugin runs ref validation in `onFinalized` (after `onPersist` has populated the catalog) and **emits warnings, never errors**. Four checks run regardless of whether `schemaKey` is set:

- **Shape** — value under a `$`-key isn't a string or string array
- **Collision** — both `author:` and `$author:` declared in the same entity
- **Existence** — `$author: /authors/dick` and no entity resolves at that href
- **Target type** — when typed via `entityRef('author')` (planned), the target's layout doesn't match

Warnings are transition-based: a warning fires the first time an entity's issue set appears or changes; an info fires when an entity that previously had issues comes back clean. Stable repeats are silent so a single broken ref doesn't flood the log every cycle.

```
WARN  Refs problem: /documents/en/posts/refs-broken.md
  $author: reference /authors/does-not-exist does not resolve
```

A pending-validation map keyed by entity id is re-evaluated every cycle — entries whose targets finally appear clear themselves; new failures get added. The current state is exposed via the `mikser://schemas/pending` MCP resource so editors, dashboards, and AI agents can ask "what's currently broken?" without scraping logs.

`onError: 'fail'` in the config applies only to schema-shape mismatches against the Zod schema — never to ref failures, which are always warnings because they are always recoverable through subsequent edits.

### Working with refs from the frontend

References behave differently in three layers per ADR-0007 A3:

| Layer | Shape |
|---|---|
| Source files on disk | `$author: /authors/dick` |
| Catalog (in-memory) | preserved canonical `$`-keys |
| Templates / render context | normalized — `$` stripped, you do `{{ meta.author }}` |
| SDK responses | normalized — you read `entity.meta.author` |

So a Vue/React/Svelte component reading `useDocument` always sees `meta.author` as a plain string, regardless of whether the source used `author:` or `$author:`. Existing templates and SDK code keep working unchanged.

To get the resolved entity inline (instead of just the href string) ask the api to `expand` it — see [`mikser-io-sdk-api`](https://github.com/almero-digital-marketing/mikser-io-sdk-api)'s `expand` parameter. One round-trip, full graph context, type-safe via the generated `.d.ts`.

### What about graph-shaped queries?

For "which entities reference this one?", "what does this entity link to?", and atomic rename cascade, the engine maintains an inverse-reference index at `runtime.refs.*`. The same data is exposed via MCP tools (`mikser_refs_inbound`, `_outbound`, `_broken`, `_rename`) and the `mikser://refs/index` resource. The index is engine-level (not a plugin) — see ADR-0006's four-test analysis in ADR-0007 §B9 — so it's always available with no plugin-coordination required. This schemas plugin currently does its own catalog walk for re-evaluation; a future optimisation will use `runtime.refs.inboundFor(ref)` to look up exactly which pending entries are affected when a target appears mid-cycle.

## Conventions

- **One schema file per layout**, named after the layout: `schemas/article.js`, `schemas/product.js`, etc.
- **Default export is the Zod schema.** No registration boilerplate.
- **Optional `revision`** export — bump to invalidate the type cache deliberately. (mikser's journal handles incremental builds normally, but this gives you a manual override if needed.)
- **Optional `external`** export — `export const external = true` when the
  schema is consumed by something that imports the file directly rather than
  through `schemaKey` front-matter or the `schemas` service. Without it the
  build closes by reporting the schema as unused, which is accurate about
  what the registry observed and wrong about what to do. Must be exactly
  `true`: a truthy value would let a typo switch the guard off while reading
  as a denial.
- **HMR**: edit a schema file while `mikser --watch` is running and the plugin re-loads it, re-validates affected entities, and re-emits the `.d.ts`.

## Configuration reference

```js
schemas: {
    // Folder containing the schema modules. Default: 'schemas'.
    schemasFolder: 'schemas',

    // Where to write the generated TypeScript declaration file.
    // Path is relative to the working folder; default 'entities.d.ts'.
    typesFile: 'entities.d.ts',

    // How to behave when an entity fails its schema.
    //   'warn' — log, continue.            (default)
    //   'fail' — throw, exit non-zero.
    //   'off'  — skip validation entirely.
    onError: 'warn',

    // Dotted path on the entity that holds the layout name. The
    // filename stem of each schema file is matched against this value.
    // REQUIRED. No default. Pick 'meta.layout' for SSG projects, or
    // 'meta.component' for SPA projects (no rendered HTML, no layout).
    schemaKey: 'meta.layout',
}
```

## Lifecycle hooks used

The plugin hooks into:

| Hook | What it does |
|---|---|
| `onLoaded` | Resolves config paths, ensures `schemasFolder` exists, registers the schema-folder watcher. Also registers the `mikser://schemas/pending` MCP resource when an MCP substrate is available. |
| `onSync('schemas', ...)` | Loads / reloads / unloads schema modules as files appear in `schemasFolder`. Cache-busted dynamic import so HMR works. |
| `onValidate([CREATE, UPDATE], ...)` | Looks up the schema by `entity.meta[schemaKey]` and runs `.safeParse(entity.meta)`. Returns the error message string in `'warn'` mode, throws in `'fail'` mode. Skips silently when `schemaKey` is unset (the finalize warning surfaces the off state). Used for **schema-shape validation only**; ref validation is deferred (see below). |
| `onFinalized` | Two passes: (1) walks every entity in the catalog and runs ref validation (shape, collision, existence) — see [ADR-0007 A6](https://github.com/almero-digital-marketing/mikser-io/blob/main/documentation/decisions/0007-references-declaration-and-expansion.md). All transitions are logged; stable repeats are silent. (2) If anything changed in the schemas map this run, re-emits the `.d.ts`. |

The split between schema validation (`onValidate`, per-entity at create/update) and ref validation (`onFinalized`, full-catalog re-eval per cycle) matches the two failure modes' timing characteristics: schema shape is a property of one entity in isolation; ref resolution depends on the whole catalog's current state, which is only fully visible after `onPersist`.

No engine changes, no new lifecycle phases — the plugin lives entirely on top of the existing engine API.

## License

MIT
