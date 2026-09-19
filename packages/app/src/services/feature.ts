// Explicit bundle opt-in; preview operations additionally require the current
// physical connection's advertised registry. Default builds remain unchanged.
export const servicesCatalogEnabled = process.env.EXPO_PUBLIC_PASEO_SERVICES_CATALOG === "1";
