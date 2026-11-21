/** Shared provider display order for the composer and command model pickers. */

function providerRank(id: string): number {
  if (id === 'deepseek-account') return 0
  if (id === 'deepseek-official') return 1
  if (id === 'nimi') return 2
  if (id === 'nimi-local') return 3
  if (id.startsWith('nimi-cloud.')) return 4
  return 5
}

/**
 * Put the account and official providers first, followed by Nimi Saved / Local / Cloud groups,
 * preserving every other relative order.
 * @param groups - Provider groups in catalog order.
 * @returns a sorted copy; model order within each group is unchanged.
 */
export function orderModelProviders<T extends { readonly id: string; readonly name?: string }>(groups: readonly T[]): T[] {
  return groups.toSorted((left, right) => {
    const rankDiff = providerRank(left.id) - providerRank(right.id)
    if (rankDiff !== 0) return rankDiff
    if (left.id.startsWith('nimi-cloud.') && right.id.startsWith('nimi-cloud.')) {
      return (left.name ?? left.id).localeCompare(right.name ?? right.id)
    }
    return 0
  })
}
