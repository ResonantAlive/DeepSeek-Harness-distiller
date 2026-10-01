import { afterEach, describe, expect, it } from 'vitest'
import { bootDistillComposition, pinnedTeacher } from '../src/composition.ts'
import type { DistillComposition } from '../src/composition.ts'

/**
 * These cases boot the real composition and reach the real provider, so they run
 * only when a key is present. Everything else about the application is covered
 * without a key by the distill package's suites.
 */
const apiKey: string | undefined = process.env['DEEPSEEK_API_KEY']
const describeReal = apiKey === undefined || apiKey.length === 0 ? describe.skip : describe

const booted: DistillComposition[] = []

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (composition) => { await composition.shutdown() }))
})

describeReal('the composed application', () => {
  it('boots the distill profile through the Loader and pins one teacher', async () => {
    const composition = await bootDistillComposition()
    booted.push(composition)
    // The teacher lock refuses the load unless every layer agreed, so a booted
    // composition proves the lock ran and accepted the pinned model.
    const teacher = pinnedTeacher(composition.ctx)
    expect(teacher.model).toBe('deepseek-flash')
    expect(teacher.provider.length).toBeGreaterThan(0)
    // The capture is mounted and published, so an attempt can bind its recorder.
    expect(composition.capture).toBeDefined()
  }, 180_000)
})
