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

import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  PluginPackages,
  boot,
  createRuntimeResolution,
  loadOverlayPatches,
  loadProfile,
} from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext, ProfileLayer } from '@deepseek-ai/dsh-app-boot'
import { apply as applyCapture, captureOf } from '@deepseek-ai/dsh-distill-trajectory-events'
import type { TrajectoryCapture } from '@deepseek-ai/dsh-distill-trajectory-events'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** The launcher identity these rows are composed under. */
const BIN_NAME = 'dsh'

/** The installation every composed package resolves against. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../../cli/package.json', import.meta.url))

/** The profile this application boots. */
export const DISTILL_PROFILE = 'distill'

/**
 * The overlay this application layers over the profile.
 * @returns the absolute path of the shipped overlay.
 */
export function defaultOverlayPath(): string {
  return fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
}

/** The model the composition pinned. */
export interface PinnedTeacher {
  /** The provider id the composition registered. */
  readonly provider: string
  /** The model id every attempt must run under. */
  readonly model: string
  /** The reasoning effort the composition pinned, when it pinned one. */
  readonly reasoningEffort?: 'low' | 'high' | 'max'
}

/**
 * Read the teacher the composition pinned.
 *
 * The teacher lock has already refused the load unless every layer agreed on one
 * allowed model, so this is the selection a run may use rather than one a caller
 * may choose.
 *
 * @param ctx - the composed context.
 * @returns the provider, model, and reasoning effort the composition selected.
 */
export function pinnedTeacher(ctx: Context): PinnedTeacher {
  const selection = ctx.agentDefaultModel.currentSelection()
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/**
 * Name the packages an overlay inserts, so the profile can resolve them.
 * @param entries - the rows the overlay inserts.
 * @returns the specifiers the rows name, including nested group members.
 */
function insertedPluginNames(entries: readonly EntryOptions[]): string[] {
  return entries.flatMap((entry) => {
    const children = entry.group === true && Array.isArray(entry.config)
      ? insertedPluginNames(entry.config as EntryOptions[])
      : []
    return [entry.name, ...children]
  })
}

/**
 * Reduce a specifier to its package name.
 * @param specifier - a plugin specifier.
 * @returns the package name, or `undefined` for a relative or protocol specifier.
 */
function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('file:') || specifier.includes(':')) return undefined
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

/**
 * Give an overlay's own packages the profile's module visibility.
 * @param path - the overlay file, used as the resolution base.
 * @param patches - the rows the overlay contributes.
 * @returns one module layer per package the overlay inserts.
 */
function overlayModuleLayers(path: string, patches: readonly PatchOptions[]): ProfileLayer[] {
  const require = createRequire(path)
  const packages = new Map<string, string>()
  const inserted = patches.flatMap(patch => patch.insert ?? [])
  for (const specifier of insertedPluginNames(inserted)) {
    const name = packageName(specifier)
    if (name === undefined || packages.has(name)) continue
    packages.set(name, dirname(require.resolve(`${name}/package.json`)))
  }
  return [...packages].map(([name, packageDir], index) => ({
    packageName: `distill-overlay:${String(index)}:${name}`,
    packageDir,
    patchPaths: [path],
    patches: [],
  }))
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
  const overlayPaths = options.overlays ?? [defaultOverlayPath()]
  const profile = loadProfile(BIN_NAME, DISTILL_PROFILE, INSTALL_ANCHOR, undefined, { userLayer: true })
  const rootConfig = join(profile.dir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  const overlays = overlayPaths.map(path => loadOverlayPatches(BIN_NAME, path))
  const moduleLayers = overlayPaths.flatMap((path, index) => overlayModuleLayers(path, overlays[index] ?? []))
  const resolution = await createRuntimeResolution({
    installAnchor: INSTALL_ANCHOR,
    profile: { ...profile, layers: [...profile.layers, ...moduleLayers] },
  })
  const ctx = await boot(BIN_NAME, rootConfig, [
    ...profile.layers.flatMap(layer => layer.patches),
    ...overlays.flat(),
  ], async (inner: Context) => {
    const profileContext: ProfileContext = {
      name: DISTILL_PROFILE,
      dir: profile.dir,
      patchPath: profile.patchPath,
      installAnchor: INSTALL_ANCHOR,
      cwd: process.cwd(),
      home: process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
      startedBundles: profile.layers.map(layer => layer.packageName),
      overlays: overlays.flat(),
      telemetryDisabledEnv: process.env['DSH_TELEMETRY_DISABLED'],
    }
    inner.provide('profileContext', profileContext)
    await inner.plugin(PluginPackages, { resolution })
  })
  // The Loader has mounted every row by the time `boot` resolves, so the capture
  // subscribes to a live event stream rather than a half-built context.
  await ctx.plugin({ name: 'distill-capture', apply: (inner: Context) => { applyCapture(inner) } })
  const capture = captureOf(ctx)
  if (capture === undefined) throw new Error('the trajectory capture did not publish its service')
  return { ctx, capture, shutdown: async () => { await ctx.fiber.dispose() } }
}
