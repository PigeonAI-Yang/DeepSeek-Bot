import { autonomyDomain } from './domain.js'

export async function openStore(storageDomain) {
  const domain = await storageDomain.open(autonomyDomain)
  return Object.freeze({
    responsibilities: domain.table('responsibilities'),
    workItems: domain.table('work_items'),
    close: () => domain.close(),
  })
}
