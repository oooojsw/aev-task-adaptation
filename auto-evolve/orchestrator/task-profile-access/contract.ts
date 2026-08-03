export type TaskAccessSystemID = "legacy" | "profile_v2"

export type TaskProfileDescriptor = {
  id: string
  accessSystem: TaskAccessSystemID
  version?: string
}

export type InformationViewSensitivity =
  | "public"
  | "training"
  | "private_oracle"
  | "internal"

export type InformationViewAccess = "read_only" | "read_write" | "write_only"

export type InformationViewDescriptor = {
  id: string
  description?: string
  paths: string[]
  entryPaths?: string[]
  boundaryRoots: string[]
  sensitivity: InformationViewSensitivity
  access: InformationViewAccess
}

export type RoleAccessPolicy = {
  roleID: string
  readableViews: string[]
  writableViews: string[]
  referenceViews: string[]
  allowedSensitivities: InformationViewSensitivity[]
  allowShell?: boolean
}

export type CompiledInformationView = {
  id: string
  sensitivity: InformationViewSensitivity
  access: InformationViewAccess
  paths: string[]
  entryPaths: string[]
  boundaryRoots: string[]
}

export type CompiledRoleAccess = {
  schema: "auto-evolve-role-access-manifest/v1"
  profileID: string
  roleID: string
  createdAt: string
  referencePaths: string[]
  permissionReadPaths: string[]
  permissionEditPaths: string[]
  allowShell: boolean
  views: CompiledInformationView[]
}
