import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

type RepoDisplayLabelItem = {
  path: string
  displayName: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

// Why: two repos can share the same absolute path across hosts (e.g. a local
// /Users/alice and an SSH host's /Users/alice). Keying labels by raw path alone
// lets one repo's label overwrite the other's, so scope the key by execution
// host. getRepoExecutionHostId returns 'local' for local repos and falls back to
// the connectionId (ssh:<id>) for SSH folder-repos that leave executionHostId unset.
export function getRepoDisplayLabelKey(
  item: Pick<RepoDisplayLabelItem, 'path' | 'connectionId' | 'executionHostId'>
): string {
  return `${getRepoExecutionHostId(item)}::${item.path}`
}

function normalizePathSegments(path: string): string[] {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '').split('/').filter(Boolean)
}

function labelForDepth(item: RepoDisplayLabelItem, depth: number): string {
  const segments = normalizePathSegments(item.path)
  const suffix = segments.slice(Math.max(0, segments.length - depth))
  if (suffix.length === 0) {
    return item.displayName
  }
  suffix[suffix.length - 1] = item.displayName
  return suffix.join('/')
}

function hasDuplicateLabels(labels: readonly string[]): boolean {
  return new Set(labels).size !== labels.length
}

/**
 * Labels each repo by name, keyed by host and path. Same-name repos get the
 * shortest parent-path suffix that separates their distinct paths; same-path
 * repos on different hosts share one label.
 */
export function getRepoDisplayLabelsByPath(
  items: readonly RepoDisplayLabelItem[]
): Map<string, string> {
  const labels = new Map<string, string>()
  const itemsByName = new Map<string, RepoDisplayLabelItem[]>()

  for (const item of items) {
    const displayName = item.displayName || item.path
    labels.set(getRepoDisplayLabelKey(item), displayName)
    const colliding = itemsByName.get(displayName) ?? []
    colliding.push({ ...item, displayName })
    itemsByName.set(displayName, colliding)
  }

  for (const collidingItems of itemsByName.values()) {
    // Why: no suffix separates same-path twins on different hosts, so only distinct paths set the depth.
    const distinctPathItems = [
      ...new Map(
        collidingItems.map((item) => [normalizePathSegments(item.path).join('/'), item])
      ).values()
    ]
    if (distinctPathItems.length < 2) {
      continue
    }
    const maxDepth = Math.max(
      ...distinctPathItems.map((item) => normalizePathSegments(item.path).length)
    )
    let depth = 1
    while (
      depth < maxDepth &&
      hasDuplicateLabels(distinctPathItems.map((item) => labelForDepth(item, depth)))
    ) {
      depth += 1
    }
    for (const item of collidingItems) {
      labels.set(getRepoDisplayLabelKey(item), labelForDepth(item, depth))
    }
  }

  return labels
}
