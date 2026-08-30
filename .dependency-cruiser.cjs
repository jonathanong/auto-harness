/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "modules-not-to-services",
      comment: "Shared modules must not depend on deployable services.",
      severity: "error",
      from: { path: "^modules/" },
      to: { path: "^services/" },
    },
    {
      name: "actions-not-to-services",
      comment: "GitHub Actions may depend on shared modules, never deployable services.",
      severity: "error",
      from: { path: "^actions/" },
      to: { path: "^services/" },
    },
    {
      name: "no-cross-service",
      comment: "Services must not import other services; share code via modules/.",
      severity: "error",
      from: { path: "^services/([^/]+)/" },
      to: {
        path: "^services/([^/]+)/",
        pathNot: "^services/$1/",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules|\\.next|cdk\\.out",
    },
    exclude: {
      path: "node_modules|\\.next|cdk\\.out|next-env\\.d\\.ts",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
