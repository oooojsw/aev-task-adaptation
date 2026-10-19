export async function join<T>(tasks: readonly PromiseLike<T>[]): Promise<T[]> {
  let failure: { reason: unknown } | undefined
  // 首个失败保留原样，但全部写入者退出后才能释放轮级屏障。
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve(task).catch(reason => {
    failure ??= { reason }
    throw reason
  })))
  if (failure) throw failure.reason
  return results.map(result => (result as PromiseFulfilledResult<T>).value)
}
