type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK'

interface MockShopProduct {
  storeProductId: string
  name: string
  brand: string
  size: string
  image: string
  price: number
  mrp: number
  stockQty: number
  stockStatus: StockStatus
}

interface MockShop {
  id: string
  name: string
  category: string
  neighborhood: string
  etaMinutes: number
  products: MockShopProduct[]
}

const shops: MockShop[] = [
  {
    id: 'green-basket',
    name: 'Green Basket',
    category: 'Fresh groceries',
    neighborhood: 'Sector 14',
    etaMinutes: 25,
    products: [
      {
        storeProductId: 'gb-milk-500',
        name: 'Amul Gold Milk',
        brand: 'Amul',
        size: '500 ml',
        image:
          'https://images.unsplash.com/photo-1563636619-e9143da7973b?auto=format&fit=crop&w=800&q=80',
        price: 34,
        mrp: 36,
        stockQty: 12,
        stockStatus: 'IN_STOCK',
      },
      {
        storeProductId: 'gb-bread-400',
        name: 'Brown Bread',
        brand: 'Harvest Bake',
        size: '400 g',
        image:
          'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=800&q=80',
        price: 48,
        mrp: 55,
        stockQty: 4,
        stockStatus: 'LOW_STOCK',
      },
      {
        storeProductId: 'gb-banana-1kg',
        name: 'Banana Robusta',
        brand: 'Farm Fresh',
        size: '1 kg',
        image:
          'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?auto=format&fit=crop&w=800&q=80',
        price: 62,
        mrp: 68,
        stockQty: 0,
        stockStatus: 'OUT_OF_STOCK',
      },
      {
        storeProductId: 'gb-rice-5kg',
        name: 'Daily Rice',
        brand: 'NearCart Select',
        size: '5 kg',
        image:
          'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=800&q=80',
        price: 369,
        mrp: 399,
        stockQty: 9,
        stockStatus: 'IN_STOCK',
      },
    ],
  },
  {
    id: 'daily-mart',
    name: 'Daily Mart',
    category: 'Household essentials',
    neighborhood: 'Main Market',
    etaMinutes: 18,
    products: [
      {
        storeProductId: 'dm-detergent-1l',
        name: 'Liquid Detergent',
        brand: 'CleanWave',
        size: '1 L',
        image:
          'https://images.unsplash.com/photo-1583947215259-38e31be8751f?auto=format&fit=crop&w=800&q=80',
        price: 189,
        mrp: 210,
        stockQty: 7,
        stockStatus: 'IN_STOCK',
      },
      {
        storeProductId: 'dm-tissues-4',
        name: 'Soft Tissue Pack',
        brand: 'CloudSoft',
        size: '4 rolls',
        image:
          'https://images.unsplash.com/photo-1583947582886-f40ec95dd752?auto=format&fit=crop&w=800&q=80',
        price: 124,
        mrp: 140,
        stockQty: 2,
        stockStatus: 'LOW_STOCK',
      },
      {
        storeProductId: 'dm-dishwash-500',
        name: 'Dishwash Gel',
        brand: 'Spark',
        size: '500 ml',
        image:
          'https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?auto=format&fit=crop&w=800&q=80',
        price: 79,
        mrp: 85,
        stockQty: 15,
        stockStatus: 'IN_STOCK',
      },
      {
        storeProductId: 'dm-sponge-3',
        name: 'Kitchen Sponge',
        brand: 'ScrubPro',
        size: 'Pack of 3',
        image:
          'https://images.unsplash.com/photo-1616627458591-0d707b4b3b2d?auto=format&fit=crop&w=800&q=80',
        price: 49,
        mrp: 49,
        stockQty: 0,
        stockStatus: 'OUT_OF_STOCK',
      },
    ],
  },
  {
    id: 'spice-corner',
    name: 'Spice Corner',
    category: 'Regional pantry picks',
    neighborhood: 'Lake Road',
    etaMinutes: 30,
    products: [
      {
        storeProductId: 'sc-turmeric-200',
        name: 'Turmeric Powder',
        brand: 'Spice Corner',
        size: '200 g',
        image:
          'https://images.unsplash.com/photo-1615486363973-f79d875780cf?auto=format&fit=crop&w=800&q=80',
        price: 88,
        mrp: 95,
        stockQty: 11,
        stockStatus: 'IN_STOCK',
      },
      {
        storeProductId: 'sc-chilli-100',
        name: 'Red Chilli Powder',
        brand: 'Spice Corner',
        size: '100 g',
        image:
          'https://images.unsplash.com/photo-1596040033229-a9821ebd058d?auto=format&fit=crop&w=800&q=80',
        price: 72,
        mrp: 80,
        stockQty: 3,
        stockStatus: 'LOW_STOCK',
      },
      {
        storeProductId: 'sc-jeera-250',
        name: 'Whole Jeera',
        brand: 'Spice Corner',
        size: '250 g',
        image:
          'https://images.unsplash.com/photo-1515543904379-3d757afe72e4?auto=format&fit=crop&w=800&q=80',
        price: 116,
        mrp: 130,
        stockQty: 6,
        stockStatus: 'IN_STOCK',
      },
      {
        storeProductId: 'sc-garam-masala-100',
        name: 'Garam Masala',
        brand: 'Spice Corner',
        size: '100 g',
        image:
          'https://images.unsplash.com/photo-1532336414038-cf19250c5757?auto=format&fit=crop&w=800&q=80',
        price: 0,
        mrp: 0,
        stockQty: 0,
        stockStatus: 'OUT_OF_STOCK',
      },
    ],
  },
]

const shopPreviews = shops.map(({ products, ...shop }) => shop)

function getShopById(shopId: string): MockShop | null {
  return shops.find((shop) => shop.id === shopId) || null
}

export { shopPreviews, getShopById }
