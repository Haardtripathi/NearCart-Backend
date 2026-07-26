import prisma from '../lib/prisma'

interface WriteAuditLogInput {
  actorId: string | null
  actorType: string
  action: string
  entityType: string
  entityId: string
  before?: unknown
  after?: unknown
}

/**
 * Minimal, intentionally non-general audit logging — just two call sites
 * today (`createOrder`/`ORDER_CREATE` and `cancelOrder`/`ORDER_CANCEL` in
 * `orders.service.ts`), not a framework. Never throws: an audit-write
 * failure must not fail the business operation it's recording — logs and
 * swallows instead, same "never break the primary flow" convention as
 * `syncOrderToInventoryBridge`/`refreshOrderStatusFromInventory`.
 */
async function writeAuditLog(input: WriteAuditLogInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        actorType: input.actorType,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        beforeJson:
          input.before !== undefined ? JSON.stringify(input.before) : null,
        afterJson:
          input.after !== undefined ? JSON.stringify(input.after) : null,
      },
    })
  } catch (error) {
    console.error(
      `[NearKart] Failed to write audit log (${input.action} on ${input.entityType}:${input.entityId}):`,
      error instanceof Error ? error.message : error,
    )
  }
}

export { writeAuditLog }
