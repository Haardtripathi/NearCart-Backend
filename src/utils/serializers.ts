import type {
  Address,
  CustomerProfile,
  Order,
  OrderItem,
  OrderReview,
  Shop,
  ShopOwnerProfile,
  User,
} from '@prisma/client'

import { getShopTodayStatus } from './shop-availability'
import { getDashboardPathForRole } from './user'

type SafeUserSource = User & {
  customerProfile?: (Pick<CustomerProfile, 'id' | 'defaultAddressId'> & { defaultAddress?: Address | null }) | null
  shopOwnerProfile?: Pick<ShopOwnerProfile, 'id' | 'isApproved'> | null
}

type CustomerProfileSource = CustomerProfile & {
  defaultAddress?: Address | null
  loyaltyPoints?: number
}

type ShopSource = Shop & {
  logoImageUrl?: string | null
  publicCatalogEnabled?: boolean
  inventoryOrganizationId?: string | null
  inventoryBranchId?: string | null
  deliveryEnabled?: boolean
  minimumOrderAmount?: number
  deliveryFeeDefault?: number
  estimatedDeliveryMinutes?: number | null
  serviceRadiusKm?: number | null
  lastCatalogSyncAt?: Date | null
}

type OrderItemSource = OrderItem & {
  inventoryProductId?: string | null
  inventoryVariantId?: string | null
  unitLabel?: string | null
}

type OrderSource = Order & {
  items?: OrderItemSource[] | null
  inventorySalesOrderId?: string | null
  inventorySalesOrderNumber?: string | null
  inventorySyncStatus?: string | null
  inventorySyncError?: string | null
  inventoryLastSyncedAt?: Date | null
  driverName?: string | null
  driverPhone?: string | null
  driverVehicleType?: string | null
  driverAssignedAt?: Date | null
  review?: OrderReview | null
  couponCode?: string | null
  discountAmount?: number
  loyaltyPointsEarned?: number | null
}

function mapAddress(address: Address) {
  return {
    id: address.id,
    userId: address.userId,
    label: address.label,
    fullName: address.fullName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    area: address.area,
    pincode: address.pincode,
    landmark: address.landmark,
    latitude: address.latitude,
    longitude: address.longitude,
    isDefault: address.isDefault,
    createdAt: address.createdAt,
    updatedAt: address.updatedAt,
  }
}

function mapSafeUser(user: SafeUserSource) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    isActive: user.isActive,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    customerProfileId: user.customerProfile?.id ?? null,
    defaultAddressId: user.customerProfile?.defaultAddressId ?? null,
    shopOwnerProfileId: user.shopOwnerProfile?.id ?? null,
    shopOwnerApproved: user.shopOwnerProfile?.isApproved ?? null,
    dashboardPath: getDashboardPathForRole(user.role),
  }
}

function mapCustomerProfile(profile: CustomerProfileSource) {
  return {
    id: profile.id,
    userId: profile.userId,
    defaultAddressId: profile.defaultAddressId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    defaultAddress: profile.defaultAddress
      ? mapAddress(profile.defaultAddress)
      : null,
    loyaltyPoints: profile.loyaltyPoints ?? 0,
  }
}

function mapShopOwnerProfile(profile: ShopOwnerProfile) {
  return {
    id: profile.id,
    userId: profile.userId,
    businessName: profile.businessName,
    gstNumber: profile.gstNumber,
    isApproved: profile.isApproved,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

function mapShop(shop: ShopSource) {
  return {
    id: shop.id,
    ownerProfileId: shop.ownerProfileId,
    name: shop.name,
    slug: shop.slug,
    description: shop.description,
    logoImageUrl: shop.logoImageUrl,
    category: shop.category,
    phone: shop.phone,
    email: shop.email,
    addressLine1: shop.addressLine1,
    addressLine2: shop.addressLine2,
    city: shop.city,
    area: shop.area,
    pincode: shop.pincode,
    latitude: shop.latitude,
    longitude: shop.longitude,
    openingTime: shop.openingTime,
    closingTime: shop.closingTime,
    publicCatalogEnabled: shop.publicCatalogEnabled,
    inventoryOrganizationId: shop.inventoryOrganizationId,
    inventoryBranchId: shop.inventoryBranchId,
    deliveryEnabled: shop.deliveryEnabled,
    minimumOrderAmount: shop.minimumOrderAmount,
    deliveryFeeDefault: shop.deliveryFeeDefault,
    estimatedDeliveryMinutes: shop.estimatedDeliveryMinutes,
    serviceRadiusKm: shop.serviceRadiusKm,
    lastCatalogSyncAt: shop.lastCatalogSyncAt,
    isOpenToday: shop.isOpenToday,
    todayStatusReason: shop.todayStatusReason,
    todayStatusUpdatedAt: shop.todayStatusUpdatedAt,
    todayStatus: getShopTodayStatus(shop),
    isActive: shop.isActive,
    approvalStatus: shop.approvalStatus,
    createdAt: shop.createdAt,
    updatedAt: shop.updatedAt,
  }
}

function mapOrderItem(item: OrderItemSource) {
  return {
    id: item.id,
    orderId: item.orderId,
    storeProductId: item.storeProductId,
    inventoryProductId: item.inventoryProductId,
    inventoryVariantId: item.inventoryVariantId,
    name: item.name,
    brand: item.brand,
    size: item.size,
    unitLabel: item.unitLabel,
    image: item.image,
    price: item.price,
    mrp: item.mrp,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
  }
}

function mapOrderReviewSummary(review: OrderReview) {
  return {
    id: review.id,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt,
  }
}

function mapOrder(order: OrderSource) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerUserId: order.customerUserId,
    shopId: order.shopId,
    shopRecordId: order.shopRecordId,
    shopName: order.shopName,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerEmail: order.customerEmail,
    deliveryAddressId: order.deliveryAddressId,
    deliveryAddressLabel: order.deliveryAddressLabel,
    deliveryAddressLine1: order.deliveryAddressLine1,
    deliveryAddressLine2: order.deliveryAddressLine2,
    city: order.city,
    area: order.area,
    pincode: order.pincode,
    landmark: order.landmark,
    latitude: order.latitude,
    longitude: order.longitude,
    notes: order.notes,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    weatherSurchargeFee: order.weatherSurchargeFee,
    weatherCondition: order.weatherCondition,
    platformFee: order.platformFee,
    couponCode: order.couponCode ?? null,
    discountAmount: order.discountAmount ?? 0,
    totalAmount: order.totalAmount,
    loyaltyPointsEarned: order.loyaltyPointsEarned ?? null,
    placedAt: order.placedAt,
    acceptedAt: order.acceptedAt,
    deliveredAt: order.deliveredAt,
    driverName: order.driverName ?? null,
    driverPhone: order.driverPhone ?? null,
    driverVehicleType: order.driverVehicleType ?? null,
    driverAssignedAt: order.driverAssignedAt ?? null,
    // Mirrors the locked business rule in `orders.service.ts`'s
    // `cancelOrder` — a customer can only cancel while the shop hasn't
    // acted on the order yet. Computed here (not stored) so it's always
    // derived from the current status rather than risking drift.
    isCancellable: order.status === 'PENDING_CONFIRMATION',
    inventorySalesOrderId: order.inventorySalesOrderId ?? null,
    inventorySalesOrderNumber: order.inventorySalesOrderNumber ?? null,
    inventorySyncStatus: order.inventorySyncStatus ?? null,
    inventorySyncError: order.inventorySyncError ?? null,
    inventoryLastSyncedAt: order.inventoryLastSyncedAt ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: Array.isArray(order.items) ? order.items.map(mapOrderItem) : [],
    // Present only when the caller's query included the `review` relation
    // (see `getOrderById` in orders.service.ts) — `undefined` in `order`
    // (relation not queried) maps to `null` here too, same as `review: null`
    // (queried, none exists), so the frontend can't tell those two apart
    // from this field alone. That's fine: every call site that cares about
    // review state always includes the relation.
    review: order.review ? mapOrderReviewSummary(order.review) : null,
  }
}

function mapOrderPreview(order: Order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerUserId: order.customerUserId,
    shopId: order.shopId,
    shopName: order.shopName,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    totalAmount: order.totalAmount,
    customerName: order.customerName,
    placedAt: order.placedAt,
    deliveredAt: order.deliveredAt,
  }
}

export {
  mapAddress,
  mapCustomerProfile,
  mapOrder,
  mapOrderPreview,
  mapSafeUser,
  mapShop,
  mapShopOwnerProfile,
}
