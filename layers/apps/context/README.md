# @nuxtinator/context

Context portfolios: structured markdown sections that describe an organization
(or anything else a template defines), edited in the web app, reviewed through
suggestions, and read by AI clients over MCP.

## Public server API: `#context/server`

`#context/server` is the context layer's public, semver-covered server surface
for consumer layers. Removing an export or changing a signature in it is a
breaking change and requires a major version of `@nuxtinator/context`.
Anything not exported here (other files under `server/utils/`, routes, MCP
tool internals) is private and may change in any release.

A layer that imports it lists `"@nuxtinator/context": "*"` in its
`optionalDependencies` and extends the context layer; core ships no fallback.
Every function takes the caller's tenant transaction (`tx` from
`defineTenantHandler` / `withOrgPermission`).

| Area | Exports |
|---|---|
| Portfolios | `createPortfolio`, `getPortfolioById`, `getPortfolioBySlug`, `getPortfolioBySlugOr404`, `listPortfolios` |
| Sections | `getPortfolioSections`, `loadSection`, `saveSectionContent`, `addSection` |
| Suggestions | `createSuggestionSet`, `decideSuggestions`, `withdrawSuggestions`, `pendingForSection` |
| Templates | `registerPortfolioTemplate`, `getRegisteredPortfolioTemplate`, `getRegisteredPortfolioTemplates`, `DEFAULT_PORTFOLIO_TEMPLATE_ID` |
| Types | `PortfolioRow`, `CreatePortfolioInput`, `SectionDef`, `MergedSection`, `PortfolioRef`, `SectionRow`, `SaveSectionOptions`, `AddSectionInput`, `PortfolioTemplate`, `NewSuggestion`, `SuggestionViewer`, `CreatedSuggestionSet`, `DecidedSuggestion`, `SectionPendingSuggestions`, `ContextSectionVersionSource`, `ContextSuggestionStatus` |

```ts
import { getPortfolioBySlugOr404, getPortfolioSections, saveSectionContent } from '#context/server'

const portfolio = await getPortfolioBySlugOr404(tx, slug)
const sections = await getPortfolioSections(tx, portfolio) // a portfolio row or its id
await saveSectionContent(tx, portfolio.id, 'team', markdown, userId, { source: 'user' })
```

## Portfolio templates

A portfolio template is the code-owned set of sections a portfolio starts with.
The built-in `default` template is the organization catalog in
[app/utils/section-catalog.ts](app/utils/section-catalog.ts) (identity, vision
and values, team, …). Another layer adds its own template from a Nitro plugin:

```ts
// layers/translate/server/plugins/register-translate-template.ts
import { registerPortfolioTemplate } from '#context/server'

export default defineNitroPlugin(() => {
  registerPortfolioTemplate({
    id: 'translate',
    label: 'Bible translation project',
    description: 'Sections that describe a translation project.',
    sections: [
      { key: 'source-texts', title: 'Source Texts', description: 'Which source texts the project translates from', order: 1, staleness_days: 90 },
      { key: 'team', title: 'Translation Team', description: 'Who translates, checks, and reviews', order: 2, staleness_days: 60 }
    ]
  })
})
```

Create a portfolio from it with `template` on `POST /api/context/portfolios`,
the `create_portfolio` MCP tool, or `createPortfolio(tx, { name, template }, userId)`.
`builtin_sections` then picks from that template's keys. `GET /api/context/templates`
lists the registered templates and their sections; the web app's new-portfolio
dialog offers a template picker when more than one is registered.

- The database stores only the portfolio's template id
  (`context_portfolios.template`, null for `default`) and each section's key.
  Titles, descriptions, order, and staleness of template sections resolve from
  code on every read, so adding or renaming a template section is a code
  change, never a migration.
- Template ids and section keys are lowercase letters, digits, and hyphens.
  Registering a duplicate id, or a template that repeats a section key, throws
  at boot.
- Custom sections work the same in every portfolio; a custom key may not reuse
  one of the portfolio's own template keys. A section created as custom is
  flagged as such (`context_section_definitions.is_custom`) and stays custom
  even if a later template version declares the same key.
- A key the template no longer declares (or a portfolio whose template is no
  longer registered) reads as an orphan: listed under its key, as a custom
  section, until it is removed.
