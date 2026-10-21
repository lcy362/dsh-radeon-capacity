import assert from 'node:assert/strict'
import test from 'node:test'

import { createCapacitySource, normalizeLoad } from '../src/host/load.js'

/** 造一份上游响应。 */
function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  }
}

test('normalizeLoad 只留白名单字段，并夹住越界数字', () => {
  const models = normalizeLoad({
    models: {
      'GLM-5.3-Flash': { state: 'full', label: 'At capacity', utilization: 100, secret: 'x' },
      'Qwen3.8-27B': { state: 'idle', label: 'Idle', utilization: 140 },
      broken: null,
      '': { state: 'idle' },
    },
  })
  assert.deepEqual(Object.keys(models), ['GLM-5.3-Flash', 'Qwen3.8-27B'])
  assert.deepEqual(models['GLM-5.3-Flash'], { state: 'full', label: 'At capacity', utilization: 100 })
  assert.equal(models['Qwen3.8-27B'].utilization, 100)
})

test('正常路径：读一次打上游一次，TTL 内复用缓存', async () => {
  let calls = 0
  let clock = 1000
  const source = createCapacitySource({
    now: () => clock,
    ttlMs: 30_000,
    resolveAuth: async () => ({ key: 'rc-test' }),
    fetchImpl: async () => {
      calls += 1
      return response({ models: { A: { state: 'idle', label: 'Idle', utilization: 3 } } })
    },
  })

  const first = await source.read()
  assert.equal(calls, 0, 'read 不阻塞在 25 秒的请求上')
  await source.refresh()
  assert.equal(calls, 1)
  const second = await source.read()
  assert.equal(second.ok, true)
  assert.equal(second.models.A.utilization, 3)
  assert.equal(calls, 1, 'TTL 内不再请求')

  clock += 31_000
  const stale = await source.read()
  assert.equal(stale.refreshing, true, '过期只触发后台刷新，不阻塞返回')
  await source.refresh()
  assert.equal(calls, 2)
})

test('单飞：并发刷新只打一次上游', async () => {
  let calls = 0
  const source = createCapacitySource({
    resolveAuth: async () => ({ key: 'rc-test' }),
    fetchImpl: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return response({ models: {} })
    },
  })
  await Promise.all([source.refresh(), source.refresh(), source.refresh()])
  assert.equal(calls, 1)
})

test('没有凭据时安静失败，不请求上游', async () => {
  let calls = 0
  const source = createCapacitySource({
    resolveAuth: async () => null,
    fetchImpl: async () => {
      calls += 1
      return response({})
    },
  })
  const view = await source.refresh()
  assert.equal(calls, 0)
  assert.equal(view.ok, false)
  assert.equal(view.error, 'no-credential')
})

test('失败后保留旧值并标出错误，且按 retryMs 退避', async () => {
  let clock = 0
  let calls = 0
  let fail = false
  const source = createCapacitySource({
    now: () => clock,
    ttlMs: 1000,
    retryMs: 15_000,
    resolveAuth: async () => ({ key: 'rc-test' }),
    fetchImpl: async () => {
      calls += 1
      if (fail) throw new Error('boom')
      return response({ models: { A: { state: 'busy', label: 'Busy', utilization: 50 } } })
    },
  })
  await source.refresh()
  fail = true
  clock += 2000
  await source.read()
  await source.refresh()
  const view = source.peek()
  assert.equal(view.ok, true, '旧数据仍然可用')
  assert.equal(view.error, 'boom')
  const before = calls
  await source.read()
  assert.equal(calls, before, 'retryMs 内不再尝试')
  clock += 20_000
  await source.read()
  assert.equal(calls, before + 1)
})

test('HTTP 非 2xx 记成错误而不是空数据', async () => {
  const source = createCapacitySource({
    resolveAuth: async () => ({ key: 'rc-test' }),
    fetchImpl: async () => response({}, { ok: false, status: 502 }),
  })
  const view = await source.refresh()
  assert.equal(view.ok, false)
  assert.equal(view.error, 'HTTP 502')
})
