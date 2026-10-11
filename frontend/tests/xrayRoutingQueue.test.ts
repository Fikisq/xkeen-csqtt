import assert from 'node:assert/strict'
import test from 'node:test'
import { createXrayRoutingQueue } from '../src/lib/xrayRoutingQueue.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('edits appear immediately and edits during a request are coalesced without losing order', async () => {
  const first = deferred()
  const calls: Array<[string, string]> = []
  const states: Array<[string, boolean]> = []
  const commits: string[] = []
  const queue = createXrayRoutingQueue({
    initial: 'A',
    send: async (previous, content) => { calls.push([previous, content]); if (calls.length === 1) await first.promise },
    onState: (content, pending) => { states.push([content, pending]) },
    onCommit: content => { commits.push(content) }, onError: error => { throw error },
  })
  const one = queue.edit(content => `${content}B`)
  assert.deepEqual(states.at(-1), ['AB', true])
  await Promise.resolve()
  const two = queue.edit(content => `${content}C`)
  const three = queue.edit(content => `${content}D`)
  assert.deepEqual(states.at(-1), ['ABCD', true])
  assert.deepEqual(calls, [['A', 'AB']])
  first.resolve()
  assert.deepEqual(await Promise.all([one, two, three]), [true, true, true])
  assert.deepEqual(calls, [['A', 'AB'], ['AB', 'ABCD']])
  assert.deepEqual(commits, ['AB', 'ABCD'])
  assert.deepEqual(states.at(-1), ['ABCD', false])
})

test('a rejected request rolls back pending edits to the last confirmed snapshot', async () => {
  const second = deferred()
  let calls = 0
  let preview = ''
  let errorCount = 0
  const queue = createXrayRoutingQueue({
    initial: 'A', send: async () => { if (++calls === 2) await second.promise },
    onState: content => { preview = content }, onCommit: () => {}, onError: () => { errorCount++ },
  })
  assert.equal(await queue.edit(content => `${content}B`), true)
  const two = queue.edit(content => `${content}C`)
  await Promise.resolve()
  const three = queue.edit(content => `${content}D`)
  second.reject(new Error('Xray rejected rules'))
  assert.deepEqual(await Promise.all([two, three]), [false, false])
  assert.equal(preview, 'AB')
  assert.equal(errorCount, 1)
  assert.equal(calls, 2)
})

test('edits that cancel each other do not call the API; a throwing edit leaves the queue usable', async () => {
  let calls = 0
  const queue = createXrayRoutingQueue({
    initial: 'A', send: async () => { calls++ }, onState: () => {}, onCommit: () => {}, onError: () => {},
  })
  const one = queue.edit(() => 'B')
  const two = queue.edit(() => 'A')
  assert.deepEqual(await Promise.all([one, two]), [true, true])
  assert.equal(calls, 0)
  assert.throws(() => queue.edit(() => { throw new Error('Invalid edit') }))
  assert.equal(await queue.edit(content => `${content}C`), true)
  assert.equal(calls, 1)
})
