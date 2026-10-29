// What the file models ask of the person using this client.

import type { FileAccessRequest } from '../contract'

declare module '@kernel/interaction/contract' {
  interface ClientUi {
    /** Asks before files dropped from outside Cate are copied into
     *  `destName`. Optional: without it dropped files are copied at once. */
    confirmImportEntries?(request: { count: number; destName: string }): Promise<'copy' | 'cancel'>
    /** Shows the exact external path and the scope that approval will remember. */
    confirmFileAccess?(request: FileAccessRequest): Promise<boolean>
  }
}

export {}
