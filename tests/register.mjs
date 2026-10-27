/**
 * Register the harness resolution hook before a scenario module loads.
 * Usage: node --import ./tests/register.mjs ./tests/tools-sim.mjs
 */
import { register } from 'node:module'

register(new URL('./hooks.mjs', import.meta.url))
