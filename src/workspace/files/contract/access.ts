export type FileAccessOperation = 'read' | 'write' | 'browse'

/** A path request the runtime is waiting for a person to approve. */
export interface FileAccessRequest {
  id: string
  /** The exact path the operation tried to use. */
  path: string
  /** The path that approval will add to this workspace's persistent grants. */
  grantPath: string
  operation: FileAccessOperation
}
