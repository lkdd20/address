export interface CatalogRegionIdentity {
  id: number;
  country_code: string;
  code?: string;
  iso2?: string;
  type?: string;
  parent_id?: number | null;
}

export function correctRegionParents<T extends CatalogRegionIdentity>(regions: T[]): T[];
export const catalogCityRegions: Record<string, Map<number, string>>;
export function catalogHierarchyPaths(regions: CatalogRegionIdentity[]): Map<number, string>;
