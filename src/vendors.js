// Vendor data for Semper Fi Heating & Cooling
// Las Vegas metro area HVAC distributors

const VENDORS = {
  'russell-sigler': {
        name: 'Russell Sigler',
    phone: '(702) 384-2996',
        address: '3150 W Sunset Rd, Las Vegas, NV',
    brands: ['carrier', 'bryant', 'payne'],
        primary: true,
  },
  'lennox-pro': {
        name: 'Lennox Pro Store',
    phone: '(702) 560-6550',
        address: '6435 S Valley View Blvd Ste F, Las Vegas, NV',
    brands: ['lennox'],
        primary: true,
  },
  'heating-cooling-supply': {
        name: 'Heating & Cooling Supply',
    phone: '(702) 430-8652',
        address: '3655 W Quail Ave Unit A, Las Vegas, NV 89118',
    brands: ['allied', 'rheem', 'ruud'],
        primary: true,
  },
  'trane-supply': {
        name: 'Trane Supply',
    phone: '(725) 726-2629',
        address: '3930 W Windmill Ln Ste 170, Las Vegas, NV',
    brands: ['trane', 'american standard'],
        primary: true,
  },
  'ferguson-lv': {
        name: 'Ferguson HVAC Las Vegas',
    phone: '(702) 260-9388',
        address: '6845 S Decatur Blvd Ste 190, Las Vegas, NV',
    brands: ['trane', 'american standard'],
        primary: false,
  },
  'ferguson-henderson': {
    name: 'Ferguson HVAC Henderson',
    phone: '(725) 294-0178',
    address: '500 N Gibson Rd, Henderson, NV',
    brands: ['trane', 'american standard'],
        primary: false,
  },
  'daikin-comfort-lv': {
        name: 'Daikin Comfort Las Vegas',
    phone: '(702) 871-1046',
        address: '4000 W Harmon Ave Ste 1, Las Vegas, NV 89103',
    brands: ['goodman', 'amana', 'daikin'],
        primary: true,
  },
  'daikin-comfort-nlv': {
        name: 'Daikin Comfort N. Las Vegas',
    phone: '(702) 651-0621',
        address: '4464 Calimesa St, N. Las Vegas, NV',
    brands: ['goodman', 'amana', 'daikin'],
        primary: false,
  },
  'daikin-comfort-henderson': {
    name: 'Daikin Comfort Henderson',
    phone: '(702) 558-2183',
    address: '751 W Warm Springs Rd, Henderson, NV',
    brands: ['goodman', 'amana', 'daikin'],
        primary: false,
  },
  'stevens-supply': {
        name: 'Stevens Equipment Supply',
    phone: '(725) 223-8550',
        address: '6721 S Eastern Ave, Las Vegas, NV',
    brands: ['daikin'],
        primary: false,
  },
  'johnstone-lv': {
        name: 'Johnstone Supply Las Vegas',
    phone: '(702) 384-3980',
        address: '4144 W Sunset Rd, Las Vegas, NV',
    brands: ['york', 'bosch'],
        primary: true,
  },
  'johnstone-henderson': {
    name: 'Johnstone Supply Henderson',
    phone: '(702) 558-2323',
    address: '671 Middlegate Rd, Henderson, NV',
    brands: ['york', 'bosch'],
        primary: false,
  },
  'winsupply': {
        name: 'Winsupply HVAC',
    phone: '(702) 365-9722',
        address: '5480 Procyon St, Las Vegas, NV',
    brands: ['coleman', 'luxaire', 'jci', 'johnson controls'],
        primary: true,
  },
  'acpro-russell': {
    name: 'AC Pro (W Russell Rd)',
    phone: '(702) 795-4746',
        address: '4085 W Russell Rd, Las Vegas, NV 89118',
    brands: ['ac pro', 'maytag'],
        primary: true,
  },
  'acpro-nlv': {
        name: 'AC Pro N. Las Vegas',
    phone: '(702) 829-3010',
        address: '2910 S Highland Dr, N. Las Vegas, NV',
    brands: ['ac pro', 'maytag'],
        primary: false,
  },
  'acpro-henderson': {
    name: 'AC Pro Henderson',
    phone: '(702) 560-5670',
    address: '7365 Commercial Way #155, Henderson, NV 89011',
    brands: ['ac pro', 'maytag'],
        primary: false,
  },
};

// Brand to vendor mapping
const BRAND_MAP = {
    'carrier':          'russell-sigler',
    'bryant':           'russell-sigler',
    'payne':            'russell-sigler',
    'lennox':           'lennox-pro',
    'allied':           'heating-cooling-supply',
    'rheem':            'heating-cooling-supply',
    'ruud':             'heating-cooling-supply',
    'trane':            'trane-supply',
    'american standard':'trane-supply',
    'goodman':          'daikin-comfort-lv',
    'amana':            'daikin-comfort-lv',
    'daikin':           'stevens-supply',
    'york':             'johnstone-lv',
    'bosch':            'johnstone-lv',
    'coleman':          'winsupply',
    'luxaire':          'winsupply',
    'jci':              'winsupply',
    'johnson controls': 'winsupply',
    'ac pro':           'acpro-russell',
    'maytag':           'acpro-russell',
};

function getVendorForBrand(brand) {
  if (!brand) return null;
  const key = brand.toLowerCase().trim();
  const vendorId = BRAND_MAP[key];
  return vendorId ? VENDORS[vendorId] : null;
}

  function getAllVendors() {
    return Object.values(VENDORS);
  }

    function getPrimaryVendors() {
      return Object.values(VENDORS).filter(v => v.primary);
    }

      module.exports = { VENDORS, BRAND_MAP, getVendorForBrand, getAllVendors, getPrimaryVendors };
