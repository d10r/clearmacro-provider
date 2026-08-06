export function metricSampleValue(
  metricsText: string,
  name: string,
  labels: Record<string, string>,
): number | undefined {
  for (const line of metricsText.split("\n")) {
    if (!line.startsWith(`${name}{`) || line.startsWith("#")) {
      continue;
    }
    const openBrace = line.indexOf("{");
    const closeBrace = line.indexOf("}", openBrace);
    if (openBrace === -1 || closeBrace === -1) {
      continue;
    }
    const labelText = line.slice(openBrace + 1, closeBrace);
    const parsedLabels = Object.fromEntries(
      labelText.split(",").map((part) => {
        const eq = part.indexOf("=");
        const key = part.slice(0, eq);
        const value = part.slice(eq + 2, -1);
        return [key, value];
      }),
    );
    const matches = Object.entries(labels).every(
      ([key, value]) => parsedLabels[key] === value,
    );
    if (!matches) {
      continue;
    }
    const value = Number(line.slice(closeBrace + 1).trim());
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

export function hasMetricSample(
  metricsText: string,
  name: string,
  labels: Record<string, string>,
): boolean {
  return metricSampleValue(metricsText, name, labels) !== undefined;
}
