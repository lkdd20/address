import { foldName } from '../../src/domain/region-names.mjs';

// Export quotas: every locality keeps a baseline, popular cities fill up to the city limit, then the remaining budget
// follows sqrt(population). Popular cities are the curated shortcuts plus the most populous catalog places of at least
// 100,000 people; each covers its metro area, since sources often name suburbs (Australia) or neighbourhoods as cities.
export const LOCALITY_BASELINE = 10;
export const POPULAR_CITY_LIMIT = 30_000;
const TOP_POPULATION_PLACES = 30;
const TOP_POPULATION_FLOOR = 100_000;
const DOMINANCE_RATIO = 10;
// A popular city's metro area: 5 km per sqrt(100,000 people), 5-40 km (Los Angeles ~31 km, Manchester ~12 km).
const metroRadiusKm = (population) => Math.min(40, Math.max(5, 5 * Math.sqrt(population / 100_000)));
const administrativeTypes = /^(?:adm\d|region|county|province|state)$/u;

const keys = (...values) => [...new Set(values.map(foldName).filter(Boolean))];

export const buildLocalityWeights = async (database, countryCode) => {
  const regions = (await database.prepare('SELECT id,code,name,native_name,path FROM catalog_regions WHERE country_code=?')
    .bind(countryCode).all()).results || [];
  const cities = (await database.prepare(`SELECT name,native_name,zh_name,type,population,region_id,latitude,longitude FROM catalog_cities
    WHERE country_code=? AND population > 0`).bind(countryCode).all()).results || [];
  const byId = new Map(regions.map((region) => [Number(region.id), region]));
  const rootOf = (region) => byId.get(Number(String(region?.path || '').split('/').filter(Boolean)[0])) || region;
  const places = cities.map((city) => {
    const region = byId.get(Number(city.region_id));
    const root = rootOf(region);
    return {
      admin1: keys(root?.code, root?.name, root?.native_name, region?.code, region?.name, region?.native_name),
      locality: keys(city.name, city.native_name),
      names: keys(city.name, city.native_name, city.zh_name),
      population: Number(city.population),
      latitude: city.latitude == null ? null : Number(city.latitude),
      longitude: city.longitude == null ? null : Number(city.longitude),
      administrative: administrativeTypes.test(String(city.type || '')),
      popular: false,
      dominant: true
    };
  });
  // A name shared by several places means its most populous place only where it is ten times the runner-up.
  const byKey = new Map();
  for (const place of places) for (const key of place.locality) byKey.set(key, [...byKey.get(key) || [], place]);
  for (const sharing of byKey.values()) {
    const ranked = [...sharing].sort((left, right) => right.population - left.population);
    for (const [index, place] of ranked.entries()) {
      if (index > 0 || (ranked[1] && place.population < ranked[1].population * DOMINANCE_RATIO)) place.dominant = false;
    }
  }
  // Loaded on use: the country configuration is TypeScript, and plain-Node scripts (pool audit) import the ETL modules.
  const { countries } = await import('../../src/domain/countries');
  const curated = countries.find((country) => country.code === countryCode)?.popularCities || [];
  for (const shortcut of curated) {
    const names = new Set(keys(shortcut.value, shortcut.label.en, shortcut.label['zh-CN']));
    const best = places.filter((place) => place.names.some((name) => names.has(name)))
      .sort((left, right) => right.population - left.population)[0];
    if (best) best.popular = true;
  }
  for (const place of places.filter((candidate) => !candidate.administrative && candidate.population >= TOP_POPULATION_FLOOR)
    .sort((left, right) => right.population - left.population).slice(0, TOP_POPULATION_PLACES)) place.popular = true;
  return {
    baseline: LOCALITY_BASELINE,
    cityLimit: POPULAR_CITY_LIMIT,
    places: places.map(({ admin1, locality, population, popular, dominant, latitude, longitude }) => ({
      admin1, locality, population, popular, dominant,
      ...(popular && latitude != null && longitude != null ? { latitude, longitude, radiusKm: metroRadiusKm(population) } : {})
    }))
  };
};
