import { z } from 'zod'

const updateShopApprovalSchema = z.object({
  approvalStatus: z.enum(['APPROVED', 'REJECTED']),
})

const updateShopStorefrontSchema = z.object({
  inventoryOrganizationId: z.string().trim().min(1),
  inventoryBranchId: z.string().trim().min(1),
  publicCatalogEnabled: z.boolean(),
  logoImageUrl: z.string().trim().url().optional().or(z.literal('')),
})

type UpdateShopApprovalInput = z.infer<typeof updateShopApprovalSchema>
type UpdateShopStorefrontInput = z.infer<typeof updateShopStorefrontSchema>

export { updateShopApprovalSchema, updateShopStorefrontSchema }

export type { UpdateShopApprovalInput, UpdateShopStorefrontInput }
