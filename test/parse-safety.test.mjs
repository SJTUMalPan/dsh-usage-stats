/**
 * 解析层的类型安全测试（审计发现 → 回归护栏）。
 *
 * 背景：会话日志里的 `turn` / `step` 过去被**原样透传**进仪表盘 payload，而
 * `lib/client.js` 把数值位置直接拼进 `innerHTML`（未走 esc()）。日志写在
 * `DSH_HOME` 下、可被能写该目录的进程（含子代理）修改，于是构成**同源存储型 XSS**
 * ——仪表盘与 DSH GUI 同源，脚本可拿到 DSH 同源权限。
 *
 * 修法：在解析层把这些字段强制成数字（语义上它们本就是数字），一次消掉整类注入面，
 * 而不是在渲染层逐个补 esc()（后者容易在后续改动里漏）。
 *
 * 跑法：`node --test test/`
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { foldSession } from '../lib/sessions.mjs'
import { decompressAll } from '../lib/zstd.mjs'

/**
 * 写一个真实的多帧 zstd 会话日志（DSH 每个事件一帧）。
 * @param {object[]} events - 事件对象数组。
 * @returns {string} 日志路径。
 */
function writeLog(events) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-test-'))
  const file = join(dir, 'session.v3.jsonl.zstd')
  const frames = events.map((e) => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))
  writeFileSync(file, Buffer.concat(frames))
  return file
}

/**
 * 造一个最小会话：session 头 + 一条带 usage 的 assistant/message。
 * @param {unknown} turn - 被测试的 turn 值。
 * @param {unknown} step - 被测试的 step 值。
 * @returns {string} 日志路径。
 */
function logWith(turn, step) {
  return writeLog([
    { type: 'session', time: '2026-09-27T00:00:00.000Z', data: { id: 'session-x', version: 3, cwd: '/proj' } },
    { type: 'request/context', time: '2026-09-27T00:00:00.500Z', data: { model: 'm' } },
    {
      type: 'assistant/message',
      time: '2026-09-27T00:00:01.000Z',
      data: { turn, step, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } },
    },
  ])
}

describe('解压上限（解压炸弹防护）', () => {
  it('超过上限时报错，而不是把内存打满', () => {
    // 造一个压缩率极高的多帧日志：单帧压缩后极小、解压后 1 MB，重复 8 帧
    const chunk = Buffer.from('A'.repeat(1024 * 1024), 'utf8')
    const frames = []
    for (let i = 0; i < 8; i += 1) frames.push(zstdCompressSync(chunk))
    const buf = Buffer.concat(frames)
    assert.ok(buf.length < 100 * 1024, `压缩后应很小，实际 ${buf.length}`)
    assert.throws(
      () => decompressAll(buf, { maxOutput: 1024 * 1024 }),
      /cap/,
      '超过上限必须报错',
    )
  })

  it('正常日志不受上限影响', () => {
    const buf = zstdCompressSync(Buffer.from('hello', 'utf8'))
    assert.equal(decompressAll(buf, { maxOutput: 1024 }).toString('utf8'), 'hello')
  })
})

describe('会话日志字段的类型安全', () => {
  it('turn/step 被污染为标记时，折叠结果里不再是字符串', () => {
    const folded = foldSession(logWith('<img src=x onerror=alert(1)>', '<script>x</script>'))
    assert.notEqual(folded, null, 'fixture 应能被解析成会话')
    const st = folded.steps[0]
    assert.equal(typeof st.turn === 'string', false, `turn 仍是字符串：${JSON.stringify(st.turn)}`)
    assert.equal(typeof st.step === 'string', false, `step 仍是字符串：${JSON.stringify(st.step)}`)
  })

  it('合法数字原样保留', () => {
    const folded = foldSession(logWith(3, 7))
    assert.equal(folded.steps[0].turn, 3)
    assert.equal(folded.steps[0].step, 7)
  })

  it('缺字段保持 null（不把缺失变成 0，避免污染统计语义）', () => {
    const folded = foldSession(logWith(undefined, undefined))
    assert.equal(folded.steps[0].turn, null)
    assert.equal(folded.steps[0].step, null)
  })

  it('depth（delegationDepth）同样被强制数字化：它也被直接拼进 innerHTML', () => {
    const file = writeLog([
      { type: 'session', time: '2026-09-27T00:00:00.000Z',
        data: { id: 's', version: 3, cwd: '/p', delegationDepth: '<img src=x onerror=alert(1)>' } },
      { type: 'assistant/message', time: '2026-09-27T00:00:01.000Z',
        data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } } },
    ])
    const folded = foldSession(file)
    assert.equal(typeof folded.depth === 'string', false, `depth 仍是字符串：${JSON.stringify(folded.depth)}`)
  })

  it('非有限数字（Infinity/NaN/超长串）也被归为 null', () => {
    const folded = foldSession(logWith('Infinity', 'x'.repeat(500)))
    assert.equal(folded.steps[0].turn, null)
    assert.equal(folded.steps[0].step, null)
  })
})
