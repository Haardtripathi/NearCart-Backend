const { getDashboardPathForRole } = require('./user')

function mapAddress(address) {
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

function mapSafeUser(user) {
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

function mapCustomerProfile(profile) {
  return {
    id: profile.id,
    userId: profile.userId,
    defaultAddressId: profile.defaultAddressId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    defaultAddress: profile.defaultAddress
      ? mapAddress(profile.defaultAddress)
      : null,
  }
}

function mapShopOwnerProfile(profile) {
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

function mapShop(shop) {
  return {
    id: shop.id,
    ownerProfileId: shop.ownerProfileId,
    name: shop.name,
    slug: shop.slug,
    description: shop.description,
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
    isActive: shop.isActive,
    approvalStatus: shop.approvalStatus,
    createdAt: shop.createdAt,
    updatedAt: shop.updatedAt,
  }
}

function mapOrderItem(item) {
  return {
    id: item.id,
    orderId: item.orderId,
    storeProductId: item.storeProductId,
    name: item.name,
    brand: item.brand,
    size: item.size,
    image: item.image,
    price: item.price,
    mrp: item.mrp,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
  }
}

function mapOrder(order) {
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
    platformFee: order.platformFee,
    totalAmount: order.totalAmount,
    placedAt: order.placedAt,
    acceptedAt: order.acceptedAt,
    deliveredAt: order.deliveredAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: Array.isArray(order.items) ? order.items.map(mapOrderItem) : [],
  }
}

function mapOrderPreview(order) {
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

module.exports = {
  mapAddress,
  mapCustomerProfile,
  mapOrder,
  mapOrderPreview,
  mapSafeUser,
  mapShop,
  mapShopOwnerProfile,
}
