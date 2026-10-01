/**
 * Boot the distillation composition through the Cordis Loader.
 *
 * A distillation run is an ordinary harness application: it composes the shipped
 * base bundle plus the overlay this application owns, waits for the Loader to
 * mount every row, and only then drives an agent. Nothing here hand-builds a
 * plugin list, so the plugins a run depends on are exactly the ones a
 * `cordis.yml` composition would mount.
 *
 * @module @deepseek-ai/dsh-distill-app/composition
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { apply as applyCapture, captureOf } from '@deepseek-ai/dsh-distill-trajectory-events'
import type { TrajectoryCapture } from '@deepseek-ai/dsh-distill-trajectory-events'

/** The profile this application boots. */
export const DISTILL_PROFILE = 'distill'

/**
 * The overlay this application layers over the profile.
 * @returns the absolute path of the shipped overlay.
 */
export function defaultOverlayPath(): string {
  return fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
}

/** A booted composition. */
export interface DistillComposition {
  /** The composed context; every service a run needs is reachable from it. */
  readonly ctx: Context
  /** The capture the attempt runner binds each attempt's recorder to. */
  readonly capture: TrajectoryCapture
  /** Stop the composition and release its rows. */
  readonly shutdown: () => Promise<void>
}

/**
 * Boot the composition and mount the trajectory capture.
 *
 * The capture is mounted here rather than as a patch row because it publishes an
 * object the runner binds per attempt; a row would carry the same object as
 * plain configuration, which cannot hold it.
 *
 * @param options - the overlay paths to layer after the profile's own layers.
 * @returns the composed context, its capture, and its shutdown.
 */
export async function bootDistillComposition(
  options: { overlays?: readonly string[] } = {},
): Promise<DistillComposition> {
  const application = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: DISTILL_PROFILE,
    patchFiles: [...(options.overlays ?? [defaultOverlayPath()])],
    args: [],
  })
  const { ctx, shutdown } = application
  // The Loader has mounted every row by the time `runProfile` resolves, so the
  // capture subscribes to a live event stream rather than a half-built context.
  await ctx.plugin({ name: 'distill-capture', apply: (inner: Context) => { applyCapture(inner) } })
  const capture = captureOf(ctx)
  if (capture === undefined) throw new Error('the trajectory capture did not publish its service')
  return { ctx, capture, shutdown: async () => { await shutdown() } }
}
