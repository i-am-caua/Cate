import { defineSettings, oneOf, setting } from '@kernel/settings/contract/define'

export type FileAccessMode = 'ask' | 'full'

/** Whether this workspace runtime may use file paths outside its workspace. */
export const filesSettings = defineSettings({
  scope: 'workspace',
  keys: {
    fileAccessMode: setting<FileAccessMode>('ask', oneOf('ask', 'full')),
  },
})
