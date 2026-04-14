import { z } from 'zod'

const updateShopApprovalSchema = z.object({
  approvalStatus: z.enum(['APPROVED', 'REJECTED']),
})

type UpdateShopApprovalInput = z.infer<typeof updateShopApprovalSchema>

export { updateShopApprovalSchema }

export type { UpdateShopApprovalInput }
