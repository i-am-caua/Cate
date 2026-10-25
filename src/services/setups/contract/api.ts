// cate.setup commands for the shared setup library.

import { bool, defineCateApi, defineCliArea, opt, panel, path as pathArg, str } from '@kernel/api/contract'

export const setupCliArea = defineCliArea({
  label: 'Setups',
  read: {
    key: 'cliSetupReadEnabled',
    code: 'setup-read-disabled',
    detail: 'cate setup list and show: inspect saved workspace and global setups.',
  },
  control: {
    key: 'cliSetupControlEnabled',
    code: 'setup-control-disabled',
    detail: 'cate setup apply, save, import and delete: start setup agents and manage setup files.',
  },
})

export const setupApi = defineCateApi(
  'setup',
  {
    list: {
      access: 'read',
      handler: 'service',
      summary: 'List workspace and global setups',
      format: 'setupList',
      cli: { command: ['setup', 'list'] },
    },
    show: {
      access: 'read',
      handler: 'service',
      summary: 'Show a setup',
      args: { setupId: str.nonEmpty().pos('id').help('Setup id from cate setup list') },
      format: 'prettyJson',
      cli: { command: ['setup', 'show'] },
    },
    apply: {
      access: 'control',
      handler: 'service',
      summary: 'Start the agents and relations in a setup',
      args: {
        setupId: str.nonEmpty().pos('id').help('Setup id from cate setup list'),
        canvasPanelId: opt(panel('canvas')).flag('canvas', 'id').help('Place agents on this canvas'),
      },
      timeoutMs: 180_000,
      cli: { command: ['setup', 'apply'] },
    },
    save: {
      access: 'control',
      handler: 'service',
      summary: 'Validate and save a setup file',
      args: {
        file: pathArg.pos('file').help('Setup JSON file'),
        global: opt(bool, false).help('Save to ~/.cate/setups'),
        setupId: opt(str.nonEmpty()).flag('id').help('Override the setup id'),
        name: opt(str.nonEmpty()).help('Override the setup name'),
      },
      cli: { command: ['setup', 'save'] },
    },
    'import': {
      access: 'control',
      handler: 'service',
      summary: 'Copy a setup file into the workspace',
      args: { file: pathArg.pos('file').help('Setup JSON file') },
      cli: { command: ['setup', 'import'] },
    },
    delete: {
      access: 'control',
      handler: 'service',
      summary: 'Delete a workspace or global setup',
      args: {
        setupId: str.nonEmpty().pos('id').help('Setup id from cate setup list'),
        global: opt(bool, false).help('Delete from ~/.cate/setups'),
      },
      cli: { command: ['setup', 'delete'] },
    },
  },
  { area: setupCliArea, summary: 'Save, inspect and apply agent setups' },
)

