import { defineCapability, method } from '@kernel/rpc/contract'
import type { CateSetup, SetupApplyResult, SetupEntry, SetupScope } from './schema'

/** Setups of this workspace (`.cate/setups`) and the machine (`~/.cate/setups`),
 *  plus saving and applying one. Applying starts agent panels, so it mutates. */
export const setupCapability = defineCapability('setup', {
  methods: {
    list: method<void, SetupEntry[]>(),
    /** Saves to the workspace's `.cate/setups` by default. Without `id` the
     *  id is the name's slug, made unique instead of overwriting. */
    save: method<{ setup: CateSetup; scope?: SetupScope; id?: string }, SetupEntry>({ mutates: true }),
    /** Starts every node's agent on a canvas and draws the edges. */
    apply: method<{ id: string; scope?: SetupScope; canvasPanelId?: string; orchestratorPrompt?: string }, SetupApplyResult>({
      mutates: true,
      timeoutMs: 180_000,
    }),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    setup: typeof setupCapability
  }
}
