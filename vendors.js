const VENDORS = {
  sigler_lv:     { name:"Russell Sigler",          city:"Las Vegas",    phone:"+17023842996", addr:"3150 W Sunset Rd" },
  lennox_lv:     { name:"Lennox Pro Store",         city:"Las Vegas",    phone:"+17025606550", addr:"6435 S Valley View Blvd Ste F" },
  hcs_lv:        { name:"Heating & Cooling Supply", city:"Las Vegas",    phone:"+17024308652", addr:"3655 W Quail Ave Unit A" },
  trane_lv:      { name:"Trane Supply",             city:"Las Vegas",    phone:"+17257262629", addr:"3930 W Windmill Ln Ste 170" },
  ferguson_lv:   { name:"Ferguson HVAC",            city:"Las Vegas",    phone:"+17022609388", addr:"6845 S Decatur Blvd Ste 190" },
  ferguson_hnd:  { name:"Ferguson HVAC",            city:"Henderson",    phone:"+17252940178", addr:"500 N Gibson Rd" },
  daikin_lv:     { name:"Daikin Comfort",           city:"Las Vegas",    phone:"+17028711046", addr:"4000 W Harmon Ave Ste 1" },
  daikin_nlv:    { name:"Daikin Comfort",           city:"N. Las Vegas", phone:"+17026510621", addr:"4464 Calimesa St" },
  daikin_hnd:    { name:"Daikin Comfort",           city:"Henderson",    phone:"+17025582183", addr:"751 W Warm Springs Rd" },
  johnstone_lv:  { name:"Johnstone Supply",         city:"Las Vegas",    phone:"+17023843980", addr:"4144 W Sunset Rd" },
  johnstone_hnd: { name:"Johnstone Supply",         city:"Henderson",    phone:"+17025582323", addr:"671 Middlegate Rd" },
  winsupply_lv:  { name:"Winsupply HVAC",           city:"Las Vegas",    phone:"+17023659722", addr:"5480 Procyon St" },
  acpro_lv:      { name:"AC Pro",                   city:"Las Vegas",    phone:"+17027954746", addr:"4085 W Russell Rd" },
  acpro_nlv:     { name:"AC Pro",                   city:"N. Las Vegas", phone:"+17028293010", addr:"2910 S Highland Dr Ste D" },
  acpro_hnd:     { name:"AC Pro",                   city:"Henderson",    phone:"+17025605670", addr:"7365 Commercial Way #155" },
};

const BRAND_MAP = {
  "carrier":           "sigler_lv",
  "bryant":            "sigler_lv",
  "payne":             "sigler_lv",
  "lennox":            "lennox_lv",
  "allied":            "hcs_lv",
  "rheem":             "hcs_lv",
  "ruud":              "hcs_lv",
  "trane":             "trane_lv",
  "american standard": "trane_lv",
  "goodman":           "daikin_lv",
  "amana":             "daikin_lv",
  "daikin":            "daikin_lv",
  "york":              "johnstone_lv",
  "bosch":             "johnstone_lv",
  "coleman":           "winsupply_lv",
  "luxaire":           "winsupply_lv",
  "jci":               "winsupply_lv",
  "johnson controls":  "winsupply_lv",
  "ac pro":            "acpro_lv",
  "maytag":            "acpro_lv",
};

function getVendorForBrand(brand) {
  const key = (brand || '').toLowerCase().trim();
  const vendorId = BRAND_MAP[key];
  return vendorId ? VENDORS[vendorId] : null;
}

module.exports = { VENDORS, BRAND_MAP, getVendorForBrand };
