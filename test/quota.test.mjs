import assert from 'node:assert/strict'
import test from 'node:test'

import { createQuotaSource, parseQuota } from '../src/host/quota.js'

test('parseQuota 认 Headers 与普通对象两种形态', () => {
  const headers = new Headers({
    'x-ratelimit-limit-user-daily-usd': '1',
    'x-ratelimit-remaining-user-daily-usd': '0.982',
    'x-ratelimit-used-user-daily-usd': '0.018',
    'x-ratelimit-limit-user-rpm': '20',
    'x-ratelimit-remaining-user-rpm': '17',
    'x-ratelimit-reset-user-daily-usd': '1792598400',
  })
  const quota = parseQuota(headers)
  assert.equal(quota.dailyUsd.limit, 1)
  assert.equal(quota.dailyUsd.remaining, 0.982)
  assert.equal(quota.dailyUsd.used, 0.018)
  assert.equal(quota.rpm.remaining, 17)
  assert.equal(quota.dailyUsd.resetAt, 1792598400000)

  const plain = parseQuota({ 'X-RateLimit-Limit-User-RPM': '20', 'x-ratelimit-remaining-user-rpm': '19' })
  assert.equal(plain.rpm.limit, 20)
  assert.equal(plain.rpm.remaining, 19)

  assert.equal(parseQuota(new Headers()), null)
  assert.equal(parseQuota(undefined), null)
})

test('探针确实发一次 1-token 请求并读头，TTL 内复用', async () => {
  let clock = 0
  const calls = []
  const source = createQuotaSource({
    now: () => clock,
    ttlMs: 60_000,
    retryMs: 0,
    resolveAuth: async () => ({ key: 'rc-test', baseURL: 'https://developer.amd.com.cn/radeon/api/v1' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-ratelimit-limit-user-daily-usd': '1', 'x-ratelimit-remaining-user-daily-usd': '1' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    },
  })

  await source.read(true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://developer.amd.com.cn/radeon/api/v1/chat/completions')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.max_tokens, 1, '只为读头，不产生产出')
  assert.equal(body.stream, false)
  assert.equal(calls[0].init.headers.authorization, 'Bearer rc-test')

  const view = await source.read()
  assert.equal(view.ok, true)
  assert.equal(view.quota.dailyUsd.remaining, 1)
  assert.equal(calls.length, 1, 'TTL 内不再探针')

  clock += 61_000
  await source.read()
  await source.read(true)
  assert.equal(calls.length, 2)
})

test('429 也当有效读数（头里写着剩余额度）', async () => {
  const source = createQuotaSource({
    resolveAuth: async () => ({ key: 'rc-test', baseURL: 'https://example.test/v1' }),
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: new Headers({ 'x-ratelimit-limit-user-rpm': '20', 'x-ratelimit-remaining-user-rpm': '0' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  })
  const view = await source.read(true)
  assert.equal(view.ok, true)
  assert.equal(view.quota.rpm.remaining, 0)
})

test('关闭探针时直接返回 disabled，不发请求', async () => {
  let calls = 0
  const source = createQuotaSource({
    enabled: false,
    resolveAuth: async () => ({ key: 'rc-test' }),
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) }
    },
  })
  const view = await source.read(true)
  assert.equal(calls, 0)
  assert.equal(view.ok, false)
  assert.equal(view.error, 'disabled')
})
