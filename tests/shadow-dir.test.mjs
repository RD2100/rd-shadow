/**
 * Checks for the one owner of the shadow-directory rule.
 *
 * The default must not be a development machine's path: an installation on
 * another machine has to point at a directory it can create. These checks pin
 * that, plus the `~` expansion a bundle patch relies on (it ships identical YAML
 * to every machine and cannot know a user's home path).
 */
import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SHADOW_DIR, directoryKey, expandShadowDir } from '../lib/shadow-dir.js'

const { check, done } = suite('shadow-dir')

check('TC-DIR-001', 'the default lives under the user home, not a machine path', () => {
  assert.equal(DEFAULT_SHADOW_DIR, path.join(os.homedir(), 'dsh-shadow'))
  assert.ok(DEFAULT_SHADOW_DIR.startsWith(os.homedir()), `default is not under home: ${DEFAULT_SHADOW_DIR}`)
  assert.ok(!DEFAULT_SHADOW_DIR.toLowerCase().includes('d:\\dsh'), `default leaked a development path: ${DEFAULT_SHADOW_DIR}`)
})

check('TC-DIR-002', 'an explicit path is used as configured', () => {
  assert.equal(expandShadowDir('D:\\work\\shadow'), 'D:\\work\\shadow')
  assert.equal(expandShadowDir('/var/lib/shadow'), '/var/lib/shadow')
})

check('TC-DIR-003', 'a leading tilde expands to the user home', () => {
  assert.equal(expandShadowDir('~'), os.homedir())
  assert.equal(expandShadowDir('~/dsh-shadow'), path.join(os.homedir(), 'dsh-shadow'))
  assert.equal(expandShadowDir('~\\shadow'), path.join(os.homedir(), 'shadow'))
})

check('TC-DIR-004', 'surrounding whitespace does not survive', () => {
  assert.equal(expandShadowDir('  D:\\work  '), 'D:\\work')
})

check('TC-DIR-005', 'an absent or empty value yields no path', () => {
  for (const value of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(expandShadowDir(value), undefined, `expected undefined for ${String(value)}`)
  }
})

check('TC-DIR-006', 'comparison ignores separators, trailing slashes, and case', () => {
  assert.equal(directoryKey('D:\\DSH\\shadow'), 'd:/dsh/shadow')
  assert.equal(directoryKey('D:/DSH/shadow/'), 'd:/dsh/shadow')
  assert.equal(directoryKey('d:/dsh/shadow'), 'd:/dsh/shadow')
  assert.equal(directoryKey(''), undefined)
  assert.equal(directoryKey(undefined), undefined)
})

await done()
