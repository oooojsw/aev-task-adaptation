import path from "node:path"
import { lstat, realpath } from "node:fs/promises"
import { ensureDirectory, pathExists, writeJsonFile } from "../fs"
import type {
  CompiledInformationView,
  CompiledRoleAccess,
  InformationViewDescriptor,
  RoleAccessPolicy,
} from "./contract"

function uniquePaths(items: string[]) {
  return Array.from(new Set(items.map((item) => path.resolve(item))))
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function overlaps(left: string, right: string) {
  return isWithin(left, right) || isWithin(right, left)
}

async function nearestExistingPath(input: string) {
  let current = path.resolve(input)
  while (!(await pathExists(current))) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`No existing ancestor for access path: ${input}`)
    current = parent
  }
  return current
}

async function assertNoLinkedPathComponents(input: {
  viewID: string
  boundaryRoot: string
  existingCandidate: string
}) {
  const root = path.resolve(input.boundaryRoot)
  const candidate = path.resolve(input.existingCandidate)
  const relative = path.relative(root, candidate)
  const components = relative === "" ? [] : relative.split(path.sep).filter(Boolean)
  let current = root
  for (const component of ["", ...components]) {
    if (component) current = path.join(current, component)
    if (!(await pathExists(current))) break
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Information view '${input.viewID}' cannot traverse a symlink or junction: ${current}`,
      )
    }
  }
}

async function assertPathInsideBoundary(input: {
  viewID: string
  candidate: string
  boundaryRoots: string[]
}) {
  const candidate = path.resolve(input.candidate)
  const roots = uniquePaths(input.boundaryRoots)
  if (!roots.length) throw new Error(`Information view '${input.viewID}' has no boundary roots.`)
  const lexicalRoot = roots.find((root) => isWithin(root, candidate))
  if (!lexicalRoot) {
    throw new Error(`Information view '${input.viewID}' path escapes declared boundaries: ${candidate}`)
  }

  const existingCandidate = await nearestExistingPath(candidate)
  await assertNoLinkedPathComponents({
    viewID: input.viewID,
    boundaryRoot: lexicalRoot,
    existingCandidate,
  })
  const [candidateTruth, rootTruth] = await Promise.all([
    realpath(existingCandidate),
    realpath(await nearestExistingPath(lexicalRoot)),
  ])
  if (!isWithin(path.resolve(rootTruth), path.resolve(candidateTruth))) {
    throw new Error(`Information view '${input.viewID}' resolves outside its boundary: ${candidate}`)
  }

}

async function normalizeView(view: InformationViewDescriptor): Promise<CompiledInformationView> {
  const paths = uniquePaths(view.paths)
  const entryPaths = uniquePaths(view.entryPaths ?? [])
  const boundaryRoots = uniquePaths(view.boundaryRoots)
  for (const candidate of [...paths, ...entryPaths]) {
    await assertPathInsideBoundary({ viewID: view.id, candidate, boundaryRoots })
  }
  for (const entry of entryPaths) {
    if (!paths.some((root) => isWithin(root, entry))) {
      throw new Error(`Information view '${view.id}' entry path is not inside a view path: ${entry}`)
    }
  }
  return {
    id: view.id,
    sensitivity: view.sensitivity,
    access: view.access,
    paths,
    entryPaths,
    boundaryRoots,
  }
}

export async function compileRoleAccess(input: {
  profileID: string
  policy: RoleAccessPolicy
  views: InformationViewDescriptor[]
  manifestPath?: string
}): Promise<CompiledRoleAccess> {
  const viewMap = new Map(input.views.map((view) => [view.id, view]))
  const requested = new Set([
    ...input.policy.readableViews,
    ...input.policy.writableViews,
    ...input.policy.referenceViews,
  ])
  const missing = [...requested].filter((id) => !viewMap.has(id))
  if (missing.length) {
    throw new Error(`Role '${input.policy.roleID}' references unknown information view(s): ${missing.join(", ")}`)
  }

  const selected = await Promise.all([...requested].map((id) => normalizeView(viewMap.get(id)!)))
  for (const view of selected) {
    if (!input.policy.allowedSensitivities.includes(view.sensitivity)) {
      throw new Error(
        `Role '${input.policy.roleID}' cannot access ${view.sensitivity} information view '${view.id}'.`,
      )
    }
  }

  const readable = selected.filter((view) => input.policy.readableViews.includes(view.id))
  const writable = selected.filter((view) => input.policy.writableViews.includes(view.id))
  for (const view of readable) {
    if (view.access === "write_only") {
      throw new Error(`Role '${input.policy.roleID}' cannot read write-only view '${view.id}'.`)
    }
  }
  for (const view of writable) {
    if (view.access === "read_only") {
      throw new Error(`Role '${input.policy.roleID}' cannot write read-only view '${view.id}'.`)
    }
  }

  const readPaths = uniquePaths(readable.flatMap((view) => view.paths))
  const editPaths = uniquePaths(writable.flatMap((view) => view.paths))
  for (const editPath of editPaths) {
    for (const readPath of readPaths) {
      if (!overlaps(editPath, readPath)) continue
      const sharedReadWriteView = selected.some(
        (view) =>
          view.access === "read_write" &&
          input.policy.readableViews.includes(view.id) &&
          input.policy.writableViews.includes(view.id) &&
          view.paths.some((candidate) => overlaps(candidate, editPath) && overlaps(candidate, readPath)),
      )
      if (!sharedReadWriteView) {
        throw new Error(
          `Role '${input.policy.roleID}' has unsafe read/write overlap: read=${readPath} edit=${editPath}`,
        )
      }
    }
  }

  const referenceViews = selected.filter((view) => input.policy.referenceViews.includes(view.id))
  const referencePaths = uniquePaths(
    referenceViews.flatMap((view) => (view.entryPaths.length ? view.entryPaths : view.paths)),
  )
  for (const referencePath of referencePaths) {
    if (!readPaths.some((readPath) => isWithin(readPath, referencePath))) {
      throw new Error(`Role '${input.policy.roleID}' reference is not readable: ${referencePath}`)
    }
  }

  const manifestPath = input.manifestPath ? path.resolve(input.manifestPath) : undefined
  const manifest: CompiledRoleAccess = {
    schema: "auto-evolve-role-access-manifest/v1",
    profileID: input.profileID,
    roleID: input.policy.roleID,
    createdAt: new Date().toISOString(),
    referencePaths: uniquePaths([...referencePaths, ...(manifestPath ? [manifestPath] : [])]),
    permissionReadPaths: uniquePaths([...readPaths, ...(manifestPath ? [manifestPath] : [])]),
    permissionEditPaths: editPaths,
    allowShell: input.policy.allowShell ?? false,
    views: selected,
  }
  if (manifestPath) {
    await ensureDirectory(path.dirname(manifestPath))
    await writeJsonFile(manifestPath, manifest)
  }
  return manifest
}
