export function projectAdministrativeRow<T extends {
  administrative_patch_json?: string | null;
  component_variants_json?: string;
}>(row: T): T;
