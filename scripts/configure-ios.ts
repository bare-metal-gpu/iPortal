/** Set the runner identity without renaming upstream library/test targets. */
export function configure(source: string, team: string): string {
  if (!/^[A-Z0-9]{10}$/.test(team))
    throw new Error("Expected a ten-character Apple development team ID");
  let count = 0;
  const result = source.replace(
    /PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);(\s*)PRODUCT_NAME = [^;]+;/g,
    (match, identifier: string, whitespace: string) => {
      if (!identifier.endsWith(".WebDriverAgentRunner") && !identifier.endsWith(".iportal.mobile"))
        return match;
      count++;
      return `PRODUCT_BUNDLE_IDENTIFIER = com.${team.toLowerCase()}.iportal.mobile;${whitespace}PRODUCT_NAME = iPortalRunner;`;
    },
  );
  if (count < 2) throw new Error("Unsupported WDA project: missing runner build configurations");
  return result;
}

if (import.meta.main) {
  const [project, team] = process.argv.slice(2);
  if (!project || !team) throw new Error("Usage: configure-ios.ts <project> <team>");
  await Bun.write(project, configure(await Bun.file(project).text(), team));
}
