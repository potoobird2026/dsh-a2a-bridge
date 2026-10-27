/**
 * 测试夹具：申请一个当前空闲的本地端口。
 *
 * 为什么不能用「猜端口」：CI 上并行跑的 inbound 用例如果各自硬编码
 * 3000 / 8080，会在同一台机器上互相抢占，失败还带随机性。让内核用
 * `listen(0)` 分配、把端口号读出来、再关闭，是唯一不会与其它进程撞车的取法。
 *
 * 注意这个夹具天生有一个 TOCTOU 窗口：`close()` 到调用方真正 `listen()` 之间，
 * 端口可能被系统重新分给别的进程。所以调用方（尤其是 CI 上的真机 HTTP 用例）
 * 应当在 `EADDRINUSE` 时重试 2~3 次，而不是假定拿到就一定能绑上。
 *
 * 说明：本目录的夹具由 Vitest 直接执行，而 **Vitest 不做类型检查** ——
 * 这里的类型错误不会让 `npm test` 变红，只有独立的 `npm run typecheck`
 * 门禁才能发现（若 tests 未纳入 tsconfig，则连门禁也覆盖不到，属于已知缺口）。
 *
 * 本机未安装 node_modules，本文件未实际运行验证。
 */

import { createServer } from 'node:net'

/**
 * 申请一个空闲的 IPv4 回环端口。
 *
 * @returns 已确认可绑定、且已释放的端口号（1..65535）
 * @throws 内核未返回 TCP 地址，或绑定/关闭失败时抛出
 */
export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    // 不让这个探测用的 server 把测试进程的生命周期拖住。
    server.unref()

    server.once('error', (error) => {
      reject(error)
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('freePort: 内核没有返回 TCP 端口（address 为 null / string）'))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}
