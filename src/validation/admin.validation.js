const { z } = require('zod')

const updateShopApprovalSchema = z.object({
  approvalStatus: z.enum(['APPROVED', 'REJECTED']),
})

module.exports = {
  updateShopApprovalSchema,
}
