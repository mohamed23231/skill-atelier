# Evidence and Policies Reference

Architecture Visualizer 2.0 incorporates a deterministic validation and evidence verification subsystem. It distinguishes grounded, verified facts from assumptions, verifies disk assets, enforces architectural boundaries, and reports policy findings.

---

## 1. Evidence System

The evidence subsystem grounds architectural models in real repository code, contracts, and database structures.

### Verification States

Every evidence item is evaluated against the local repository during `validate` and `build`:

| State | Definition | Resolution Rule |
| --- | --- | --- |
| `verified` | Confirmed accurate against the filesystem. | The target path exists on disk strictly under `--repo-root`. If a line range is declared, it falls within the file. If a symbol is declared, it appears as a whole identifier (not as part of a longer name) and, when a line range is given, inside that range. |
| `unresolved` | File or path cannot be found under the repository root. | Path does not exist under `--repo-root` (`evidence.missing`), or it points outside the root: an absolute path elsewhere, a `../` escape, a symlink leading out, or the root itself (`evidence.outside_repo`). |
| `stale` | Path exists, but contents have drifted. | File exists, but specified symbol is not found or `startLine`/`endLine` indices exceed the file line count or are inverted (`endLine < startLine`). Generates an `evidence.stale` finding. |
| `asserted` | Non-file evidence recorded as an assertion. | Applied to `assertion` or `command` evidence types that cannot be verified solely by checking static files on disk. |
| `compatibility` | Synthesized from legacy v1 fields. | Created automatically when normalizing legacy v1 `details.files`, `details.apis`, or `details.tables`. |

### Locators

Locators identify the exact target of an evidence record:

```jsonc
// 1. File Locator
{
  "id": "ev_order_service",
  "type": "file",
  "locator": { "path": "src/services/order.ts" },
  "origin": "author"
}

// 2. Symbol Locator (verifies file existence, symbol text, and optional line numbers)
{
  "id": "ev_payment_handler",
  "type": "symbol",
  "locator": {
    "path": "src/handlers/payment.ts",
    "symbol": "processPayment",
    "startLine": 45,
    "endLine": 92
  },
  "origin": "author"
}

// 3. Document Locator
{
  "id": "ev_spec_rfc",
  "type": "document",
  "locator": {
    "document": "docs/rfcs/0042-billing.md",
    "startLine": 1,
    "endLine": 120
  },
  "origin": "author"
}

// 4. API Endpoint Locator (`path` is the route; add `file` to verify the handler file)
{
  "id": "ev_checkout_api",
  "type": "api",
  "locator": { "method": "POST", "path": "/api/v2/checkout", "file": "src/routes/checkout.ts" },
  "origin": "author"
}

// 5. Database Table Locator
{
  "id": "ev_invoices_table",
  "type": "table",
  "locator": { "table": "invoices" },
  "origin": "author"
}

// 6. Command Locator
{
  "id": "ev_db_migration_cmd",
  "type": "command",
  "locator": { "command": "npm run db:migrate:status" },
  "origin": "author"
}

// 7. Assertion Locator
{
  "id": "ev_latency_slo",
  "type": "assertion",
  "locator": { "assertion": "p99 latency under 150ms per SLA section 4.2" },
  "origin": "author"
}
```

---

## 2. Policy Engine

Policies define structural, architectural, and governance constraints evaluated against the graph during validation.

### Built-in Policy Kinds

| Policy Kind | Description | Configurable Properties |
| --- | --- | --- |
| `forbidden_dependency` | Forbids edges between matching nodes. | `from`, `to`, `fromType`, `toType`, `fromBoundary`, `toBoundary`, `severity` |
| `required_dependency` | Demands at least one edge between source and target sets. | `from`, `to`, `fromType`, `toType`, `severity` |
| `layer_direction` | Enforces unidirectional flow across sequential boundaries. Flagged if an edge goes backwards across ranks. | `layers` (array of boundary IDs in order), `severity` |
| `cycle` | Detects any directed cycle in the component graph. | `severity` |
| `required_evidence` | Enforces that components of a given status or type link to verified evidence. | `status` (default: `"VERIFIED"`), `componentType`, `evidenceTypes`, `severity` |
| `fan_out` | Flags nodes with outgoing edges exceeding a threshold. | `max` (number), `nodeType`, `severity` |
| `fan_in` | Flags nodes with incoming edges exceeding a threshold. | `max` (number), `nodeType`, `severity` |

### Built-in Evidence Policy Rules

The engine automatically evaluates built-in evidence checks:

- `evidence.required`: A node marked `status: "VERIFIED"` must link to resolvable evidence in `evidenceIds` or `details`.
- `evidence.missing`: Referenced evidence could not be found on disk (`EVIDENCE_VERIFICATION.UNRESOLVED`).
- `evidence.stale`: Referenced evidence contains outdated line bounds or missing symbols (`EVIDENCE_VERIFICATION.STALE`).
- `evidence.outside_repo`: Referenced evidence points outside the repository root, so it cannot ground a claim about this repository.
- `evidence.unresolved_reference`: A node lists an ID in `evidenceIds` that does not exist in the top-level `evidence` array.

---

## 3. Findings

When policies fail or evidence checks detect discrepancies, structured findings are generated.

```jsonc
{
  "id": "finding_policy_pol_client_never_direct_db_web_app_order_db",
  "severity": "error", // "error" | "warn" | "info"
  "message": "Forbidden dependency from \"web_app\" to \"order_db\".",
  "nodeIds": ["web_app", "order_db"],
  "edgeIds": ["edge_web_direct_db"],
  "policyId": "pol_client_never_direct_db",
  "evidenceIds": []
}
```

Findings are surfaced directly in:
1. **CLI Output**: Formatted warning and error summaries during `arch-viz validate`.
2. **Offline HTML Workbench**: The interactive Findings & Evidence inspector panel with severity badges and node-highlight links.
3. **Markdown Architecture Report**: Dedicated `### Findings` and `### Evidence manifest` sections.

---

## 4. Security Rules & Untrusted Text Handling

Because architecture models may be drafted from diffs, generated by agents, or shared across security perimeters, strict sanitization invariants are enforced:

### Secret Exposure Prohibitions

- **No Secrets**: Never include real API tokens, database credentials, passwords, session cookies, private keys, or internal JWTs in `locator`, `assertion`, `details.apis`, or `scenarios[].payload`.
- **Sanitized Placeholders**: Use generic placeholders (e.g. `Bearer <redacted_jwt>`, `DATABASE_URL=postgres://user:***@host/db`).

### XSS & Script Tag Escaping

- **DOM Sink Escaping**: All node labels, descriptions, technology fields, and detail attributes rendered to the DOM are escaped using strict entity encoding (`&amp;`, `&lt;`, `&gt;`, `&quot;`).
- **Script Tag Neutralization**: Spec JSON embedded within the compiled HTML is serialized with `<` characters escaped to `\u003c`. An injected `</script>` string inside a description or payload cannot prematurely terminate the `<script>` container.
- **Placeholder Substitution Safety**: The compiler uses single backward literal substring slicing (`replaceOnce`) rather than regex substitution. This prevents `$1`, `$&`, or `$'` characters in user specifications from triggering unintended template expansions.
